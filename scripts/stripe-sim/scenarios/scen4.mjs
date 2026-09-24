// S13 (refund after restricted + disconnected) and S17 (screen figures vs ledger). PLATFORM_FEE_BPS=0.
import fs from 'node:fs'
import { check, saveResults, sim, sleep, psqlJson, fn, rest, mark, since, DIR } from './lib.mjs'
import { F, tok, checkout, snapshot } from './common.mjs'
import { receipts } from '../../../src/routes/manage/rules.ts'

const S1 = JSON.parse(fs.readFileSync(`${DIR}/state1.json`, 'utf8'))
const acct = F.people.conn.stripe_account_id
const S = {}
const conn = () => psqlJson(`select stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled from connectors where id='${F.people.conn.connector_id}'`)[0]

// ---- S13
{
  const r1 = await sim('POST', `/_sim/account/${acct}`, { charges_enabled: false, requirements: { disabled_reason: 'requirements.past_due', currently_due: ['individual.verification.document'] } })
  await sleep(400)
  const afterRestrict = conn()
  check('S13', 'account.updated (restricted) -> connector restricted, charges off', r1.body?.webhook?.status === 200 && afterRestrict.stripe_account_status === 'restricted' && afterRestrict.stripe_charges_enabled === false, { webhook: r1.body?.webhook?.status, connector: afterRestrict })
  const blocked = await checkout('m5', 's2')
  check('S13', 'new sale on restricted connector refused 409, no Stripe session created', blocked.status === 409 && !blocked.stripe.some((l) => l.method === 'POST'), { status: blocked.status, reason: blocked.body?.reason, calls: blocked.stripe.map((l) => `${l.method} ${l.path}`) })
  const m = mark()
  const d = await fn(await tok('conn'), 'stripe-connect', { action: 'disconnect' })
  await sleep(200)
  const deauth = since(m).filter((l) => l.kind === 'api')
  const afterDisc = conn()
  check('S13', 'disconnect 200 -> status disconnected, stripe_account_id kept, deauthorize sent to sim', d.status === 200 && afterDisc.stripe_account_status === 'disconnected' && afterDisc.stripe_account_id === acct && deauth.some((l) => l.path === '/oauth/deauthorize'), { body: d.body, connector: afterDisc, calls: deauth.map((l) => `${l.method} ${l.path}`) })
  const revive = await sim('POST', `/_sim/account/${acct}`, { charges_enabled: true, requirements: { disabled_reason: null } })
  await sleep(400)
  check('S13', 'a later account.updated does not put a disconnected connector back on sale', revive.body?.webhook?.status === 200 && conn().stripe_account_status === 'disconnected' && conn().stripe_charges_enabled === false, conn())
  const o = S1.S2d.order
  const m2 = mark()
  const r = await fn(await tok('conn'), 'event-refund', { order_id: o })
  await sleep(200)
  const req = since(m2).find((l) => l.kind === 'api' && l.path === '/v1/refunds')
  check('S13', 'refund after disconnect: 200, Stripe-Account is the order stored account', r.status === 200 && req?.stripe_account === acct && Number(req?.body?.amount) === 4000, { status: r.status, body: r.body, stripe_account: req?.stripe_account })
  const st = await sim('POST', `/_sim/refund/${r.body.stripe_refund_id}/succeed`)
  await sleep(400)
  const snap = snapshot('s2', 'm4')
  check('S13', 'refund completes, order refunded, place kept', st.body?.webhook?.status === 200 && snap.orders[0].status === 'refunded' && snap.registrations[0].status === 'confirmed', { order: snap.orders[0].status, refunds: snap.refunds })
  S.S13 = { restrict: afterRestrict, blocked: { status: blocked.status, reason: blocked.body?.reason }, disconnect: d.body, refund: r.body, stripe_account_on_refund: req?.stripe_account }
}

// ---- S17 screen figures (same queries as EventResults.tsx:89-121 / AdminEvent.tsx:193,218) vs sim ledger
{
  const ledger = (await sim('GET', '/_sim/ledger')).body
  const orders = psqlJson(`select id, event_id, stripe_checkout_session_id, stripe_payment_intent_id from event_orders where event_id in (${Object.values(F.events).map((e) => `'${e.id}'`).join(',')})`)
  const evOfSession = Object.fromEntries(orders.map((o) => [o.stripe_checkout_session_id, o.event_id]))
  const evOfPi = Object.fromEntries(orders.filter((o) => o.stripe_payment_intent_id).map((o) => [o.stripe_payment_intent_id, o.event_id]))
  S.S17 = {}
  for (const [key, ev] of Object.entries(F.events)) {
    const who = ev.payment_connector_id ? 'conn' : 'admin'
    const t = await tok(who)
    const or = await rest(t, 'GET', `event_orders?select=*&event_id=eq.${ev.id}`)
    const ids = (or.body ?? []).map((o) => o.id)
    const rf = ids.length ? await rest(t, 'GET', `event_refunds?select=*&order_id=in.(${ids.join(',')})`) : { body: [] }
    const screen = receipts(or.body ?? [], rf.body ?? [], ev.currency)
    const charges = ledger.entries.filter((e) => e.kind === 'charge' && evOfSession[e.session] === ev.id)
    const refunds = ledger.entries.filter((e) => e.kind === 'refund' && evOfPi[e.payment_intent] === ev.id)
    const gross = charges.reduce((s, e) => s + e.gross, 0)
    const stripeFee = charges.reduce((s, e) => s + e.stripe_fee, 0)
    const refunded = refunds.reduce((s, e) => s + e.amount, 0)
    const appFee = charges.reduce((s, e) => s + e.application_fee_to_platform, 0)
    const receiver = [...new Set(charges.map((e) => e.charged_on))]
    const realNet = gross - stripeFee - refunded - appFee
    S.S17[key] = { viewer: who, screen, ledger: { receiver, charges: charges.length, gross, stripe_fee_assumed: stripeFee, refunded, app_fee: appFee, net_to_receiver_assumed: realNet } }
    if (charges.length === 0) continue
    check('S17', `${key}: screen gross/refunded/paid-orders match the ledger`, screen.grossCents === gross && screen.refundedCents === refunded && screen.paidOrders === charges.length, { screen, gross, refunded, charges: charges.length })
    check('S17', `${key}: screen "Net receipts" equals what the receiver actually nets (ledger, assumed Stripe fee)`, screen.netCents === realNet, { screen_net: screen.netCents, screen_fees_line: screen.feesCents, ledger_net: realNet, stripe_fee_assumed: stripeFee })
  }
  const ps = await fn(await tok('admin'), 'payments-status', {})
  S.S17.payments_status = { status: ps.status, body: ps.body }
}

fs.writeFileSync(`${DIR}/state4.json`, JSON.stringify(S, null, 2))
saveResults('results4.json')
