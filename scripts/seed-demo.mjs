/**
 * Seeds a working demo by driving the real application code paths, using only
 * the publishable key — exactly what a person going through /join does:
 *
 *   admin -> create_connector_invitation -> redeem_code (connector)
 *         -> create_invite_code -> redeem_code (members) -> notes
 *
 * No service-role key is involved, so a successful run also proves the whole
 * invite chain works for an ordinary visitor with nothing privileged.
 *
 *   SUPABASE_URL=<url> PUB=<publishable-key> DEMO_PASSWORD=<pw> node scripts/seed-demo.mjs
 */
const BASE = process.env.SUPABASE_URL
const PUB = process.env.PUB
const PASSWORD = process.env.DEMO_PASSWORD

if (!BASE || !PUB || !PASSWORD) {
  console.error('Set SUPABASE_URL, PUB and DEMO_PASSWORD before running this.')
  process.exit(1)
}

const anonHeaders = { apikey: PUB, 'Content-Type': 'application/json' }

/** Sign up, or sign in if the account already exists, and return a session. */
async function account(email, fullName) {
  const signUp = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ email, password: PASSWORD, data: { full_name: fullName } }),
  })
  const created = await signUp.json()

  if (created.access_token) {
    return { token: created.access_token, id: created.user.id, isNew: true }
  }

  const signIn = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const session = await signIn.json()
  if (!session.access_token) {
    throw new Error(`Could not sign up or sign in ${email}: ${JSON.stringify(created)}`)
  }
  return { token: session.access_token, id: session.user.id, isNew: false }
}

function authed(token) {
  return { apikey: PUB, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function rpc(token, fn, args) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify(args),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${fn}: ${JSON.stringify(body)}`)
  return body
}

async function patchProfile(token, id, fields) {
  const res = await fetch(`${BASE}/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...authed(token), Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`patchProfile: ${await res.text()}`)
}

async function insertNote(token, note) {
  return insert(token, 'connector_notes', note)
}

/** Insert and return the row, so seeded ids can be referenced afterwards. */
async function insert(token, table, body) {
  const res = await fetch(`${BASE}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...authed(token), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  const rows = await res.json()
  if (!res.ok) throw new Error(`${table}: ${JSON.stringify(rows)}`)
  return Array.isArray(rows) ? rows[0] : rows
}

/* -------------------------------------------------------------------------- */

console.log('1. administrator')
// The email is on admin_allowlist, so handle_new_user grants the admin role.
const admin = await account('moshe@valued.ventures', 'Moshe')
console.log('   signed in')

console.log('2. administrator creates a connector')
const invitation = await rpc(admin.token, 'create_connector_invitation', {
  p_full_name: 'Elena Vasquez',
  p_email: 'zalmytouger@gmail.com',
  p_capacity: 8,
})
console.log('   claim code', invitation.claim_code)

console.log('3. connector claims their account')
const connector = await account('zalmytouger@gmail.com', 'Elena Vasquez')
const claimed = await rpc(connector.token, 'redeem_code', {
  p_code: invitation.claim_code,
  p_full_name: 'Elena Vasquez',
})
console.log('   first invitation code', claimed.invite_code)

await patchProfile(connector.token, connector.id, {
  current_profession: 'Partner, Meridian Capital',
  semantic_summary:
    'I back founders building infrastructure for the energy transition. Twenty years between operating and investing, and I care most about the unglamorous middle layer, the software that makes physical projects financeable.',
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
    interests: ['energy', 'hardware', 'regulation', 'west africa'],
    code: claimed.invite_code,
    note: 'Met James through the Lagos energy cohort. Genuinely rare combination of deep power systems background and real commercial instinct. Worth introducing to anyone in grid-adjacent infrastructure.',
    shareNote: true,
  },
  {
    email: 'priya.raghavan@ramedia.dev',
    name: 'Priya Raghavan',
    profession: 'Head of Design, Lumen Health',
    summary:
      'I design clinical software that nurses actually want to use. Spent five years watching good products fail on the ward because nobody watched the ward. Interested in people working where design meets regulated environments.',
    interests: ['design', 'health', 'regulation'],
    code: shared.code,
    note: 'Priya is the most rigorous design thinker I know in health tech. She is quietly looking at what is next, so do not surface that broadly.',
    shareNote: false,
  },
  {
    email: 'tomas.lindqvist@ramedia.dev',
    name: 'Tomas Lindqvist',
    profession: 'General Counsel, Aster Materials',
    summary:
      'Commercial lawyer by training, increasingly pulled into strategy. I spend my time on supply agreements for critical minerals and I am trying to understand the technical side properly rather than nodding along.',
    interests: ['minerals', 'supply chain', 'legal'],
    code: shared.code,
    note: 'Tomas asked to be introduced to people working on minerals traceability. Reliable, low-ego, follows up.',
    shareNote: true,
  },
]

const sessions = {}

for (const member of MEMBERS) {
  const session = await account(member.email, member.name)
  sessions[member.name] = session
  await rpc(session.token, 'redeem_code', { p_code: member.code, p_full_name: member.name })
  await patchProfile(session.token, session.id, {
    current_profession: member.profession,
    semantic_summary: member.summary,
    interests: member.interests,
  })
  await insertNote(connector.token, {
    connector_id: claimed.connector_id,
    user_profile_id: session.id,
    note_text: member.note,
    is_searchable_by_admin: member.shareNote,
  })
  console.log(`   ${member.name} joined on ${member.code}`)
}

await patchProfile(connector.token, connector.id, {
  interests: ['energy', 'infrastructure', 'investing'],
})

console.log('6. the feed')
const james = sessions['James Oduya']
const priya = sessions['Priya Raghavan']
const tomas = sessions['Tomas Lindqvist']

const post = await insert(james.token, 'posts', {
  author_id: james.id,
  body: "Spent the week in Accra with two distribution utilities. The technical problem is nowhere near the hard part. The hard part is that nobody owns the meter data. If you have taken hardware into a regulated market and lived through this, I would like to buy you a coffee.",
})
const secondPost = await insert(connector.token, 'posts', {
  author_id: connector.id,
  body: 'Reading week. Three things worth your time if you invest in anything physical: the IEA electricity report, the FERC interconnection order, and any conversation with somebody who has actually built a substation.',
})

await insert(priya.token, 'post_likes', { post_id: post.id, profile_id: priya.id })
await insert(tomas.token, 'post_likes', { post_id: post.id, profile_id: tomas.id })
await insert(connector.token, 'post_likes', { post_id: post.id, profile_id: connector.id })
await insert(james.token, 'post_likes', { post_id: secondPost.id, profile_id: james.id })

await insert(tomas.token, 'post_comments', {
  post_id: post.id,
  author_id: tomas.id,
  body: 'Metering data ownership is a contract problem before it is a technical one. Happy to walk you through how we structured ours.',
})
await insert(priya.token, 'post_comments', {
  post_id: post.id,
  author_id: priya.id,
  body: 'This is the same shape as clinical records. Nobody owns the data and everybody depends on it.',
})
console.log('   2 posts, 4 likes, 2 comments')

console.log('7. an event, with people going')
const inAWeek = new Date(Date.now() + 7 * 864e5)
inAWeek.setHours(18, 30, 0, 0)
const event = await insert(connector.token, 'events', {
  host_id: connector.id,
  title: 'Founders dinner: infrastructure that has to touch the ground',
  description:
    'Twelve people, one long table, no panel. Bring a problem you are actually stuck on. Dinner is covered; getting there is not.',
  location: 'The Hoxton, Shoreditch',
  starts_at: inAWeek.toISOString(),
})
await insert(james.token, 'event_invitations', {
  event_id: event.id, profile_id: james.id, status: 'going', responded_at: new Date().toISOString(),
})
await insert(tomas.token, 'event_invitations', {
  event_id: event.id, profile_id: tomas.id, status: 'going', responded_at: new Date().toISOString(),
})
await insert(connector.token, 'event_invitations', {
  event_id: event.id, profile_id: priya.id, status: 'invited',
})
await insert(james.token, 'posts', {
  author_id: james.id,
  event_id: event.id,
  body: 'Is anyone driving up from Bristol? Happy to split the trip.',
})
console.log('   1 event, 2 going, 1 invited, 1 note on it')

console.log('8. the circle talks')
for (const [who, text] of [
  [james, 'Anyone going to the dinner on the 14th?'],
  [tomas, 'I am. Coming in the afternoon before if anyone wants to get there early.'],
  [connector, 'Good. Bring the minerals traceability question, Tomas. James will have opinions.'],
]) {
  await insert(who.token, 'circle_messages', {
    connector_id: claimed.connector_id,
    author_id: who.id,
    body: text,
  })
}
console.log('   3 messages')

console.log('9. somebody raises a correction')
await insert(priya.token, 'profile_reports', {
  subject_id: tomas.id,
  reporter_id: priya.id,
  kind: 'correction',
  field: 'current_profession',
  body: 'Tomas mentioned at the last dinner that he moved out of the GC role in the spring and is consulting now. His profile still says General Counsel.',
})
console.log('   1 open correction, visible to Elena and admins only')

console.log('10. a second connector, with a circle of their own')
// Two circles, not one. Without a second the isolation between them cannot be
// demonstrated or tested: everyone would be in the same room by default.
const secondInvitation = await rpc(admin.token, 'create_connector_invitation', {
  p_full_name: 'Daniel Abiodun',
  p_email: 'daniel.abiodun@ramedia.dev',
  p_capacity: 5,
})
const daniel = await account('daniel.abiodun@ramedia.dev', 'Daniel Abiodun')
const danielClaimed = await rpc(daniel.token, 'redeem_code', {
  p_code: secondInvitation.claim_code,
  p_full_name: 'Daniel Abiodun',
})
await patchProfile(daniel.token, daniel.id, {
  current_profession: 'Founder, Kestrel Logistics',
  semantic_summary:
    'I move things that are awkward to move. Cold chain across three countries, and a growing interest in who actually carries the risk when a shipment sits at a border.',
  interests: ['logistics', 'trade', 'operations'],
})

const sofia = await account('sofia.mensah@ramedia.dev', 'Sofia Mensah')
await rpc(sofia.token, 'redeem_code', {
  p_code: danielClaimed.invite_code,
  p_full_name: 'Sofia Mensah',
})
await patchProfile(sofia.token, sofia.id, {
  current_profession: 'Director of Trade Finance, Ashanti Bank',
  semantic_summary:
    'I underwrite the working capital behind physical trade. Most of my week is spent deciding which counterparties deserve terms they have not earned yet.',
  interests: ['trade finance', 'risk', 'banking'],
})
await insert(daniel.token, 'circle_messages', {
  connector_id: danielClaimed.connector_id,
  author_id: daniel.id,
  body: 'Welcome Sofia. This room is just us for now.',
})
console.log('   Daniel claimed, Sofia joined, second circle talking')

console.log('11. a third connector, left unclaimed for demos')
const pending = await rpc(admin.token, 'create_connector_invitation', {
  p_full_name: 'Marta Reyes',
  p_email: 'marta.reyes@ramedia.dev',
  p_capacity: 5,
})
console.log('   unclaimed claim code', pending.claim_code)

console.log('\nDone.')
console.log('Password for every seeded account:', PASSWORD)
console.log('Connector claim code to try:', pending.claim_code)
console.log('Member invitation code to try:', claimed.invite_code)
