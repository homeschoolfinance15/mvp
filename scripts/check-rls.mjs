/** Asserts the row level security rules actually hold against the live project. */
const URL = process.env.SUPABASE_URL
const PUB = process.env.PUB
const PASSWORD = process.env.DEMO_PASSWORD
if (!PASSWORD) {
  console.error('Set DEMO_PASSWORD to the password seed-demo.mjs used.')
  process.exit(1)
}

async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const j = await r.json()
  return { token: j.access_token, id: j.user.id }
}

function headers(token) {
  return token
    ? { apikey: PUB, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { apikey: PUB, 'Content-Type': 'application/json' }
}

async function get(token, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: headers(token) })
  return { ok: r.ok, status: r.status, body: await r.json() }
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const admin = await signIn('moshe@valued.ventures')
const connector = await signIn('zalmytouger@gmail.com')
const james = await signIn('mn26ventures@gmail.com')
const priya = await signIn('priya.raghavan@ramedia.dev')
// Sofia was invited by a different connector, so she is the only person here
// who can prove that one circle cannot reach another. Priya and James share
// Elena's circle, which is why using Priya for that check passed vacuously.
const sofia = await signIn('sofia.mensah@ramedia.dev')

// 1. A member sees only themselves and their connector — not other members.
const jamesProfiles = await get(james.token, 'profiles?select=id,full_name,role')
const names = jamesProfiles.body.map((p) => p.full_name).sort()
check(
  'member sees only self + their connector',
  jamesProfiles.body.length === 2 && names.includes('Elena Vasquez') && names.includes('James Oduya'),
  `saw ${jamesProfiles.body.length}: ${names.join(', ')}`,
)

// 2. A member cannot read notes written about them.
const jamesNotes = await get(james.token, 'connector_notes?select=*')
check(
  'member cannot read notes about themselves',
  Array.isArray(jamesNotes.body) && jamesNotes.body.length === 0,
  `saw ${Array.isArray(jamesNotes.body) ? jamesNotes.body.length : 'error'}`,
)

// 3. The connector sees all three of their own notes.
const connectorNotes = await get(connector.token, 'connector_notes?select=*')
check(
  'connector reads all their own notes',
  connectorNotes.body.length === 3,
  `saw ${connectorNotes.body.length}`,
)

// 4. The admin sees only notes flagged searchable (Priya's was marked private).
const adminNotes = await get(admin.token, 'connector_notes?select=*,is_searchable_by_admin')
const allShared = adminNotes.body.every((n) => n.is_searchable_by_admin)
check(
  'admin sees only admin-searchable notes',
  adminNotes.body.length === 2 && allShared,
  `saw ${adminNotes.body.length} of 3, all shared: ${allShared}`,
)

// 5. A member cannot promote themselves to admin.
const escalate = await fetch(`${URL}/rest/v1/profiles?id=eq.${priya.id}`, {
  method: 'PATCH',
  headers: { ...headers(priya.token), Prefer: 'return=representation' },
  body: JSON.stringify({ role: 'admin', profile_status: 'active' }),
})
const escalated = await escalate.json()
check(
  'member cannot escalate their own role',
  escalate.ok && escalated[0]?.role === 'user',
  `role after attempt: ${escalated[0]?.role}`,
)

// 6. Anonymous visitors cannot read the waitlist they can write to.
// Either an outright permission denial or an empty result satisfies this;
// the grant is withheld from anon, so PostgREST refuses before RLS is consulted.
const anonWaitlist = await get(null, 'waitlist_entries?select=*')
const anonBlocked = Array.isArray(anonWaitlist.body)
  ? anonWaitlist.body.length === 0
  : anonWaitlist.status === 401 || anonWaitlist.status === 403
check(
  'anon cannot read the waitlist',
  anonBlocked,
  Array.isArray(anonWaitlist.body)
    ? `saw ${anonWaitlist.body.length} rows`
    : `${anonWaitlist.status} ${anonWaitlist.body.message}`,
)

// 7. A member cannot enumerate connector claim codes.
const anonInvites = await get(james.token, 'connector_invitations?select=*')
check(
  'member cannot read connector claim codes',
  Array.isArray(anonInvites.body) && anonInvites.body.length === 0,
  `saw ${Array.isArray(anonInvites.body) ? anonInvites.body.length : 'error'}`,
)

// 8. A member cannot create an invitation code.
const mintAttempt = await fetch(`${URL}/rest/v1/rpc/create_invite_code`, {
  method: 'POST',
  headers: headers(james.token),
  body: JSON.stringify({ p_max_uses: 5 }),
})
const mintBody = await mintAttempt.json()
check(
  'member cannot mint invitation codes',
  !mintAttempt.ok && String(mintBody.message).includes('Only a connector'),
  mintBody.message,
)

// 9. A connector cannot create another connector.
const connectorAttempt = await fetch(`${URL}/rest/v1/rpc/create_connector_invitation`, {
  method: 'POST',
  headers: headers(connector.token),
  body: JSON.stringify({ p_full_name: 'Mallory', p_email: 'mallory@example.com', p_capacity: 99 }),
})
const connectorBody = await connectorAttempt.json()
check(
  'connector cannot create connectors',
  !connectorAttempt.ok && String(connectorBody.message).includes('administrator'),
  connectorBody.message,
)

// 10. A connector cannot assign someone off the waitlist — that is admin-only.
// The admin guard fires before the ids are looked at, so placeholders are fine.
const NIL = '00000000-0000-0000-0000-000000000000'
const assignAttempt = await fetch(`${URL}/rest/v1/rpc/assign_waitlist_entry`, {
  method: 'POST',
  headers: headers(connector.token),
  body: JSON.stringify({ p_entry_id: NIL, p_connector_id: NIL }),
})
const assignBody = await assignAttempt.json()
check(
  'connector cannot assign waitlist entries',
  !assignAttempt.ok && String(assignBody.message).includes('Only an admin'),
  assignBody.message,
)

// ---------------------------------------------------------------------------
// The shared surfaces: feed, events, circle chat, trust layer, recommender.
// These assert the state of a deployed project — they fail until the
// 20260907 migrations have been applied.
// ---------------------------------------------------------------------------

// 11. The directory widening is surgical: a member can put a name to anyone on
// the network, and still cannot read anybody's email. This is the whole reason
// member_directory exists instead of an open profiles_select, so it is the one
// check worth caring about most.
const jamesDirectory = await get(james.token, 'member_directory?select=id,full_name')
const jamesProfilesAgain = await get(james.token, 'profiles?select=id,email')
check(
  'member sees the whole directory but only two profiles',
  Array.isArray(jamesDirectory.body) &&
    jamesDirectory.body.length > 2 &&
    Array.isArray(jamesProfilesAgain.body) &&
    jamesProfilesAgain.body.length === 2,
  `directory ${jamesDirectory.body?.length}, profiles ${jamesProfilesAgain.body?.length}`,
)

// 12. And the view itself must not carry an email column at all.
const directoryLeak = await get(james.token, 'member_directory?select=email')
check(
  'member_directory exposes no email column',
  !directoryLeak.ok || (Array.isArray(directoryLeak.body) && directoryLeak.body.length === 0),
  directoryLeak.ok ? 'column resolved' : String(directoryLeak.body.message).slice(0, 60),
)

// 13. Anonymous visitors cannot read the feed.
const anonPosts = await get(null, 'posts?select=*')
check(
  'anon cannot read the feed',
  Array.isArray(anonPosts.body) ? anonPosts.body.length === 0 : anonPosts.status >= 400,
  Array.isArray(anonPosts.body) ? `saw ${anonPosts.body.length}` : `${anonPosts.status}`,
)

// 14. A member cannot post in somebody else's name.
const spoof = await fetch(`${URL}/rest/v1/posts`, {
  method: 'POST',
  headers: headers(james.token),
  body: JSON.stringify({ author_id: connector.id, body: 'Posted as my connector.' }),
})
check(
  'member cannot post as another author',
  !spoof.ok,
  `${spoof.status}`,
)

// 15. The subject of a report cannot read it. Rule 1 of the trust layer, and
// the reason anybody would ever raise one.
const reportsAboutMe = await get(james.token, `profile_reports?subject_id=eq.${james.id}`)
check(
  'a member cannot read a report filed about them',
  Array.isArray(reportsAboutMe.body) && reportsAboutMe.body.length === 0,
  `saw ${Array.isArray(reportsAboutMe.body) ? reportsAboutMe.body.length : 'error'}`,
)

// 16. Nor resolve one. The RPC is the only way status moves, and it refuses.
const resolveAttempt = await fetch(`${URL}/rest/v1/rpc/resolve_profile_report`, {
  method: 'POST',
  headers: headers(james.token),
  body: JSON.stringify({ p_report_id: '00000000-0000-0000-0000-000000000000', p_status: 'resolved' }),
})
const resolveBody = await resolveAttempt.json()
check(
  'member cannot resolve reports',
  !resolveAttempt.ok,
  String(resolveBody.message).slice(0, 70),
)

// 17. Circle chat is closed to anyone outside the circle. Sofia belongs to the
// second connector's circle, so James reaching into hers is a real crossing.
const sofiaCircle = await fetch(`${URL}/rest/v1/rpc/my_circle_id`, {
  method: 'POST',
  headers: headers(sofia.token),
  body: '{}',
})
const sofiaCircleId = await sofiaCircle.json()
const intrusion = await fetch(`${URL}/rest/v1/circle_messages`, {
  method: 'POST',
  headers: headers(james.token),
  body: JSON.stringify({
    connector_id: sofiaCircleId,
    author_id: james.id,
    body: 'Speaking into a room I am not in.',
  }),
})
check(
  'member cannot speak into another circle',
  !intrusion.ok,
  `${intrusion.status}`,
)

// 17b. And cannot read it either.
const eavesdrop = await get(james.token, `circle_messages?connector_id=eq.${sofiaCircleId}`)
check(
  'member cannot read another circle',
  Array.isArray(eavesdrop.body) && eavesdrop.body.length === 0,
  `saw ${Array.isArray(eavesdrop.body) ? eavesdrop.body.length : 'error'}`,
)

// 18. Recommendations are private to their subject, and a member cannot
// manufacture one for themselves.
const forgery = await fetch(`${URL}/rest/v1/recommendations`, {
  method: 'POST',
  headers: headers(james.token),
  body: JSON.stringify({
    profile_id: james.id,
    member_id: connector.id,
    reason: 'I recommended myself.',
    rank: 1,
    batch_id: '00000000-0000-0000-0000-000000000000',
  }),
})
check(
  'member cannot write their own recommendations',
  !forgery.ok,
  `${forgery.status}`,
)

// 19. The audit log is readable by admins and nobody else.
const memberLog = await get(james.token, 'activity_log?select=*')
check(
  'member cannot read the activity log',
  Array.isArray(memberLog.body) ? memberLog.body.length === 0 : memberLog.status >= 400,
  Array.isArray(memberLog.body) ? `saw ${memberLog.body.length}` : `${memberLog.status}`,
)

const adminLog = await get(admin.token, 'activity_log?select=id&limit=1')
check(
  'admin can read the activity log',
  adminLog.ok && Array.isArray(adminLog.body),
  adminLog.ok ? 'readable' : `${adminLog.status}`,
)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
