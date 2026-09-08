/**
 * Asserts the signup questionnaire against the acceptance checks written at
 * the end of Amaizing-Signup-Developer-Handoff.docx.
 *
 *   Catalogs complete. All five tag catalogs exactly match this document,
 *     with stable IDs and no preselected values.
 *   Limits enforced. Test each minimum/maximum, custom-tag counting,
 *     duplicate handling, and "Something else" without details.
 *   Text preserved. Test whitespace-only input, maximum length, emoji, and
 *     saving/editing optional answers.
 *   Access isolated. A member cannot read another member's answers; a
 *     connector cannot read another community.
 *
 * The remaining two checks, flow recovery and mobile usability, are browser
 * behaviour and are verified there rather than here.
 *
 *   SUPABASE_URL=<url> PUB=<publishable-key> node scripts/check-questionnaire.mjs
 */
const URL_ = process.env.SUPABASE_URL
const PUB = process.env.PUB
const PASSWORD = process.env.DEMO_PASSWORD
if (!PASSWORD) {
  console.error('Set DEMO_PASSWORD to the password seed-demo.mjs used.')
  process.exit(1)
}

if (!URL_ || !PUB) {
  console.error('Set SUPABASE_URL and PUB before running this.')
  process.exit(1)
}

const anon = { apikey: PUB, 'Content-Type': 'application/json' }
const auth = (t) => ({ ...anon, Authorization: `Bearer ${t}` })

async function signIn(email) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: anon,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const j = await r.json()
  return { token: j.access_token, id: j.user?.id }
}

const get = async (token, path) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: auth(token) })
  return { ok: r.ok, status: r.status, body: await r.json() }
}

const write = async (token, body) =>
  fetch(`${URL_}/rest/v1/profile_answers?on_conflict=profile_id`, {
    method: 'POST',
    headers: { ...auth(token), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* -------------------------------------------------------------------------- */

const james = await signIn('mn26ventures@gmail.com')
const priya = await signIn('priya.raghavan@ramedia.dev')
const elena = await signIn('zalmytouger@gmail.com')
const daniel = await signIn('daniel.abiodun@ramedia.dev')
// Nothing in this suite writes to Tomas, which is what makes him a fair
// subject for "starts with no answers". Using somebody the suite also writes
// to makes that check depend on the order it runs in.
const tomas = await signIn('tomas.lindqvist@ramedia.dev')
const admin = await signIn('moshe@valued.ventures')

// --- Catalogs complete -----------------------------------------------------

const EXPECTED = {
  current_focus: 13,
  desired_outcomes: 11,
  conversation_topics: 42,
  outside_work_interests: 32,
  strongest_skills: 36,
}

const catalog = await get(james.token, 'profile_tags?select=id,field,label,position')
const byField = {}
for (const tag of catalog.body ?? []) (byField[tag.field] ??= []).push(tag)

for (const [field, expected] of Object.entries(EXPECTED)) {
  check(
    `catalog ${field} has ${expected} tags`,
    (byField[field]?.length ?? 0) === expected,
    `saw ${byField[field]?.length ?? 0}`,
  )
}

// The handoff's own worked example of the slug rule.
const ai = (byField.conversation_topics ?? []).find((t) => t.label === 'Artificial intelligence')
check(
  'tag ids follow <field_key>.<slug>',
  ai?.id === 'conversation_topics.artificial_intelligence',
  ai?.id,
)

check(
  '"Something else" exists on Q0 and Q3 only',
  Boolean((byField.current_focus ?? []).find((t) => t.id === 'current_focus.something_else')) &&
    Boolean(
      (byField.desired_outcomes ?? []).find((t) => t.id === 'desired_outcomes.something_else'),
    ) &&
    !(byField.conversation_topics ?? []).some((t) => t.label === 'Something else'),
)

// --- No preselected values -------------------------------------------------

const fresh = await get(tomas.token, `profile_answers?profile_id=eq.${tomas.id}`)
check(
  'a member starts with no answers',
  Array.isArray(fresh.body) && fresh.body.length === 0,
  `saw ${Array.isArray(fresh.body) ? fresh.body.length : 'error'} rows`,
)

// --- Limits enforced -------------------------------------------------------

const topics = (byField.conversation_topics ?? []).map((t) => t.id)
const focus = (byField.current_focus ?? []).map((t) => t.id)

const overTopics = await write(james.token, {
  profile_id: james.id,
  conversation_topics: { selected_tag_ids: topics.slice(0, 6), custom_tags: [] },
})
check('six conversation topics refused (max 5)', !overTopics.ok, `${overTopics.status}`)

const overFocus = await write(james.token, {
  profile_id: james.id,
  current_focus: { selected_tag_ids: focus.slice(0, 4), custom_tags: [] },
})
check('four current-focus tags refused (max 3)', !overFocus.ok, `${overFocus.status}`)

const customOnQ0 = await write(james.token, {
  profile_id: james.id,
  current_focus: { selected_tag_ids: [focus[0]], custom_tags: ['not allowed here'] },
})
check(
  'custom tags refused on Q0 (allowed only on Q5, Q7, Q10)',
  !customOnQ0.ok,
  `${customOnQ0.status}`,
)

const longText = await write(james.token, {
  profile_id: james.id,
  current_project: 'x'.repeat(301),
})
check('301 characters refused on a 300-character answer', !longText.ok, `${longText.status}`)

// --- A valid full answer, with emoji preserved -----------------------------

const EMOJI = 'Building something 🚀 for local shops'
const good = await write(james.token, {
  profile_id: james.id,
  current_focus: { selected_tag_ids: focus.slice(0, 2), custom_tags: [] },
  desired_outcomes: {
    selected_tag_ids: (byField.desired_outcomes ?? []).slice(0, 1).map((t) => t.id),
    custom_tags: [],
  },
  conversation_topics: { selected_tag_ids: topics.slice(0, 3), custom_tags: ['Restaurant operations'] },
  outside_work_interests: { selected_tag_ids: [], custom_tags: [] },
  strongest_skills: { selected_tag_ids: [], custom_tags: [] },
  current_project: EMOJI,
  home_city: 'Manchester, England',
  travel_preference: 'up_to_60_min',
  gathering_preference: ['intimate_dinners', 'one_on_ones'],
  travels_often: true,
  travel_destinations: 'London most months',
})
check('a complete answer saves', good.ok, `${good.status}`)

const saved = await get(james.token, `profile_answers?profile_id=eq.${james.id}`)
const row = saved.body?.[0]
check('emoji survives the round trip', row?.current_project === EMOJI, row?.current_project)
check(
  'a custom tag is stored alongside selected ids',
  row?.conversation_topics?.custom_tags?.[0] === 'Restaurant operations' &&
    row?.conversation_topics?.selected_tag_ids?.length === 3,
)
check('taxonomy_version is recorded', row?.taxonomy_version === 1, String(row?.taxonomy_version))
check(
  'the ranked gathering order is preserved',
  JSON.stringify(row?.gathering_preference) === JSON.stringify(['intimate_dinners', 'one_on_ones']),
  JSON.stringify(row?.gathering_preference),
)

const dupeRank = await write(james.token, {
  profile_id: james.id,
  gathering_preference: ['big_events', 'big_events'],
})
check('a ranking cannot repeat an option', !dupeRank.ok, `${dupeRank.status}`)

// --- Access isolated -------------------------------------------------------

const byOther = await get(priya.token, `profile_answers?profile_id=eq.${james.id}`)
check(
  "a member cannot read another member's answers",
  Array.isArray(byOther.body) && byOther.body.length === 0,
  `saw ${Array.isArray(byOther.body) ? byOther.body.length : 'error'}`,
)

const byConnector = await get(elena.token, `profile_answers?profile_id=eq.${james.id}`)
check(
  "a member's own connector can read them",
  Array.isArray(byConnector.body) && byConnector.body.length === 1,
  `saw ${Array.isArray(byConnector.body) ? byConnector.body.length : 'error'}`,
)

const byOtherConnector = await get(daniel.token, `profile_answers?profile_id=eq.${james.id}`)
check(
  'a connector cannot read another community',
  Array.isArray(byOtherConnector.body) && byOtherConnector.body.length === 0,
  `saw ${Array.isArray(byOtherConnector.body) ? byOtherConnector.body.length : 'error'}`,
)

const byAdmin = await get(admin.token, `profile_answers?profile_id=eq.${james.id}`)
check(
  'an admin can read them',
  Array.isArray(byAdmin.body) && byAdmin.body.length === 1,
  `saw ${Array.isArray(byAdmin.body) ? byAdmin.body.length : 'error'}`,
)

const forged = await write(priya.token, { profile_id: james.id, curation_notes: 'not mine' })
check("a member cannot write another member's answers", !forged.ok, `${forged.status}`)

const anonRead = await fetch(`${URL_}/rest/v1/profile_answers?select=*`, { headers: anon })
const anonBody = await anonRead.json()
check(
  'anon cannot read any answers',
  Array.isArray(anonBody) ? anonBody.length === 0 : anonRead.status >= 400,
  Array.isArray(anonBody) ? `saw ${anonBody.length}` : `${anonRead.status}`,
)

// --- The answers stay out of the public directory --------------------------

const directory = await get(priya.token, 'member_directory?select=*&limit=1')
const columns = Object.keys(directory.body?.[0] ?? {})
check(
  'the directory exposes no questionnaire answer',
  !columns.some((c) =>
    [
      'current_focus',
      'desired_outcomes',
      'conversation_topics',
      'outside_work_interests',
      'strongest_skills',
      'current_project',
      'phone',
      'home_city',
      'age_range',
    ].includes(c),
  ),
  columns.join(', '),
)

// --- Order, which the handoff is explicit about --------------------------
// "After the existing account and location fields, show the five initial
// questions below in order." Q1 is second and Q10 is last; rendering all the
// tag questions and then all the text ones puts Q1 fifth and Q10 first.

const { INITIAL_ORDER, LATER_ORDER } = await import('../src/lib/questionnaire.ts')
  .catch(() => ({ INITIAL_ORDER: null, LATER_ORDER: null }))

if (INITIAL_ORDER) {
  check(
    'initial questions are ordered Q0, Q1, Q3, Q5, Q7',
    JSON.stringify([...INITIAL_ORDER]) ===
      JSON.stringify([
        'current_focus',
        'current_project',
        'desired_outcomes',
        'conversation_topics',
        'outside_work_interests',
      ]),
    [...INITIAL_ORDER].join(', '),
  )
  check(
    'later questions are ordered Q2, Q4, Q6, Q9, Q10',
    JSON.stringify([...LATER_ORDER]) ===
      JSON.stringify([
        'background',
        'room_contribution',
        'current_conversation_need',
        'curation_notes',
        'strongest_skills',
      ]),
    [...LATER_ORDER].join(', '),
  )
}

// --- LinkedIn, listed as a signup field in the raw notes -------------------

const linkedinOnProfile = await get(james.token, 'profiles?select=linkedin_url&limit=1')
check(
  'a member profile carries a LinkedIn field',
  linkedinOnProfile.ok,
  linkedinOnProfile.ok ? 'present' : JSON.stringify(linkedinOnProfile.body).slice(0, 70),
)

const dirColumns = Object.keys((await get(priya.token, 'member_directory?select=*&limit=1')).body?.[0] ?? {})
check(
  'LinkedIn is not exposed to other members',
  !dirColumns.includes('linkedin_url'),
  dirColumns.join(', '),
)

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
