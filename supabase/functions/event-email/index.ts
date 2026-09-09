// ============================================================================
// event-email — the five messages an event sends
//
//   invited    a host put you on the list
//   cohost     a host asked you to run it with them
//   updated    the time, the place or the name of it changed
//   cancelled  it is not happening
//   rsvp       somebody is coming, told to every host
//
// Why this is an edge function and not four lines in Events.tsx:
//
//   member_directory deliberately has no email column — that is what keeps
//   one member's address out of another member's hands. So the addresses can
//   only be read with the service role, which must never reach a browser.
//   The caller's own token answers "who is asking", exactly as invite-email
//   does, and the service role does the reading.
//
// Who may send what:
//
//   invited, cohost, updated and cancelled are host business, so the caller
//   has to host the event. rsvp is the one a guest triggers about themselves,
//   so the caller has to be somebody with a 'going' row on that event — it
//   sends to the hosts and to nobody else, and says only that they are
//   coming, which the hosts can already see.
//
// Order matters for one of them: cancelled has to be sent before the event is
// deleted, because the delete cascades the guest list away with it.
//
// Deploy:  supabase functions deploy event-email
// Secrets: supabase secrets set RESEND_API_KEY=re_...
//          supabase secrets set SITE_URL=https://goamazing.ai   (optional)
//          supabase secrets set EVENT_TZ=Europe/London          (optional)
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const FROM = 'Amazing AI <noreply@goamazing.ai>'
const SITE = (Deno.env.get('SITE_URL') ?? 'https://goamazing.ai').replace(/\/+$/, '')

// Everyone reads the same times, so they are written in the network's own
// timezone rather than the sender's. Set EVENT_TZ if the network moves.
const TZ = Deno.env.get('EVENT_TZ') ?? 'Europe/London'

/** Resend takes 100 per batch call. */
const BATCH = 100

type Kind = 'invited' | 'cohost' | 'updated' | 'cancelled' | 'rsvp'
const KINDS: Kind[] = ['invited', 'cohost', 'updated', 'cancelled', 'rsvp']

interface Recipient {
  email: string
  full_name: string
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'RESEND_API_KEY is not set.' }, 500)

  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in first.' }, 401)

  let kind = '' as Kind
  let eventId = ''
  let profileId = ''
  try {
    const body = await request.json()
    kind = String(body?.kind ?? '') as Kind
    eventId = String(body?.event_id ?? '').trim()
    profileId = String(body?.profile_id ?? '').trim()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (!KINDS.includes(kind)) return json({ error: 'Unknown kind.' }, 400)
  if (!eventId) return json({ error: 'An event is required.' }, 400)
  if (kind === 'cohost' && !profileId) {
    return json({ error: 'A recipient is required.' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData } = await asCaller.auth.getUser()
  const me = userData?.user?.id
  if (!me) return json({ error: 'Sign in first.' }, 401)

  const { data: event } = await db
    .from('events')
    .select('id, host_id, title, description, location, starts_at, ends_at')
    .eq('id', eventId)
    .maybeSingle()
  if (!event) return json({ error: 'That event does not exist.' }, 404)

  // ---- may the caller send this ------------------------------------------

  if (kind === 'rsvp') {
    const { data: mine } = await db
      .from('event_invitations')
      .select('status')
      .eq('event_id', eventId)
      .eq('profile_id', me)
      .maybeSingle()
    if (mine?.status !== 'going') {
      return json({ error: 'That is not yours to send.' }, 403)
    }
  } else {
    const [{ data: hosts }, { data: isAdmin }] = await Promise.all([
      asCaller.rpc('hosts_event', { p_event: eventId }),
      asCaller.rpc('is_admin'),
    ])
    if (!hosts && !isAdmin) return json({ error: 'That is not yours to send.' }, 403)
  }

  // ---- who hears it -------------------------------------------------------

  const hostIds = await allHostIds(db, eventId)
  let recipientIds: string[] = []

  switch (kind) {
    case 'invited': {
      // With a profile_id it is one person being added to an existing event.
      // Without one it is everybody currently sitting at 'invited', which is
      // how a newly created event mails its whole guest list in one call
      // rather than one invocation per guest.
      const query = db
        .from('event_invitations')
        .select('profile_id')
        .eq('event_id', eventId)
        .eq('status', 'invited')
      const { data: rows } = profileId ? await query.eq('profile_id', profileId) : await query

      // Only people actually on the list, so this can never be used to mail a
      // member who was never invited.
      if (profileId && (rows ?? []).length === 0) {
        return json({ error: 'They are not on the list.' }, 409)
      }
      recipientIds = (rows ?? [])
        .map((r) => r.profile_id as string)
        .filter((id) => !hostIds.includes(id))
      break
    }
    case 'cohost': {
      const { data: row } = await db
        .from('event_hosts')
        .select('profile_id')
        .eq('event_id', eventId)
        .eq('profile_id', profileId)
        .maybeSingle()
      if (!row) return json({ error: 'They do not host that event.' }, 409)
      recipientIds = [profileId]
      break
    }
    case 'updated':
    case 'cancelled': {
      // Everyone with a live answer. Somebody who already said no is left
      // alone, and the hosts are not told what they just did themselves.
      const { data: rows } = await db
        .from('event_invitations')
        .select('profile_id')
        .eq('event_id', eventId)
        .in('status', ['invited', 'going'])
      recipientIds = (rows ?? [])
        .map((r) => r.profile_id as string)
        .filter((id) => !hostIds.includes(id))
      break
    }
    case 'rsvp':
      recipientIds = hostIds.filter((id) => id !== me)
      break
  }

  if (recipientIds.length === 0) return json({ sent: 0 }, 200)

  const recipients = await addressesFor(db, recipientIds)
  if (recipients.length === 0) return json({ sent: 0 }, 200)

  // ---- the one name that appears inside the message -----------------------

  const actorId = kind === 'rsvp' ? me : event.host_id
  const { data: actor } = await db
    .from('profiles')
    .select('full_name')
    .eq('id', actorId)
    .maybeSingle()
  const actorName = String(actor?.full_name ?? 'Someone')

  // ---- send ---------------------------------------------------------------

  const link = `${SITE}/events?event=${encodeURIComponent(eventId)}`
  const when = formatWhen(event.starts_at as string, event.ends_at as string | null)
  const detail = { title: String(event.title), when, location: event.location as string | null, link }

  const messages = recipients.map((person) => {
    const first = person.full_name.split(' ')[0] || 'there'
    const copy = WRITE[kind](first, actorName, detail)
    return {
      from: FROM,
      to: person.email,
      subject: copy.subject,
      text: copy.text,
      html: shell(copy.body, kind === 'cancelled' ? null : link, copy.cta),
    }
  })

  let sent = 0
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH)
    const response = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chunk),
    })
    if (!response.ok) {
      // Say how far it got. The caller has already made the change in the
      // database; a failed send is worth reporting but never worth undoing
      // an event that was correctly created, edited or cancelled.
      return json({ error: `Resend refused it: ${await response.text()}`, sent }, 502)
    }
    sent += chunk.length
  }

  return json({ sent }, 200)
})

/* -------------------------------------------------------------------------- */
/* Reading people                                                              */
/* -------------------------------------------------------------------------- */

async function allHostIds(
  db: ReturnType<typeof createClient>,
  eventId: string,
): Promise<string[]> {
  const { data } = await db.rpc('event_host_ids', { p_event: eventId })
  return ((data ?? []) as { profile_id: string }[]).map((r) => r.profile_id)
}

/** Addresses live on profiles, which is why this runs with the service role. */
async function addressesFor(
  db: ReturnType<typeof createClient>,
  ids: string[],
): Promise<Recipient[]> {
  const { data } = await db
    .from('profiles')
    .select('email, full_name')
    .in('id', ids)
    // Somebody suspended or removed is not written to.
    .eq('profile_status', 'active')
  return ((data ?? []) as { email: string | null; full_name: string | null }[])
    .filter((p): p is { email: string; full_name: string | null } => Boolean(p.email))
    .map((p) => ({ email: p.email, full_name: String(p.full_name ?? '') }))
}

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

interface Detail {
  title: string
  when: string
  location: string | null
  link: string
}

interface Copy {
  subject: string
  /** Paragraphs. Plain text; the shell escapes them for the HTML version. */
  body: string[]
  cta: string
  text: string
}

/** Where and when, written once. */
function place(d: Detail): string {
  return d.location ? `${d.when} at ${d.location}` : d.when
}

const WRITE: Record<Kind, (first: string, actor: string, d: Detail) => Copy> = {
  invited: (first, actor, d) => ({
    subject: `${actor} invited you to ${d.title}`,
    body: [
      `Hello ${first},`,
      `${actor} has put you on the list for ${d.title}.`,
      place(d) + '.',
      'Let them know whether you are coming.',
    ],
    cta: 'See the event',
    text: `Hello ${first},

${actor} has put you on the list for ${d.title}.

${place(d)}.

Let them know whether you are coming:
${d.link}

— Amazing AI
`,
  }),

  cohost: (first, actor, d) => ({
    subject: `You are hosting ${d.title}`,
    body: [
      `Hello ${first},`,
      `${actor} has asked you to host ${d.title} with them.`,
      place(d) + '.',
      'You can edit it, invite people and see who is coming, the same as they can.',
    ],
    cta: 'Open the event',
    text: `Hello ${first},

${actor} has asked you to host ${d.title} with them.

${place(d)}.

You can edit it, invite people and see who is coming, the same as they can:
${d.link}

— Amazing AI
`,
  }),

  updated: (first, _actor, d) => ({
    subject: `${d.title} has changed`,
    body: [
      `Hello ${first},`,
      `Something about ${d.title} has changed. It is now:`,
      place(d) + '.',
      'Nothing is needed from you — your answer still stands.',
    ],
    cta: 'See what changed',
    text: `Hello ${first},

Something about ${d.title} has changed. It is now:

${place(d)}.

Nothing is needed from you — your answer still stands. The full details:
${d.link}

— Amazing AI
`,
  }),

  cancelled: (first, actor, d) => ({
    subject: `${d.title} is not happening`,
    body: [
      `Hello ${first},`,
      `${actor} has cancelled ${d.title}, which was to be ${place(d)}.`,
      'There is nothing you need to do. Sorry for the change of plan.',
    ],
    cta: '',
    text: `Hello ${first},

${actor} has cancelled ${d.title}, which was to be ${place(d)}.

There is nothing you need to do. Sorry for the change of plan.

— Amazing AI
`,
  }),

  rsvp: (first, actor, d) => ({
    subject: `${actor} is coming to ${d.title}`,
    body: [
      `Hello ${first},`,
      `${actor} has said they are coming to ${d.title}, ${place(d)}.`,
    ],
    cta: 'See who is coming',
    text: `Hello ${first},

${actor} has said they are coming to ${d.title}, ${place(d)}.

${d.link}

— Amazing AI
`,
  }),
}

/** The same envelope every other message from here arrives in. */
function shell(paragraphs: string[], link: string | null, cta: string): string {
  const body = paragraphs
    .map(
      (p, i) =>
        `<p style="margin:0 0 ${i === paragraphs.length - 1 ? 28 : 18}px;">${escapeHtml(p)}</p>`,
    )
    .join('\n        ')

  const button =
    link && cta
      ? `<p style="margin:0 0 28px;">
          <a href="${link}" style="display:inline-block;padding:12px 22px;background:#2f2f2c;color:#faf9f7;text-decoration:none;font-size:14px;">${escapeHtml(cta)}</a>
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
        ${button}
        <p style="margin:0;color:#6f6f68;font-size:13px;">&mdash; Amazing AI</p>
      </td></tr>
    </table>
  </body>
</html>
`
}

/** "Thursday 12 March, 7:00 pm" — and the end time when there is one. */
function formatWhen(startsAt: string, endsAt: string | null): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  })
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  })

  const start = new Date(startsAt)
  const opening = `${date.format(start)}, ${time.format(start)}`
  if (!endsAt) return opening

  const end = new Date(endsAt)
  // Same day reads as a range; a different day gets written out in full.
  return date.format(end) === date.format(start)
    ? `${opening} to ${time.format(end)}`
    : `${opening} until ${date.format(end)}, ${time.format(end)}`
}

/** Titles, locations and names are all typed by members. */
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
        'authorization, x-client-info, apikey, content-type',
    },
  })
}
