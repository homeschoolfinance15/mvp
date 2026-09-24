// S1 S2 S4 S5 S6 S7 S8 S9 S16 — PLATFORM_FEE_BPS=0
import crypto from 'node:crypto'
import fs from 'node:fs'
import { check, saveResults, sim, sleep, psqlJson, DIR, URL } from './lib.mjs'
import { F, checkout, payPage, snapshot, capacity, createReq, hasAppFee } from './common.mjs'

const S = {}
const acct = F.people.conn.stripe_account_id

async function paidPurchase(sc, who, ev, expect) {
  const co = await checkout(who, ev)
  check(sc, 'stripe-checkout 200 with a sim session url', co.status === 200 && /localhost:12111\/pay\/cs_test_/.test(co.body?.url ?? ''), { status: co.status, url: co.body?.url, reason: co.body?.reason })
  const req = createReq(co.stripe)
  const li = req?.body?.line_items ?? []
  check(sc, 'one session-create request captured', !!req, co.stripe.map((l) => `${l.method} ${l.path}`))
  check(sc, 'Stripe-Account header', req?.stripe_account === expect.account, `sent ${req?.stripe_account}, expected ${expect.account}`)
  check(sc, 'line items', li.length === expect.lines.length && expect.lines.every((l, i) => Number(li[i]?.price_data?.unit_amount) === l.amount && li[i]?.price_data?.product_data?.name?.includes(l.name)), li.map((l) => ({ name: l.price_data?.product_data?.name, unit_amount: l.price_data?.unit_amount, currency: l.price_data?.currency, qty: l.quantity })))
  check(sc, 'currency on every line', li.every((l) => l.price_data?.currency === expect.currency), li.map((l) => l.price_data?.currency))
  check(sc, 'no application_fee_amount / transfer_data', !hasAppFee(req?.body) && !JSON.stringify(req?.body ?? {}).includes('transfer_data'), Object.keys(req?.body?.payment_intent_data ?? {}))
  check(sc, 'metadata + client_reference_id name the order', req?.body?.client_reference_id === co.body?.order_id && req?.body?.metadata?.order_id === co.body?.order_id, { client_reference_id: req?.body?.client_reference_id, metadata: req?.body?.metadata })
  check(sc, 'response amount/fee/currency', co.body?.amount_cents === expect.total && co.body?.fee_cents === (expect.fee ?? 0) && co.body?.currency === expect.currency, { amount_cents: co.body?.amount_cents, fee_cents: co.body?.fee_cents, currency: co.body?.currency })
  const before = snapshot(ev, who)
  check(sc, 'before pay: order pending, registration pending hold, no ticket', before.orders[0]?.status === 'pending' && before.registrations[0]?.status === 'pending' && before.tickets.length === 0, { order: before.orders[0]?.status, reg: before.registrations[0]?.status, tickets: before.tickets.length })
  const pay = await payPage(co.body.session_id, 'pay')
  const wh = pay.log.find((l) => l.kind === 'webhook')
  check(sc, 'pay: 303 to success_url, webhook delivered 200', pay.status === 303 && wh?.status === 200 && (wh?.account ?? null) === (expect.account ?? null), { status: pay.status, redirect: pay.body?.redirect, webhook: wh && { type: wh.type, account: wh.account, status: wh.status } })
  const after = snapshot(ev, who)
  const o = after.orders[0]
  check(sc, 'order paid with frozen account, amount, currency, app fee 0', o?.status === 'paid' && o?.has_paid_at && (o?.stripe_account_id ?? null) === (expect.account ?? null) && o?.amount_cents === expect.total && o?.currency === expect.currency && o?.application_fee_cents === 0 && (o?.fee_cents ?? 0) === (expect.fee ?? 0) && /^pi_sim_/.test(o?.stripe_payment_intent_id ?? ''), o)
  check(sc, 'registration confirmed, one ticket, exactly one message (payment)', after.registrations[0]?.status === 'confirmed' && after.tickets.length === 1 && after.messages.length === 1 && after.messages[0].kind === 'payment', { reg: after.registrations.map((r) => r.status), tickets: after.tickets.length, messages: after.messages })
  S[sc] = { who, ev, session: co.body.session_id, order: co.body.order_id, pi: o?.stripe_payment_intent_id }
  return S[sc]
}

// ---- S1 admin event GBP £25 -> platform account
await paidPurchase('S1', 'm1', 's1', { account: null, currency: 'gbp', total: 2500, lines: [{ name: 'Standard', amount: 2500 }] })
// ---- S2 connector event GBP £40 -> connector account (direct charge)
await paidPurchase('S2', 'g1', 's2', { account: acct, currency: 'gbp', total: 4000, lines: [{ name: 'Standard', amount: 4000 }] })
// ---- S4 EUR (connector) / S5 USD (admin)
await paidPurchase('S4', 'm2', 's4', { account: acct, currency: 'eur', total: 3000, lines: [{ name: 'Standard', amount: 3000 }] })
await paidPurchase('S5', 'g2', 's5', { account: null, currency: 'usd', total: 5000, lines: [{ name: 'Standard', amount: 5000 }] })
// extra paid orders on S2 used by the refund scenarios (S10–S13)
await paidPurchase('S2b', 'm3', 's2', { account: acct, currency: 'gbp', total: 4000, lines: [{ name: 'Standard', amount: 4000 }] })
await paidPurchase('S2c', 'g3', 's2', { account: acct, currency: 'gbp', total: 4000, lines: [{ name: 'Standard', amount: 4000 }] })
await paidPurchase('S2d', 'm4', 's2', { account: acct, currency: 'gbp', total: 4000, lines: [{ name: 'Standard', amount: 4000 }] })

// ---- S6 the same completed webhook delivered again, twice at once
{
  const state = (await sim('GET', '/_sim/state')).body
  const sess = state.sessions.find((s) => s.id === S.S2.session)
  const { account, ...obj } = sess
  const replays = await Promise.all([1, 2, 3].map(() => sim('POST', '/_sim/webhook', { type: 'checkout.session.completed', object: obj, account })))
  await sleep(500)
  const snap = snapshot('s2', 'g1')
  check('S6', 'three replays all acknowledged 200', replays.every((r) => r.body?.status === 200), replays.map((r) => r.body?.status))
  check('S6', 'still one paid order, one confirmed registration, one ticket, exactly one message (payment)', snap.orders.length === 1 && snap.orders[0].status === 'paid' && snap.registrations.length === 1 && snap.tickets.length === 1 && snap.messages.length === 1 && snap.messages[0].kind === 'payment', { orders: snap.orders.map((o) => o.status), tickets: snap.tickets.length, messages: snap.messages.length })
}

// ---- S7 session expired -> order failed, place released
{
  const cap0 = capacity('s9')
  const co = await checkout('m6', 's9') // capacity-1 event: the hold takes the only place
  const capHeld = capacity('s9')
  const blocked = await checkout('g6', 's9')
  const exp = await sim('POST', `/_sim/session/${co.body.session_id}/expire`)
  await sleep(400)
  const snap = snapshot('s9', 'm6')
  const capAfter = capacity('s9')
  check('S7', 'hold took the last place; a second buyer was refused sold_out with no Stripe call', co.status === 200 && blocked.status === 409 && blocked.body?.reason === 'sold_out' && blocked.stripe.length === 0, { cap0, capHeld, blocked: { status: blocked.status, reason: blocked.body?.reason, stripe_calls: blocked.stripe.length } })
  check('S7', 'expired webhook 200 -> order failed, registration expired, no ticket', exp.body?.webhook?.status === 200 && snap.orders[0]?.status === 'failed' && snap.registrations[0]?.status === 'expired' && snap.tickets.length === 0, { webhook: exp.body?.webhook?.status, order: snap.orders[0]?.status, reg: snap.registrations[0]?.status })
  check('S7', 'place is back on sale', capAfter.state === 'open', capAfter)
  S.S7 = { session: co.body.session_id, cap0, capHeld, capAfter }
}

// ---- S8 decline, and delayed method that fails
{
  const co = await checkout('g4', 's1')
  const dec = await payPage(co.body.session_id, 'decline')
  const wh = dec.log.find((l) => l.kind === 'webhook')
  const snap = snapshot('s1', 'g4')
  check('S8', 'Decline -> 303 to cancel_url, expired webhook 200, order failed, registration expired, no ticket', dec.status === 303 && /cancelled=1/.test(dec.body?.redirect ?? '') && wh?.status === 200 && snap.orders[0]?.status === 'failed' && snap.registrations[0]?.status === 'expired' && snap.tickets.length === 0, { redirect: dec.body?.redirect, webhook: wh?.type, order: snap.orders[0]?.status, reg: snap.registrations[0]?.status })
  // delayed method: completed-but-unpaid must not confirm; async_failed must release
  const co2 = await checkout('g4', 's1')
  const pa = await payPage(co2.body.session_id, 'pay_async')
  const mid = snapshot('s1', 'g4')
  const midOrder = mid.orders.find((o) => o.stripe_checkout_session_id === co2.body.session_id)
  check('S8', 'completed with payment_status=unpaid does NOT mark paid or issue a ticket', midOrder?.status === 'pending' && mid.tickets.length === 0, { order: midOrder?.status, tickets: mid.tickets.length, webhook: pa.log.find((l) => l.kind === 'webhook')?.status })
  const af = await sim('POST', `/_sim/session/${co2.body.session_id}/async_fail`)
  await sleep(400)
  const end = snapshot('s1', 'g4')
  const endOrder = end.orders.find((o) => o.stripe_checkout_session_id === co2.body.session_id)
  check('S8', 'async_payment_failed -> order failed, place released', af.body?.webhook?.status === 200 && endOrder?.status === 'failed' && end.registrations.every((r) => r.status === 'expired') && end.tickets.length === 0, { webhook: af.body?.webhook?.status, order: endOrder?.status, regs: end.registrations.map((r) => r.status) })
}

// ---- S9 two buyers race for the last paid place
{
  const [a, b] = await Promise.all([checkout('m5', 's9'), checkout('g5', 's9')])
  const creates = [...a.stripe, ...b.stripe].filter((l) => l.method === 'POST' && l.path === '/v1/checkout/sessions')
  const winner = a.status === 200 ? a : b
  const loser = a.status === 200 ? b : a
  check('S9', 'exactly one 200 and one 409 sold_out', [a.status, b.status].sort().join() === '200,409' && loser.body?.reason === 'sold_out', [{ status: a.status, reason: a.body?.reason }, { status: b.status, reason: b.body?.reason }])
  // Race logs can interleave; count sessions by the sim's own state instead.
  const st = (await sim('GET', '/_sim/state')).body
  const s9sessions = st.sessions.filter((s) => s.metadata?.event_id === F.events.s9.id && s.status === 'open')
  check('S9', 'only one open Stripe session exists for the event', s9sessions.length === 1, { open_sessions: s9sessions.length, creates_seen: creates.length })
  const pay = await payPage(winner.body.session_id, 'pay')
  const w = a.status === 200 ? 'm5' : 'g5'
  const l = a.status === 200 ? 'g5' : 'm5'
  const ws = snapshot('s9', w)
  const ls = snapshot('s9', l)
  check('S9', 'winner confirmed with a ticket; loser has no order and no registration', ws.orders[0]?.status === 'paid' && ws.tickets.length === 1 && ls.orders.length === 0 && ls.registrations.length === 0, { winner: w, loser: l, ws: ws.orders.map((o) => o.status), lo: ls.orders.length })
  check('S9', 'event now sold out', capacity('s9').state === 'sold_out', capacity('s9'))
  S.S9 = { winner: w, loser: l, session: winner.body.session_id }
}

// ---- S16 forged / unsigned webhooks
{
  const co = await checkout('g6', 's1')
  const st = (await sim('GET', '/_sim/state')).body
  const sess = st.sessions.find((s) => s.id === co.body.session_id)
  const { account, ...obj } = sess
  const forged = { id: 'evt_forged', object: 'event', type: 'checkout.session.completed', data: { object: { ...obj, status: 'complete', payment_status: 'paid', payment_intent: 'pi_forged' } } }
  const payload = JSON.stringify(forged)
  const t = Math.floor(Date.now() / 1000)
  const sig = (secret, p = payload) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${p}`).digest('hex')}`
  const post = (headers, body = payload) => fetch(`${URL}/functions/v1/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.text() }))
  const unsigned = await post({})
  const wrong = await post({ 'stripe-signature': sig('whsec_attacker') })
  const tampered = await post({ 'stripe-signature': sig('whsec_local_sim', payload.replace('"paid"', '"unpaid"')) })
  const stale = await post({ 'stripe-signature': `t=${t - 3600},v1=${crypto.createHmac('sha256', 'whsec_local_sim').update(`${t - 3600}.${payload}`).digest('hex')}` })
  const snap = snapshot('s1', 'g6')
  check('S16', 'unsigned 400, wrong secret 400, tampered body 400, 1h-old timestamp 400', [unsigned, wrong, tampered, stale].every((r) => r.status === 400), [unsigned, wrong, tampered, stale].map((r) => `${r.status} ${r.body.slice(0, 60)}`))
  check('S16', 'no writes: order still pending, no ticket, no message', snap.orders[0]?.status === 'pending' && snap.tickets.length === 0 && snap.messages.length === 0, { order: snap.orders[0]?.status, tickets: snap.tickets.length })
  S.S16 = { session: co.body.session_id, order: co.body.order_id }
}

fs.writeFileSync(`${DIR}/state1.json`, JSON.stringify(S, null, 2))
saveResults('results1.json')
