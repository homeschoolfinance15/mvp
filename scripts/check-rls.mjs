/** Asserts the row level security rules actually hold against the live project. */
const URL = process.env.SUPABASE_URL
const PUB = process.env.PUB
const PASSWORD = 'AmazingDemo2026!'

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
  return { status: r.status, body: await r.json() }
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const admin = await signIn('moshe@valued.ventures')
const connector = await signIn('elena.vasquez@ramedia.dev')
const james = await signIn('james.oduya@ramedia.dev')
const priya = await signIn('priya.raghavan@ramedia.dev')

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

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
