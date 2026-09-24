// ============================================================================
// event-mailer — the dispatcher
//
// Nothing in the event platform sends an email directly any more. Everything
// writes rows into event_messages + event_message_recipients (see
// supabase/functions/event-email, the enqueue API) and this function drains
// that queue.
//
// The queue is the whole point. Sending straight from the code that made the
// change cannot honestly do any of these:
//
//   EML-06  no duplicate copies. Claiming a message is a single conditional
//           update, so two overlapping runs — the pg_cron one and the GitHub
//           Actions one, say — cannot both take it.
//   EML-07  eligibility is re-checked per recipient at send time. A list
//           built an hour ago must not keep emailing somebody who cancelled
//           twenty minutes ago.
//   EML-08  per-recipient status, so a partial failure retries only the
//           failures and never re-sends to the people who got it.
//
// Why it runs with the service role: profiles holds the addresses and
// member_directory deliberately does not, which is what keeps one member's
// email out of another member's hands. Same reasoning as event-email.
//
// Recipients never see each other (EML-05) — one Resend message per person,
// never a shared To or Cc. Resend takes 100 messages per batch call, so the
// per-person messages go up in chunks of 100.
//
// "Sent" is the strongest word used here. Resend's batch response says it
// accepted the message, not that anyone received or read it (EML-08).
//
// Self-check:  deno run -A supabase/functions/event-mailer/index.ts --check
// Deploy:  supabase functions deploy event-mailer --no-verify-jwt
// Secrets: supabase secrets set RESEND_API_KEY=re_...
//          supabase secrets set MAILER_SECRET=...                 (required)
//          supabase secrets set SITE_URL=https://goamazing.ai     (optional)
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { staleChanges, staleSnapshot } from '../_shared/event-update.ts'
import {
  type Db,
  type MessageKind,
  planFor,
  resolveAudience,
} from '../_shared/audience.ts'

const FROM = 'Amazing AI <noreply@goamazing.ai>'
const SITE = (Deno.env.get('SITE_URL') ?? 'https://goamazing.ai').replace(/\/+$/, '')

/** Resend takes 100 per batch call. */
const BATCH = 100

/**
 * The claim. EML-06: a message is only ever taken out of 'scheduled', so the
 * update matches nothing the second time two runs overlap on the same row.
 * Postgres re-evaluates the WHERE clause after the first update commits, so
 * the loser claims zero rows rather than a duplicate copy.
 *
 * It is a named constant because the self-check asserts on it — an
 * unconditional claim is the one bug in this file that sends two emails.
 */
const CLAIM_FROM = ['scheduled'] as const

/**
 * EML-08. A named message may also be claimed back out of 'failed', which is
 * what a retry is. Only the recipients that failed are still outstanding, so
 * re-opening the message writes to them and to nobody who already had it.
 *
 * Still conditional, so it is still safe against an overlapping run — and a
 * sweep with no message_id never picks failures up on its own, because
 * retrying the same broken thing every five minutes for ever is not a retry.
 */
const RETRY_FROM = ['scheduled', 'failed'] as const

/**
 * EML-07. Which kinds mean "you are coming to this", and therefore have to be
 * re-checked against a live registration at send time. The rest are about
 * something that happened to one person — a payment, a refund, their own
 * cancellation — and stay true whatever their registration says now.
 */
const NEEDS_LIVE_REGISTRATION: MessageKind[] = ['reminder', 'update']

/**
 * FDB-06. feedback_open is re-checked against attendance instead, because
 * attendance is what the feedback form itself requires — "Buying a ticket,
 * receiving an invitation, or RSVPing alone is insufficient." Checking it
 * against a registration would drop a walk-in whose place was recorded by
 * mark_attended without one, and mail a no-show a form that will refuse them.
 */
const NEEDS_ATTENDANCE: MessageKind[] = ['feedback_open']

/**
 * EML-07 again. "You are hosting this" stops being true the moment somebody
 * is removed as a cohost, and a queued message can outlive that — so it is
 * checked against event_hosts at send time like everything else.
 */
const NEEDS_HOSTING: MessageKind[] = ['cohost']

interface EventRow {
  id: string
  /** The creator. CONTRACT §7.0 — whoever created the event owns its money. */
  host_id: string
  title: string
  slug: string | null
  description: string | null
  location: string | null
  venue_name: string | null
  address: string | null
  attendee_instructions: string | null
  starts_at: string
  ends_at: string | null
  timezone: string | null
  status: string | null
  currency: string | null
  feedback_opens_after_minutes?: number
}

interface MessageRow {
  id: string
  event_id: string
  kind: MessageKind
  /** The reminder time a 'reminder' was scheduled for; null once that time is removed. */
  reminder_id: string | null
  scheduled_for: string | null
  subject: string | null
  body: string | null
  changed_details: Record<string, { from: unknown; to: unknown }> | null
  preview_snapshot?: Record<string, unknown> | null
}

interface RecipientRow {
  id: string
  profile_id: string
  email: string | null
  status: string
}

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

async function handle(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const db = createClient(url, serviceKey)

  // Two ways in, and neither is an open endpoint. The cron schedules carry a
  // shared secret; a human running a dispatch by hand carries their own token
  // and has to be an admin. verify_jwt is off precisely so cron can call it,
  // which makes this check the only door.
  const secret = Deno.env.get('MAILER_SECRET')
  const presented = request.headers.get('x-mailer-secret')
  let authorised = Boolean(secret) && presented === secret

  if (!authorised) {
    const authorization = request.headers.get('Authorization') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (authorization && anonKey) {
      const asCaller = createClient(url, anonKey, {
        global: { headers: { Authorization: authorization } },
      })
      const { data: isAdmin } = await asCaller.rpc('is_admin')
      authorised = Boolean(isAdmin)
    }
  }
  if (!authorised) return json({ error: 'Not authorised.' }, 401)

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'RESEND_API_KEY is not set.' }, 500)

  let only = ''
  try {
    const body = request.headers.get('content-length') === '0' ? {} : await request.json()
    only = String(body?.message_id ?? '').trim()
  } catch {
    // An empty body is the normal cron call. Only a malformed one lands here,
    // and a dispatch run with no filter is exactly what cron wanted anyway.
  }

  const now = new Date()
  const claimed = await claim(db, now, only)

  const results: { message_id: string; status: string; sent: number; failed: number }[] = []
  for (const message of claimed) {
    results.push(await dispatch(db, message, now, resendKey))
  }

  return json({
    claimed: claimed.length,
    sent: results.reduce((n, r) => n + r.sent, 0),
    failed: results.reduce((n, r) => n + r.failed, 0),
    messages: results,
  })
}

/**
 * EML-06. One conditional update takes every due message at once. Whoever
 * gets there first owns them; a second run claims nothing.
 *
 * ponytail: no limit on the claim, so one run takes the whole backlog. Fine
 * while a dispatch is a handful of messages — add `.limit()` with an ordered
 * claim if a single run ever risks the function timeout.
 */
async function claim(db: Db, now: Date, only: string): Promise<MessageRow[]> {
  let query = db
    .from('event_messages')
    .update({ status: 'queued' })
    .in('status', only ? [...RETRY_FROM] : [...CLAIM_FROM])
    .lte('scheduled_for', now.toISOString())
  if (only) query = query.eq('id', only)

  const { data, error } = await query.select(
    'id, event_id, kind, reminder_id, scheduled_for, subject, body, changed_details, preview_snapshot',
  )
  if (error) throw new Error(`Could not claim messages: ${error.message}`)
  return (data ?? []) as unknown as MessageRow[]
}

/* -------------------------------------------------------------------------- */
/* One message                                                                 */
/* -------------------------------------------------------------------------- */

async function dispatch(db: Db, message: MessageRow, now: Date, resendKey: string) {
  const { data: row, error: readError } = await db
    .from('events')
    .select(
      'id, host_id, title, slug, description, location, venue_name, address,' +
        ' attendee_instructions, starts_at, ends_at, timezone, status, currency, feedback_opens_after_minutes',
    )
    .eq('id', message.event_id)
    .maybeSingle()

  // A read that failed says nothing about the event, only about the
  // connection — and this message has already been taken out of the pool by
  // claim(). Hand the claim back so the next sweep tries again, rather than
  // dropping a cancellation notice because the database blinked. Nothing has
  // been sent at this point, so re-claiming it cannot duplicate anything.
  //
  // ponytail: a permanently failing read re-queues for ever. It never sends,
  // so the worst case is a message that sits there — add an attempt count on
  // event_messages if that ever needs a ceiling.
  if (readError) {
    await db.from('event_messages').update({ status: 'scheduled' }).eq('id', message.id)
    return { message_id: message.id, status: 'requeued', sent: 0, failed: 0 }
  }

  if (!row) {
    await finish(db, message.id, 'skipped', 'The event no longer exists.')
    return { message_id: message.id, status: 'skipped', sent: 0, failed: 0 }
  }

  // Narrowed once, here, rather than cast at each use. Casting per use is how
  // host_id came to be read off a value that could still have been an error.
  const event = row as unknown as EventRow

  // A reschedule may race a claim. Keep the initial request pending until its
  // full configured opening time, rather than discarding it as a stale reminder.
  const feedbackDue = new Date(event.ends_at ?? event.starts_at).getTime() + (event.feedback_opens_after_minutes ?? 0) * 60_000
  if (message.kind === 'feedback_open' && event.status !== 'cancelled' && now.getTime() < feedbackDue) {
    await db.from('event_messages').update({ status: 'scheduled', scheduled_for: new Date(feedbackDue).toISOString() }).eq('id', message.id)
    return { message_id: message.id, status: 'deferred', sent: 0, failed: 0 }
  }

  const reason = skipReason(message, event, now)
  if (reason) {
    await finish(db, message.id, 'skipped', reason)
    return { message_id: message.id, status: 'skipped', sent: 0, failed: 0 }
  }

  // How many recipients this message has *at all*, not how many are still
  // pending. The two are different questions and conflating them is what made
  // every scheduled reminder read as delivered: schedule_event_messages()
  // writes the event_messages row in SQL and nothing in SQL has ever written
  // event_message_recipients, so a reminder arrived here with no recipients,
  // no pending rows, and was marked 'sent' without an email being sent.
  const { count } = await db
    .from('event_message_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('message_id', message.id)
  const onFile = count ?? 0

  const plan = planFor(message.kind, onFile)

  // A message nobody can work out the audience for is never called 'sent'.
  // Its recipients are one named person whose id lives only on the recipient
  // row, so if that row is missing the information is simply gone — which is
  // a fault to look at, not a delivery.
  if (plan === 'unresolvable') {
    await finish(
      db,
      message.id,
      'failed',
      'No recipients on file and this kind cannot be resolved from the event.',
    )
    return { message_id: message.id, status: 'failed', sent: 0, failed: 0 }
  }

  // EML-07 is the reason this happens here rather than at schedule time: the
  // audience has to be re-checked at send time anyway, so resolving it days
  // early would be stale as well as duplicated. Same resolver event-email
  // uses — one definition of who hears a thing.
  if (plan === 'resolve') {
    const audience = await resolveAudience(db, message.kind, message.event_id, '')
    if (audience.length > 0) {
      // Unique (message_id, profile_id) means a second run that races this one
      // cannot put anybody on the message twice (EML-06).
      await db.from('event_message_recipients').upsert(
        audience.map((person) => ({
          message_id: message.id,
          profile_id: person.profile_id,
          email: person.email,
          status: 'scheduled',
        })),
        { onConflict: 'message_id,profile_id', ignoreDuplicates: true },
      )
    }
    // The count SQL could not know when it wrote the row.
    await db
      .from('event_messages')
      .update({ audience_count: audience.length })
      .eq('id', message.id)

    if (audience.length === 0) {
      // Resolved, and nobody qualified. An event with nobody confirmed has
      // nobody to remind, and that genuinely is a finished message — the
      // audience_count of 0 above is what says so.
      await finish(db, message.id, 'sent', null)
      return { message_id: message.id, status: 'sent', sent: 0, failed: 0 }
    }
  }

  // EML-08. A retry re-opens the message; only the recipients that failed are
  // still outstanding, so the people who already received it are not written
  // to a second time.
  const { data: rows } = await db
    .from('event_message_recipients')
    .select('id, profile_id, email, status')
    .eq('message_id', message.id)
    .in('status', ['scheduled', 'failed'])
  const pending = (rows ?? []) as unknown as RecipientRow[]

  // Everybody on the message has already had it — the completion of a retry.
  if (pending.length === 0) {
    await finish(db, message.id, 'sent', null)
    return { message_id: message.id, status: 'sent', sent: 0, failed: 0 }
  }

  const { eligible, dropped } = await recheck(db, message, pending)
  for (const row of dropped) {
    await db
      .from('event_message_recipients')
      .update({ status: 'skipped', error: row.reason })
      .eq('id', row.id)
  }

  if (eligible.length === 0) {
    await finish(db, message.id, 'skipped', 'Nobody was still eligible at send time.')
    return { message_id: message.id, status: 'skipped', sent: 0, failed: 0 }
  }

  const facts = await perPerson(db, message, eligible.map((r) => r.profile_id))
  const detail = describe(event, await hostName(db, event.host_id))

  const messages = eligible.map((person) => {
    const copy = WRITE[message.kind](
      { ...facts[person.profile_id], first: person.first },
      detail,
      message,
    )
    return { row: person, ...render(copy, person.email) }
  })

  let sent = 0
  let failed = 0
  let lastError: string | null = null

  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH)
    let error: string | null = null
    try {
      const response = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk.map((m) => m.payload)),
      })
      if (!response.ok) error = `Resend refused it: ${await response.text()}`.slice(0, 500)
    } catch (thrown) {
      error = String(thrown).slice(0, 500)
    }

    const at = new Date().toISOString()
    for (const m of chunk) {
      // "sent" means Resend accepted it. It is not delivery and it is not a
      // read receipt — the batch response does not carry either (EML-08).
      await db
        .from('event_message_recipients')
        .update({
          status: error ? 'failed' : 'sent',
          error,
          sent_at: error ? null : at,
        })
        .eq('id', m.row.id)
    }
    if (error) {
      failed += chunk.length
      lastError = error
    } else {
      sent += chunk.length
    }
  }

  // EML-08. A failure here is recorded and nothing else. It has never undone
  // a ticket, a saved event change or a completed refund, and it must not
  // start: the email is the notification, not the thing itself.
  const status = failed > 0 ? 'failed' : 'sent'
  await finish(db, message.id, status, lastError)
  return { message_id: message.id, status, sent, failed }
}

async function finish(db: Db, id: string, status: string, error: string | null) {
  await db
    .from('event_messages')
    .update({
      status,
      error,
      sent_at: status === 'sent' || status === 'failed' ? new Date().toISOString() : null,
    })
    .eq('id', id)
}

/**
 * EML-06. Some messages stop being true before they are sent — usually
 * because the organiser moved the event. A reminder for something that has
 * already started is wrong in a way that sending it late cannot fix, so it is
 * marked skipped and the reschedule queues a fresh one.
 *
 * Returns the reason to skip, or null to send. Pure — the self-check drives it.
 */
export function skipReason(message: MessageRow, event: EventRow, now: Date): string | null {
  const starts = new Date(event.starts_at)
  const ends = event.ends_at ? new Date(event.ends_at) : null

  if (event.status === 'cancelled') {
    // A cancellation, a refund and somebody's own cancellation are the three
    // things still worth saying about an event that is not happening.
    const stillWorthSending: MessageKind[] = ['cancelled', 'refund', 'attendee_cancelled']
    if (!stillWorthSending.includes(message.kind)) {
      return 'The event was cancelled before this went out.'
    }
    return null
  }

  // Its reminder time was removed (the foreign key nulls it). Nobody asked for
  // this one any more.
  if (message.kind === 'reminder' && message.reminder_id == null) {
    return 'This reminder time was removed before it went out.'
  }

  if (message.kind === 'reminder' && now >= starts) {
    return 'The event had already started — a late reminder is not sent.'
  }

  if (message.kind === 'feedback_open' && now.getTime() < (ends ?? starts).getTime() + (event.feedback_opens_after_minutes ?? 0) * 60_000) {
    return 'The event now ends later — feedback is not open yet.'
  }

  if (message.kind === 'update' && (
    staleChanges(message.changed_details ?? {}, event as unknown as Record<string, unknown>).length > 0 ||
    (message.preview_snapshot && staleSnapshot(message.preview_snapshot, event as unknown as Record<string, unknown>).length > 0)
  )) {
    return 'The event changed after this update was previewed. Build a fresh preview before sending.'
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* Who is still eligible, at send time                                         */
/* -------------------------------------------------------------------------- */

interface Eligible {
  id: string
  profile_id: string
  email: string
  first: string
}

/**
 * EML-07. The recipient list was written when the message was queued, which
 * may have been days ago. Everything that could have changed since is checked
 * again here: the address, whether the person is still an active profile, and
 * — for the kinds that mean "you are coming to this" — whether they are still
 * registered.
 *
 * The address is re-read rather than trusted, so a change of email between
 * queueing and sending goes to the new one.
 */
export async function recheck(
  db: Db,
  message: MessageRow,
  pending: RecipientRow[],
): Promise<{ eligible: Eligible[]; dropped: { id: string; reason: string }[] }> {
  const ids = pending.map((r) => r.profile_id)

  const { data: profileRows } = await db
    .from('profiles')
    .select('id, email, full_name, profile_status')
    .in('id', ids)
  const profiles = new Map(
    ((profileRows ?? []) as { id: string; email: string | null; full_name: string | null; profile_status: string }[])
      .map((p) => [p.id, p]),
  )

  let registered: Map<string, string> | null = null
  if (NEEDS_LIVE_REGISTRATION.includes(message.kind)) {
    const { data: regRows } = await db
      .from('event_registrations')
      .select('profile_id, status')
      .eq('event_id', message.event_id)
      .in('profile_id', ids)
      // EML-05. Currently registered means confirmed — free and paid alike.
      // A cancelled registration and a purchase that never completed are both
      // out, and neither is written to again.
      .eq('status', 'confirmed')
    registered = new Map(
      ((regRows ?? []) as { profile_id: string; status: string }[]).map((r) => [
        r.profile_id,
        r.status,
      ]),
    )
  }

  let missing = 'No longer registered for this event.'
  if (NEEDS_HOSTING.includes(message.kind)) {
    const { data: hostRows } = await db
      .from('event_hosts')
      .select('profile_id')
      .eq('event_id', message.event_id)
      .in('profile_id', ids)
    registered = new Map(
      ((hostRows ?? []) as { profile_id: string }[]).map((r) => [r.profile_id, 'hosting']),
    )
    missing = 'No longer a host of this event.'
  }
  if (NEEDS_ATTENDANCE.includes(message.kind)) {
    const { data: attendedRows } = await db
      .from('event_attendance')
      .select('profile_id')
      .eq('event_id', message.event_id)
      .in('profile_id', ids)
    registered = new Map(
      ((attendedRows ?? []) as { profile_id: string }[]).map((r) => [r.profile_id, 'attended']),
    )
    missing = 'No verified attendance at this event.'
  }

  return split(pending, profiles, registered, missing)
}

/**
 * The decision itself, with the reading already done. Pure — self-checked.
 *
 * `stillOn` is whichever live fact this kind depends on — a confirmed
 * registration, or attendance — or null when the message is about something
 * that happened to one person and stays true whatever they do next.
 */
export function split(
  pending: RecipientRow[],
  profiles: Map<string, { email: string | null; full_name: string | null; profile_status: string }>,
  stillOn: Map<string, string> | null,
  missing = 'No longer registered for this event.',
): { eligible: Eligible[]; dropped: { id: string; reason: string }[] } {
  const eligible: Eligible[] = []
  const dropped: { id: string; reason: string }[] = []

  for (const row of pending) {
    const profile = profiles.get(row.profile_id)
    if (!profile) {
      dropped.push({ id: row.id, reason: 'No profile.' })
      continue
    }
    if (profile.profile_status !== 'active') {
      dropped.push({ id: row.id, reason: 'The account is no longer active.' })
      continue
    }
    const email = profile.email ?? row.email
    if (!email) {
      dropped.push({ id: row.id, reason: 'No address to write to.' })
      continue
    }
    if (stillOn && !stillOn.has(row.profile_id)) {
      dropped.push({ id: row.id, reason: missing })
      continue
    }
    eligible.push({
      id: row.id,
      profile_id: row.profile_id,
      email,
      first: String(profile.full_name ?? '').split(' ')[0] || 'there',
    })
  }

  return { eligible, dropped }
}

/* -------------------------------------------------------------------------- */
/* The facts that differ per person                                            */
/* -------------------------------------------------------------------------- */

interface Person {
  first: string
  ticket?: string | null
  paid?: string | null
  currency?: string
  refunded?: string | null
  refundState?: string | null
}

/**
 * EML-10. A ticket link and an amount belong to one person, so they are read
 * at send time rather than baked into the queued row. What the email says you
 * paid is what the order says now.
 */
async function perPerson(
  db: Db,
  message: MessageRow,
  ids: string[],
): Promise<Record<string, Person>> {
  const out: Record<string, Person> = {}
  for (const id of ids) out[id] = { first: '' }

  if (['confirmation', 'payment', 'reminder'].includes(message.kind)) {
    const { data } = await db
      .from('event_tickets')
      .select('id, profile_id')
      .eq('event_id', message.event_id)
      .in('profile_id', ids)
      .is('revoked_at', null)
    for (const t of (data ?? []) as { id: string; profile_id: string }[]) {
      out[t.profile_id].ticket = `${SITE}/events/tickets/${t.id}`
    }
  }

  if (['payment', 'refund'].includes(message.kind)) {
    const { data: orders } = await db
      .from('event_orders')
      .select('id, profile_id, amount_cents, currency, status')
      .eq('event_id', message.event_id)
      .in('profile_id', ids)
      .eq('status', 'paid')
    const byOrder = new Map<string, string>()
    for (const o of (orders ?? []) as {
      id: string
      profile_id: string
      amount_cents: number
      currency: string
    }[]) {
      out[o.profile_id].paid = money(o.amount_cents, o.currency)
      out[o.profile_id].currency = o.currency
      byOrder.set(o.id, o.profile_id)
    }

    if (message.kind === 'refund' && byOrder.size > 0) {
      const { data: refunds } = await db
        .from('event_refunds')
        .select('order_id, amount_cents, status')
        .in('order_id', [...byOrder.keys()])
      for (const r of (refunds ?? []) as {
        order_id: string
        amount_cents: number
        status: string
      }[]) {
        const profileId = byOrder.get(r.order_id)
        if (!profileId) continue
        // BUY-08. Never "refunded" until the refund actually completed.
        out[profileId].refundState = REFUND_WORDS[r.status] ?? r.status
        out[profileId].refunded = money(r.amount_cents, out[profileId].currency ?? 'gbp')
      }
    }
  }

  return out
}

const REFUND_WORDS: Record<string, string> = {
  requested: 'Refund requested',
  processing: 'Refund processing',
  completed: 'Refunded',
  failed: 'Refund failed',
  needs_attention: 'Refund needs attention',
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'gbp').toUpperCase(),
  }).format(cents / 100)
}

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

interface Detail {
  title: string
  /** Who is running it. Named in the money emails — see WRITE.payment. */
  host: string | null
  when: string
  where: string | null
  instructions: string | null
  link: string
  feedbackLink: string
  /** Where a host is sent, as opposed to a guest. */
  manageLink: string
}

/**
 * CONTRACT §7.0. An event's money belongs to whoever created it: Amazing for
 * a platform event, a super connector's own Stripe account for theirs. This
 * function is not told which, so the money emails name the event and its host
 * and assert nothing about whose account took or returned the payment.
 */
async function hostName(db: Db, hostId: string): Promise<string | null> {
  const { data } = await db
    .from('profiles')
    .select('full_name')
    .eq('id', hostId)
    .maybeSingle()
  return String((data as { full_name?: string | null } | null)?.full_name ?? '').trim() || null
}

function describe(event: EventRow, host: string | null): Detail {
  const slug = event.slug ?? event.id
  return {
    title: String(event.title),
    host,
    when: formatWhen(event),
    where: [event.venue_name, event.address].filter(Boolean).join(', ') || event.location,
    instructions: event.attendee_instructions,
    link: `${SITE}/e/${encodeURIComponent(slug)}`,
    feedbackLink: `${SITE}/events/feedback/${encodeURIComponent(slug)}`,
    manageLink: `${SITE}/manage/events/${encodeURIComponent(event.id)}`,
  }
}

interface Copy {
  subject: string
  /** Paragraphs, plain text. The shell escapes them. */
  body: string[]
  /**
   * EML-10. The structured facts, kept out of the prose so the organiser's own
   * words can never be mistaken for the time or the address, and so they stay
   * accurate even when the organiser writes something vague around them.
   */
  facts: [string, string][]
  cta: string
  link: string | null
}

/** Where and when, which nearly every message needs. */
function coordinates(d: Detail): [string, string][] {
  const facts: [string, string][] = [['When', d.when]]
  if (d.where) facts.push(['Where', d.where])
  return facts
}

const WRITE: Record<MessageKind, (p: Person, d: Detail, m: MessageRow) => Copy> = {
  confirmation: (p, d) => ({
    subject: `You are going to ${d.title}`,
    body: [
      `Hello ${p.first},`,
      `Your place at ${d.title} is confirmed.`,
      p.ticket
        ? 'Your ticket is below — bring it with you, on your phone is fine.'
        : 'Your ticket is on your tickets page.',
      ...(d.instructions ? [d.instructions] : []),
    ],
    facts: [...coordinates(d), ...(p.ticket ? ([['Your ticket', p.ticket]] as [string, string][]) : [])],
    cta: p.ticket ? 'Open your ticket' : 'See the event',
    link: p.ticket ?? d.link,
  }),

  // CONTRACT §7.0 / BUY-14. The money for an event goes to whoever created
  // it — Amazing's own Stripe for a platform event, the super connector's own
  // account for theirs. This function cannot tell which, so the wording says
  // the payment went through and who is hosting, and never that Amazing took
  // it. Claiming the wrong party took somebody's money is worse than saying
  // less.
  payment: (p, d) => ({
    subject: `Payment received for ${d.title}`,
    body: [
      `Hello ${p.first},`,
      p.paid
        ? `Your payment of ${p.paid} for ${d.title} has gone through, and your place is confirmed.`
        : `Your payment for ${d.title} has gone through, and your place is confirmed.`,
      d.host
        ? `${d.title} is hosted by ${d.host}. Anything about the payment itself goes to them.`
        : 'Anything about the payment itself goes to the event host.',
    ],
    facts: [
      ...(p.paid ? ([['Paid', p.paid]] as [string, string][]) : []),
      ['Event', d.title],
      ...(d.host ? ([['Hosted by', d.host]] as [string, string][]) : []),
      ...coordinates(d),
      ...(p.ticket ? ([['Your ticket', p.ticket]] as [string, string][]) : []),
    ],
    cta: p.ticket ? 'Open your ticket' : 'See the event',
    link: p.ticket ?? d.link,
  }),

  reminder: (p, d) => ({
    subject: `${d.title} is coming up`,
    body: [
      `Hello ${p.first},`,
      `${d.title} is nearly here. Here is everything you need.`,
      ...(d.instructions ? [d.instructions] : []),
    ],
    facts: [...coordinates(d), ...(p.ticket ? ([['Your ticket', p.ticket]] as [string, string][]) : [])],
    cta: p.ticket ? 'Open your ticket' : 'See the event',
    link: p.ticket ?? d.link,
  }),

  invite: (p, d, m) => ({
    subject: m.subject ?? `You are invited to ${d.title}`,
    body: [
      `Hello ${p.first},`,
      `You have been invited to ${d.title}.`,
      ...(m.body ? [m.body] : []),
      'Your place is not held until you register.',
    ],
    facts: coordinates(d),
    cta: 'Register',
    link: d.link,
  }),

  // Not in EML-01, and deliberately so — see event-email's note on the kind.
  // A hosting credit does not itself assign event-management permissions.
  cohost: (p, d) => ({
    subject: `You are hosting ${d.title}`,
    body: [
      `Hello ${p.first},`,
      d.host
        ? `${d.host} has asked you to host ${d.title} with them.`
        : `You have been asked to host ${d.title}.`,
      'You are listed as a host. The event manager can separately give you access to manage this event.',
    ],
    facts: coordinates(d),
    cta: 'Open the event',
    link: d.link,
  }),

  // EML-03/04. The organiser's own explanation sits above, and what actually
  // changed is listed below it as facts, so a vague note cannot obscure a new
  // start time or a new address.
  update: (p, d, m) => ({
    subject: m.subject ?? `${d.title} has changed`,
    body: [
      `Hello ${p.first},`,
      ...(m.body ? [m.body] : [`Something about ${d.title} has changed.`]),
      'Your place still stands — nothing is needed from you.',
    ],
    facts: [...changedFacts(m), ...coordinates(d), ...(d.instructions ? [['Instructions', d.instructions] as [string, string]] : [])],
    cta: 'See the event',
    link: d.link,
  }),

  cancelled: (p, d, m) => ({
    subject: `${d.title} is not happening`,
    body: [
      `Hello ${p.first},`,
      `${d.title}, which was to be ${d.when}, has been cancelled.`,
      ...(m.body ? [m.body] : []),
      // Deliberately does not promise a refund. Whether money comes back, and
      // when, is the refund message's job and nothing here should pre-empt it.
      d.host
        ? `If you paid for a ticket, ${d.host} will be in touch about it separately.`
        : 'If you paid for a ticket, the host will be in touch about it separately.',
    ],
    facts: coordinates(d),
    cta: '',
    link: null,
  }),

  attendee_cancelled: (p, d) => ({
    subject: `Your place at ${d.title} is cancelled`,
    body: [
      `Hello ${p.first},`,
      `You are no longer registered for ${d.title} and your place has been released.`,
      'If you paid, any refund is handled separately and you will hear about it on its own.',
      'You can register again while there are places left.',
    ],
    facts: coordinates(d),
    cta: 'See the event',
    link: d.link,
  }),

  // Same rule as payment, and BUY-08: never the word "refunded" until the
  // refund actually completed. A refund comes back out of whichever account
  // took the money, which is not necessarily Amazing's, so nothing here says
  // who is returning it.
  refund: (p, d) => ({
    subject: `${p.refundState ?? 'Refund update'} — ${d.title}`,
    body: [
      `Hello ${p.first},`,
      p.refundState === 'Refunded'
        ? `The refund for your ticket to ${d.title} is complete and on its way back to the card you paid with. Banks usually take a few days to show it.`
        : `Here is where the refund for your ticket to ${d.title} stands.`,
      d.host
        ? `${d.title} is hosted by ${d.host}. Anything further about the money goes to them.`
        : 'Anything further about the money goes to the event host.',
    ],
    facts: [
      ['Status', p.refundState ?? 'Refund requested'],
      ...(p.refunded ? ([['Amount', p.refunded]] as [string, string][]) : []),
      ['Event', d.title],
      ...(d.host ? ([['Hosted by', d.host]] as [string, string][]) : []),
    ],
    cta: 'See your orders',
    link: `${SITE}/events/mine`,
  }),

  // FDB-03 / EML-09. This says feedback is open and how to give it. It never
  // says what anyone wrote, how anyone was rated, or whether anyone answered.
  // Nothing readable from this email exposes a single submitted answer.
  feedback_open: (p, d) => ({
    subject: `How was ${d.title}?`,
    body: [
      `Hello ${p.first},`,
      `${d.title} has finished. Feedback is now open.`,
      'You will be asked about the event itself, and about the people you met. It takes a couple of minutes, and answers are never shown to the people they are about.',
    ],
    facts: [['Event', d.title], ['When it was', d.when]],
    cta: 'Give feedback',
    link: d.feedbackLink,
  }),
}

/** EML-04. What changed, named, one line each. */
function changedFacts(m: MessageRow): [string, string][] {
  const labels: Record<string, string> = {
    title: 'Name',
    starts_at: 'New start',
    ends_at: 'New end',
    timezone: 'Timezone',
    venue_name: 'Venue',
    address: 'Address',
    location: 'Where',
    attendee_instructions: 'Joining instructions',
    refund_terms: 'Refund terms',
  }
  return Object.entries(m.changed_details ?? {}).map(([key, change]) => {
    const to = change?.to == null || change.to === '' ? 'removed' : String(change.to)
    const from = change?.from == null || change.from === '' ? null : String(change.from)
    return [labels[key] ?? key, from ? `${to} (was ${from})` : to] as [string, string]
  })
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                                */
/* -------------------------------------------------------------------------- */

function render(copy: Copy, to: string) {
  const factLines = copy.facts.map(([label, value]) => `${label}: ${value}`)
  const text = [
    ...copy.body,
    ...(factLines.length ? ['', ...factLines] : []),
    ...(copy.link ? ['', copy.link] : []),
    '',
    '— Amazing AI',
    '',
  ].join('\n\n')

  return {
    payload: {
      from: FROM,
      // One message per person. Never a shared To, never a Cc — EML-05.
      to,
      subject: copy.subject,
      text,
      html: shell(copy.body, copy.facts, copy.link, copy.cta),
    },
  }
}

/** The same envelope every other message from here arrives in. */
function shell(
  paragraphs: string[],
  facts: [string, string][],
  link: string | null,
  cta: string,
): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 18px;">${escapeHtml(p)}</p>`)
    .join('\n        ')

  const table = facts.length
    ? `<table role="presentation" style="margin:0 0 28px;border-collapse:collapse;font-size:14px;">
          ${facts
            .map(
              ([label, value]) =>
                `<tr><td style="padding:4px 16px 4px 0;color:#6f6f68;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:4px 0;">${escapeHtml(value)}</td></tr>`,
            )
            .join('\n          ')}
        </table>`
    : ''

  const button =
    link && cta
      ? `<p style="margin:0 0 28px;">
          <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;background:#2f2f2c;color:#faf9f7;text-decoration:none;font-size:14px;">${escapeHtml(cta)}</a>
        </p>`
      : ''

  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#faf9f7;font-family:Georgia,'Times New Roman',serif;color:#2f2f2c;">
    <table role="presentation" style="max-width:520px;margin:0 auto;border-collapse:collapse;">
      <tr><td style="padding-bottom:28px;">
        <span style="font-size:20px;font-weight:700;letter-spacing:-0.03em;text-transform:uppercase;">Amazing<span style="color:#b08d3f;">.</span></span>
      </td></tr>
      <tr><td style="font-size:15px;line-height:1.65;">
        ${body}
        ${table}
        ${button}
        <p style="margin:0;color:#6f6f68;font-size:13px;">&mdash; Amazing AI</p>
      </td></tr>
    </table>
  </body>
</html>
`
}

/**
 * EVT-02. An event happens in its own timezone, not the reader's, and the
 * zone is named so somebody abroad can do the arithmetic. Mirrors eventWhen()
 * in src/lib/events.ts — an edge function cannot import from src.
 */
function formatWhen(event: EventRow): string {
  const tz = event.timezone || 'Europe/London'
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz,
  })
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  })
  const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short', timeZone: tz })
    .formatToParts(new Date(event.starts_at))
    .find((p) => p.type === 'timeZoneName')?.value

  const start = new Date(event.starts_at)
  const opening = `${date.format(start)}, ${time.format(start)}`
  if (!event.ends_at) return `${opening} (${zone})`

  const end = new Date(event.ends_at)
  return date.format(end) === date.format(start)
    ? `${opening} to ${time.format(end)} (${zone})`
    : `${opening} until ${date.format(end)}, ${time.format(end)} (${zone})`
}

/** Titles, venues, organisers' notes — all typed by members. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers':
        'authorization, x-client-info, apikey, content-type, x-mailer-secret',
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Self-check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three decisions in this file that quietly send the wrong email if they
 * break: who is still eligible, whether a reminder has gone stale, and
 * whether the claim is conditional. All three are pure, so they are checked
 * without a database and without Resend.
 *
 *   deno run -A supabase/functions/event-mailer/index.ts --check
 */
function demo(): void {
  const ok = (claim: boolean, what: string) => {
    if (!claim) throw new Error(`FAILED: ${what}`)
    console.log(`  ok  ${what}`)
  }

  // ---- EML-07: a cancelled registration stops receiving ---------------------

  const pending: RecipientRow[] = [
    { id: 'r1', profile_id: 'still-coming', email: 'a@example.com', status: 'scheduled' },
    { id: 'r2', profile_id: 'cancelled', email: 'b@example.com', status: 'scheduled' },
    { id: 'r3', profile_id: 'suspended', email: 'c@example.com', status: 'scheduled' },
    { id: 'r4', profile_id: 'retry', email: 'd@example.com', status: 'failed' },
  ]
  const profiles = new Map([
    ['still-coming', { email: 'a@example.com', full_name: 'Ada Lovelace', profile_status: 'active' }],
    ['cancelled', { email: 'b@example.com', full_name: 'Bo Nolan', profile_status: 'active' }],
    ['suspended', { email: 'c@example.com', full_name: 'Cy Marsh', profile_status: 'suspended' }],
    ['retry', { email: 'd@example.com', full_name: 'Dee Okafor', profile_status: 'active' }],
  ])
  // Only the confirmed registrations come back from the re-check query.
  const registered = new Map([
    ['still-coming', 'confirmed'],
    ['retry', 'confirmed'],
  ])

  const audience = split(pending, profiles, registered)
  const got = audience.eligible.map((e) => e.profile_id).sort()
  ok(
    JSON.stringify(got) === JSON.stringify(['retry', 'still-coming']),
    'EML-07 a cancelled registration is dropped at send time, not emailed',
  )
  ok(
    audience.dropped.some((d) => d.id === 'r2' && d.reason.includes('registered')),
    'EML-07 the drop says why',
  )
  ok(
    audience.dropped.some((d) => d.id === 'r3'),
    'a suspended account is never written to',
  )
  ok(
    audience.eligible.some((e) => e.id === 'r4'),
    'EML-08 a retry picks the previously failed recipient back up',
  )
  ok(
    audience.eligible.find((e) => e.id === 'r1')?.first === 'Ada',
    'the greeting uses the first name',
  )

  // A payment or a refund is about one person and is not re-checked against a
  // registration — they are told about their own money either way.
  ok(
    split(pending, profiles, null).eligible.length === 3,
    'EML-09 money messages do not require a live registration',
  )

  // FDB-06. feedback_open is checked against attendance, not a ticket. Here
  // only one of the two live registrations actually turned up.
  const attended = split(
    pending,
    profiles,
    new Map([['still-coming', 'attended']]),
    'No verified attendance at this event.',
  )
  ok(
    attended.eligible.length === 1 && attended.eligible[0].profile_id === 'still-coming',
    'FDB-06 a registered no-show is not sent the feedback request',
  )
  ok(
    attended.dropped.some((d) => d.id === 'r4' && d.reason.includes('attendance')),
    'FDB-06 the drop says attendance, not registration',
  )

  // ---- EML-06: a reminder whose moment has passed --------------------------

  const event: EventRow = {
    id: 'e1',
    host_id: 'h1',
    title: 'Dinner',
    slug: 'dinner',
    description: null,
    location: 'The Hoxton',
    venue_name: null,
    address: null,
    attendee_instructions: null,
    starts_at: '2026-03-12T19:00:00Z',
    ends_at: '2026-03-12T22:00:00Z',
    timezone: 'Europe/London',
    status: 'published',
    currency: 'gbp',
  }
  const reminder = { id: 'm1', event_id: 'e1', kind: 'reminder', reminder_id: 'r1' } as MessageRow

  ok(
    skipReason({ ...reminder, kind: 'feedback_open' }, { ...event, feedback_opens_after_minutes: 120 }, new Date('2026-03-12T23:00:00Z')) !== null,
    'FDB-15 feedback waits for the configured delay, not just the event end',
  )
  ok(
    skipReason({ ...reminder, kind: 'update', changed_details: { address: { from: 'Old', to: 'Stale' } } }, { ...event, address: 'Latest' }, new Date('2026-03-12T18:00:00Z')) !== null,
    'EML-04 a queued update with outdated saved details is not sent',
  )

  ok(
    skipReason(reminder, event, new Date('2026-03-12T18:00:00Z')) === null,
    'EML-06 a reminder an hour before the event is sent',
  )
  ok(
    skipReason({ ...reminder, reminder_id: null }, event, new Date('2026-03-12T18:00:00Z')) !== null,
    'a reminder whose time was removed is skipped, not sent',
  )
  ok(
    skipReason(reminder, event, new Date('2026-03-12T19:30:00Z')) !== null,
    'EML-06 a reminder for an event that already started is skipped, not sent late',
  )
  ok(
    skipReason(reminder, { ...event, status: 'cancelled' }, new Date('2026-03-12T18:00:00Z')) !== null,
    'EML-06 a reminder for a cancelled event is skipped',
  )
  ok(
    skipReason(
      { ...reminder, kind: 'cancelled' },
      { ...event, status: 'cancelled' },
      new Date('2026-03-12T18:00:00Z'),
    ) === null,
    'the cancellation notice itself still goes out',
  )
  ok(
    skipReason(
      { ...reminder, kind: 'feedback_open' },
      event,
      new Date('2026-03-12T20:00:00Z'),
    ) !== null,
    'EML-06 feedback_open waits when the end time moved later',
  )

  // ---- EML-06: the claim is conditional ------------------------------------

  ok(
    CLAIM_FROM.length === 1 && CLAIM_FROM[0] === 'scheduled',
    'EML-06 a sweep only ever takes a message out of scheduled',
  )
  ok(
    !CLAIM_FROM.includes('failed' as never) && RETRY_FROM.includes('failed'),
    'EML-08 only a named message is re-opened from failed, never the whole sweep',
  )

  // ---- FDB-03 / EML-09: no feedback content in the feedback email ----------

  const detail = describe(event, 'Mona Kessler')
  const feedback = WRITE.feedback_open({ first: 'Ada' }, detail, {
    id: 'm2',
    event_id: 'e1',
    kind: 'feedback_open',
    body: 'Someone wrote that Ada was brilliant',
    subject: null,
    scheduled_for: null,
    changed_details: null,
    reminder_id: null,
  })
  const wholeEmail = JSON.stringify(feedback).toLowerCase()
  ok(
    !wholeEmail.includes('brilliant'),
    'FDB-03 the feedback email carries no submitted feedback, not even from the message body',
  )
  ok(feedback.link === detail.feedbackLink, 'FDB-03 it says how to give feedback')

  // ---- EML-10: the organiser's words never replace the facts ---------------

  const update = WRITE.update({ first: 'Ada' }, detail, {
    id: 'm3',
    event_id: 'e1',
    kind: 'update',
    subject: 'A small change',
    body: 'Sorry, we had to shuffle things a bit.',
    scheduled_for: null,
    changed_details: { venue_name: { from: 'The Standard', to: 'The Hoxton' } },
    reminder_id: null,
  })
  ok(
    update.facts.some(([l, v]) => l === 'Venue' && v === 'The Hoxton (was The Standard)'),
    'EML-04 the update names what changed, from and to',
  )
  ok(
    update.facts.some(([l]) => l === 'When'),
    'EML-10 the current time is stated whatever the organiser wrote',
  )

  // ---- a message that arrives with no recipients ---------------------------
  //
  // The one this file got wrong. schedule_event_messages() writes the
  // event_messages row in SQL and nothing in SQL writes recipients, so every
  // reminder and every feedback_open reached the dispatcher with an empty
  // recipient set — and was marked 'sent'. The organiser's history said the
  // reminder went out. It never did.
  //
  // Every fixture above supplies recipients, which is exactly why none of
  // them caught it.

  ok(
    planFor('reminder', 0) === 'resolve',
    'a reminder with no recipients resolves an audience — it is never called sent',
  )
  ok(
    planFor('feedback_open', 0) === 'resolve',
    'a feedback request with no recipients resolves an audience',
  )
  ok(
    (['reminder', 'feedback_open', 'update', 'cancelled', 'invite'] as MessageKind[]).every(
      (kind) => planFor(kind, 0) !== 'send',
    ),
    'no event-wide kind is ever dispatched as done on an empty recipient set',
  )
  ok(
    planFor('reminder', 3) === 'send',
    'a reminder that has recipients is dispatched, not resolved again',
  )
  ok(
    planFor('confirmation', 0) === 'unresolvable' && planFor('cohost', 0) === 'unresolvable',
    'a message about one named person cannot be resolved from the event alone',
  )
  ok(
    (['confirmation', 'payment', 'refund', 'attendee_cancelled', 'cohost'] as MessageKind[]).every(
      (kind) => planFor(kind, 0) !== 'send',
    ),
    'and is reported as a fault rather than quietly marked sent',
  )

  // ---- cohost: restored pre-existing behaviour -----------------------------

  const cohost = WRITE.cohost({ first: 'Ada' }, detail, {
    ...({ id: 'm5', event_id: 'e1', kind: 'cohost', subject: null, body: null,
      scheduled_for: null, changed_details: null } as MessageRow),
  })
  ok(
    cohost.subject === 'You are hosting Dinner' &&
      cohost.body.some((line) => line.includes('Mona Kessler has asked you to host')),
    'a new cohost is told they are hosting, and by whom',
  )
  ok(
    cohost.link === detail.link,
    'a named cohost receives the event page without a promise of management access',
  )

  // Removed as a cohost before the message went out — EML-07 covers this the
  // same way it covers a cancelled registration.
  const stillHosting = split(
    pending,
    profiles,
    new Map([['still-coming', 'hosting']]),
    'No longer a host of this event.',
  )
  ok(
    stillHosting.eligible.length === 1 &&
      stillHosting.dropped.some((d) => d.reason.includes('host')),
    'EML-07 somebody removed as a cohost is not told they are hosting',
  )

  // ---- CONTRACT §7.0: the money emails do not name the wrong party ---------

  const paid = { first: 'Ada', paid: '£40.00', refundState: 'Refunded', refunded: '£40.00' }
  const stub = { id: 'm4', event_id: 'e1', kind: 'payment', subject: null, body: null, scheduled_for: null, changed_details: null } as MessageRow
  for (const kind of ['payment', 'refund'] as const) {
    const copy = WRITE[kind](paid, detail, { ...stub, kind })
    const prose = copy.body.join(' ')
    ok(
      !/\b(we|us|our|amazing)\b/i.test(prose.replace('— Amazing AI', '')),
      `${kind} does not claim Amazing took or returned the money`,
    )
    ok(
      copy.facts.some(([l, v]) => l === 'Hosted by' && v === 'Mona Kessler') &&
        copy.facts.some(([l]) => l === 'Event'),
      `${kind} names the event and its host`,
    )
  }

  console.log('\nevent-mailer: all checks passed.')
}

if (Deno.args.includes('--check')) {
  demo()
} else {
  Deno.serve(handle)
}
