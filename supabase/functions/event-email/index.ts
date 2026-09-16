// ============================================================================
// event-email — the enqueue API
//
// This used to send the five event emails itself. It no longer sends
// anything. It resolves who should hear a thing, writes one event_messages
// row and one event_message_recipients row per person, and stops.
// supabase/functions/event-mailer drains that queue and does the sending.
//
// Splitting it in two is what buys the three rules that matter:
//
//   EML-06  the queue is claimed atomically, so nobody gets two copies even
//           when two dispatch runs overlap.
//   EML-07  the audience resolved here is re-checked at send time. This list
//           is a starting point, never the final word — somebody who cancels
//           between now and the send is dropped there, not here.
//   EML-08  status is per recipient, so a partial failure retries only the
//           people it failed for.
//
// Why it is still an edge function: member_directory deliberately has no
// email column — that is what keeps one member's address out of another
// member's hands. Addresses can only be read with the service role, which
// must never reach a browser. The caller's own token answers "who is
// asking", exactly as invite-email does, and the service role does the
// reading.
//
// Who may ask for what:
//
//   Host business — reminder, invite, update, cancelled, feedback_open —
//   needs hosts_event() or is_admin() (EML-09).
//   attendee_cancelled is the one an attendee triggers, and only about
//   themselves.
//   confirmation, payment and refund are queued by stripe-webhook and
//   event-refund with the service role; money is only ever confirmed by the
//   thing that took it.
//
// Queueing a message never changes the event. Saving an event and notifying
// the people coming to it are two separate outcomes with two separate
// results (ORG-10, EML-03) — a failure here has never undone a saved change
// and must not start.
//
// Deploy:  supabase functions deploy event-email
// Secrets: supabase secrets set SITE_URL=https://goamazing.ai   (optional)
//          supabase secrets set MAILER_SECRET=...   (needed for send_now)
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import {
  addressesFor,
  type Db,
  KINDS,
  type MessageKind,
  PERSONAL,
  resolveAudience,
  SERVICE_ONLY,
  unresolvedProfiles,
  withoutHosts,
} from '../_shared/audience.ts'

interface Body {
  kind: MessageKind
  event_id: string
  profile_id?: string
  subject?: string
  body?: string
  changed_details?: Record<string, { from: unknown; to: unknown }>
  audience_count?: number
  reminder_id?: string
  scheduled_for?: string
  send_now?: boolean
}

async function handle(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in first.' }, 401)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }

  const kind = String(body?.kind ?? '') as MessageKind
  const eventId = String(body?.event_id ?? '').trim()
  const profileId = String(body?.profile_id ?? '').trim()

  if (!KINDS.includes(kind)) return json({ error: 'Unknown kind.' }, 400)
  if (!eventId) return json({ error: 'An event is required.' }, 400)
  if (PERSONAL.includes(kind) && !profileId) {
    return json({ error: 'A recipient is required.' }, 400)
  }
  if (kind === 'update' && !String(body?.subject ?? '').trim()) {
    return json({ error: 'An update needs a subject.' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  const db = createClient(url, serviceKey)

  // stripe-webhook and event-refund call this with the service role. They are
  // server-side and already established the fact they are reporting.
  const asService = authorization === `Bearer ${serviceKey}`

  let me: string | null = null
  if (!asService) {
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
    })
    const { data: userData } = await asCaller.auth.getUser()
    me = userData?.user?.id ?? null
    if (!me) return json({ error: 'Sign in first.' }, 401)

    if (SERVICE_ONLY.includes(kind)) {
      return json({ error: 'That is not yours to send.' }, 403)
    }

    if (kind === 'attendee_cancelled' && profileId === me) {
      // EML-09. An attendee may ask for this about themselves and nobody else.
      // No further check: it is their own cancellation, their own address.
    } else {
      const [{ data: hosts }, { data: isAdmin }] = await Promise.all([
        asCaller.rpc('hosts_event', { p_event: eventId }),
        asCaller.rpc('is_admin'),
      ])
      if (!hosts && !isAdmin) return json({ error: 'That is not yours to send.' }, 403)
    }
  }

  const { data: eventRow, error: readError } = await db
    .from('events')
    .select('id, title, slug, starts_at, ends_at, status, venue_name, address, location,' +
      ' attendee_instructions, timezone, refund_terms')
    .eq('id', eventId)
    .maybeSingle()

  // A failed read is not "no such event", and the difference matters for the
  // next block: EML-04 compares the preview against this row, so running that
  // comparison on an error object would find every field changed and refuse a
  // perfectly good announcement with a nonsense list of what moved.
  if (readError) return json({ error: 'Could not read the event.' }, 500)
  if (!eventRow) return json({ error: 'That event does not exist.' }, 404)

  const event = eventRow as unknown as Record<string, unknown>

  // EML-04. The organiser approved a preview built against the event as it
  // read a moment ago. If it has moved again since, the announcement they
  // approved is not the announcement that would go out, so it is refused
  // rather than sent stale. Nothing is queued and nothing is lost — they
  // build the preview again against what the event says now.
  if (kind === 'update') {
    const moved = staleChanges(body.changed_details ?? {}, event)
    if (moved.length > 0) {
      return json(
        {
          error: 'The event changed again after this preview was built.',
          stale: moved,
          refresh_preview: true,
        },
        409,
      )
    }
  }

  // Only somebody who actually hosts the event can be told they host it. The
  // original checked this too, and it is what stops this kind being used to
  // mail an arbitrary member a message about an event they have nothing to do
  // with.
  if (kind === 'cohost') {
    const { data: row } = await db
      .from('event_hosts')
      .select('profile_id')
      .eq('event_id', eventId)
      .eq('profile_id', profileId)
      .maybeSingle()
    if (!row) return json({ error: 'They do not host that event.' }, 409)
  }

  // EML-01, the paid row: "Payment and ticket confirmation may be combined
  // into one clear email." They are. The paid path sends `payment`, which
  // already states the amount, that the place is confirmed, and where the
  // ticket is — so a `confirmation` for somebody who has paid is suppressed
  // here rather than relying on two workstreams agreeing about which of the
  // two to call. One purchase, one email, whoever asks.
  if (kind === 'confirmation') {
    const { data: order } = await db
      .from('event_orders')
      .select('id')
      .eq('event_id', eventId)
      .eq('profile_id', profileId)
      .eq('status', 'paid')
      .limit(1)
      .maybeSingle()
    if (order) {
      return json({ message_id: null, audience_count: 0, superseded_by: 'payment' }, 200)
    }
  }

  // FDB-06. A missed check-in corrected after the feedback email already went
  // out. The corrected guest gets their initial request; nobody who already
  // had one gets a second.
  if (kind === 'feedback_open' && profileId) {
    const late = await addLateRecipient(db, eventId, profileId)
    if (late) {
      if (late.reopened) await dispatch(url, late.message_id)
      return json(late, 200)
    }
  }

  const audience = await resolveAudience(db, kind, eventId, profileId)
  if (audience.length === 0) return json({ message_id: null, audience_count: 0 }, 200)

  const scheduledFor =
    body.send_now || !body.scheduled_for ? new Date().toISOString() : body.scheduled_for

  const { data: message, error: messageError } = await db
    .from('event_messages')
    .insert({
      event_id: eventId,
      kind,
      reminder_id: body.reminder_id ?? null,
      scheduled_for: scheduledFor,
      status: 'scheduled',
      subject: body.subject ?? null,
      body: body.body ?? null,
      changed_details: body.changed_details ?? null,
      // The count that goes on the record is the one just resolved, not the
      // one the preview guessed — the preview is what the organiser saw, this
      // is what was actually queued.
      audience_count: audience.length,
      triggered_by: me,
    })
    .select('id, kind, scheduled_for, status, audience_count')
    .single()

  if (messageError || !message) {
    return json({ error: `Could not queue it: ${messageError?.message}` }, 500)
  }

  // EML-06. Unique (message_id, profile_id) in the schema means a repeated
  // call cannot put the same person on the same message twice, whatever this
  // code does. upsert leans on that rather than re-asserting it.
  const { error: recipientError } = await db
    .from('event_message_recipients')
    .upsert(
      audience.map((person) => ({
        message_id: message.id,
        profile_id: person.profile_id,
        email: person.email,
        status: 'scheduled',
      })),
      { onConflict: 'message_id,profile_id', ignoreDuplicates: true },
    )

  if (recipientError) {
    await db
      .from('event_messages')
      .update({ status: 'cancelled', error: recipientError.message })
      .eq('id', message.id)
    return json({ error: `Could not queue the recipients: ${recipientError.message}` }, 500)
  }

  // A host pressing Send watches it go rather than waiting for the next cron
  // tick. The dispatcher claims conditionally, so this racing the schedule is
  // harmless — one of them gets the message and the other gets nothing.
  let dispatched = false
  if (body.send_now) {
    dispatched = await dispatch(url, String(message.id))
  }

  return json(
    {
      message_id: message.id,
      kind,
      audience_count: audience.length,
      scheduled_for: scheduledFor,
      status: 'scheduled',
      dispatched,
    },
    200,
  )
}

/* -------------------------------------------------------------------------- */
/* FDB-06 — a check-in corrected after the feedback email went out             */
/* -------------------------------------------------------------------------- */

interface LateAdd {
  message_id: string
  audience_count: number
  added: boolean
  reopened: boolean
  note: string
}

/**
 * FDB-06: "Include them in the initial feedback email if it has not yet been
 * sent. If feedback has already opened, make the feedback link available and
 * send their initial request without duplicating an earlier send. A corrected
 * guest must not remain blocked solely because the original check-in was
 * missed."
 *
 * The first half is free — a correction made before the send is picked up by
 * the dispatcher's EML-07 re-check. This is the second half.
 *
 * It adds the one person to the **existing** feedback_open message rather than
 * making a second one, because a second message is a second audience and the
 * only thing stopping it mailing everybody twice would be care. Unique
 * (message_id, profile_id) on the existing row is a guard that holds whatever
 * this code does (EML-06).
 *
 * Re-opening a finished message to 'scheduled' is safe: the dispatcher only
 * ever writes to recipients still sitting at 'scheduled' or 'failed', so the
 * people who already received it are not written to a second time (EML-08).
 *
 * Returns null when there is no feedback_open message yet — then the ordinary
 * enqueue path runs and the correction simply lands in the first send.
 */
async function addLateRecipient(
  db: Db,
  eventId: string,
  profileId: string,
): Promise<LateAdd | null> {
  const { data: existing } = await db
    .from('event_messages')
    .select('id, status')
    .eq('event_id', eventId)
    .eq('kind', 'feedback_open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!existing) return null

  const message = existing as { id: string; status: string }

  const { data: already } = await db
    .from('event_message_recipients')
    .select('id')
    .eq('message_id', message.id)
    .eq('profile_id', profileId)
    .maybeSingle()
  if (already) {
    // They were on the original send. Nothing to do, and saying so is not an
    // error — a host correcting attendance twice is not a fault.
    return {
      message_id: message.id,
      audience_count: 0,
      added: false,
      reopened: false,
      note: 'Already on this message.',
    }
  }

  const [person] = await addressesFor(db, [profileId])
  if (!person) {
    return {
      message_id: message.id,
      audience_count: 0,
      added: false,
      reopened: false,
      note: 'No active profile to write to.',
    }
  }

  const { error } = await db.from('event_message_recipients').insert({
    message_id: message.id,
    profile_id: profileId,
    email: person.email,
    status: 'scheduled',
  })
  if (error) {
    return {
      message_id: message.id,
      audience_count: 0,
      added: false,
      reopened: false,
      note: error.message,
    }
  }

  const reopened = message.status !== 'scheduled'
  if (reopened) {
    await db.from('event_messages').update({ status: 'scheduled' }).eq('id', message.id)
  }

  return {
    message_id: message.id,
    audience_count: 1,
    added: true,
    reopened,
    note: 'Added to the original feedback request.',
  }
}

/* -------------------------------------------------------------------------- */
/* EML-04 — is this preview still true                                         */
/* -------------------------------------------------------------------------- */

/**
 * The preview recorded, per field, what the value was about to become. If the
 * event still says that, the preview is current. If it says something else,
 * the organiser is about to announce a time or a place that is already wrong.
 *
 * Returns the fields that have moved on. Pure, so the mailer's self-check can
 * borrow the same reasoning.
 */
export function staleChanges(
  changed: Record<string, { from: unknown; to: unknown }>,
  event: Record<string, unknown>,
): string[] {
  return Object.entries(changed)
    .filter(([field, change]) => {
      if (!(field in event)) return false
      return normalise(event[field]) !== normalise(change?.to)
    })
    .map(([field]) => field)
}

/** Timestamps come back from Postgres spelled differently to how they went in. */
function normalise(value: unknown): string {
  if (value == null) return ''
  const text = String(value)
  const asDate = Date.parse(text)
  return Number.isNaN(asDate) ? text.trim() : String(asDate)
}

/* -------------------------------------------------------------------------- */
/* Send now                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Nudges the dispatcher for this one message. Best effort on purpose: the
 * message is already queued and the schedule will pick it up within five
 * minutes regardless, so a failure here is not worth failing the request the
 * organiser made.
 */
async function dispatch(url: string, messageId: string): Promise<boolean> {
  const secret = Deno.env.get('MAILER_SECRET')
  if (!secret) return false
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/event-mailer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mailer-secret': secret },
      body: JSON.stringify({ message_id: messageId }),
    })
    return response.ok
  } catch {
    return false
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers':
        'authorization, x-client-info, apikey, content-type',
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Self-check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * EML-04 is the one decision here that is wrong quietly rather than loudly:
 * a stale preview sends a correct-looking announcement carrying last week's
 * address. It is pure, so it is checked without a database.
 *
 *   deno run -A supabase/functions/event-email/index.ts --check
 */
function demo(): void {
  const ok = (claim: boolean, what: string) => {
    if (!claim) throw new Error(`FAILED: ${what}`)
    console.log(`  ok  ${what}`)
  }

  const event = {
    title: 'Dinner',
    venue_name: 'The Hoxton',
    starts_at: '2026-03-12T19:00:00+00:00',
    address: null,
  }

  ok(
    staleChanges({ venue_name: { from: 'The Standard', to: 'The Hoxton' } }, event).length === 0,
    'EML-04 a preview that matches the event is sent',
  )
  ok(
    staleChanges({ venue_name: { from: 'The Standard', to: 'The Standard' } }, event)[0] ===
      'venue_name',
    'EML-04 a preview built before a later edit is refused, not sent stale',
  )
  ok(
    staleChanges({ starts_at: { from: null, to: '2026-03-12T19:00:00Z' } }, event).length === 0,
    'EML-04 the same instant spelled differently by Postgres is not a change',
  )
  ok(
    staleChanges({ starts_at: { from: null, to: '2026-03-12T20:00:00Z' } }, event)[0] ===
      'starts_at',
    'EML-04 a moved start time is caught',
  )
  ok(
    staleChanges({ address: { from: '12 Holywell Lane', to: null } }, event).length === 0,
    'EML-04 a cleared field reads as cleared, not as a change',
  )

  // ---- EML-01: who hears a cancellation ------------------------------------

  const registrations = [{ profile_id: 'confirmed' }, { profile_id: 'mid-checkout' }]
  const orders = [
    { id: 'o1', profile_id: 'mid-checkout', status: 'pending' },
    { id: 'o2', profile_id: 'paid-up', status: 'paid' },
    // Refunded already, so not an unresolved obligation on its own …
    { id: 'o3', profile_id: 'settled', status: 'refunded' },
    // … but this one's refund is still in flight, which is.
    { id: 'o4', profile_id: 'awaiting-refund', status: 'refunded' },
    { id: 'o5', profile_id: 'never-paid', status: 'failed' },
  ]
  const hears = unresolvedProfiles(registrations, orders, ['o4']).sort()

  ok(
    JSON.stringify(hears) ===
      JSON.stringify(['awaiting-refund', 'confirmed', 'mid-checkout', 'paid-up']),
    'EML-01 a cancellation reaches everyone with an unresolved booking or payment',
  )
  ok(
    !hears.includes('never-paid') && !hears.includes('settled'),
    'EML-01 a failed purchase and a finished refund are not unresolved obligations',
  )
  ok(
    hears.filter((id) => id === 'mid-checkout').length === 1,
    'EML-06 somebody who is both registered and mid-payment hears once, not twice',
  )

  // ---- a host is not a guest of their own event ----------------------------

  ok(
    JSON.stringify(withoutHosts(['guest', 'cohost', 'other'], ['cohost', 'creator'])) ===
      JSON.stringify(['guest', 'other']),
    'somebody hosting the event is left out of the invite audience',
  )
  ok(
    withoutHosts(['cohost'], ['cohost']).length === 0,
    'a new cohost hears "you are hosting this" and not "you are invited to this"',
  )
  ok(
    JSON.stringify(withoutHosts(['guest'], [])) === JSON.stringify(['guest']),
    'an event with no cohosts still invites its guests',
  )

  console.log('\nevent-email: all checks passed.')
}

if (Deno.args.includes('--check')) {
  demo()
} else {
  Deno.serve(handle)
}
