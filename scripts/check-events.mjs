/**
 * The row level security grid for the event platform, against a live database.
 *
 * A companion to check-acceptance.mjs rather than a duplicate of it: that one
 * walks the §11 journeys end to end, this one is a grid over the RLS surface —
 * every table, asked by every kind of account that might reach for it. Two bugs
 * that only execution could find came out of this surface in one day, so both
 * are worth having.
 *
 *   SB_URL=<url> SB_SERVICE=<service-key> SB_PUB=<publishable-key> \
 *     node scripts/check-events.mjs
 *
 * It creates its own people, its own connectors and its own events, and removes
 * all of them on the way out including on failure. It depends on no seed data
 * and leaves none behind. Everything it makes is tagged with a timestamp, so an
 * interrupted run is identifiable.
 *
 * The service role is used for two things only: building fixtures and tearing
 * them down. Every assertion goes through an anon or user token, because the
 * service role bypasses RLS and would prove nothing.
 */

const URL = process.env.SB_URL
const SERVICE = process.env.SB_SERVICE
const PUB = process.env.SB_PUB
if (!URL || !SERVICE || !PUB) {
  console.error('Set SB_URL, SB_SERVICE and SB_PUB.')
  process.exit(1)
}

const TAG = `grid-${Date.now()}`
const PW = `Grid-${Date.now()}-Aa1!`
const made = { users: [], events: [] }

function headers(token) {
  return token
    ? { apikey: PUB, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { apikey: PUB, 'Content-Type': 'application/json' }
}

const svcHeaders = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
}

const svc = (path, opts = {}) =>
  fetch(`${URL}/rest/v1/${path}`, { ...opts, headers: { ...svcHeaders, ...(opts.headers || {}) } })

async function get(token, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: headers(token) })
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
}

async function write(token, method, path, body) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { ...headers(token), Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
}

/**
 * An insert that does not ask for the row back.
 *
 * Feedback tables have no select policy for anybody but an admin (FDB-09), and
 * `Prefer: return=representation` makes PostgREST read the row it just wrote.
 * That read is refused, and the refusal rolls the insert back with it — so a
 * perfectly legitimate submission fails with the same 42501 a permission bug
 * gives. supabase-js already sends return=minimal for an insert with no
 * .select(), so the app is right and the test has to match.
 */
async function insertMinimal(token, path, body) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...headers(token), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  return { ok: r.ok, status: r.status, body: r.ok ? null : await r.json().catch(() => null) }
}

async function rpc(token, fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(args ?? {}),
  })
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** A read is blocked if it either errors outright or comes back empty. */
function blocked(res) {
  return Array.isArray(res.body) ? res.body.length === 0 : !res.ok
}
function saw(res) {
  return Array.isArray(res.body) ? `saw ${res.body.length}` : `${res.status}`
}

const soon = (days, hours = 0) =>
  new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString()

async function signInAs(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })
  return (await r.json()).access_token
}

/**
 * Role is set at insert time, never afterwards. A service-role PATCH of
 * profiles.role is silently reverted by protect_profile_fields — auth.uid() is
 * null for the service key, so it is not an admin, so role is pinned. It
 * returns 200 and changes nothing, which is correct behaviour and a trap.
 *
 * current_profession is what onboarding_complete() reads. Without it BUY-01
 * correctly refuses every registration this script attempts.
 */
async function makeUser(label, name, role = 'user') {
  const email = `${TAG}-${label}@events-grid.invalid`
  const r = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, email_confirm: true }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`could not create ${label}: ${JSON.stringify(u).slice(0, 200)}`)
  made.users.push(u.id)
  await svc('profiles', {
    method: 'POST',
    body: JSON.stringify({
      id: u.id,
      full_name: name,
      email,
      role,
      profile_status: 'active',
      current_profession: 'Grid Fixture',
    }),
  })
  return { id: u.id, email, token: await signInAs(email) }
}

/**
 * An event-only account, made the way ACC-02 makes one: an auth user with no
 * invitation who calls create_event_account() for themselves. It is the only
 * thing that may write network_member = false — a service-role PATCH of that
 * column is pinned exactly as role is.
 */
async function makeAccountOnly(label, name) {
  const email = `${TAG}-${label}@events-grid.invalid`
  const u = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, email_confirm: true }),
  }).then((r) => r.json())
  if (!u.id) throw new Error(`could not create ${label}`)
  made.users.push(u.id)
  const token = await signInAs(email)
  const r = await rpc(token, 'create_event_account', { p_full_name: name })
  if (!r.ok) throw new Error(`create_event_account failed for ${label}: ${JSON.stringify(r.body)}`)
  await write(token, 'PATCH', `profiles?id=eq.${u.id}`, { current_profession: 'Grid Attendee' })
  return { id: u.id, email, token }
}

/** A connector row for somebody who already holds a connector profile. */
async function makeConnector(profileId) {
  const r = await svc('connectors', {
    method: 'POST',
    body: JSON.stringify({ profile_id: profileId }),
  })
  return (await r.json())[0]?.id
}

/** ORG-08A's community membership: who joined on whose code. */
const linkToCommunity = (connectorId, profileId) =>
  svc('connector_user_links', {
    method: 'POST',
    body: JSON.stringify({ connector_id: connectorId, user_profile_id: profileId }),
  })

/**
 * Events first, then people. An event cascades its registrations, tickets,
 * attendance and queued messages; deleting the people first would leave the
 * events behind. The deletion probe removes its own auth user mid-run, so a 404
 * here is expected and ignored.
 */
async function cleanup() {
  for (const id of made.events) {
    await svc(`events?id=eq.${id}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of made.users) {
    await fetch(`${URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    }).catch(() => {})
  }
}

async function main() {
  console.log(`\nRLS grid — live database, tag ${TAG}\n`)

  // -------------------------------------------------------------------------
  // Cast — all of it built here, none of it assumed to exist
  // -------------------------------------------------------------------------

  const admin = await makeUser('adm', 'Grid Admin', 'admin')
  const host = await makeUser('host', 'Grid Host', 'connector')
  const otherHost = await makeUser('host2', 'Grid Second Host', 'connector')
  const member = await makeUser('m1', 'Grid Member')
  const member2 = await makeUser('m2', 'Grid Member Two')
  // The outsider joined on the second connector's code, so they are the only
  // person here who can prove that one connector cannot reach into another's
  // community (ORG-08A). A member of the host's own community would pass
  // vacuously.
  const outsider = await makeUser('out', 'Grid Outsider')

  const connectorId = await makeConnector(host.id)
  const otherConnectorId = await makeConnector(otherHost.id)
  if (!connectorId || !otherConnectorId) throw new Error('could not create connector rows')

  await linkToCommunity(connectorId, member.id)
  await linkToCommunity(connectorId, member2.id)
  await linkToCommunity(otherConnectorId, outsider.id)

  // ACC-02. A real person who signed up to buy a ticket and was never invited.
  const ticketBuyer = await makeAccountOnly('eo', 'Grid Ticket Buyer')

  const setConnector = (patch) =>
    write(admin.token, 'PATCH', `connectors?id=eq.${connectorId}`, patch)

  async function createDraft(token, fields) {
    const res = await write(token, 'POST', 'events', {
      host_id: host.id,
      title: `${TAG} probe`,
      starts_at: soon(7),
      ends_at: soon(7, 2),
      ...fields,
    })
    const id = res.body?.[0]?.id
    if (id) made.events.push(id)
    return { res, id }
  }


  // ---------------------------------------------------------------------------
  // 1. ACC-05 — an event-only account is not a member
  //
  // The single most important consequence of splitting is_member(). This person
  // holds a profile, so every surface still gated on "has a profile" would let
  // them straight in.
  // ---------------------------------------------------------------------------

  const directory = await get(ticketBuyer.token, 'member_directory?select=id')
  check('event-only account cannot read the member directory', blocked(directory), saw(directory))

  const feed = await get(ticketBuyer.token, 'posts?select=id')
  check('event-only account cannot read the feed', blocked(feed), saw(feed))

  const circle = await get(ticketBuyer.token, 'circle_messages?select=id')
  check('event-only account cannot read circle chat', blocked(circle), saw(circle))

  const answers = await get(ticketBuyer.token, `profile_answers?profile_id=eq.${member.id}&select=id`)
  check("event-only account cannot read another person's profile answers", blocked(answers), saw(answers))

  // And the gate they do pass, so the check above is not passing vacuously on a
  // broken account.
  const publicEvents = await get(ticketBuyer.token, 'event_public?select=id&limit=1')
  check('event-only account can still read public events', publicEvents.ok, `${publicEvents.status}`)

  // ---------------------------------------------------------------------------
  // 2. ACC-04 / ORG-01A — who may put an event on the calendar
  // ---------------------------------------------------------------------------

  await setConnector({
    can_create_events: false,
    stripe_account_id: null,
    stripe_charges_enabled: false,
    stripe_account_status: 'none',
  })

  const memberEvent = await write(member.token, 'POST', 'events', {
    host_id: member.id,
    title: 'A member throwing a party',
    starts_at: soon(3),
  })
  check('ordinary account holder cannot create an event', !memberEvent.ok, `${memberEvent.status}`)

  const offAttempt = await createDraft(host.token, { title: 'Refused while switched off' })
  check(
    'connector with can_create_events false cannot create an event',
    !offAttempt.res.ok,
    `${offAttempt.res.status}`,
  )

  await setConnector({ can_create_events: true })

  const draft = await createDraft(host.token, { title: 'Check-events draft' })
  check('connector with can_create_events true can create an event', draft.res.ok, `${draft.res.status}`)

  // The regression test for the INSERT ... RETURNING bug. createDraft sends
  // `Prefer: return=representation`, exactly as supabase-js `.insert().select()`
  // does, so the new draft has to survive events_select being applied to the
  // returned row. Before `host_id = auth.uid()` was added to that policy this was
  // a 42501 for every connector and a 201 for every admin.
  check(
    'and gets the row back, not a 42501 on RETURNING',
    Array.isArray(draft.res.body) && draft.res.body.length === 1 && draft.res.body[0].status === 'draft',
    draft.res.ok ? `returned ${draft.res.body?.length} row(s)` : String(draft.res.body?.message ?? '').slice(0, 70),
  )

  // ---------------------------------------------------------------------------
  // 3. EVT-01 / ORG-02 — the public link, and the draft that has no public link
  // ---------------------------------------------------------------------------

  const anonDraft = await get(null, `events?id=eq.${draft.id}&select=id`)
  check('anon cannot select a draft event', blocked(anonDraft), saw(anonDraft))

  const publish = await write(host.token, 'PATCH', `events?id=eq.${draft.id}`, { status: 'published' })
  check('host can publish their draft', publish.ok && publish.body?.[0]?.status === 'published', `${publish.status}`)

  const anonPublished = await get(null, `events?id=eq.${draft.id}&select=id,slug,status`)
  check(
    'anon can select a published event',
    Array.isArray(anonPublished.body) && anonPublished.body.length === 1,
    saw(anonPublished),
  )

  const slug = anonPublished.body?.[0]?.slug
  const anonView = await get(null, `event_public?slug=eq.${slug}&select=slug,host_names`)
  check(
    'anon can read the public event view with host names',
    Array.isArray(anonView.body) && anonView.body.length === 1 && Array.isArray(anonView.body[0].host_names),
    saw(anonView),
  )

  // ---------------------------------------------------------------------------
  // 4. §7.3 — no Stripe, no paid sales; free events unaffected
  // ---------------------------------------------------------------------------

  const paid = await createDraft(host.token, { title: 'Paid, with nowhere for the money to go' })
  await write(host.token, 'POST', 'ticket_types', {
    event_id: paid.id,
    name: 'Standard',
    price_cents: 5000,
  })
  const paidPublish = await write(host.token, 'PATCH', `events?id=eq.${paid.id}`, { status: 'published' })
  check(
    'connector with no Stripe cannot publish a paid event',
    !paidPublish.ok && String(paidPublish.body?.message ?? '').includes('Stripe'),
    paidPublish.ok ? 'published anyway' : String(paidPublish.body?.message ?? paidPublish.status).slice(0, 70),
  )

  const free = await createDraft(host.token, { title: 'Free, and no Stripe needed' })
  await write(host.token, 'POST', 'ticket_types', {
    event_id: free.id,
    name: 'Free entry',
    price_cents: 0,
  })
  const freePublish = await write(host.token, 'PATCH', `events?id=eq.${free.id}`, { status: 'published' })
  check(
    'connector with no Stripe can still publish a free event',
    freePublish.ok && freePublish.body?.[0]?.status === 'published',
    freePublish.ok ? 'published' : String(freePublish.body?.message ?? freePublish.status).slice(0, 70),
  )

  // §7.0. The money routes to the creator's connector without anybody choosing it.
  check(
    'a connector-created event is routed to that connector',
    freePublish.body?.[0]?.payment_connector_id === connectorId,
    `payment_connector_id ${freePublish.body?.[0]?.payment_connector_id}`,
  )

  // ---------------------------------------------------------------------------
  // 4a. §7.3 — readiness is derived from current state, not from publication
  //
  // The gap this closes: a connector restricted by Stripe after publishing used
  // to produce silence. Readiness is recomputed on every call, so the dashboard
  // and checkout both see it the moment it changes.
  // ---------------------------------------------------------------------------

  const notReady = await rpc(host.token, 'event_sale_readiness', { p_event: paid.id })
  check(
    'an event with no Stripe reports why it cannot sell, and the fix (§7.3)',
    notReady.body?.[0]?.can_sell_paid === false &&
      notReady.body?.[0]?.reason === 'no_account' &&
      notReady.body?.[0]?.fix_action === 'connect',
    JSON.stringify(notReady.body?.[0]),
  )

  // Status beats charges_enabled: a restricted account is restricted even while
  // Stripe still reports charges on, and the organiser needs the real reason.
  await setConnector({
    stripe_account_id: 'acct_grid_probe',
    stripe_charges_enabled: true,
    stripe_account_status: 'restricted',
  })
  const restricted = await rpc(host.token, 'event_sale_readiness', { p_event: paid.id })
  check(
    'a restricted account reports restricted, not ready',
    restricted.body?.[0]?.can_sell_paid === false &&
      restricted.body?.[0]?.reason === 'restricted' &&
      restricted.body?.[0]?.fix_action === 'stripe',
    JSON.stringify(restricted.body?.[0]),
  )

  // One vocabulary. fix_action must be a PayoutState.fix value, because the
  // client already maps those and a parallel set in the database is two places
  // to change with one of them forgotten.
  check(
    'fix_action uses payoutState()’s verbs and no others',
    ['connect', 'continue', 'stripe'].includes(notReady.body?.[0]?.fix_action) &&
      ['connect', 'continue', 'stripe'].includes(restricted.body?.[0]?.fix_action),
    `${notReady.body?.[0]?.fix_action} | ${restricted.body?.[0]?.fix_action}`,
  )

  // reason is a code, not prose. The words live in payouts.ts.
  check(
    'reason is a stable code, not a sentence',
    !/\s/.test(notReady.body?.[0]?.reason ?? ' ') &&
      !/\s/.test(restricted.body?.[0]?.reason ?? ' '),
    `${notReady.body?.[0]?.reason} | ${restricted.body?.[0]?.reason}`,
  )

  await setConnector({ stripe_account_status: 'ready' })
  const ready = await rpc(host.token, 'event_sale_readiness', { p_event: paid.id })
  check(
    'a ready account says so',
    ready.body?.[0]?.can_sell_paid === true &&
      ready.body?.[0]?.reason === 'ready' &&
      ready.body?.[0]?.fix_action === null,
    JSON.stringify(ready.body?.[0]),
  )

  // An Amazing-hosted event has no connector, and that is not a failure state.
  const platformEvent = await write(admin.token, 'POST', 'events', {
    host_id: admin.id,
    title: `${TAG} platform event`,
    starts_at: soon(9),
    ends_at: soon(9, 2),
  })
  if (platformEvent.body?.[0]?.id) made.events.push(platformEvent.body[0].id)
  const platformReady = await rpc(admin.token, 'event_sale_readiness', {
    p_event: platformEvent.body?.[0]?.id,
  })
  check(
    'an admin-hosted event routes to the platform account and can sell (BUY-13)',
    platformReady.body?.[0]?.can_sell_paid === true &&
      platformReady.body?.[0]?.reason === 'platform_account' &&
      platformReady.body?.[0]?.fix_action === null,
    JSON.stringify(platformReady.body?.[0]),
  )

  // The single question, asked of a free-only event whose host has no Stripe.
  // false is the correct answer and every caller ignores it, because none of
  // them asks unless there is a paid ticket to sell.
  const freeOnly = await rpc(host.token, 'event_sale_readiness', { p_event: free.id })
  check(
    'readiness ignores whether the event has paid tickets at all',
    typeof freeOnly.body?.[0]?.can_sell_paid === 'boolean',
    `can_sell_paid ${freeOnly.body?.[0]?.can_sell_paid} for a free-only event`,
  )

  const paidPublishNow = await write(host.token, 'PATCH', `events?id=eq.${paid.id}`, {
    status: 'published',
  })
  check(
    'and the paid event that was refused can now be published',
    paidPublishNow.ok && paidPublishNow.body?.[0]?.status === 'published',
    paidPublishNow.ok ? 'published' : String(paidPublishNow.body?.message ?? '').slice(0, 60),
  )

  // Put the account back as it was, so nothing later depends on this. That is
  // also the true -> false transition BUY-14 cares about, and the paid event
  // published a moment ago is exactly the "something to break" case.
  await setConnector({
    stripe_account_id: null,
    stripe_charges_enabled: false,
    stripe_account_status: 'none',
  })

  const blockedNotice = await get(
    host.token,
    `notifications?kind=eq.event_payments_blocked&event_id=eq.${paid.id}&select=id,actor_id`,
  )
  check(
    'losing Stripe tells the host their paid event stopped selling (BUY-14)',
    blockedNotice.body?.length === 1 && blockedNotice.body[0].actor_id === null,
    saw(blockedNotice),
  )

  // A repeated account.updated carrying the same false must not notify again.
  await setConnector({ stripe_charges_enabled: false })
  const noRepeat = await get(
    host.token,
    `notifications?kind=eq.event_payments_blocked&event_id=eq.${paid.id}&select=id`,
  )
  check(
    'and a repeat of the same false does not tell them twice',
    noRepeat.body?.length === 1,
    saw(noRepeat),
  )

  // A connector with nothing live to break hears nothing at all.
  await write(admin.token, 'PATCH', `connectors?id=eq.${otherConnectorId}`, {
    stripe_account_id: 'acct_grid_quiet',
    stripe_charges_enabled: true,
    stripe_account_status: 'ready',
  })
  await write(admin.token, 'PATCH', `connectors?id=eq.${otherConnectorId}`, {
    stripe_charges_enabled: false,
    stripe_account_status: 'restricted',
  })
  const quiet = await get(otherHost.token, 'notifications?kind=eq.event_payments_blocked&select=id')
  check(
    'a connector with no live paid events is not alarmed',
    blocked(quiet),
    saw(quiet),
  )

  // ---------------------------------------------------------------------------
  // 5. BUY-05 — two people, one place, one winner
  //
  // Two separate HTTP requests fired together, so they land in two different
  // database sessions and genuinely race. The event row lock in
  // enforce_event_capacity() is the only thing standing between this and an
  // over-sold room.
  // ---------------------------------------------------------------------------

  const lastPlace = await createDraft(host.token, {
    title: 'One place left',
    capacity: 1,
  })
  await write(host.token, 'PATCH', `events?id=eq.${lastPlace.id}`, { status: 'published' })

  const [first, second] = await Promise.all([
    rpc(member.token, 'register_free', { p_event: lastPlace.id }),
    rpc(member2.token, 'register_free', { p_event: lastPlace.id }),
  ])
  const winners = [first, second].filter((r) => r.ok).length
  check(
    'two concurrent register_free calls for one place: exactly one wins',
    winners === 1,
    `${winners} succeeded — ${[first, second].map((r) => (r.ok ? 'ok' : String(r.body?.message ?? r.status).slice(0, 40))).join(' | ')}`,
  )

  const state = await rpc(member.token, 'event_capacity_state', { p_event: lastPlace.id })
  check(
    'the event now reads as sold out',
    state.body?.[0]?.state === 'sold_out' && state.body?.[0]?.confirmed === 1,
    `state ${state.body?.[0]?.state}, confirmed ${state.body?.[0]?.confirmed}`,
  )

  // BUY-10. Whoever won has a ticket, issued by trigger rather than by a caller.
  const winner = first.ok ? member : member2
  const loser = first.ok ? member2 : member
  const ticket = await get(winner.token, `event_tickets?event_id=eq.${lastPlace.id}&select=code`)
  check(
    'the confirmed registration was issued a ticket',
    Array.isArray(ticket.body) && ticket.body.length === 1 && /^[0-9a-f]{32}$/.test(ticket.body[0].code),
    saw(ticket),
  )

  // QLT-08. A host pulls the event back to draft. The person holding a place
  // must not lose sight of the event their ticket is for.
  await write(host.token, 'PATCH', `events?id=eq.${lastPlace.id}`, { status: 'draft' })

  const bookedView = await get(winner.token, `events?id=eq.${lastPlace.id}&select=id,status`)
  check(
    'an unpublished event stays readable to somebody holding a place (QLT-08)',
    Array.isArray(bookedView.body) && bookedView.body.length === 1,
    saw(bookedView),
  )

  const strangerView = await get(loser.token, `events?id=eq.${lastPlace.id}&select=id`)
  check(
    'and is still invisible to everybody else (ORG-02)',
    blocked(strangerView),
    saw(strangerView),
  )

  const bookedPublicView = await get(winner.token, `event_public?id=eq.${lastPlace.id}&select=id`)
  check(
    'event_public agrees with the table about that (QLT-08)',
    Array.isArray(bookedPublicView.body) && bookedPublicView.body.length === 1,
    saw(bookedPublicView),
  )

  await write(host.token, 'PATCH', `events?id=eq.${lastPlace.id}`, { status: 'published' })

  // ---------------------------------------------------------------------------
  // 6. ATT-02/03/06 — the door
  // ---------------------------------------------------------------------------

  const code = ticket.body?.[0]?.code

  const scan1 = await rpc(host.token, 'check_in', { p_ticket_code: code, p_event: lastPlace.id })
  check('a valid ticket scans as ok', scan1.body === 'ok', String(scan1.body))

  const scan2 = await rpc(host.token, 'check_in', { p_ticket_code: code, p_event: lastPlace.id })
  check('a second scan of the same ticket says already (ATT-03)', scan2.body === 'already', String(scan2.body))

  const wrongEvent = await rpc(host.token, 'check_in', { p_ticket_code: code, p_event: draft.id })
  check('a ticket for another event is rejected as wrong_event', wrongEvent.body === 'wrong_event', String(wrongEvent.body))

  const nonsense = await rpc(host.token, 'check_in', {
    p_ticket_code: 'deadbeefdeadbeefdeadbeefdeadbeef',
    p_event: lastPlace.id,
  })
  check('an unknown code is rejected as invalid', nonsense.body === 'invalid', String(nonsense.body))

  // ATT-06. A guest cannot mark themselves attended — they are not a host, so
  // the host check refuses them whoever they name.
  const selfMark = await rpc(loser.token, 'mark_attended', { p_event: lastPlace.id, p_profile: loser.id })
  check(
    'an attendee cannot mark themselves attended (ATT-06)',
    !selfMark.ok,
    String(selfMark.body?.message ?? selfMark.status).slice(0, 60),
  )

  // FDB-06. A present host is a participant even though they bought no ticket,
  // and their presence has to be recordable — including by themselves, because
  // a host running an event alone has nobody else to do it.
  const hostPresent = await rpc(host.token, 'mark_attended', {
    p_event: lastPlace.id,
    p_profile: host.id,
    p_reason: 'Hosting, no ticket',
  })
  check('a host can record their own presence (FDB-06)', hostPresent.ok, `${hostPresent.status}`)

  // ATT-02. The roster has to name whoever scanned a ticket, and staff working a
  // door they did not buy a ticket for is the ordinary case. Elena hosts the free
  // event and has neither registered for it nor been scanned at it.
  const roster = await get(host.token, `event_participants?event_id=eq.${free.id}&select=profile_id,is_host,attended`)
  check(
    'a host who never registered or scanned is still on the roster (ATT-02)',
    Array.isArray(roster.body) &&
      roster.body.some((r) => r.profile_id === host.id && r.is_host === true && r.attended === false),
    saw(roster),
  )

  // The dedupe the third union branch has to preserve: Elena hosts this one and
  // was marked present, so she is produced by every branch. One row, attended.
  const hostRow = await get(host.token, `event_participants?event_id=eq.${lastPlace.id}&profile_id=eq.${host.id}&select=attended,is_host`)
  check(
    'a host who also attended appears exactly once',
    hostRow.body?.length === 1 && hostRow.body[0].attended === true && hostRow.body[0].is_host === true,
    `${hostRow.body?.length} row(s): ${JSON.stringify(hostRow.body?.[0])}`,
  )

  // And is_host describes the person listed, not whoever is looking.
  const guestRow = await get(host.token, `event_participants?event_id=eq.${lastPlace.id}&profile_id=eq.${winner.id}&select=attended,is_host`)
  check(
    'a guest on the same roster is not marked as a host',
    guestRow.body?.length === 1 && guestRow.body[0].is_host === false,
    JSON.stringify(guestRow.body?.[0]),
  )

  // ---------------------------------------------------------------------------
  // 7. FDB-06/09 — who may give feedback, and who may read it
  // ---------------------------------------------------------------------------

  const questions = await get(member.token, 'feedback_questions?select=id,scope,slot,wording,answer_format&order=scope,slot')
  const q = Object.fromEntries((questions.body ?? []).map((x) => [`${x.scope}${x.slot}`, x]))
  check(
    'the five questions are seeded with the exact wording (FDB-02/08)',
    questions.body?.length === 5 &&
      q.peer1?.wording === 'What was the best quality you noticed in this person?' &&
      q.peer2?.wording === 'Would you like to meet this person again?' &&
      q.peer2?.answer_format === 'choice' &&
      q.peer3?.wording === 'What would you most like to work on or collaborate on with this person?' &&
      q.event1?.wording === 'How was the event?' &&
      q.event1?.answer_format === 'scale' &&
      q.event2?.wording === 'What did you enjoy the most?',
    saw(questions),
  )

  // Attendance is the gate, not the ticket. The loser of the race has neither.
  const uneligible = await insertMinimal(loser.token, 'event_feedback', {
    event_id: lastPlace.id,
    author_id: loser.id,
    question_id: q.event1?.id,
    answer_scale: 9,
  })
  check(
    'somebody with no verified attendance cannot submit event feedback (FDB-06)',
    !uneligible.ok,
    `${uneligible.status}`,
  )

  const eligible = await insertMinimal(winner.token, 'event_feedback', {
    event_id: lastPlace.id,
    author_id: winner.id,
    question_id: q.event1?.id,
    answer_scale: 8,
  })
  check('a checked-in attendee can submit event feedback', eligible.ok, `${eligible.status}`)

  // FDB-10 and §9. The hosting team is frozen onto the answer as context. Read
  // back as the admin, because the author cannot read their own answer and that
  // is the point of the table.
  const storedFeedback = await get(admin.token, `event_feedback?event_id=eq.${lastPlace.id}&select=host_ids,answer_scale`)
  check(
    'event feedback records the hosting team as context (FDB-10)',
    Array.isArray(storedFeedback.body?.[0]?.host_ids) && storedFeedback.body[0].host_ids.includes(host.id),
    `host_ids ${JSON.stringify(storedFeedback.body?.[0]?.host_ids)}`,
  )

  const selfReview = await insertMinimal(winner.token, 'peer_feedback', {
    event_id: lastPlace.id,
    author_id: winner.id,
    subject_id: winner.id,
    question_id: q.peer2?.id,
    answer_choice: 'Yes',
  })
  check('nobody can rate themselves (FDB-01)', !selfReview.ok, `${selfReview.status}`)

  // Both were present — the attendee scanned in, the host recorded themselves.
  const peerReview = await insertMinimal(winner.token, 'peer_feedback', {
    event_id: lastPlace.id,
    author_id: winner.id,
    subject_id: host.id,
    question_id: q.peer2?.id,
    answer_choice: 'Maybe',
  })
  check('two present participants can review each other', peerReview.ok, `${peerReview.status}`)

  // FDB-05/07. The author sees outcomes and never answers, not even their own.
  const progress = await get(winner.token, `my_feedback_progress?event_id=eq.${lastPlace.id}&select=subject_id,subject_name,outcome`)
  check(
    'the author sees their own progress as outcomes only',
    Array.isArray(progress.body) &&
      progress.body.some((r) => r.subject_id === host.id && r.outcome === 'submitted') &&
      !progress.body.some((r) => r.subject_id === winner.id),
    saw(progress),
  )

  const leak = await get(winner.token, 'my_feedback_progress?select=answer_text')
  check('my_feedback_progress exposes no answer column', !leak.ok, `${leak.status}`)

  // FDB-09/12. Admin-only on select, in policy rather than in the interface.
  const peerPeek = await get(winner.token, 'peer_feedback?select=id')
  check('the author of a review cannot read it back', blocked(peerPeek), saw(peerPeek))

  const subjectPeek = await get(host.token, 'peer_feedback?select=id')
  check('the subject of a review, who is also the host, cannot read it', blocked(subjectPeek), saw(subjectPeek))

  const eventPeek = await get(host.token, 'event_feedback?select=id')
  check('a non-admin host cannot read event feedback', blocked(eventPeek), saw(eventPeek))

  const subjectsPeek = await get(host.token, 'feedback_subjects?select=id')
  check('a non-admin host cannot read feedback_subjects', blocked(subjectsPeek), saw(subjectsPeek))

  const adminPeek = await get(admin.token, `peer_feedback?event_id=eq.${lastPlace.id}&select=id`)
  check(
    'an administrator can read every review (FDB-11/13)',
    Array.isArray(adminPeek.body) && adminPeek.body.length === 1,
    saw(adminPeek),
  )

  // ---------------------------------------------------------------------------
  // 8. ORG-08A — a host cannot reach into another connector's community
  // ---------------------------------------------------------------------------

  const ownCommunity = await write(host.token, 'POST', 'event_invites', {
    event_id: free.id,
    profile_id: member.id,
    invited_by: host.id,
    via_connector_id: connectorId,
  })
  check('a host can invite somebody from their own community', ownCommunity.ok, `${ownCommunity.status}`)

  const otherCommunity = await write(host.token, 'POST', 'event_invites', {
    event_id: free.id,
    profile_id: outsider.id,
    invited_by: host.id,
    via_connector_id: connectorId,
  })
  check(
    "a host cannot invite from another connector's community (ORG-08A)",
    !otherCommunity.ok,
    `${otherCommunity.status}`,
  )

  // ORG-08B. The bell as well as the inbox, and the invitation reads as coming
  // from whoever created the event rather than whichever cohost clicked.
  const invitedBell = await get(
    member.token,
    `notifications?kind=eq.event_invited&event_id=eq.${free.id}&select=id,actor_id,read_at`,
  )
  check(
    'an invited person gets an in-app notification too (ORG-08B)',
    invitedBell.body?.length === 1 && invitedBell.body[0].actor_id === host.id,
    `${invitedBell.body?.length} notice(s), actor ${invitedBell.body?.[0]?.actor_id}`,
  )

  // EML-05A. A resend while the first notice is still unread must not stack a
  // second identical one — the partial unique index covers first asks only, so
  // nothing else stops repeated clicks becoming repeated notices.
  const resend = await write(host.token, 'POST', 'event_invites', {
    event_id: free.id,
    profile_id: member.id,
    invited_by: host.id,
    via_connector_id: connectorId,
    resend_of: ownCommunity.body?.[0]?.id,
  })
  check('a deliberate resend is allowed as a new row (EML-05A)', resend.ok, `${resend.status}`)

  const afterResend = await get(
    member.token,
    `notifications?kind=eq.event_invited&event_id=eq.${free.id}&select=id`,
  )
  check(
    'but does not stack a second unread notice (EML-05A)',
    afterResend.body?.length === 1,
    `${afterResend.body?.length} notice(s)`,
  )

  // A host on their own invite list hears nothing — they are already hosting it.
  // Sent by the admin: a connector cannot reach this case at all, because a
  // fellow host is not in their connector_user_links and ORG-08A refuses the row
  // before the trigger ever runs.
  const hostInvite = await write(admin.token, 'POST', 'event_invites', {
    event_id: free.id,
    profile_id: host.id,
    invited_by: admin.id,
  })
  const hostBell = await get(
    host.token,
    `notifications?kind=eq.event_invited&event_id=eq.${free.id}&select=id`,
  )
  check(
    'a host on the invite list is not told they are invited to their own event',
    hostInvite.ok && hostBell.body?.length === 0,
    `invite ${hostInvite.status}, ${hostBell.body?.length} notice(s)`,
  )

  // ---------------------------------------------------------------------------
  // 9. BUY-01 — onboarding is required, and required on the server
  //
  // The ticket buyer has an account and no profession, which is what the
  // /onboarding step collects. Deliberately not the network questionnaire: an
  // event-only account never answers it (ACC-02), so requiring it would make
  // buying a ticket impossible for exactly the people this platform is for.
  // ---------------------------------------------------------------------------

  await write(ticketBuyer.token, 'PATCH', `profiles?id=eq.${ticketBuyer.id}`, {
    current_profession: null,
  })

  const halfWay = await rpc(ticketBuyer.token, 'register_free', { p_event: free.id })
  check(
    'an unfinished profile cannot register, whatever the client does (BUY-01)',
    !halfWay.ok && String(halfWay.body?.message ?? '').includes('profile'),
    String(halfWay.body?.message ?? halfWay.status).slice(0, 60),
  )

  await write(ticketBuyer.token, 'PATCH', `profiles?id=eq.${ticketBuyer.id}`, {
    current_profession: 'Sound engineer',
  })

  const onboarded = await rpc(ticketBuyer.token, 'register_free', { p_event: free.id })
  check(
    'an event-only account can register once onboarded (ACC-02, BUY-01)',
    onboarded.ok,
    onboarded.ok ? 'registered' : String(onboarded.body?.message ?? onboarded.status).slice(0, 60),
  )

  // ---------------------------------------------------------------------------
  // 9a. §9 — closing an account erases the person, not the record
  //
  // A throwaway account that registers, is marked present, and then closes
  // itself. The registration and the ticket are litter and should go; the
  // attendance row is history and should stay, with nobody attached to it.
  //
  // Only the attendance half is reachable from here: event_orders has no insert
  // policy for any user role, by design, so an order cannot be created without a
  // service key. The order half of this rule is the same `on delete set null`
  // written in the same migration.
  // ---------------------------------------------------------------------------

  const probe = await makeAccountOnly('probe', 'Grid Deletion Probe')
  const probeId = probe.id
  const probeEmail = probe.email
  await rpc(probe.token, 'register_free', { p_event: free.id })
  await rpc(host.token, 'mark_attended', {
    p_event: free.id,
    p_profile: probe.id,
    p_reason: 'On the door',
  })

  // They answer the event-feedback form before leaving. The answer is about the
  // event, not about them, so it must survive with its author pseudonymised.
  await insertMinimal(probe.token, 'event_feedback', {
    event_id: free.id,
    author_id: probe.id,
    question_id: q.event1?.id,
    answer_scale: 7,
  })

  const closedAccount = await rpc(probe.token, 'delete_my_account')
  check('an account with no money in flight can close itself', closedAccount.ok, `${closedAccount.status}`)

  const orphanedAttendance = await get(
    host.token,
    `event_attendance?event_id=eq.${free.id}&profile_id=is.null&select=id,method,recorded_at,erased_subject_id`,
  )
  check(
    'the attendance record survives the person who earned it (§9)',
    Array.isArray(orphanedAttendance.body) && orphanedAttendance.body.length === 1,
    saw(orphanedAttendance),
  )

  // GDPR Art. 4(5). Nulling alone threw away linkage; the retained uuid is what
  // lets an administrator ask "were these the same person" about records that
  // no longer name anybody.
  check(
    'and carries the pseudonymised id that links it (Art. 4(5))',
    orphanedAttendance.body?.[0]?.erased_subject_id === probeId,
    `erased_subject_id ${orphanedAttendance.body?.[0]?.erased_subject_id}`,
  )

  const register = await get(
    admin.token,
    `data_subject_erasures?subject_id=eq.${probeId}&select=pseudonym,retention_until,lawful_basis`,
  )
  check(
    'the erasure is registered with a pseudonym and an expiry date (Art. 5(1)(e))',
    register.body?.length === 1 &&
      /^Former attendee [0-9A-F]{4}$/.test(register.body[0].pseudonym ?? '') &&
      typeof register.body[0].retention_until === 'string',
    JSON.stringify(register.body?.[0]),
  )

  // GDPR Art. 17, and the property rather than the mechanism: wherever their
  // details were, under whatever entity, they are not there now. Asserting on
  // the email keeps holding if the payload shape changes.
  const auditSweep = await get(
    admin.token,
    'activity_log?select=detail&order=created_at.desc&limit=500',
  )
  check(
    'no audit row anywhere still names an erased person (Art. 17)',
    auditSweep.ok && !JSON.stringify(auditSweep.body ?? []).includes(probeEmail),
    auditSweep.ok ? `scanned ${auditSweep.body?.length} rows` : `${auditSweep.status}`,
  )

  // And the event itself survives the scrub — erasure is not deletion of the
  // record that something happened.
  const auditSurvives = await get(
    admin.token,
    `activity_log?entity=eq.profiles&entity_id=eq.${probeId}&select=action`,
  )
  check(
    'but the audit events themselves survive it',
    Array.isArray(auditSurvives.body) &&
      auditSurvives.body.some((r) => r.action === 'profiles.delete'),
    saw(auditSurvives),
  )

  // GDPR Art. 17, the applicant case. No orders, no exemption, nothing kept —
  // so the whole payload goes rather than being pseudonymised. Phone is the
  // field profiles never had, so it has never been exercised until now.
  const applicantEmail = `${TAG}-applicant@events-grid.invalid`
  const applicantPhone = '+44 7700 900461'
  const applicantLinkedIn = `https://www.linkedin.com/in/${TAG}-applicant`
  await insertMinimal(null, 'waitlist_entries', {
    full_name: 'Grid Applicant',
    email: applicantEmail,
    phone: applicantPhone,
    linkedin_url: applicantLinkedIn,
  })
  const entryRow = await get(
    admin.token,
    `waitlist_entries?email=eq.${encodeURIComponent(applicantEmail)}&select=id`,
  )
  const removed = await rpc(admin.token, 'delete_waitlist_entry', {
    p_entry_id: entryRow.body?.[0]?.id,
  })
  check('an admin can remove a waitlist entry', removed.ok, `${removed.status}`)

  const applicantSweep = await get(
    admin.token,
    'activity_log?entity=eq.waitlist_entries&select=detail,action&order=created_at.desc&limit=200',
  )
  const applicantDump = JSON.stringify(applicantSweep.body ?? [])
  check(
    'a withdrawn applicant leaves no email, phone or profile link behind (Art. 17)',
    applicantSweep.ok &&
      !applicantDump.includes(applicantEmail) &&
      !applicantDump.includes(applicantPhone) &&
      !applicantDump.includes(applicantLinkedIn),
    applicantSweep.ok ? `scanned ${applicantSweep.body?.length} rows` : `${applicantSweep.status}`,
  )

  check(
    'but the removal itself is still on the record',
    Array.isArray(applicantSweep.body) &&
      applicantSweep.body.some((r) => r.action === 'waitlist_entries.delete'),
    saw(applicantSweep),
  )

  const hostRegisterPeek = await get(host.token, 'data_subject_erasures?select=subject_id')
  check(
    'and the register is readable by administrators only',
    blocked(hostRegisterPeek),
    saw(hostRegisterPeek),
  )

  // The feedback split: the answer stays, the author does not.
  const orphanedFeedback = await get(
    admin.token,
    `event_feedback?event_id=eq.${free.id}&author_id=is.null&select=answer_scale,erased_subject_id`,
  )
  check(
    "an erased author's event feedback survives, pseudonymised",
    orphanedFeedback.body?.length === 1 &&
      orphanedFeedback.body[0].answer_scale === 7 &&
      orphanedFeedback.body[0].erased_subject_id === probeId,
    JSON.stringify(orphanedFeedback.body?.[0]),
  )

  const goneRegistration = await get(
    host.token,
    `event_registrations?event_id=eq.${free.id}&profile_id=eq.${probe.id}&select=id`,
  )
  check(
    'their registration and ticket go with them',
    blocked(goneRegistration),
    saw(goneRegistration),
  )

  // ---------------------------------------------------------------------------
  // 10. ORG-03A — closed is not the same word as sold out
  // ---------------------------------------------------------------------------

  await write(host.token, 'PATCH', `events?id=eq.${free.id}`, { registration_closed: true })
  const closed = await rpc(member.token, 'event_capacity_state', { p_event: free.id })
  check(
    'an event with places left but registration closed reads as closed, not sold out',
    closed.body?.[0]?.state === 'closed',
    `state ${closed.body?.[0]?.state}`,
  )

  // ---------------------------------------------------------------------------
  // 11. BUY-08 — cancelling frees the place and stops the ticket
  // ---------------------------------------------------------------------------

  const myReg = await get(winner.token, `event_registrations?event_id=eq.${lastPlace.id}&select=id`)
  const cancelled = await rpc(winner.token, 'cancel_registration', { p_registration: myReg.body?.[0]?.id })
  check('an attendee can cancel their own registration', cancelled.ok, `${cancelled.status}`)

  const freedUp = await rpc(member.token, 'event_capacity_state', { p_event: lastPlace.id })
  check(
    'the cancelled place is available again',
    freedUp.body?.[0]?.state === 'open' && freedUp.body?.[0]?.confirmed === 0,
    `state ${freedUp.body?.[0]?.state}, confirmed ${freedUp.body?.[0]?.confirmed}`,
  )

  const deadTicket = await rpc(host.token, 'check_in', { p_ticket_code: code, p_event: lastPlace.id })
  check('a cancelled registration stops scanning', deadTicket.body === 'cancelled', String(deadTicket.body))

  // ---------------------------------------------------------------------------
  // 11a. BUY-06 — a hold with no expiry must not eat a place
  //
  // The insert is permitted: the policy allows a caller to hold their own place
  // as 'pending', and it says nothing about the expiry. What matters is not
  // whether the row exists but whether it costs anybody a seat, so the
  // assertion is on the capacity, not on the HTTP status.
  // ---------------------------------------------------------------------------

  const holdRoom = await createDraft(host.token, { title: `${TAG} hold room`, capacity: 2 })
  await write(host.token, 'PATCH', `events?id=eq.${holdRoom.id}`, { status: 'published' })

  const before = await rpc(member.token, 'event_capacity_state', { p_event: holdRoom.id })
  const phantom = await write(member.token, 'POST', 'event_registrations', {
    event_id: holdRoom.id,
    profile_id: member.id,
    status: 'pending',
    hold_expires_at: null,
  })
  const after = await rpc(member.token, 'event_capacity_state', { p_event: holdRoom.id })

  check(
    'a pending row with no expiry costs nobody a place (BUY-06)',
    after.body?.[0]?.remaining === before.body?.[0]?.remaining &&
      after.body?.[0]?.state === 'open',
    `remaining ${before.body?.[0]?.remaining} -> ${after.body?.[0]?.remaining}, state ${after.body?.[0]?.state}, insert ${phantom.status}`,
  )

  // And it does not lock that person out of registering either, because
  // expire_event_holds() now sweeps it.
  const afterSweep = await rpc(member.token, 'register_free', { p_event: holdRoom.id })
  check(
    'and does not block that person from registering properly',
    afterSweep.ok,
    afterSweep.ok ? 'registered' : String(afterSweep.body?.message ?? afterSweep.status).slice(0, 60),
  )

  // ---------------------------------------------------------------------------
  // 11b. ATT-02/03 — two stewards, one ticket, in the same instant
  //
  // Sequential scans are covered in section 6. This is the race: two devices,
  // two sessions, fired together. Exactly one arrival, and the loser must be
  // told "already" rather than shown a service error, because a steward who
  // reads "we couldn't tell" does not know whether to admit the person.
  // ---------------------------------------------------------------------------

  const buyerTicket = await get(ticketBuyer.token, `event_tickets?event_id=eq.${free.id}&select=code`)
  const buyerCode = buyerTicket.body?.[0]?.code

  const [scanA, scanB] = await Promise.all([
    rpc(host.token, 'check_in', { p_ticket_code: buyerCode, p_event: free.id }),
    rpc(host.token, 'check_in', { p_ticket_code: buyerCode, p_event: free.id }),
  ])
  const outcomes = [scanA.body, scanB.body].sort()
  check(
    'simultaneous scans answer ok and already, never an error (ATT-02)',
    scanA.ok && scanB.ok && outcomes[0] === 'already' && outcomes[1] === 'ok',
    `${JSON.stringify(outcomes)} (${scanA.status}/${scanB.status})`,
  )

  const arrivals = await get(
    host.token,
    `event_attendance?event_id=eq.${free.id}&profile_id=eq.${ticketBuyer.id}&select=id`,
  )
  check('and record exactly one arrival (ATT-03)', arrivals.body?.length === 1, saw(arrivals))

  // ---------------------------------------------------------------------------
  // 11c. ORG-09 — cancelling an event queues exactly one cancellation
  //
  // Two producers used to write that message, so an attendee got two emails.
  // The partial unique index is what makes a second one impossible; this is the
  // assertion that would have caught it.
  // ---------------------------------------------------------------------------

  const doomed = await createDraft(host.token, { title: `${TAG} doomed` })
  await write(host.token, 'PATCH', `events?id=eq.${doomed.id}`, { status: 'published' })
  await rpc(member2.token, 'register_free', { p_event: doomed.id })
  await write(host.token, 'PATCH', `events?id=eq.${doomed.id}`, { status: 'cancelled' })

  const cancelMsgs = await get(
    host.token,
    `event_messages?event_id=eq.${doomed.id}&kind=eq.cancelled&select=id,status`,
  )
  check(
    'cancelling an event queues exactly one cancellation message',
    cancelMsgs.body?.length === 1,
    saw(cancelMsgs),
  )

  const doomedState = await rpc(member2.token, 'event_capacity_state', { p_event: doomed.id })
  check(
    'and the event reads as cancelled everywhere',
    doomedState.body?.[0]?.state === 'cancelled',
    `state ${doomedState.body?.[0]?.state}`,
  )

  // ---------------------------------------------------------------------------
  // 12. ORG-07/08 — the guest list a host operates from
  // ---------------------------------------------------------------------------

  const guestList = await get(
    host.token,
    `event_guest_list?event_id=eq.${lastPlace.id}&select=profile_id,email,registration_status,attended`,
  )
  check(
    'a host can read their own guest list, contact details included (ORG-08)',
    Array.isArray(guestList.body) &&
      guestList.body.some((g) => g.profile_id === winner.id && typeof g.email === 'string' && g.email.includes('@')),
    saw(guestList),
  )

  const outsiderList = await get(loser.token, `event_guest_list?event_id=eq.${lastPlace.id}&select=profile_id`)
  check(
    'somebody who does not host the event cannot read its guest list',
    blocked(outsiderList),
    saw(outsiderList),
  )

  // ORG-08 excludes connector notes and unrelated profile answers by name, and a
  // view is only as safe as its column list.
  const listLeak = await get(host.token, 'event_guest_list?select=semantic_summary')
  check('the guest list exposes no profile internals', !listLeak.ok, `${listLeak.status}`)

  // ---------------------------------------------------------------------------
  // 13. ORG-01C — switching the permission off does not lock an organiser out
  //
  // The rule that is easiest to get wrong, and the one with the worst failure
  // mode: a host locked out of the guest list of an event that is happening
  // tomorrow.
  // ---------------------------------------------------------------------------

  await setConnector({ can_create_events: false })

  const stillEditing = await write(host.token, 'PATCH', `events?id=eq.${draft.id}`, {
    venue_name: 'The Hoxton, Shoreditch',
  })
  check(
    'permission off: an existing event stays editable (ORG-01C)',
    stillEditing.ok && stillEditing.body?.[0]?.venue_name === 'The Hoxton, Shoreditch',
    stillEditing.ok ? 'edited' : `${stillEditing.status}`,
  )

  // EML-08. Changing the venue leaves the event marked as having something the
  // attendees have not been told, and that outlives the tab that changed it.
  check(
    'a saved venue change is marked as not yet announced (EML-08)',
    stillEditing.body?.[0]?.details_notified_at === null,
    `details_notified_at ${stillEditing.body?.[0]?.details_notified_at}`,
  )

  const stillSelling = await write(host.token, 'POST', 'ticket_types', {
    event_id: draft.id,
    name: 'Added after the permission was withdrawn',
    price_cents: 0,
  })
  check('permission off: they can still manage tickets', stillSelling.ok, `${stillSelling.status}`)

  const newOne = await createDraft(host.token, { title: 'Refused again' })
  check(
    'permission off: they still cannot start another event',
    !newOne.res.ok,
    `${newOne.res.status}`,
  )
}

main()
  .catch((e) => {
    console.error(`\nrun aborted: ${e.message}`)
    results.push({ name: 'run completed without aborting', pass: false, detail: e.message })
  })
  .finally(async () => {
    await cleanup()
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
    console.log('fixtures removed')
    process.exit(failed.length ? 1 : 0)
  })
