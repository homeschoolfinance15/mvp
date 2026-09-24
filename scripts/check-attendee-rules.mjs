/**
 * The promises the five attendee screens make that nothing else would catch.
 *
 *   node scripts/check-attendee-rules.mjs
 *
 * Two kinds of assertion, for two kinds of mistake.
 *
 * The first kind is logic, and it is imported and run: what the words for a
 * refund actually come out as, and what a price actually formats to. Node
 * strips the TypeScript types on import, so this needs no build.
 *
 * The second kind is shape. Each of these is one careless edit away from being
 * wrong in a way that still renders, still typechecks and still ships: a QR
 * moved outside the branch that checks the ticket is valid, a `profile_id`
 * filter dropped from a query that the RLS policy also lets a host through, a
 * price divided by a hundred by hand. The product would look fine and be
 * wrong, so the shape is asserted rather than trusted.
 *
 * No database, no secrets, no network.
 */
import { readFileSync } from 'node:fs'
import { attendanceAndMoney, money, priceLabel } from '../src/lib/events.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const PUBLIC_EVENT = read('src/routes/events/PublicEvent.tsx')
const BROWSE = read('src/routes/events/Browse.tsx')
const CHECKOUT = read('src/routes/events/Checkout.tsx')
const MY_EVENTS = read('src/routes/events/MyEvents.tsx')
const TICKET = read('src/routes/events/Ticket.tsx')
const SHARED = read('src/routes/events/shared.tsx')

const ALL = {
  'PublicEvent.tsx': PUBLIC_EVENT,
  'Browse.tsx': BROWSE,
  'Checkout.tsx': CHECKOUT,
  'MyEvents.tsx': MY_EVENTS,
  'Ticket.tsx': TICKET,
  'shared.tsx': SHARED,
}

let failures = 0
function check(name, pass, detail = '') {
  if (!pass) failures += 1
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* -------------------------------------------------------------------------- */
/* BUY-08 — never say refunded until it is                                     */
/* -------------------------------------------------------------------------- */

check(
  'BUY-08  a cancelled place with no refund says nothing about money',
  !/refund/i.test(attendanceAndMoney('cancelled', null)),
  attendanceAndMoney('cancelled', null),
)

check(
  'BUY-08  a requested refund is not a completed one',
  /refund requested/.test(attendanceAndMoney('confirmed', 'requested')) &&
    !/\brefunded\b/.test(attendanceAndMoney('confirmed', 'requested')),
  attendanceAndMoney('confirmed', 'requested'),
)

check(
  'BUY-08  only a completed refund reads as refunded',
  /\brefunded\b/.test(attendanceAndMoney('cancelled', 'completed')),
  attendanceAndMoney('cancelled', 'completed'),
)

check(
  'BUY-08  MyEvents puts attendance and money through the one function',
  MY_EVENTS.includes('attendanceAndMoney('),
  'CONTRACT §3 exports it so no screen re-words the two facts on its own',
)

/* -------------------------------------------------------------------------- */
/* EVT-04 — money is minor units, formatted in one place                       */
/* -------------------------------------------------------------------------- */

check('EVT-04  minor units format with their currency', money(2500, 'gbp') === '£25.00', money(2500, 'gbp'))
check('EVT-04  US dollars read as $, not US$ (USD is the default currency)', money(2500, 'usd') === '$25.00', money(2500, 'usd'))
check(
  'EVT-04  a zero-priced ticket reads as Free, not as £0.00',
  priceLabel({ price_cents: 0, currency: 'gbp' }) === 'Free',
)

for (const [file, source] of Object.entries(ALL)) {
  // A price arrived at by hand is a price that will eventually be wrong by a
  // penny, in a currency nobody named. money() and priceLabel() are the only
  // two ways a number becomes a price on these screens.
  check(
    `EVT-04  ${file} does no currency arithmetic of its own`,
    !/toFixed\(|\/\s*100\b/.test(source),
  )
}

/* -------------------------------------------------------------------------- */
/* QLT-05 — the id in the address is not proof of whose it is                  */
/* -------------------------------------------------------------------------- */

for (const [file, source] of [
  ['Checkout.tsx', CHECKOUT],
  ['MyEvents.tsx', MY_EVENTS],
  ['Ticket.tsx', TICKET],
]) {
  // RLS lets a host read their guests' registrations, orders and tickets. A
  // screen that reads "the row for this id" and calls it yours would show a
  // host somebody else's booking, entirely within the policy.
  const reads = (source.match(/supabase\s*\n?\s*\.from\(/g) ?? []).length
  const scoped = (source.match(/\.eq\('profile_id'/g) ?? []).length
  check(
    `QLT-05  ${file} scopes every row it reads to the reader`,
    reads > 0 && scoped >= reads,
    `${scoped} profile_id filters for ${reads} reads`,
  )
}

/* -------------------------------------------------------------------------- */
/* BUY-04 — the browser is never the authority on whether money moved          */
/* -------------------------------------------------------------------------- */

check(
  'BUY-04  Checkout writes no order or registration state of its own',
  !/\.update\(|\.insert\(|\.upsert\(/.test(CHECKOUT),
  'only register_free() and stripe-checkout may create anything',
)

check(
  'BUY-04  Checkout treats only a confirmed registration as a place',
  /status === 'confirmed'/.test(CHECKOUT),
  'a redirect back from Stripe is not proof that money moved',
)

check(
  'QLT-09  waiting on a payment is a state with words, not a bare spinner',
  /still waiting|taking longer|being looked into|has not reached us|few minutes/i.test(CHECKOUT),
)

/* -------------------------------------------------------------------------- */
/* BUY-11 — a ticket that will not work shows no code to try                   */
/* -------------------------------------------------------------------------- */

const usableBranch = TICKET.indexOf('{usable ? (')
const qr = TICKET.indexOf('<QrCode')
const elseBranch = TICKET.indexOf(') : ', usableBranch)

check(
  'BUY-11  the QR is drawn only inside the branch that checked the ticket',
  usableBranch !== -1 && qr > usableBranch && qr < elseBranch,
)
check(
  'BUY-11  there is exactly one place a code can be drawn',
  (TICKET.match(/<QrCode/g) ?? []).length === 1,
)
check(
  'BUY-11  revoked, cancelled place and cancelled event all disarm it',
  /const usable = !revoked && !cancelledPlace && !cancelledEvent/.test(TICKET),
)

/* -------------------------------------------------------------------------- */
/* BUY-01, EVT-06 — onboarding happens before registration or payment          */
/* -------------------------------------------------------------------------- */

check(
  'BUY-01  Checkout will not register an account that has not finished onboarding',
  /needsOnboarding\(/.test(CHECKOUT),
  'required onboarding comes before registration or payment, free or paid',
)
check(
  'EVT-06  a visitor sent away to sign up is brought back to this event',
  PUBLIC_EVENT.includes('rememberSignupResume('),
)

/* -------------------------------------------------------------------------- */
/* BUY-09, QLT-08 — money and bookings outlive the event's visibility          */
/* -------------------------------------------------------------------------- */

check(
  'QLT-08  MyEvents never drops a booking whose event it cannot read',
  !/\.filter\(\(b\)\s*=>\s*b\.events\)/.test(MY_EVENTS),
  'an unpublished event must not erase a paid booking',
)
check(
  'BUY-09  a cancelled paid booking with no refund row still says where the money stands',
  /No refund has been started/i.test(MY_EVENTS),
  'silence is not an accurate status',
)
check(
  'QLT-08  an unreadable event still shows the booking and what was paid',
  /QLT-08 names three things/.test(MY_EVENTS) && /PAYMENT_WORDS\[order\.status\]/.test(MY_EVENTS),
)
check(
  'BUY-04  a held place is not mistaken for a payment in flight',
  !/registration\?\.status === 'pending'\s*\|\|/.test(CHECKOUT),
  'otherwise abandoning Stripe traps them on "do not pay again" with no way to pay',
)

check(
  'BUY-09  a stalled refund says what happens next, not just its status',
  /needs_attention/.test(MY_EVENTS) &&
    /host has been told|looked into|needs somebody|flagged|chase/i.test(MY_EVENTS),
)

/* -------------------------------------------------------------------------- */
/* ORG-03A — sold out and registration closed are different facts              */
/* -------------------------------------------------------------------------- */

for (const [file, source] of [
  ['PublicEvent.tsx', PUBLIC_EVENT],
  ['Checkout.tsx', CHECKOUT],
]) {
  // Collapsing these two into one message is the easy mistake, and it tells
  // somebody the event filled up when in fact the organiser stopped selling.
  check(
    `ORG-03A  ${file} answers sold_out and closed separately`,
    source.includes("state === 'sold_out'") && source.includes("state === 'closed'"),
  )
}

check(
  'ORG-03A  the words for every state come from one map',
  SHARED.includes('CAPACITY_WORDS[state]'),
)

/* -------------------------------------------------------------------------- */

console.log(failures === 0 ? '\nAll attendee rules hold.' : `\n${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
