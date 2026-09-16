/**
 * What `event_sale_readiness()` actually returns, in every state.
 *
 * This exists because of a failure worth not repeating. The contract for this
 * one function changed three times across two migrations, and instructions
 * about it were issued from a reading taken before the last two landed. Four
 * rounds of work were built against a shape production did not have, and the
 * contradiction was caught by someone with no database access reading the
 * migration history — because the person holding the credentials had probed
 * once and then kept talking.
 *
 * So: this makes "what does it actually return" a command rather than a thing
 * somebody has to remember to check. Run it before instructing anyone about
 * this contract, and paste the output rather than describing it.
 *
 *   SB_URL=… SB_SERVICE=… SB_PUB=… node scripts/check-readiness.mjs
 *
 * It creates its own connector and event, walks them through all five payment
 * states, prints what comes back, asserts the contract holds, and deletes
 * everything it made — including on failure.
 */

const URL = process.env.SB_URL
const SERVICE = process.env.SB_SERVICE
const PUB = process.env.SB_PUB
if (!URL || !SERVICE || !PUB) {
  console.error('Set SB_URL, SB_SERVICE and SB_PUB.')
  process.exit(1)
}

const TAG = `rdy-${Date.now()}`
const PW = `Readiness-${Date.now()}-Aa1!`
const made = { users: [], events: [] }
let pass = 0
let fail = 0

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const svc = (p, o = {}) => fetch(`${URL}/rest/v1/${p}`, {
  ...o,
  headers: {
    apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
    ...(o.headers || {}),
  },
})

const as = (tok, p, o = {}) => fetch(`${URL}/rest/v1/${p}`, {
  ...o,
  headers: {
    apikey: PUB, Authorization: `Bearer ${tok}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
    ...(o.headers || {}),
  },
})

/**
 * Role is set at insert time on purpose. A service-role PATCH of
 * profiles.role is silently reverted by protect_profile_fields — auth.uid()
 * is null for the service key, so it is not an admin, so role is pinned. It
 * returns 200 and changes nothing.
 */
async function makeUser(label, name, role) {
  const email = `${TAG}-${label}@acceptance.invalid`
  const u = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, email_confirm: true }),
  }).then(r => r.json())
  if (!u.id) throw new Error(`could not create ${label}: ${JSON.stringify(u).slice(0, 200)}`)
  made.users.push(u.id)
  await svc('profiles', {
    method: 'POST',
    body: JSON.stringify({ id: u.id, full_name: name, email, role, profile_status: 'active', current_profession: 'Readiness probe' }),
  })
  const t = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  }).then(r => r.json())
  return { id: u.id, token: t.access_token }
}

async function cleanup() {
  // Events before people: an event cascades its registrations, tickets and
  // queued messages, and erasure deliberately keeps attendance rows past the
  // person — so removing profiles first would orphan the events.
  for (const id of made.events) await svc(`events?id=eq.${id}`, { method: 'DELETE' })
  for (const id of made.users) {
    await fetch(`${URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    })
  }
}

/** The five payment states a connector can be in, as Stripe reports them. */
const STATES = [
  ['no account',        { stripe_account_id: null,      stripe_account_status: 'none',         stripe_charges_enabled: false }],
  ['pending onboarding',{ stripe_account_id: 'acct_rdy',stripe_account_status: 'pending',      stripe_charges_enabled: false }],
  ['restricted',        { stripe_account_id: 'acct_rdy',stripe_account_status: 'restricted',   stripe_charges_enabled: false }],
  ['disconnected',      { stripe_account_id: null,      stripe_account_status: 'disconnected', stripe_charges_enabled: false }],
  ['ready',             { stripe_account_id: 'acct_rdy',stripe_account_status: 'ready',        stripe_charges_enabled: true  }],
]

async function main() {
  console.log(`\nevent_sale_readiness() — live contract, tag ${TAG}\n`)

  const admin = await makeUser('adm', 'Readiness Admin', 'admin')
  const host = await makeUser('host', 'Readiness Host', 'connector')

  const conn = await svc('connectors', {
    method: 'POST', body: JSON.stringify({ profile_id: host.id }),
  }).then(r => r.json())
  const connectorId = conn[0]?.id
  await svc(`connectors?id=eq.${connectorId}`, {
    method: 'PATCH', body: JSON.stringify({ can_create_events: true }),
  })

  const starts = new Date(Date.now() + 10 * 864e5).toISOString()
  const mk = async (who) => {
    const e = await as(who.token, 'events', {
      method: 'POST',
      body: JSON.stringify({ host_id: who.id, title: `${TAG} probe`, starts_at: starts }),
    }).then(r => r.json())
    if (e[0]?.id) made.events.push(e[0].id)
    return e[0]
  }
  const connectorEvent = await mk(host)
  const platformEvent = await mk(admin)

  const read = async (eventId, tok) =>
    (await as(tok, 'rpc/event_sale_readiness', {
      method: 'POST', body: JSON.stringify({ p_event: eventId }),
    }).then(r => r.json()))[0]

  console.log('  state                can_sell  reason            fix_action')
  console.log('  ' + '-'.repeat(66))
  const seen = {}
  for (const [label, patch] of STATES) {
    await svc(`connectors?id=eq.${connectorId}`, { method: 'PATCH', body: JSON.stringify(patch) })
    const r = await read(connectorEvent.id, host.token)
    seen[label] = r
    console.log(
      `  ${label.padEnd(20)} ${String(r.can_sell_paid).padEnd(9)} ` +
      `${String(r.reason ?? 'null').padEnd(17)} ${String(r.fix_action ?? 'null')}`,
    )
  }
  const platform = await read(platformEvent.id, admin.token)
  console.log(`  ${'platform (admin)'.padEnd(20)} ${String(platform.can_sell_paid).padEnd(9)} ` +
    `${String(platform.reason ?? 'null').padEnd(17)} ${String(platform.fix_action ?? 'null')}`)

  console.log('\n  the contract:\n')

  ok('three columns and no more',
    Object.keys(seen.ready).sort().join(',') === 'can_sell_paid,fix_action,reason',
    Object.keys(seen.ready).join(','))

  // The assertion that would have caught the churn: a sentence in a code
  // column fails here rather than reaching a client that renders it raw.
  for (const [label, r] of Object.entries(seen)) {
    if (r.reason === null) continue
    ok(`${label}: reason is a code, not a sentence`,
      !/\s/.test(r.reason), JSON.stringify(r.reason).slice(0, 60))
  }

  const VERBS = ['connect', 'continue', 'stripe']
  for (const [label, r] of Object.entries(seen)) {
    if (r.fix_action === null) continue
    ok(`${label}: fix_action is one of ${VERBS.join('/')}`,
      VERBS.includes(r.fix_action), JSON.stringify(r.fix_action))
  }

  // `reason` is *not* null when it can sell — it carries `ready` for a
  // connector and `platform_account` for an Amazing event, which is a useful
  // distinction the caller would otherwise have to re-derive from
  // events.payment_connector_id. What must be null is `fix_action`: there is
  // no repair to offer, and a non-null verb would draw a button for a problem
  // that does not exist.
  //
  // This assertion originally required both to be null, because that is what
  // a report said. Production said otherwise on the first run of this script,
  // which is the whole argument for the script.
  ok('ready sells and offers no repair',
    seen.ready.can_sell_paid === true && seen.ready.fix_action === null,
    JSON.stringify(seen.ready))

  ok('a sellable state still answers with a code, not silence',
    typeof seen.ready.reason === 'string' && typeof platform.reason === 'string',
    `${JSON.stringify(seen.ready.reason)} / ${JSON.stringify(platform.reason)}`)

  ok('every other state refuses',
    ['no account', 'pending onboarding', 'restricted', 'disconnected']
      .every(s => seen[s].can_sell_paid === false))

  // BUY-13. Amazing's own events sell on the platform account, and whether
  // that key exists is a deployment fact no query can see — so from SQL it is
  // simply ready. This is the default path for every event Amazing runs.
  ok('an admin-hosted event sells on the platform account (BUY-13)',
    platform.can_sell_paid === true, JSON.stringify(platform))

  console.log(`\n${pass} passed, ${fail} failed`)
}

main()
  .catch(e => { console.error('\nRUN ERROR:', e.message); fail++ })
  .finally(async () => {
    await cleanup()
    console.log('fixtures removed')
    process.exit(fail ? 1 : 0)
  })
