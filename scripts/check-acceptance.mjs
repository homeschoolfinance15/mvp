/**
 * §11 acceptance run against the live database.
 *
 * Everything that can be proven without Stripe keys or a mail server. It
 * creates its own people and its own event, exercises the rules through
 * ordinary user tokens so row level security is actually under test, and
 * deletes everything it made on the way out — including on failure.
 *
 * Service role is used for two things only: making the fixtures, and cleaning
 * them up. Every assertion goes through an anon or user token, because the
 * service role bypasses RLS and would prove nothing.
 */

const URL = process.env.SB_URL
const SERVICE = process.env.SB_SERVICE
const PUB = process.env.SB_PUB
const TAG = `acc-${Date.now()}`
const PW = `Accept-${Date.now()}-Aa1!`

let pass = 0, fail = 0
const failures = []
const made = { users: [], events: [] }

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const svc = (p, o = {}) => fetch(`${URL}/rest/v1/${p}`, {
  ...o,
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(o.headers || {}) },
})
const as = (tok, p, o = {}) => fetch(`${URL}/rest/v1/${p}`, {
  ...o,
  headers: { apikey: PUB, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(o.headers || {}) },
})
const anon = (p, o = {}) => fetch(`${URL}/rest/v1/${p}`, {
  ...o, headers: { apikey: PUB, 'Content-Type': 'application/json', ...(o.headers || {}) },
})

/**
 * Writing feedback must not ask for the row back.
 *
 * FDB-09 makes the feedback tables admin-only on select, so an author
 * genuinely cannot read what they just wrote — `INSERT ... RETURNING` is
 * refused with the same 42501 an RLS failure gives, which makes a successful
 * write look like a permission bug. supabase-js already sends return=minimal
 * for an insert with no .select(), so the app is right; the test has to match.
 */
const write = (tok, p, body) => as(tok, p, {
  method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'return=minimal' },
})

/**
 * Role must be set at creation. A service-role PATCH of profiles.role is
 * silently reverted by protect_profile_fields — auth.uid() is null for the
 * service key, so it is not an admin, so role is pinned. It returns 200 and
 * changes nothing, which is correct behaviour and a trap for fixtures.
 */
async function makeUser(label, name, role = 'user') {
  const email = `${TAG}-${label}@acceptance.invalid`
  const r = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, email_confirm: true }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`could not create ${label}: ${JSON.stringify(u).slice(0, 200)}`)
  made.users.push(u.id)
  // current_profession is what onboarding_complete() reads, and BUY-01 is
  // enforced server-side in register_free and stripe-checkout. Without it
  // every registration is correctly refused.
  await svc('profiles', { method: 'POST', body: JSON.stringify({ id: u.id, full_name: name, email, role, profile_status: 'active', current_profession: 'Acceptance Tester' }) })
  const t = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  }).then(r => r.json())
  return { id: u.id, email, token: t.access_token }
}

/**
 * An event-only account, made the way ACC-01 makes one: an auth user with no
 * invitation, who then calls create_event_account() for themselves. No
 * connector_user_links row, network_member false.
 */
async function makeAccountOnly(label, name) {
  const email = `${TAG}-${label}@acceptance.invalid`
  const u = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, email_confirm: true }),
  }).then(r => r.json())
  if (!u.id) throw new Error(`could not create ${label}`)
  made.users.push(u.id)
  const t = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  }).then(r => r.json())
  const r = await as(t.access_token, 'rpc/create_event_account', {
    method: 'POST', body: JSON.stringify({ p_full_name: name }),
  })
  if (!r.ok) throw new Error(`create_event_account failed: ${r.status} ${(await r.text()).slice(0, 160)}`)
  // They finish required onboarding for themselves, as ACC-01 says they must
  // before registering. Their own row, so their own token does it.
  await as(t.access_token, `profiles?id=eq.${u.id}`, {
    method: 'PATCH', body: JSON.stringify({ current_profession: 'Acceptance Attendee' }),
  })
  return { id: u.id, email, token: t.access_token }
}

async function cleanup() {
  for (const id of made.events) await svc(`events?id=eq.${id}`, { method: 'DELETE' })
  for (const id of made.users) {
    await fetch(`${URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    })
  }
}

async function main() {
  console.log(`\n§11 acceptance — live database, tag ${TAG}\n`)

  // ---- fixtures ----------------------------------------------------------
  const host = await makeUser('host', 'Acceptance Host', 'connector')
  const guest1 = await makeUser('g1', 'Acceptance Guest One')
  const admin = await makeUser('adm', 'Acceptance Admin', 'admin')
  // host becomes a connector; permission deliberately left OFF
  const conn = await svc('connectors', { method: 'POST', body: JSON.stringify({ profile_id: host.id }) }).then(r => r.json())
  const connectorId = conn[0]?.id

  // The event-only account has to be made the way the product makes one.
  // network_member is pinned by protect_profile_fields exactly as role is, so
  // a service-role PATCH reports 200 and changes nothing — create_event_account()
  // is the only thing that may write false (ACC-01, ACC-02).
  const eventOnly = await makeAccountOnly('eo', 'Acceptance Event Only')
  const eoRow = await svc(`profiles?id=eq.${eventOnly.id}&select=network_member`).then(r => r.json())
  ok('ACC-01 an event-only signup is not a network member',
    eoRow[0]?.network_member === false, `network_member=${eoRow[0]?.network_member}`)

  console.log('— accounts and hosting permission —')

  ok('ORG-01A connector event permission starts off',
    conn[0]?.can_create_events === false, `got ${conn[0]?.can_create_events}`)

  // ACC-04 / §11 "Ordinary account holder tries to create or publish an event"
  let r = await as(guest1.token, 'events', {
    method: 'POST', body: JSON.stringify({ host_id: guest1.id, title: 'Should not exist', starts_at: new Date(Date.now() + 864e5).toISOString() }),
  })
  ok('ACC-04 ordinary account holder cannot create an event', r.status === 401 || r.status === 403, `HTTP ${r.status}`)

  // §11 "Connector with event-creation permission switched off"
  r = await as(host.token, 'events', {
    method: 'POST', body: JSON.stringify({ host_id: host.id, title: 'Should not exist', starts_at: new Date(Date.now() + 864e5).toISOString() }),
  })
  ok('ORG-01A connector with permission OFF cannot create an event', r.status === 401 || r.status === 403, `HTTP ${r.status}`)

  // switch it on
  await svc(`connectors?id=eq.${connectorId}`, { method: 'PATCH', body: JSON.stringify({ can_create_events: true }) })
  const starts = new Date(Date.now() + 864e5).toISOString()
  r = await as(host.token, 'events', {
    method: 'POST',
    body: JSON.stringify({ host_id: host.id, title: `${TAG} dinner`, starts_at: starts, ends_at: new Date(Date.now() + 9e7).toISOString(), capacity: 1, timezone: 'Europe/London' }),
  })
  const ev = (await r.json())[0]
  if (ev?.id) made.events.push(ev.id)
  ok('ORG-01A connector with permission ON can create an event', !!ev?.id, `HTTP ${r.status}`)

  // §11 "Connector's permission is switched off again"
  await svc(`connectors?id=eq.${connectorId}`, { method: 'PATCH', body: JSON.stringify({ can_create_events: false }) })
  r = await as(host.token, `events?id=eq.${ev.id}`, { method: 'PATCH', body: JSON.stringify({ description: 'still mine to manage' }) })
  ok('ORG-01C permission off still allows managing an existing event', r.status === 200, `HTTP ${r.status}`)
  await svc(`connectors?id=eq.${connectorId}`, { method: 'PATCH', body: JSON.stringify({ can_create_events: true }) })

  console.log('\n— discovery and publication —')

  // ORG-02 a draft is not discoverable
  let seen = await anon(`events?id=eq.${ev.id}&select=id`).then(r => r.json())
  ok('ORG-02 a draft is invisible to an anonymous visitor', Array.isArray(seen) && seen.length === 0, JSON.stringify(seen).slice(0, 80))

  // Publish as the host. A service-role PATCH cannot: enforce_event_lifecycle
  // asks may_create_events(auth.uid()) on the first publish, and auth.uid() is
  // null for the service key, so it raises. That gate is ORG-01B working.
  const tt = await svc('ticket_types', {
    method: 'POST', body: JSON.stringify({ event_id: ev.id, name: 'General', price_cents: 0, currency: 'gbp', position: 1, is_active: true }),
  }).then(r => r.json())
  const ticketTypeId = tt[0]?.id

  r = await as(host.token, `events?id=eq.${ev.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) })
  ok('ORG-01B an enabled connector publishes directly, with no approval step',
    r.status === 200, `HTTP ${r.status} ${(await r.clone().text()).slice(0, 90)}`)

  seen = await anon(`event_public?id=eq.${ev.id}&select=id,title,host_names`).then(r => r.json())
  ok('EVT-01 a published event opens for someone with no account', seen.length === 1 && seen[0].title === `${TAG} dinner`)
  ok('EVT-02 the public view names the host without leaking email',
    Array.isArray(seen[0]?.host_names) && seen[0].host_names.length > 0 && !JSON.stringify(seen[0]).includes('@'))

  const avail = await anon(`event_availability?event_id=eq.${ev.id}&select=*`).then(r => r.json())
  ok('EVT-05 availability is readable anonymously', avail.length === 1 && avail[0].state === 'open', JSON.stringify(avail).slice(0, 90))

  console.log('\n— capacity, the last ticket —')

  // §11 "Two people try to claim the final available place"
  const [a, b] = await Promise.all([
    as(guest1.token, 'rpc/register_free', { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_ticket_type: ticketTypeId }) }),
    as(eventOnly.token, 'rpc/register_free', { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_ticket_type: ticketTypeId }) }),
  ])
  const wins = [a.status, b.status].filter(s => s >= 200 && s < 300).length
  const why = wins === 1 ? '' : `statuses ${a.status}/${b.status} — ${(await a.clone().text()).slice(0, 120)} | ${(await b.clone().text()).slice(0, 120)}`
  ok('BUY-05 two people race for the last place: exactly one wins', wins === 1, why)
  ok('BUY-05 the loser is refused in plain words, not a raw error',
    wins !== 1 || /sold out|full|no places|unavailable/i.test(await [a, b].find(x => !x.ok).clone().text()),
    wins === 1 ? `loser said: ${(await [a, b].find(x => !x.ok).clone().text()).slice(0, 120)}` : 'skipped')

  const after = await anon(`event_availability?event_id=eq.${ev.id}&select=state,remaining`).then(r => r.json())
  ok('ORG-03A the event now reads Sold out everywhere', after[0]?.state === 'sold_out', JSON.stringify(after[0]))

  const confirmed = await svc(`event_registrations?event_id=eq.${ev.id}&status=eq.confirmed&select=id,profile_id`).then(r => r.json())
  ok('BUY-02 the winner holds exactly one confirmed place', confirmed.length === 1, `${confirmed.length} confirmed`)

  const winner = confirmed[0]?.profile_id === guest1.id ? guest1 : eventOnly
  const tickets = await svc(`event_tickets?event_id=eq.${ev.id}&select=id,code,profile_id`).then(r => r.json())
  ok('BUY-10 a confirmed place issues exactly one scannable ticket', tickets.length === 1 && (tickets[0].code || '').length >= 32, JSON.stringify(tickets).slice(0, 90))

  // repeat click must not issue a second place
  const again = await as(winner.token, 'rpc/register_free', { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_ticket_type: ticketTypeId }) })
  const stillOne = await svc(`event_registrations?event_id=eq.${ev.id}&status=in.(pending,confirmed)&select=id`).then(r => r.json())
  ok('Individual registration: a repeat click issues no second place', stillOne.length === 1, `${stillOne.length} live, retry HTTP ${again.status}`)

  console.log('\n— the back door (BUY-03, BUY-04) —')

  // Regression for a hole that was live on production. 20260916000012
  // recreated event_registrations_insert to add the BUY-01 onboarding gate and
  // dropped the `status = 'pending'` clause with it, so any onboarded account
  // could write itself a confirmed registration — which issue_ticket_on_confirm
  // turned into a real scannable ticket to a paid event, with no order behind
  // it, consuming a place a paying customer would have had.
  //
  // The first assertion is not the important one. The second is: what matters
  // is that no ticket exists, and a refusal that still left a ticket would
  // pass a policy test and fail a person at a door.
  const paid = await svc('events', {
    method: 'POST',
    body: JSON.stringify({ host_id: admin.id, title: `${TAG} paid gala`, starts_at: starts, status: 'draft', capacity: 20 }),
  }).then(r => r.json())
  if (paid[0]?.id) made.events.push(paid[0].id)
  await svc('ticket_types', {
    method: 'POST',
    body: JSON.stringify({ event_id: paid[0].id, name: 'Full price', price_cents: 15000, currency: 'gbp', position: 1, is_active: true }),
  })
  await as(admin.token, `events?id=eq.${paid[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) })

  r = await as(guest1.token, 'event_registrations', {
    method: 'POST',
    body: JSON.stringify({ event_id: paid[0].id, profile_id: guest1.id, status: 'confirmed' }),
  })
  ok('BUY-03 an attendee cannot confirm their own registration', r.status >= 400, `HTTP ${r.status}`)

  const freeTickets = await svc(`event_tickets?event_id=eq.${paid[0].id}&select=id`).then(r => r.json())
  ok('BUY-04 and no ticket was issued for it', freeTickets.length === 0, `${freeTickets.length} tickets`)

  r = await as(guest1.token, 'event_registrations', {
    method: 'POST',
    body: JSON.stringify({ event_id: paid[0].id, profile_id: guest1.id, status: 'pending' }),
  })
  ok('BUY-06 but a caller may still hold their own place', r.status === 201, `HTTP ${r.status}`)

  console.log('\n— every automatic email has a producer (EML-01) —')

  // Both of these had no producer at all: the engine, the resolvers and the
  // copy all existed and nothing ever queued them. They are per-person kinds,
  // so the message must arrive carrying its recipient — a personal message
  // with no recipient row would be broadcast to the whole event if anything
  // downstream tried to resolve one.
  const msgs = await svc(`event_messages?event_id=eq.${ev.id}&select=id,kind,status`).then(r => r.json())
  const conf = msgs.find(m => m.kind === 'confirmation')
  ok('EML-01 a free RSVP queues a confirmation', !!conf, JSON.stringify(msgs.map(m => m.kind)))
  if (conf) {
    const to = await svc(`event_message_recipients?message_id=eq.${conf.id}&select=profile_id`).then(r => r.json())
    ok('and it carries exactly one recipient, never a broadcast', to.length === 1, `${to.length} recipients`)
  }

  const reminders = await svc(`event_messages?event_id=eq.${ev.id}&kind=eq.reminder&select=id,status`).then(r => r.json())
  if (reminders.length) {
    const to = await svc(`event_message_recipients?message_id=eq.${reminders[0].id}&select=id`).then(r => r.json())
    ok('EML-07 a reminder carries no recipients — resolved at send time', to.length === 0, `${to.length}`)
    ok('EML-01 and it is scheduled, not already marked sent', reminders[0].status === 'scheduled', reminders[0].status)
  }

  console.log('\n— private information (ACC-05) —')

  for (const [name, path] of [
    ['member_directory', 'member_directory?select=id&limit=1'],
    ['connector_notes', 'connector_notes?select=id&limit=1'],
    ['peer_feedback', 'peer_feedback?select=id&limit=1'],
    ['event_feedback', 'event_feedback?select=id&limit=1'],
  ]) {
    const res = await as(eventOnly.token, path)
    const body = await res.json().catch(() => null)
    const empty = res.status >= 400 || (Array.isArray(body) && body.length === 0)
    ok(`ACC-05 event-only account reads nothing from ${name}`, empty, `HTTP ${res.status} ${JSON.stringify(body).slice(0, 60)}`)
  }

  console.log('\n— attendance and feedback eligibility —')

  // FDB-06: a ticket alone is not eligibility
  let elig = await as(winner.token, `rpc/attended_event`, { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_profile: winner.id }) }).then(r => r.json())
  ok('FDB-06 a ticket holder who has not attended is not eligible', elig === false, `got ${JSON.stringify(elig)}`)

  const fq = await as(winner.token, 'feedback_questions?select=id,scope,slot,wording&order=scope,slot').then(r => r.json())
  const peerQ = fq.filter(q => q.scope === 'peer')
  const evQ = fq.filter(q => q.scope === 'event')
  ok('FDB-02 three peer questions are seeded', peerQ.length === 3, `${peerQ.length}`)
  ok('FDB-02 peer question 1 wording is exact',
    peerQ[0]?.wording === 'What was the best quality you noticed in this person?', peerQ[0]?.wording)
  ok('FDB-02 peer question 3 wording is exact',
    peerQ[2]?.wording === 'What would you most like to work on or collaborate on with this person?', peerQ[2]?.wording)
  ok('FDB-08 event question 1 wording is exact',
    evQ[0]?.wording === 'How was the event?', evQ[0]?.wording)
  ok('FDB-08 event question 2 wording is exact',
    evQ[1]?.wording === 'What did you enjoy the most?', evQ[1]?.wording)

  // a purchaser who did not attend cannot submit
  r = await write(winner.token, 'event_feedback', { event_id: ev.id, author_id: winner.id, question_id: evQ[0].id, answer_scale: 9 })
  ok('§11 person who only bought a ticket cannot submit feedback', r.status === 401 || r.status === 403, `HTTP ${r.status}`)

  // host records attendance for the guest, and for themselves (FDB-06 present hosts)
  r = await as(host.token, 'rpc/mark_attended', { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_profile: winner.id, p_reason: 'acceptance run' }) })
  ok('ATT-04/ATT-06 a host can record a missed check-in', r.status >= 200 && r.status < 300, `HTTP ${r.status}`)

  // a guest cannot mark themselves
  r = await as(winner.token, 'rpc/mark_attended', { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_profile: winner.id, p_reason: 'self' }) })
  ok('§11 attendee cannot mark themselves attended', r.status === 401 || r.status === 403 || r.status >= 400, `HTTP ${r.status}`)

  const att = await svc(`event_attendance?event_id=eq.${ev.id}&select=method,corrected,recorded_by`).then(r => r.json())
  ok('ATT-06 the correction is recorded as a correction, not a fabricated scan',
    att.length === 1 && att[0].method === 'manual' && att[0].corrected === true && att[0].recorded_by === host.id,
    JSON.stringify(att).slice(0, 100))

  elig = await as(winner.token, 'rpc/attended_event', { method: 'POST', body: JSON.stringify({ p_event: ev.id, p_profile: winner.id }) }).then(r => r.json())
  ok('FDB-06 the correction makes them eligible', elig === true, `got ${JSON.stringify(elig)}`)

  r = await write(winner.token, 'event_feedback', { event_id: ev.id, author_id: winner.id, question_id: evQ[0].id, answer_scale: 9 })
  ok('FDB-08 an attendee can now submit event feedback', r.status >= 200 && r.status < 300, `HTTP ${r.status} ${(await r.text()).slice(0, 90)}`)

  // self-review
  r = await write(winner.token, 'peer_feedback', { event_id: ev.id, author_id: winner.id, subject_id: winner.id, question_id: peerQ[0].id, answer_text: 'me' })
  ok('§11 participant cannot rate themselves', r.status >= 400, `HTTP ${r.status}`)

  console.log('\n— feedback is admin-only (FDB-09/12/13) —')

  const mine = await as(winner.token, `event_feedback?event_id=eq.${ev.id}&select=*`).then(r => r.json())
  ok('FDB-12 the author cannot read back their own submitted feedback',
    Array.isArray(mine) && mine.length === 0, JSON.stringify(mine).slice(0, 80))

  const hostSees = await as(host.token, `event_feedback?event_id=eq.${ev.id}&select=*`).then(r => r.json())
  ok('FDB-09 a non-admin host cannot read submitted feedback for their own event',
    Array.isArray(hostSees) && hostSees.length === 0, JSON.stringify(hostSees).slice(0, 80))

  const adminSees = await as(admin.token, `event_feedback?event_id=eq.${ev.id}&select=*`).then(r => r.json())
  ok('FDB-09/13 an administrator reads every review',
    Array.isArray(adminSees) && adminSees.length === 1, JSON.stringify(adminSees).slice(0, 80))

  console.log('\n— cancellation frees the place (ORG-03A) —')

  const regId = confirmed[0].id
  r = await as(winner.token, 'rpc/cancel_registration', { method: 'POST', body: JSON.stringify({ p_registration: regId }) })
  ok('BUY-07 an attendee can cancel their own place', r.status >= 200 && r.status < 300, `HTTP ${r.status}`)
  const freed = await anon(`event_availability?event_id=eq.${ev.id}&select=state,remaining`).then(r => r.json())
  ok('ORG-03A the place returns to the pool after cancellation', freed[0]?.state === 'open', JSON.stringify(freed[0]))
  const revoked = await svc(`event_tickets?event_id=eq.${ev.id}&select=revoked_at`).then(r => r.json())
  ok('BUY-11 the cancelled ticket stops admitting its holder', revoked.every(t => t.revoked_at !== null), JSON.stringify(revoked).slice(0, 80))

  console.log('\n— QLT-08 a booking survives its event being unpublished —')

  await svc(`event_registrations?id=eq.${regId}`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed', cancelled_at: null }) })
  await svc(`events?id=eq.${ev.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) })
  const stillReadable = await as(winner.token, `events?id=eq.${ev.id}&select=id,title`).then(r => r.json())
  ok('QLT-08 an attendee still reads the event their booking is for',
    Array.isArray(stillReadable) && stillReadable.length === 1, JSON.stringify(stillReadable).slice(0, 80))
  const strangerSees = await as(guest1.id === winner.id ? eventOnly.token : guest1.token, `events?id=eq.${ev.id}&select=id`).then(r => r.json())
  ok('ORG-02 someone with no booking still cannot see the draft',
    Array.isArray(strangerSees) && strangerSees.length === 0, JSON.stringify(strangerSees).slice(0, 80))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  - ${f}`)) }
}

main()
  .catch(e => { console.error('\nRUN ERROR:', e.message); fail++ })
  .finally(async () => {
    await cleanup()
    console.log('\nfixtures removed')
    process.exit(fail ? 1 : 0)
  })
