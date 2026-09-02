/**
 * Seeds a working demo by driving the real application code paths:
 * admin -> create_connector_invitation -> redeem_code (connector)
 *       -> create_invite_code -> redeem_code (members) -> notes.
 *
 * Auth users are created with email_confirm:true via the admin API purely so
 * this can run while "Confirm email" is still switched on in the project.
 */
const URL = process.env.SUPABASE_URL
const PUB = process.env.PUB
const SR = process.env.SR
const PASSWORD = 'AmazingDemo2026!'

const adminHeaders = { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }

async function createUser(email, fullName) {
  const res = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  })
  const body = await res.json()
  if (!res.ok && !String(body.msg ?? body.message ?? '').includes('already been registered')) {
    throw new Error(`createUser ${email}: ${JSON.stringify(body)}`)
  }
  return body
}

async function signIn(email) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`signIn ${email}: ${JSON.stringify(body)}`)
  return { token: body.access_token, id: body.user.id }
}

async function rpc(token, fn, args) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: PUB, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${fn}: ${JSON.stringify(body)}`)
  return body
}

async function patchProfile(token, id, fields) {
  const res = await fetch(`${URL}/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`patchProfile: ${await res.text()}`)
}

async function insertNote(token, note) {
  const res = await fetch(`${URL}/rest/v1/connector_notes`, {
    method: 'POST',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(note),
  })
  if (!res.ok) throw new Error(`insertNote: ${await res.text()}`)
}

/* -------------------------------------------------------------------------- */

console.log('1. admin account')
await createUser('moshe@valued.ventures', 'Moshe')
const admin = await signIn('moshe@valued.ventures')
console.log('   signed in as admin', admin.id)

console.log('2. admin creates a connector')
const invitation = await rpc(admin.token, 'create_connector_invitation', {
  p_full_name: 'Elena Vasquez',
  p_email: 'zalmytouger@gmail.com',
  p_capacity: 8,
})
console.log('   claim code', invitation.claim_code)

console.log('3. connector claims the account')
await createUser('zalmytouger@gmail.com', 'Elena Vasquez')
const connector = await signIn('zalmytouger@gmail.com')
const claimed = await rpc(connector.token, 'redeem_code', {
  p_code: invitation.claim_code,
  p_full_name: 'Elena Vasquez',
})
console.log('   connector first invite code', claimed.invite_code)

await patchProfile(connector.token, connector.id, {
  current_profession: 'Partner, Meridian Capital',
  semantic_summary:
    'I back founders building infrastructure for the energy transition. Twenty years between operating and investing, and I care most about the unglamorous middle layer — the software that makes physical projects financeable.',
})

console.log('4. connector mints a shared code')
const shared = await rpc(connector.token, 'create_invite_code', { p_max_uses: 3 })
console.log('   shared code', shared.code)

console.log('5. members join')
const MEMBERS = [
  {
    email: 'mn26ventures@gmail.com',
    name: 'James Oduya',
    profession: 'Founder & CEO, Northwind Grid',
    summary:
      'Building distribution-level grid software for utilities across West Africa. Previously ten years in power systems engineering. Curious about how regulation actually moves, and looking for operators who have taken hardware into regulated markets.',
    code: claimed.invite_code,
    note: 'Met James through the Lagos energy cohort. Genuinely rare combination — deep power systems background and a real commercial instinct. Worth introducing to anyone in grid-adjacent infrastructure.',
    shareNote: true,
  },
  {
    email: 'priya.raghavan@ramedia.dev',
    name: 'Priya Raghavan',
    profession: 'Head of Design, Lumen Health',
    summary:
      'I design clinical software that nurses actually want to use. Spent five years watching good products fail on the ward because nobody watched the ward. Interested in people working where design meets regulated environments.',
    code: shared.code,
    note: 'Priya is the most rigorous design thinker I know in health tech. She is quietly looking at what is next — do not surface that broadly.',
    shareNote: false,
  },
  {
    email: 'tomas.lindqvist@ramedia.dev',
    name: 'Tomas Lindqvist',
    profession: 'General Counsel, Aster Materials',
    summary:
      'Commercial lawyer by training, increasingly pulled into strategy. I spend my time on supply agreements for critical minerals and I am trying to understand the technical side properly rather than nodding along.',
    code: shared.code,
    note: 'Tomas asked to be introduced to people working on minerals traceability. Reliable, low-ego, follows up.',
    shareNote: true,
  },
]

for (const member of MEMBERS) {
  await createUser(member.email, member.name)
  const session = await signIn(member.email)
  await rpc(session.token, 'redeem_code', { p_code: member.code, p_full_name: member.name })
  await patchProfile(session.token, session.id, {
    current_profession: member.profession,
    semantic_summary: member.summary,
  })
  await insertNote(connector.token, {
    connector_id: claimed.connector_id,
    user_profile_id: session.id,
    note_text: member.note,
    is_searchable_by_admin: member.shareNote,
  })
  console.log(`   ${member.name} joined on ${member.code}`)
}

console.log('6. a second connector, left unclaimed')
const pending = await rpc(admin.token, 'create_connector_invitation', {
  p_full_name: 'Daniel Abiodun',
  p_email: 'daniel.abiodun@ramedia.dev',
  p_capacity: 5,
})
console.log('   unclaimed claim code', pending.claim_code)

console.log('\nDone. Password for every seeded account:', PASSWORD)
