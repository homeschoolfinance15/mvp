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
  // The two halves of the confirmation path, which used to be one file. Both
  // are in `sources` so every rule below that sweeps `Object.values(sources)`
  // covers them without being told about them individually — a rule that names
  // its files is a rule that stops applying the moment code moves, which is
  // exactly what moving the confirmation out of stripe-webhook just did.
  'order-state': await Deno.readTextFile('supabase/functions/_shared/order-state.ts'),
  'stripe-reconcile': await Deno.readTextFile('supabase/functions/stripe-reconcile/index.ts'),
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

/* -- §7.3: paid-sale readiness has one definition -------------------------- */
//
// The gate must ask `event_sale_readiness()`, not read the connector's flags
// itself. Re-inlining it is the tempting edit — it looks like removing an
// indirection — and it silently forks the rule away from the publish check and
// the organiser's dashboard banner, which is how a hole opens six months later
// with nothing failing loudly in between.

check(
  'stripe-checkout asks event_sale_readiness() for the paid-sale gate',
  /rpc\('event_sale_readiness'/.test(checkout),
)
// Comments stripped first: this file explains *why* it does not read the flag,
// and an assertion that cannot tell prose from code would fail on the
// explanation of its own rule.
const checkoutCode = checkout
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('//'))
  .join(' ')

check(
  'it does not read stripe_charges_enabled directly',
  !/stripe_charges_enabled/.test(checkoutCode),
)
check(
  'it still resolves the destination account from the event',
  /payment_connector_id/.test(checkout) && /stripe_account_id/.test(checkout),
)
check(
  'an unresolved connector account is refused, never charged to the platform',
  /connector_account_unresolved/.test(checkout),
)

// QLT-05. Everyone who calls stripe-checkout is an attendee. `fix_action` is
// the organiser's instruction — it names the host's Stripe state and points at
// a page the reader cannot open — so it must not travel out of this function.
// An error body is somewhere information appears.
// The value only escapes if it is read off the readiness row. The interface
// still declares the field — the function does return it — so testing for the
// bare word would flag the type declaration and pass for the wrong reason.
check(
  'the attendee refusal never reads readiness.fix_action',
  !/readiness\.fix_action/.test(checkoutCode),
)
check(
  'every paid-sale refusal shows the one attendee sentence',
  (checkoutCode.match(/error: ATTENDEE_REFUSAL/g) ?? []).length >= 2,
)

// Assert on the sentence itself, not on its neighbourhood in the file.
const refusalText =
  checkout.match(/const ATTENDEE_REFUSAL =([\s\S]*?);?\r?\n\r?\n/)?.[1].toLowerCase() ?? ''
check(
  'that sentence names no Stripe account state and no organiser page',
  refusalText.length > 0 &&
    !/stripe|acct_|connector|charges|restricted|payout|dashboard|\/connector/.test(refusalText),
  refusalText.trim().slice(0, 60),
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

// Asserted over every function, not over stripe-webhook alone. When the
// confirmation moved into _shared/order-state.ts this rule went on passing
// while no longer covering the code that confirms anything — a rule naming one
// file cannot notice that the thing it guards has moved out of it.
check(
  'nothing but issue_ticket_on_confirm inserts event_tickets',
  !Object.values(sources).some((s) => /from\('event_tickets'\)/.test(s)) &&
    !/from\('event_tickets'\)/.test(checkout),
)

/* -- BUY-03/§9: one writer of `paid`, however many callers there are -------- */
//
// stripe-reconcile is the second thing that can confirm a payment: the sweep
// that asks Stripe about orders whose webhook never arrived (PAYMENTS.md §9).
// Two callers is safe, and two *implementations* would not be — the second one
// to be edited would be the one nobody watches, and the failure it produces is
// a double-issued ticket against real money.
//
// So the rule is not "only stripe-webhook writes paid". It is: the transition
// exists once, it is claimed conditionally, and no caller reimplements it.

const orderState = sources['order-state']
const reconcile = sources['stripe-reconcile']

check(
  "the pending -> paid transition exists in exactly one place",
  /status: 'paid'/.test(orderState) &&
    !/status: 'paid'/.test(sources['stripe-webhook']) &&
    !/status: 'paid'/.test(reconcile) &&
    !/status: 'paid'/.test(checkout),
)
// Scoped to each transition's own body. A whole-file regex passes as long as
// *some* function still claims conditionally — which is how the first version
// of this check went green against a confirmPaidOrder whose guard had been
// deleted, matching failPendingOrder's guard instead.
function stateFn(name: string): string {
  const at = orderState.indexOf(`export async function ${name}(`)
  if (at < 0) throw new Error(`${name} not found — has it been renamed?`)
  const next = orderState.indexOf('\nexport async function ', at + 1)
  return orderState.slice(at, next < 0 ? orderState.length : next)
}

const confirmBody = stateFn('confirmPaidOrder')
const failBody = stateFn('failPendingOrder')

check(
  'confirming claims the row conditionally, so a replay wins nothing',
  /status: 'paid'[\s\S]*?\.eq\('status', 'pending'\)[\s\S]*?\.select\('id'\)/.test(confirmBody),
)
check(
  'failing an order is claimed the same way',
  /status: 'failed'[\s\S]*?\.eq\('status', 'pending'\)[\s\S]*?\.select\('id'\)/.test(failBody),
)
// The confirmation must stop when it did not win the claim. Without this the
// guard above is decorative: the update changes nothing on a replay, and the
// code carries on to confirm the place and queue a second email anyway.
check(
  'a confirmation that loses the claim stops before the registration',
  /if \(!claimed\) return/.test(confirmBody),
)
check(
  'both callers go through the shared transition rather than their own',
  /confirmPaidOrder\(/.test(sources['stripe-webhook']) && /confirmPaidOrder\(/.test(reconcile),
)

/* -- §7.2: the sweep asks Stripe on the account that took the money --------- */

check(
  "stripe-reconcile reads each session on the order's own account",
  /options\.stripeAccount = order\.stripe_account_id/.test(reconcile),
)
check(
  'stripe-reconcile only touches orders that reached Stripe',
  /\.not\('stripe_checkout_session_id', 'is', null\)/.test(reconcile) &&
    /\.eq\('status', 'pending'\)/.test(reconcile),
)
// `paid` is the only Stripe answer that confirms. An order whose session is
// merely `complete` may still be clearing an asynchronous payment method, and
// treating that as paid would issue a ticket for money that never arrives.
check(
  "stripe-reconcile confirms on payment_status 'paid', not on session status",
  /payment_status === 'paid'/.test(reconcile),
)

/* -- BUY-01: onboarding is gated server-side -------------------------------- */

check(
  'stripe-checkout gates on onboarding, not only on has_account',
  /rpc\('onboarding_complete'\)/.test(checkout) && /onboarding_incomplete/.test(checkout),
)

// The gate must be `onboarding_complete()` and **nothing more**. A stricter
// rule here than in `register_free()` produces the dead end the audit found:
// you may RSVP to a free event but not pay for one, refused at the Pay button
// by a condition no other layer applies and no screen can route you out of
// (QLT-02). The tempting future edit is to "tighten" this back up; these two
// assertions are what should stop it.
check(
  'the gate asks onboarding_complete() rather than reimplementing it',
  !/current_profession/.test(checkout),
)
check(
  'the gate adds no questionnaire condition of its own',
  !/profile_answers/.test(checkout) && !/questionnaire_incomplete/.test(checkout),
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

/* -- payments-status never hands a key to a browser ------------------------ */
//
// The admin Payments screen reports whether Stripe is configured. It reads
// secrets out of the edge runtime, which is exactly the position from which a
// well-meaning convenience — "show the last four so I can tell which key this
// is" — puts key material into a browser, a devtools tab, a screenshot and a
// log aggregator. The rule is that the response carries booleans and a
// test/live mode and nothing else, and these assert the shape of that rather
// than the current wording of it.

const payments = await Deno.readTextFile('supabase/functions/payments-status/index.ts')

// Everything between the final `return json(` and the end of the handler: what
// actually crosses the wire.
const payload = payments.slice(payments.lastIndexOf('return json('))

// Comments stripped, for the reason checkoutCode above is: this file explains
// at length why it must not return a masked key, and an assertion that cannot
// tell prose from code fails on the explanation of its own rule.
const paymentsCode = payments
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('//'))
  .join(' ')

check(
  'payments-status is admin-only',
  /rpc\('is_admin'\)/.test(payments) && /Not authorised/.test(payments),
)
check(
  'the response never names a key variable',
  !/secretKey/.test(payload) &&
    !/Deno\.env\.get\(['"]STRIPE_SECRET_KEY/.test(payload) &&
    !/Deno\.env\.get\(['"]STRIPE_WEBHOOK_SECRET/.test(payload),
)
// The ways a partial key gets exposed while looking helpful.
for (const [name, pattern] of [
  ['no substring of a key', /(secretKey|webhookSecret)\s*\.\s*(slice|substring|substr|at)/],
  ['no masked key', /mask|last4|lastFour|redact/i],
  ['no key length', /(secretKey|webhookSecret)\s*\.\s*length/],
] as const) {
  check(name, !pattern.test(paymentsCode))
}
check(
  'presence() reports only whether a value is set',
  /function presence\([\s\S]*?return \{ set: Boolean\(/.test(payments),
)
// Mode is the one derived fact that may be returned. It must come from the
// documented prefixes and nothing else — a regex over the whole key would be
// one edit away from returning a capture group.
check(
  'mode is derived from the documented prefixes only',
  /startsWith\('sk_test_'\)/.test(payments) && /startsWith\('sk_live_'\)/.test(payments),
)

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) Deno.exit(1)
