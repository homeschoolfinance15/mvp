// Builds the money table from the sim ledger + DB rows. Every number comes from GET /_sim/ledger or event_orders/event_refunds.
import fs from 'node:fs'
import { sim, psqlJson, DIR } from './lib.mjs'
import { F } from './common.mjs'
const L = (await sim('GET', '/_sim/ledger')).body
const ids = Object.values(F.events).map((e) => `'${e.id}'`).join(',')
const orders = psqlJson(`select o.id, o.event_id, o.profile_id, o.status, o.amount_cents, o.fee_cents, o.stripe_checkout_session_id s, o.stripe_payment_intent_id pi, o.stripe_account_id, (select coalesce(sum(amount_cents),0) from event_refunds f where f.order_id=o.id and f.status='completed') refunded from event_orders o where o.event_id in (${ids})`)
const evKey = Object.fromEntries(Object.entries(F.events).map(([k, e]) => [e.id, k]))
const who = Object.fromEntries(Object.entries(F.people).map(([k, p]) => [p.id, k]))
const label = { s1: 'S1 admin', s2: 'S2 connector', s3: 'S3 connector +5% booking fee', s4: 'S4 connector EUR', s5: 'S5 admin USD', s9: 'S9 last place', s9b: 'S9b lapsed-hold oversell', s15: 'S15 cancelled event' }
const sym = { gbp: '£', eur: '€', usd: '$' }
const m = (c, cur) => `${c < 0 ? '-' : ''}${sym[cur]}${(Math.abs(c) / 100).toFixed(2)}`
const rows = []
for (const e of L.entries.filter((x) => x.kind === 'charge')) {
  const o = orders.find((x) => x.s === e.session)
  if (!o) continue
  const refunds = L.entries.filter((x) => x.kind === 'refund' && x.payment_intent === e.payment_intent).reduce((s, x) => s + x.amount, 0)
  const ticket = e.lines[0].amount_total
  const booking = e.lines.slice(1).reduce((s, l) => s + l.amount_total, 0)
  const toConnector = e.direct_charge ? e.gross - e.stripe_fee - e.application_fee_to_platform - refunds : 0
  const toAmazing = e.direct_charge ? e.application_fee_to_platform : e.gross - e.stripe_fee - refunds
  rows.push({ scen: `${label[evKey[o.event_id]]} (${who[o.profile_id]})`, cur: e.currency, ticket, booking, paid: e.gross, acct: e.charged_on, fee: e.stripe_fee, amazing: toAmazing, connector: toConnector, refunded: refunds, final: o.status, db_refunded: o.refunded })
}
let md = '| Scenario (buyer) | Currency | Ticket | Booking fee | Attendee paid | Account charged | Stripe fee (ASSUMED) | Net to Amazing | Net to connector | Refunded | Final order status |\n|---|---|---|---|---|---|---|---|---|---|---|\n'
for (const r of rows) md += `| ${r.scen} | ${r.cur.toUpperCase()} | ${m(r.ticket, r.cur)} | ${m(r.booking, r.cur)} | ${m(r.paid, r.cur)} | ${r.acct} | ${m(r.fee, r.cur)} | ${m(r.amazing, r.cur)} | ${m(r.connector, r.cur)} | ${m(r.refunded, r.cur)} | ${r.final} |\n`
const tot = {}
for (const r of rows) { const t = (tot[r.cur] ??= { paid: 0, fee: 0, amazing: 0, connector: 0, refunded: 0 }); t.paid += r.paid; t.fee += r.fee; t.amazing += r.amazing; t.connector += r.connector; t.refunded += r.refunded }
for (const [c, t] of Object.entries(tot)) md += `| **Total ${c.toUpperCase()}** | ${c.toUpperCase()} | | | ${m(t.paid, c)} | | ${m(t.fee, c)} | ${m(t.amazing, c)} | ${m(t.connector, c)} | ${m(t.refunded, c)} | |\n`
md += `\nFee assumptions (FEE_ASSUMPTIONS in scripts/stripe-sim/server.mjs): ${Object.entries(L.fee_assumptions).map(([k, v]) => `${k.toUpperCase()} ${v.label}`).join('; ')}. Stripe keeps its fee on a refund (assumed). Platform application fee = 0 on every captured request. Amazing's own account is ${L.platform_account} in the sim. Mismatch between sim refunds and DB completed refunds: ${rows.filter((r) => r.refunded !== r.db_refunded).length}.`
fs.writeFileSync(`${DIR}/ledger.md`, md)
fs.writeFileSync(`${DIR}/ledger.json`, JSON.stringify({ rows, raw: L }, null, 2))
console.log(md)
