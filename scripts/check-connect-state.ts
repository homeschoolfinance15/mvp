/**
 * Asserts the two payment rules that guard money and can be checked with no
 * Stripe key, no Supabase project and no network.
 *
 *   State cannot be aimed. A connector id changed inside the OAuth `state` is
 *     refused, so nobody finishes a Stripe connection onto a connector row
 *     that is not theirs (CONTRACT §7.1, §7.3).
 *   State cannot be replayed indefinitely. It expires, and it names the
 *     profile it was issued to so stripe-connect can refuse a stolen one.
 *   `completed` means completed. A refund reaches `completed` from exactly one
 *     Stripe status, `succeeded`, and event-refund cannot write `completed` at
 *     all — only stripe-webhook can (BUY-08, BUY-09).
 *
 * Everything else in this workstream needs a real Stripe account; PAYMENTS.md
 * lists what stays unverified until the keys exist.
 *
 *   deno run --allow-read scripts/check-connect-state.ts
 */
import { signState, STATE_MINUTES, verifyState } from '../supabase/functions/stripe-connect/state.ts'

const SECRET = 'test-signing-key-not-a-real-one'
const MINE = { connector_id: 'connector-a', profile_id: 'profile-1' }

const results: { name: string; pass: boolean; detail?: string }[] = []
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || !detail ? '' : ` — ${detail}`}`)
}

/* -- the state survives its own round trip --------------------------------- */

const good = await signState(MINE, SECRET)
const back = await verifyState(good, SECRET)
check(
  'a freshly signed state verifies and carries both ids',
  back?.connector_id === MINE.connector_id && back?.profile_id === MINE.profile_id,
  JSON.stringify(back),
)

check('two states for the same claim differ', good !== (await signState(MINE, SECRET)))

/* -- aiming at somebody else's connector row ------------------------------- */

// Re-encode the payload naming a different connector, keeping the signature.
// This is the attack: the connector id is the only thing worth changing.
const [body, mac] = good.split('.')
const decoded = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
decoded.connector_id = 'connector-b'
const forgedBody = btoa(JSON.stringify(decoded))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')

check(
  'a state re-aimed at another connector is refused',
  (await verifyState(`${forgedBody}.${mac}`, SECRET)) === null,
)

check(
  'a state signed with another key is refused',
  (await verifyState(await signState(MINE, 'some-other-key'), SECRET)) === null,
)

check('a state with a mangled signature is refused', (await verifyState(`${body}.AAAA`, SECRET)) === null)

for (const junk of ['', 'nodot', '.', 'a.b', '....', 'null']) {
  check(`rubbish state ${JSON.stringify(junk)} is refused, not thrown on`, (await verifyState(junk, SECRET)) === null)
}

/* -- expiry ---------------------------------------------------------------- */

// Hand-built rather than waiting ten minutes: same shape, exp already past.
async function signExpired(): Promise<string> {
  const payload = { ...MINE, exp: Math.floor(Date.now() / 1000) - 1, nonce: 'n' }
  const b = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b)),
  )
  const m = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b}.${m}`
}
check('a correctly signed but expired state is refused', (await verifyState(await signExpired(), SECRET)) === null)
check('the stated lifetime is short', STATE_MINUTES > 0 && STATE_MINUTES <= 15, `${STATE_MINUTES} minutes`)

/* -- BUY-08: `completed` is reachable from one status only ----------------- */
//
// Read out of the source rather than re-declared here, so a map edited in the
// function is an edit this check sees. A test that keeps its own copy of the
// rule passes happily while production says something else.

const checkout = await Deno.readTextFile('supabase/functions/stripe-checkout/index.ts')
const sources = {
  'stripe-webhook': await Deno.readTextFile('supabase/functions/stripe-webhook/index.ts'),
  'event-refund': await Deno.readTextFile('supabase/functions/event-refund/index.ts'),
}

function statusMap(source: string, name: string): Record<string, string> {
  const block = source.match(new RegExp(`const ${name}: Record<string, string> = \\{([^}]*)\\}`))
  if (!block) throw new Error(`${name} not found — has it been renamed?`)
  const map: Record<string, string> = {}
  for (const [, from, to] of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) map[from] = to
  return map
}

const webhookMap = statusMap(sources['stripe-webhook'], 'REFUND_STATUS')
const refundMap = statusMap(sources['event-refund'], 'ON_ACCEPTANCE')

check(
  "stripe-webhook writes 'completed' for 'succeeded' and nothing else",
  Object.entries(webhookMap).filter(([, v]) => v === 'completed').map(([k]) => k).join() === 'succeeded',
  JSON.stringify(webhookMap),
)
check(
  "event-refund never writes 'completed' — only the webhook may",
  !Object.values(refundMap).includes('completed'),
  JSON.stringify(refundMap),
)
check(
  "event-refund treats Stripe's 'succeeded' as only 'processing'",
  refundMap.succeeded === 'processing',
)

/* -- §7.1: no platform commission anywhere --------------------------------- */

check(
  'no function sets application_fee_amount (§13 excludes commission)',
  !Object.values(sources).some((s) => /application_fee_amount\s*:/.test(s)) &&
    !/application_fee_amount\s*:/.test(checkout),
)

/* -- §7.2: refunds read the account off the order, never the event --------- */

check(
  'event-refund takes stripeAccount from the order, not the event',
  /order\.stripe_account_id/.test(sources['event-refund']) &&
    !/payment_connector_id/.test(sources['event-refund']),
)

/* -- BUY-04: every order carries an idempotency key ------------------------- */
//
// The column is `not null` and uniquely indexed, but a unique index does not
// constrain nulls — two null keys never collide, so a nullable key would have
// given exactly zero protection against the double charge it exists to stop.
// The column is the guarantee; this asserts we never rely on the database to
// supply what only this function can compute.

const orderInserts = [
  ...checkout.matchAll(/\.from\('event_orders'\)[\s\S]{0,60}?\.insert\(\{([\s\S]*?)\}\)/g),
]
check('stripe-checkout has exactly one event_orders insert', orderInserts.length === 1, `${orderInserts.length}`)
check(
  'that insert always sets idempotency_key',
  orderInserts.every((m) => /idempotency_key:/.test(m[1])),
)
check(
  'the key is computed before any insert, not conditionally',
  /const idempotencyKey = `[^`]+`/.test(checkout),
)

/* -- BUY-10: the ticket trigger is the only issuer -------------------------- */

check(
  'stripe-webhook does not insert event_tickets — issue_ticket_on_confirm does',
  !/from\('event_tickets'\)/.test(sources['stripe-webhook']),
)

/* -- BUY-01: onboarding is gated server-side -------------------------------- */

check(
  'stripe-checkout gates on onboarding, not only on has_account',
  /onboardingGate\(/.test(checkout) && /onboarding_incomplete/.test(checkout),
)
check(
  'an event-only account is exempt from the network questionnaire (ACC-01)',
  /role === 'user' && profile\.network_member/.test(checkout),
)

/* -- §7.1: connecting Stripe is consent, not administration ----------------- */
//
// An admin who reached `start` for somebody else's connector would sign the
// OAuth state with their own profile id, authenticate at Stripe with an account
// they control, and write that `acct_…` onto the connector's row — silently,
// with every screen reading `ready` and the money landing in the wrong account
// (BUY-14, "do not route revenue to another host's account").
//
// `refresh` and `disconnect` stay open to an admin on purpose: neither can
// introduce an account, and both are support powers. That asymmetry is what
// these assertions defend, because three actions taking a connector id and one
// refusing it reads as an oversight to anybody meeting it cold.

const connect = await Deno.readTextFile('supabase/functions/stripe-connect/index.ts')

function fnBody(fn: string): string {
  const at = connect.indexOf(`async function ${fn}(`)
  if (at < 0) throw new Error(`${fn} not found — has it been renamed?`)
  const next = connect.indexOf('\nasync function ', at + 1)
  return connect.slice(at, next < 0 ? connect.length : next)
}

check('mustOwn exists and refuses with consent_required', /function mustOwn\(/.test(connect) && /consent_required/.test(connect))
check('onStart refuses a connector row the caller does not own', /mustOwn\(/.test(fnBody('onStart')))
check('onCallback re-checks ownership at the write point', /mustOwn\(/.test(fnBody('onCallback')))
check('onRefresh stays open to an admin', !/mustOwn\(/.test(fnBody('onRefresh')))
check('onDisconnect stays open to an admin', !/mustOwn\(/.test(fnBody('onDisconnect')))
// The guard must turn on ownership and nothing else. An `isAdmin` anywhere
// inside it would be the bug creeping back in as a convenience.
const mustOwnBody = connect.slice(
  connect.indexOf('function mustOwn('),
  connect.indexOf('async function onStart('),
)
check(
  'mustOwn compares the row owner against the caller, not a role',
  /row\.profile_id === me/.test(mustOwnBody) && !/isAdmin/.test(mustOwnBody),
)

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) Deno.exit(1)
