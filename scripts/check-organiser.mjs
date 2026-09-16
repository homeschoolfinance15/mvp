/**
 * The organiser dashboard's rules, asserted without a browser or a database.
 *
 * Everything in src/routes/manage/rules.ts decides something a person acts
 * on — whether an email goes out, what a blank check-in means, what a night
 * actually took after fees, whether paid tickets may go on sale at all. None
 * of it needs React, which is exactly why it is worth checking here rather
 * than by clicking through five screens.
 *
 * Node reads the TypeScript directly (type stripping, Node 22.6+). No build
 * step, no test framework, no fixtures.
 *
 *   node scripts/check-organiser.mjs
 */

import assert from 'node:assert/strict'
import {
  AUTOMATIC_MESSAGES,
  MESSAGE_STATUS_TONE,
  MESSAGE_STATUS_WORDS,
  COHOST_MONEY_NOTE,
  attendanceLabel,
  awaitsRefundDecision,
  changedDetails,
  mayMarkAttended,
  moneyState,
  paymentRecipientSentence,
  previewFingerprint,
  receipts,
  remedyFor,
  reminderLabel,
  reminderWillSkip,
  skippedSentence,
  slugify,
  validateEvent,
  whyNoCreate,
} from '../src/routes/manage/rules.ts'

const checks = []
const check = (name, fn) => checks.push([name, fn])

/* -------------------------------------------------------------------------- */
/* ORG-10 / EML-03 / EML-04                                                    */
/* -------------------------------------------------------------------------- */

check('ORG-10 a changed venue is notifiable', () => {
  const changed = changedDetails({ venue_name: 'The Clove Club' }, { venue_name: 'Brat' })
  assert.deepEqual(changed, { venue_name: { from: 'The Clove Club', to: 'Brat' } })
})

check('ORG-10 a changed description interrupts nobody', () => {
  assert.deepEqual(changedDetails({ description: 'a' }, { description: 'b' }), {})
})

check('ORG-10 an empty box and a never-filled box are the same fact', () => {
  assert.deepEqual(changedDetails({ address: null }, { address: '   ' }), {})
})

check('EML-04 a preview built before a later edit no longer matches', () => {
  const before = previewFingerprint({ venue_name: 'Brat', address: '4 Redchurch St' })
  const after = previewFingerprint({ venue_name: 'Brat', address: '7 Redchurch St' })
  assert.notEqual(before, after)
})

/* -------------------------------------------------------------------------- */
/* ORG-16 / EML-06                                                             */
/* -------------------------------------------------------------------------- */

check('ORG-16 reminder offsets read as time, not as minutes', () => {
  assert.equal(reminderLabel(1440), '1 day before')
  assert.equal(reminderLabel(10080), '1 week before')
  assert.equal(reminderLabel(180), '3 hours before')
})

check('EML-06 a reminder whose moment has gone is skipped, never sent late', () => {
  const soon = new Date(Date.now() + 30 * 60_000).toISOString()
  assert.equal(reminderWillSkip(soon, 1440), true)
  const later = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString()
  assert.equal(reminderWillSkip(later, 1440), false)
})

/* -------------------------------------------------------------------------- */
/* ORG-13 — receipts, never profit                                             */
/* -------------------------------------------------------------------------- */

check('ORG-13 gross, fees and refunds stay three separate figures', () => {
  const orders = [
    { id: 'a', amount_cents: 5000, fee_cents: 175, currency: 'gbp', status: 'paid' },
    { id: 'b', amount_cents: 5000, fee_cents: 175, currency: 'gbp', status: 'refunded' },
    { id: 'c', amount_cents: 5000, fee_cents: 175, currency: 'gbp', status: 'pending' },
  ]
  const refunds = [
    { order_id: 'b', amount_cents: 5000, status: 'completed' },
    { order_id: 'a', amount_cents: 2500, status: 'requested' },
  ]
  const r = receipts(orders, refunds, 'gbp')

  // The pending order never took any money, so it is in none of the figures.
  assert.equal(r.paidOrders, 2)
  assert.equal(r.grossCents, 10000)
  assert.equal(r.feesCents, 350)
  // A requested refund is a promise, not money that has gone back.
  assert.equal(r.refundedCents, 5000)
  assert.equal(r.netCents, 10000 - 350 - 5000)
  assert.equal(r.refundedOrders, 1)
})

check('ORG-13 an event that charged nothing reports nothing taken', () => {
  const r = receipts([], [], 'gbp')
  assert.equal(r.grossCents, 0)
  assert.equal(r.netCents, 0)
  assert.equal(r.currency, 'gbp')
})

/* -------------------------------------------------------------------------- */
/* ATT-04 / ATT-06                                                             */
/* -------------------------------------------------------------------------- */

check('ATT-04 a blank is not a no-show when nobody ran the door', () => {
  assert.equal(attendanceLabel(false, false), 'No check-in recorded')
  assert.equal(attendanceLabel(false, true), 'Not checked in')
  assert.equal(attendanceLabel(true, false), 'Attended')
})

check('ATT-06 only somebody running the event records attendance', () => {
  // Corrected 16 Sep: the rule is that a guest cannot mark themselves, not
  // that nobody may name themselves. A present host must be recordable
  // (FDB-06), including by themselves when they are running it alone.
  assert.equal(mayMarkAttended(false), false)
  assert.equal(mayMarkAttended(true), true)
})

check('BUY-08 a cancelled paid place with no refund is a job for the host', () => {
  const paidOrder = { id: 'o1', amount_cents: 5000, currency: 'gbp', status: 'paid' }

  assert.equal(moneyState(null, []), 'not_paid')
  assert.equal(moneyState({ ...paidOrder, amount_cents: 0 }, []), 'not_paid')
  assert.equal(moneyState({ ...paidOrder, status: 'pending' }, []), 'not_paid')
  assert.equal(moneyState(paidOrder, []), 'none')
  assert.equal(moneyState(paidOrder, [{ order_id: 'o1', status: 'requested' }]), 'processing')
  assert.equal(moneyState(paidOrder, [{ order_id: 'o1', status: 'processing' }]), 'processing')
  assert.equal(moneyState(paidOrder, [{ order_id: 'o1', status: 'completed' }]), 'completed')
  assert.equal(
    moneyState(paidOrder, [{ order_id: 'o1', status: 'needs_attention' }]),
    'needs_attention',
  )
  // A refund against somebody else's order says nothing about this one.
  assert.equal(moneyState(paidOrder, [{ order_id: 'o2', status: 'completed' }]), 'none')

  // Only the untouched money on a place that is gone needs a decision.
  assert.equal(awaitsRefundDecision('cancelled', 'none'), true)
  assert.equal(awaitsRefundDecision('expired', 'none'), true)
  assert.equal(awaitsRefundDecision('cancelled', 'processing'), false)
  assert.equal(awaitsRefundDecision('cancelled', 'completed'), false)
  assert.equal(awaitsRefundDecision('confirmed', 'none'), false)
})

check('EML-06 a skipped reminder reads as a schedule fact, not a fault', () => {
  assert.equal(MESSAGE_STATUS_TONE.skipped, 'inert')
  assert.equal(MESSAGE_STATUS_TONE.failed, 'bad')
  assert.doesNotMatch(MESSAGE_STATUS_WORDS.skipped, /fail/i)
  assert.match(skippedSentence('reminder', null), /Nothing went wrong/)
  // Both EML-06 causes are covered by the one sentence.
  assert.match(skippedSentence('reminder', null), /short notice/)
  assert.match(skippedSentence('reminder', null), /moved\s+earlier/)
})

check('EML-01 all nine situations are on screen, and a paid purchase is one email', () => {
  assert.equal(AUTOMATIC_MESSAGES.length, 9)
  // Only the reminder is the organiser's to switch off (EML-02).
  assert.deepEqual(
    AUTOMATIC_MESSAGES.filter((m) => m.organiserControlled).map((m) => m.kinds[0]),
    ['reminder'],
  )
  // Every kind the queue can hold is accounted for exactly once.
  const kinds = AUTOMATIC_MESSAGES.flatMap((m) => m.kinds)
  assert.equal(new Set(kinds).size, kinds.length)
  assert.equal(kinds.length, 9)
  // Each row answers all four columns the requirement asks for.
  for (const m of AUTOMATIC_MESSAGES) {
    assert.ok(m.situation && m.trigger && m.recipient && m.makesClear, m.situation)
  }
})

/* -------------------------------------------------------------------------- */
/* ACC-04 / ORG-01A                                                            */
/* -------------------------------------------------------------------------- */

check('ORG-01A a missing create button always carries its reason', () => {
  assert.equal(whyNoCreate('admin', false), null)
  assert.equal(whyNoCreate('connector', true), null)
  assert.match(whyNoCreate('connector', false), /administrator can switch this on/)
  assert.match(whyNoCreate('user', false), /connectors and administrators/)
})

/* -------------------------------------------------------------------------- */
/* §7.0 — whose money                                                          */
/* -------------------------------------------------------------------------- */

const amazing = { connectorId: null, name: 'Amazing', ownerId: null }
const dara = { connectorId: 'c1', name: 'Dara', ownerId: 'p1' }

check('§7.0 the recipient sentence names the account and never implies a split', () => {
  assert.match(paymentRecipientSentence(amazing, false), /Amazing’s own Stripe account/)
  assert.match(paymentRecipientSentence(dara, false), /Dara’s own Stripe account/)
  assert.match(paymentRecipientSentence(dara, true), /deliberately/)
  // ORG-05. The assumption everybody makes, contradicted in so many words.
  assert.match(COHOST_MONEY_NOTE, /does not split the money/)
})

/* -------------------------------------------------------------------------- */
/* §7.3 / BUY-14 — one vocabulary for whether an account can take money        */
/* -------------------------------------------------------------------------- */

/*
 * The words and the fix verbs belong to payoutState() in
 * src/routes/connector/payouts.ts, which the connector's own payment screen
 * and the administrator's view of it already use — scripts/check-payout-state
 * asserts them there and they are not re-asserted here. What is this screen's
 * own is narrower: who a remedy should be offered to. The account holder can
 * act on it; a cohost reading the same banner on the same event cannot, and
 * sending them to somebody else's payment setup or to a Stripe dashboard they
 * have no login for is the wrong button rather than a helpful one.
 */
check('BUY-14 a remedy is offered to the account holder and to nobody else', () => {
  const owner = 'p1'

  assert.deepEqual(remedyFor('connect', dara, owner), {
    href: '/connector/payments',
    label: 'Open payment setup',
  })
  assert.deepEqual(remedyFor('continue', dara, owner), {
    href: '/connector/payments',
    label: 'Open payment setup',
  })
  assert.deepEqual(remedyFor('stripe', dara, owner), {
    href: 'https://dashboard.stripe.com/',
    label: 'Finish this on Stripe',
  })

  // A cohost, or an admin looking at somebody else's event, gets told who can
  // act rather than a link that is not theirs.
  for (const fix of ['connect', 'continue', 'stripe']) {
    const other = remedyFor(fix, dara, 'someone-else')
    assert.equal(other.href, undefined, fix)
    assert.match(other.label, /Dara/, fix)
  }

  // Ready, or an Amazing-hosted event: nothing to offer either way.
  assert.deepEqual(remedyFor(null, dara, owner), { label: '' })
  assert.deepEqual(remedyFor('connect', amazing, owner), { label: '' })
})

/* -------------------------------------------------------------------------- */
/* ORG-01 / EVT-01                                                             */
/* -------------------------------------------------------------------------- */

check('ORG-01 a draft says which box is wrong, by name', () => {
  const errors = validateEvent({ title: '  ', starts_at: '' })
  assert.ok(errors.title)
  assert.ok(errors.starts_at)

  const backwards = validateEvent({
    title: 'Dinner',
    starts_at: '2026-10-01T19:00:00Z',
    ends_at: '2026-10-01T18:00:00Z',
  })
  assert.ok(backwards.ends_at)

  assert.ok(validateEvent({ title: 'Dinner', starts_at: '2026-10-01T19:00:00Z', capacity: 0 }).capacity)
  assert.deepEqual(
    validateEvent({ title: 'Dinner', starts_at: '2026-10-01T19:00:00Z', capacity: null }),
    {},
  )
})

check('EVT-01 a slug is readable and always has something in it', () => {
  assert.equal(slugify('Sunday Dinner in Shoreditch!'), 'sunday-dinner-in-shoreditch')
  assert.equal(slugify('   '), 'event')
  assert.ok(slugify('x'.repeat(200)).length <= 60)
})

/* -------------------------------------------------------------------------- */

let failures = 0
for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log(`\n${checks.length - failures}/${checks.length} organiser rules hold.`)
process.exit(failures === 0 ? 0 : 1)
