/**
 * Asserts CONTRACT §7.3 — when a connector's Stripe account may take money for
 * a ticket — exactly as the screens ask it.
 *
 * Worth a check of its own because two of the rows are easy to get backwards,
 * and both cost real money or real trust when they are:
 *
 *   Payouts are not charges. Stripe can leave `payouts_enabled` false for a
 *     week while it verifies a bank account. Refusing to sell tickets over
 *     that would be wrong — the money is safely in their balance either way.
 *   Disconnecting stops new sales and nothing else. Somebody who bought a
 *     ticket last week keeps their ticket, their place at the door and their
 *     right to a refund when the organiser walks away from Stripe today
 *     (BUY-14, §7.3 last row).
 *
 * No project, no keys, no network: this is pure logic.
 *
 *   node scripts/check-payout-state.mjs
 */
import { payoutState } from '../src/routes/connector/payouts.ts'

let failures = 0

function check(name, pass, detail) {
  if (!pass) failures += 1
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || !detail ? '' : ` — ${detail}`}`)
}

/** A connector row with only the columns §7.3 reads. */
function connector(overrides) {
  return {
    stripe_account_id: 'acct_test',
    stripe_account_status: 'ready',
    stripe_charges_enabled: true,
    stripe_payouts_enabled: true,
    ...overrides,
  }
}

/* -- the gate itself ------------------------------------------------------- */

const cases = [
  ['no Stripe account at all', { stripe_account_id: null, stripe_account_status: 'none' }, false, 'connect'],
  ['Stripe onboarding unfinished', { stripe_account_status: 'pending' }, false, 'continue'],
  ['restricted by Stripe', { stripe_account_status: 'restricted' }, false, 'stripe'],
  ['disconnected', { stripe_account_status: 'disconnected' }, false, 'connect'],
  ['connected but charges not enabled', { stripe_charges_enabled: false }, false, 'stripe'],
  ['connected and ready', {}, true, null],
]

for (const [name, overrides, canSellPaid, fix] of cases) {
  const state = payoutState(connector(overrides))
  check(
    `${name}: ${canSellPaid ? 'may' : 'may not'} sell paid tickets`,
    state.canSellPaid === canSellPaid,
    JSON.stringify(state),
  )
  check(`${name}: the repair offered is ${fix ?? 'none'}`, state.fix === fix, String(state.fix))
}

/* -- the two rows that are easy to get backwards --------------------------- */

const awaitingPayouts = payoutState(connector({ stripe_payouts_enabled: false }))
check(
  'charges on, payouts not released yet: paid tickets still go on sale',
  awaitingPayouts.canSellPaid === true,
  JSON.stringify(awaitingPayouts),
)
check(
  'charges on, payouts not released yet: it is still said out loud',
  Boolean(awaitingPayouts.outstanding),
)

const gone = payoutState(connector({ stripe_account_status: 'disconnected' }))
check(
  'disconnected says existing bookings, tickets and refunds keep working',
  /refund/i.test(gone.outstanding ?? '') && /ticket/i.test(gone.outstanding ?? ''),
  gone.outstanding ?? '(nothing said)',
)

/* -- every state that cannot sell says why --------------------------------- */

for (const status of ['none', 'pending', 'ready', 'restricted', 'disconnected']) {
  const state = payoutState(
    connector({
      stripe_account_status: status,
      stripe_account_id: status === 'none' ? null : 'acct_test',
      stripe_charges_enabled: status === 'ready',
    }),
  )
  if (state.canSellPaid) continue
  check(`${status}: names what is outstanding`, Boolean(state.outstanding))
}

console.log(failures === 0 ? '\nAll payout gates hold.' : `\n${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
