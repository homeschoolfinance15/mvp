/**
 * Asserts the event platform's database rules actually hold against the live
 * project. Same shape and same spirit as check-rls.mjs: no service-role key,
 * everything through the publishable key and real sessions, because a rule
 * that only holds for a privileged client is not a rule.
 *
 *   SUPABASE_URL=<url> PUB=<publishable-key> DEMO_PASSWORD=<pw> \
 *     node scripts/check-events.mjs
 *
 * It creates events, flips one connector's permissions and puts them back. It
 * does not touch anything seed-demo.mjs made, beyond Elena's connector row,
 * which is restored to its original values at the end.
 */
const URL = process.env.SUPABASE_URL
const PUB = process.env.PUB
const PASSWORD = process.env.DEMO_PASSWORD
if (!URL || !PUB || !PASSWORD) {
  console.error('Set SUPABASE_URL, PUB and DEMO_PASSWORD (the password seed-demo.mjs used).')
  process.exit(1)
}

function headers(token) {
  return token
    ? { apikey: PUB, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { apikey: PUB, 'Content-Type': 'application/json' }
}

async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(null),
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error(`Could not sign in ${email}: ${JSON.stringify(j)}`)
  return { token: j.access_token, id: j.user.id }
}

/** Sign up if new, sign in if the run has happened before. */
async function signUpOrIn(email, fullName) {
  const r = await fetch(`${URL}/auth/v1/signup`, {
    method: 'POST',
    headers: headers(null),
    body: JSON.stringify({ email, password: PASSWORD, data: { full_name: fullName } }),
  })
  const j = await r.json()
  if (j.access_token) return { token: j.access_token, id: j.user.id, isNew: true }
  return { ...(await signIn(email)), isNew: false }
}

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
 * perfectly legitimate submission fails. Every client writing feedback has to
 * use return=minimal; this helper is the same rule in the test.
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

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

const admin = await signIn('moshe@valued.ventures')
const elena = await signIn('zalmytouger@gmail.com')   // connector, the one under test
const james = await signIn('mn26ventures@gmail.com')  // ordinary network member, Elena's circle
const priya = await signIn('priya.raghavan@ramedia.dev')
// Sofia joined on Daniel's code, so she is the only person here who can prove
// that one connector cannot reach into another's community (ORG-08A). Using
// Priya would pass vacuously — she is Elena's.
const sofia = await signIn('sofia.mensah@ramedia.dev')

// ACC-02. A real person who signed up to buy a ticket and was never invited
// into the network. Reused between runs; create_event_account refuses a second
// time and that is fine.
const ticketBuyer = await signUpOrIn('event.only@ramedia.dev', 'Ola Bergstrom')
await rpc(ticketBuyer.token, 'create_event_account', { p_full_name: 'Ola Bergstrom' })

const elenaConnector = await get(admin.token, `connectors?profile_id=eq.${elena.id}&select=*`)
const connectorId = elenaConnector.body?.[0]?.id
const originalConnector = elenaConnector.body?.[0]
if (!connectorId) {
  console.error('Elena has no connector row — run seed-demo.mjs first.')
  process.exit(1)
}

async function setConnector(patch) {
  return write(admin.token, 'PATCH', `connectors?id=eq.${connectorId}`, patch)
}

const createdEvents = []
async function createDraft(token, fields) {
  const res = await write(token, 'POST', 'events', {
    host_id: elena.id,
    title: 'Check-events probe',
    starts_at: soon(7),
    ends_at: soon(7, 2),
    ...fields,
  })
  const id = res.body?.[0]?.id
  if (id) createdEvents.push(id)
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

const answers = await get(ticketBuyer.token, `profile_answers?profile_id=eq.${james.id}&select=id`)
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

const memberEvent = await write(james.token, 'POST', 'events', {
  host_id: james.id,
  title: 'A member throwing a party',
  starts_at: soon(3),
})
check('ordinary account holder cannot create an event', !memberEvent.ok, `${memberEvent.status}`)

const offAttempt = await createDraft(elena.token, { title: 'Refused while switched off' })
check(
  'connector with can_create_events false cannot create an event',
  !offAttempt.res.ok,
  `${offAttempt.res.status}`,
)

await setConnector({ can_create_events: true })

const draft = await createDraft(elena.token, { title: 'Check-events draft' })
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

const publish = await write(elena.token, 'PATCH', `events?id=eq.${draft.id}`, { status: 'published' })
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

const paid = await createDraft(elena.token, { title: 'Paid, with nowhere for the money to go' })
await write(elena.token, 'POST', 'ticket_types', {
  event_id: paid.id,
  name: 'Standard',
  price_cents: 5000,
})
const paidPublish = await write(elena.token, 'PATCH', `events?id=eq.${paid.id}`, { status: 'published' })
check(
  'connector with no Stripe cannot publish a paid event',
  !paidPublish.ok && String(paidPublish.body?.message ?? '').includes('Stripe'),
  paidPublish.ok ? 'published anyway' : String(paidPublish.body?.message ?? paidPublish.status).slice(0, 70),
)

const free = await createDraft(elena.token, { title: 'Free, and no Stripe needed' })
await write(elena.token, 'POST', 'ticket_types', {
  event_id: free.id,
  name: 'Free entry',
  price_cents: 0,
})
const freePublish = await write(elena.token, 'PATCH', `events?id=eq.${free.id}`, { status: 'published' })
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
// 5. BUY-05 — two people, one place, one winner
//
// Two separate HTTP requests fired together, so they land in two different
// database sessions and genuinely race. The event row lock in
// enforce_event_capacity() is the only thing standing between this and an
// over-sold room.
// ---------------------------------------------------------------------------

const lastPlace = await createDraft(elena.token, {
  title: 'One place left',
  capacity: 1,
})
await write(elena.token, 'PATCH', `events?id=eq.${lastPlace.id}`, { status: 'published' })

const [first, second] = await Promise.all([
  rpc(james.token, 'register_free', { p_event: lastPlace.id }),
  rpc(priya.token, 'register_free', { p_event: lastPlace.id }),
])
const winners = [first, second].filter((r) => r.ok).length
check(
  'two concurrent register_free calls for one place: exactly one wins',
  winners === 1,
  `${winners} succeeded — ${[first, second].map((r) => (r.ok ? 'ok' : String(r.body?.message ?? r.status).slice(0, 40))).join(' | ')}`,
)

const state = await rpc(james.token, 'event_capacity_state', { p_event: lastPlace.id })
check(
  'the event now reads as sold out',
  state.body?.[0]?.state === 'sold_out' && state.body?.[0]?.confirmed === 1,
  `state ${state.body?.[0]?.state}, confirmed ${state.body?.[0]?.confirmed}`,
)

// BUY-10. Whoever won has a ticket, issued by trigger rather than by a caller.
const winner = first.ok ? james : priya
const loser = first.ok ? priya : james
const ticket = await get(winner.token, `event_tickets?event_id=eq.${lastPlace.id}&select=code`)
check(
  'the confirmed registration was issued a ticket',
  Array.isArray(ticket.body) && ticket.body.length === 1 && /^[0-9a-f]{32}$/.test(ticket.body[0].code),
  saw(ticket),
)

// QLT-08. A host pulls the event back to draft. The person holding a place
// must not lose sight of the event their ticket is for.
await write(elena.token, 'PATCH', `events?id=eq.${lastPlace.id}`, { status: 'draft' })

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

await write(elena.token, 'PATCH', `events?id=eq.${lastPlace.id}`, { status: 'published' })

// ---------------------------------------------------------------------------
// 6. ATT-02/03/06 — the door
// ---------------------------------------------------------------------------

const code = ticket.body?.[0]?.code

const scan1 = await rpc(elena.token, 'check_in', { p_ticket_code: code, p_event: lastPlace.id })
check('a valid ticket scans as ok', scan1.body === 'ok', String(scan1.body))

const scan2 = await rpc(elena.token, 'check_in', { p_ticket_code: code, p_event: lastPlace.id })
check('a second scan of the same ticket says already (ATT-03)', scan2.body === 'already', String(scan2.body))

const wrongEvent = await rpc(elena.token, 'check_in', { p_ticket_code: code, p_event: draft.id })
check('a ticket for another event is rejected as wrong_event', wrongEvent.body === 'wrong_event', String(wrongEvent.body))

const nonsense = await rpc(elena.token, 'check_in', {
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
const hostPresent = await rpc(elena.token, 'mark_attended', {
  p_event: lastPlace.id,
  p_profile: elena.id,
  p_reason: 'Hosting, no ticket',
})
check('a host can record their own presence (FDB-06)', hostPresent.ok, `${hostPresent.status}`)

// ATT-02. The roster has to name whoever scanned a ticket, and staff working a
// door they did not buy a ticket for is the ordinary case. Elena hosts the free
// event and has neither registered for it nor been scanned at it.
const roster = await get(elena.token, `event_participants?event_id=eq.${free.id}&select=profile_id,is_host,attended`)
check(
  'a host who never registered or scanned is still on the roster (ATT-02)',
  Array.isArray(roster.body) &&
    roster.body.some((r) => r.profile_id === elena.id && r.is_host === true && r.attended === false),
  saw(roster),
)

// The dedupe the third union branch has to preserve: Elena hosts this one and
// was marked present, so she is produced by every branch. One row, attended.
const hostRow = await get(elena.token, `event_participants?event_id=eq.${lastPlace.id}&profile_id=eq.${elena.id}&select=attended,is_host`)
check(
  'a host who also attended appears exactly once',
  hostRow.body?.length === 1 && hostRow.body[0].attended === true && hostRow.body[0].is_host === true,
  `${hostRow.body?.length} row(s): ${JSON.stringify(hostRow.body?.[0])}`,
)

// And is_host describes the person listed, not whoever is looking.
const guestRow = await get(elena.token, `event_participants?event_id=eq.${lastPlace.id}&profile_id=eq.${winner.id}&select=attended,is_host`)
check(
  'a guest on the same roster is not marked as a host',
  guestRow.body?.length === 1 && guestRow.body[0].is_host === false,
  JSON.stringify(guestRow.body?.[0]),
)

// ---------------------------------------------------------------------------
// 7. FDB-06/09 — who may give feedback, and who may read it
// ---------------------------------------------------------------------------

const questions = await get(james.token, 'feedback_questions?select=id,scope,slot,wording,answer_format&order=scope,slot')
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
  Array.isArray(storedFeedback.body?.[0]?.host_ids) && storedFeedback.body[0].host_ids.includes(elena.id),
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
  subject_id: elena.id,
  question_id: q.peer2?.id,
  answer_choice: 'Maybe',
})
check('two present participants can review each other', peerReview.ok, `${peerReview.status}`)

// FDB-05/07. The author sees outcomes and never answers, not even their own.
const progress = await get(winner.token, `my_feedback_progress?event_id=eq.${lastPlace.id}&select=subject_id,subject_name,outcome`)
check(
  'the author sees their own progress as outcomes only',
  Array.isArray(progress.body) &&
    progress.body.some((r) => r.subject_id === elena.id && r.outcome === 'submitted') &&
    !progress.body.some((r) => r.subject_id === winner.id),
  saw(progress),
)

const leak = await get(winner.token, 'my_feedback_progress?select=answer_text')
check('my_feedback_progress exposes no answer column', !leak.ok, `${leak.status}`)

// FDB-09/12. Admin-only on select, in policy rather than in the interface.
const peerPeek = await get(winner.token, 'peer_feedback?select=id')
check('the author of a review cannot read it back', blocked(peerPeek), saw(peerPeek))

const subjectPeek = await get(elena.token, 'peer_feedback?select=id')
check('the subject of a review, who is also the host, cannot read it', blocked(subjectPeek), saw(subjectPeek))

const eventPeek = await get(elena.token, 'event_feedback?select=id')
check('a non-admin host cannot read event feedback', blocked(eventPeek), saw(eventPeek))

const subjectsPeek = await get(elena.token, 'feedback_subjects?select=id')
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

const ownCommunity = await write(elena.token, 'POST', 'event_invites', {
  event_id: free.id,
  profile_id: james.id,
  invited_by: elena.id,
  via_connector_id: connectorId,
})
check('a host can invite somebody from their own community', ownCommunity.ok, `${ownCommunity.status}`)

const otherCommunity = await write(elena.token, 'POST', 'event_invites', {
  event_id: free.id,
  profile_id: sofia.id,
  invited_by: elena.id,
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
  james.token,
  `notifications?kind=eq.event_invited&event_id=eq.${free.id}&select=id,actor_id,read_at`,
)
check(
  'an invited person gets an in-app notification too (ORG-08B)',
  invitedBell.body?.length === 1 && invitedBell.body[0].actor_id === elena.id,
  `${invitedBell.body?.length} notice(s), actor ${invitedBell.body?.[0]?.actor_id}`,
)

// EML-05A. A resend while the first notice is still unread must not stack a
// second identical one — the partial unique index covers first asks only, so
// nothing else stops repeated clicks becoming repeated notices.
const resend = await write(elena.token, 'POST', 'event_invites', {
  event_id: free.id,
  profile_id: james.id,
  invited_by: elena.id,
  via_connector_id: connectorId,
  resend_of: ownCommunity.body?.[0]?.id,
})
check('a deliberate resend is allowed as a new row (EML-05A)', resend.ok, `${resend.status}`)

const afterResend = await get(
  james.token,
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
  profile_id: elena.id,
  invited_by: admin.id,
})
const hostBell = await get(
  elena.token,
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

const probe = await signUpOrIn('deletion.probe@ramedia.dev', 'Wren Ashby')
await rpc(probe.token, 'create_event_account', { p_full_name: 'Wren Ashby' })
await write(probe.token, 'PATCH', `profiles?id=eq.${probe.id}`, {
  current_profession: 'Stage manager',
})
await rpc(probe.token, 'register_free', { p_event: free.id })
await rpc(elena.token, 'mark_attended', {
  p_event: free.id,
  p_profile: probe.id,
  p_reason: 'On the door',
})

const closedAccount = await rpc(probe.token, 'delete_my_account')
check('an account with no money in flight can close itself', closedAccount.ok, `${closedAccount.status}`)

const orphanedAttendance = await get(
  elena.token,
  `event_attendance?event_id=eq.${free.id}&profile_id=is.null&select=id,method,recorded_at`,
)
check(
  'the attendance record survives the person who earned it (§9)',
  Array.isArray(orphanedAttendance.body) && orphanedAttendance.body.length === 1,
  saw(orphanedAttendance),
)

const goneRegistration = await get(
  elena.token,
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

await write(elena.token, 'PATCH', `events?id=eq.${free.id}`, { registration_closed: true })
const closed = await rpc(james.token, 'event_capacity_state', { p_event: free.id })
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

const freedUp = await rpc(james.token, 'event_capacity_state', { p_event: lastPlace.id })
check(
  'the cancelled place is available again',
  freedUp.body?.[0]?.state === 'open' && freedUp.body?.[0]?.confirmed === 0,
  `state ${freedUp.body?.[0]?.state}, confirmed ${freedUp.body?.[0]?.confirmed}`,
)

const deadTicket = await rpc(elena.token, 'check_in', { p_ticket_code: code, p_event: lastPlace.id })
check('a cancelled registration stops scanning', deadTicket.body === 'cancelled', String(deadTicket.body))

// ---------------------------------------------------------------------------
// 12. ORG-07/08 — the guest list a host operates from
// ---------------------------------------------------------------------------

const guestList = await get(
  elena.token,
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
const listLeak = await get(elena.token, 'event_guest_list?select=semantic_summary')
check('the guest list exposes no profile internals', !listLeak.ok, `${listLeak.status}`)

// ---------------------------------------------------------------------------
// 13. ORG-01C — switching the permission off does not lock an organiser out
//
// The rule that is easiest to get wrong, and the one with the worst failure
// mode: a host locked out of the guest list of an event that is happening
// tomorrow.
// ---------------------------------------------------------------------------

await setConnector({ can_create_events: false })

const stillEditing = await write(elena.token, 'PATCH', `events?id=eq.${draft.id}`, {
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

const stillSelling = await write(elena.token, 'POST', 'ticket_types', {
  event_id: draft.id,
  name: 'Added after the permission was withdrawn',
  price_cents: 0,
})
check('permission off: they can still manage tickets', stillSelling.ok, `${stillSelling.status}`)

const newOne = await createDraft(elena.token, { title: 'Refused again' })
check(
  'permission off: they still cannot start another event',
  !newOne.res.ok,
  `${newOne.res.status}`,
)

// ---------------------------------------------------------------------------
// Put everything back
// ---------------------------------------------------------------------------

for (const id of createdEvents) {
  await write(admin.token, 'DELETE', `events?id=eq.${id}`)
}
await setConnector({
  can_create_events: originalConnector.can_create_events,
  stripe_account_id: originalConnector.stripe_account_id,
  stripe_charges_enabled: originalConnector.stripe_charges_enabled,
  stripe_account_status: originalConnector.stripe_account_status,
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
