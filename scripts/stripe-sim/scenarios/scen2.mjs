// S10 S11 S12 S15 S9b — PLATFORM_FEE_BPS=0
import fs from 'node:fs'
import { check, saveResults, sim, sleep, psqlJson, psql, fn, rest, mark, since, soon, DIR } from './lib.mjs'
import { F, tok, checkout, payPage, snapshot, capacity } from './common.mjs'

const S1 = JSON.parse(fs.readFileSync(`${DIR}/state1.json`, 'utf8'))
const acct = F.people.conn.stripe_account_id
const S = {}

async function refund(who, order_id, amount_cents) {
  const m = mark()
  const r = await fn(await tok(who), 'event-refund', amount_cents ? { order_id, amount_cents, reason: 'qa' } : { order_id, reason: 'qa' })
  await sleep(200)
  return { ...r, stripe: since(m).filter((l) => l.kind === 'api') }
}
const orderRow = (id) => psqlJson(`select id, status, amount_cents, stripe_account_id, stripe_payment_intent_id from event_orders where id='${id}'`)[0]
const refundRows = (id) => psqlJson(`select id, amount_cents, status, stripe_refund_id, failure_message from event_refunds where order_id='${id}' order by created_at`)
async function settle(re, ok = true) { const r = await sim('POST', `/_sim/refund/${re}/${ok ? 'succeed' : 'fail'}`); await sleep(400); return r }

// ---- S10 full refund by host (connector event s2, buyer g1)
{
  const o = S1.S2.order
  const r = await refund('conn', o)
  const req = r.stripe.find((l) => l.method === 'POST' && l.path === '/v1/refunds')
  check('S10', 'event-refund 200 processing, amount 4000, remaining 0, registration_unchanged', r.status === 200 && r.body?.status === 'processing' && r.body?.amount_cents === 4000 && r.body?.remaining_cents === 0 && r.body?.registration_unchanged === true, r.body)
  check('S10', 'Stripe refund on the order account with the order PI and full amount', req?.stripe_account === acct && req?.body?.payment_intent === S1.S2.pi && Number(req?.body?.amount) === 4000 && req?.status === 200, req && { stripe_account: req.stripe_account, body: req.body, status: req.status })
  const mid = refundRows(o)
  check('S10', 'refund row processing with stripe id, order still paid', mid.length === 1 && mid[0].status === 'processing' && /^re_sim_/.test(mid[0].stripe_refund_id ?? '') && orderRow(o).status === 'paid', { mid, order: orderRow(o).status })
  const st = await settle(r.body.stripe_refund_id)
  const after = snapshot('s2', 'g1')
  check('S10', 'refund.updated (Connect, account set) -> 200; refund completed; order refunded', st.body?.webhook?.status === 200 && refundRows(o)[0].status === 'completed' && orderRow(o).status === 'refunded', { webhook: st.body?.webhook, refund: refundRows(o)[0].status, order: orderRow(o).status })
  check('S10', 'registration still confirmed, ticket not revoked (refund is not cancellation)', after.registrations[0]?.status === 'confirmed' && after.tickets.length === 1 && !after.tickets[0].revoked, { reg: after.registrations.map((x) => x.status), tickets: after.tickets })
  check('S10', 'refund messages queued (processing + completed)', after.messages.filter((m) => m.kind === 'refund').length >= 1, after.messages)
  const again = await refund('conn', o)
  check('S10', 'refund again after full refund -> 409, no Stripe call', again.status === 409 && again.stripe.length === 0, { status: again.status, body: again.body, stripe: again.stripe.length })
  const self = await refund('g1', o)
  check('S10', 'buyer cannot call event-refund on their own order -> 403', self.status === 403 && self.stripe.length === 0, { status: self.status, body: self.body })
  S.S10 = { order: o, stripe_refund: r.body.stripe_refund_id, messages: after.messages }
}

// ---- S11 partial then second partial up to total (s2, buyer m3)
{
  const o = S1.S2b.order
  const p1 = await refund('conn', o, 1500)
  const r1 = p1.stripe.find((l) => l.path === '/v1/refunds')
  check('S11', 'first partial 1500: 200 processing, Stripe amount 1500 on connector account, remaining 2500', p1.status === 200 && Number(r1?.body?.amount) === 1500 && r1?.stripe_account === acct && p1.body?.remaining_cents === 2500, { status: p1.status, body: p1.body, sent: r1?.body?.amount, acct: r1?.stripe_account })
  const inflight = await refund('conn', o, 500)
  check('S11', 'a second partial while the first is processing -> 409 refund_in_progress, no Stripe call', inflight.status === 409 && inflight.body?.reason === 'refund_in_progress' && inflight.stripe.length === 0, { status: inflight.status, body: inflight.body })
  await settle(p1.body.stripe_refund_id)
  check('S11', 'after first settles: refund completed, order partially_refunded', refundRows(o)[0]?.status === 'completed' && orderRow(o).status === 'partially_refunded', { refunds: refundRows(o), order: orderRow(o).status })
  const over = await refund('conn', o, 3000)
  check('S11', 'over-refund 3000 of remaining 2500 -> 400, no Stripe call', over.status === 400 && over.stripe.length === 0, { status: over.status, body: over.body })
  const p2 = await refund('conn', o, 2500)
  check('S11', 'second partial 2500 (the remainder) -> 200 and a Stripe refund', p2.status === 200 && p2.stripe.some((l) => l.path === '/v1/refunds'), { status: p2.status, body: p2.body, stripe_calls: p2.stripe.map((l) => `${l.method} ${l.path} ${l.status}`) })
  const p2full = await refund('conn', o)
  check('S11', '"everything left" (no amount) while the remainder is already in flight -> 409 refund_in_progress, no Stripe call', p2full.status === 409 && p2full.body?.reason === 'refund_in_progress' && p2full.stripe.length === 0, { status: p2full.status, body: p2full.body, stripe_calls: p2full.stripe.length })
  if (p2.status === 200) await settle(p2.body.stripe_refund_id)
  else if (p2full.status === 200) await settle(p2full.body.stripe_refund_id)
  check('S11', 'order reaches refunded with completed refunds summing 4000', orderRow(o).status === 'refunded' && refundRows(o).filter((x) => x.status === 'completed').reduce((s, x) => s + x.amount_cents, 0) === 4000, { order: orderRow(o).status, refunds: refundRows(o) })
  S.S11 = { order: o, refunds: refundRows(o), order_status: orderRow(o).status, p2: { status: p2.status, body: p2.body }, p2full: { status: p2full.status, body: p2full.body } }
}

// ---- S11b partial, settle, then "everything left" with no amount (s4 EUR, buyer m2)
{
  const o = S1.S4.order
  const p1 = await refund('conn', o, 1000)
  check('S11b', 'first partial 1000: 200, remaining 2000', p1.status === 200 && p1.body?.remaining_cents === 2000, { status: p1.status, body: p1.body })
  await settle(p1.body.stripe_refund_id)
  const rest = await refund('conn', o)
  const req = rest.stripe.find((l) => l.path === '/v1/refunds')
  check('S11b', 'no amount after a settled partial -> 200 refunding exactly the 2000 left, in EUR, on the connector account', rest.status === 200 && rest.body?.amount_cents === 2000 && rest.body?.remaining_cents === 0 && Number(req?.body?.amount) === 2000 && req?.stripe_account === acct, { status: rest.status, body: rest.body, sent: req?.body?.amount, acct: req?.stripe_account })
  if (rest.status === 200) await settle(rest.body.stripe_refund_id)
  const done = refundRows(o).filter((x) => x.status === 'completed')
  check('S11b', 'order refunded, completed refunds sum to the order amount 3000', orderRow(o).status === 'refunded' && done.reduce((a, x) => a + x.amount_cents, 0) === 3000, { order: orderRow(o).status, refunds: refundRows(o) })
  const more = await refund('conn', o)
  check('S11b', 'anything further -> 409, no Stripe call', more.status === 409 && more.stripe.length === 0, { status: more.status, body: more.body })
}

// ---- S12 double refund while first in flight (s2, buyer g3)
{
  const o = S1.S2c.order
  const m = mark()
  const [a, b] = await Promise.all([fn(await tok('conn'), 'event-refund', { order_id: o }), fn(await tok('admin'), 'event-refund', { order_id: o })])
  await sleep(300)
  const posts = since(m).filter((l) => l.kind === 'api' && l.method === 'POST' && l.path === '/v1/refunds')
  const statuses = [a.status, b.status].sort().join()
  check('S12', 'host and admin click together: one 200, one 409 refund_in_progress', statuses === '200,409' && [a, b].find((x) => x.status === 409)?.body?.reason === 'refund_in_progress', [{ s: a.status, b: a.body }, { s: b.status, b: b.body }])
  check('S12', 'exactly one Stripe refund request', posts.length === 1 && posts[0].stripe_account === acct, posts.map((p) => ({ acct: p.stripe_account, amount: p.body?.amount, idem: p.idempotency_key })))
  const third = await refund('conn', o)
  check('S12', 'a third click while processing -> 409, no Stripe call', third.status === 409 && third.stripe.length === 0, { status: third.status, body: third.body })
  const ok = [a, b].find((x) => x.status === 200)
  const fail = await settle(ok.body.stripe_refund_id, false)
  check('S12', 'Stripe fails the refund -> refund row failed, order still paid', fail.body?.webhook?.status === 200 && refundRows(o)[0].status === 'failed' && orderRow(o).status === 'paid', { refunds: refundRows(o), order: orderRow(o).status })
  const retry = await refund('conn', o)
  check('S12', 'after a failed refund a retry is allowed (one new Stripe refund)', retry.status === 200 && retry.stripe.filter((l) => l.path === '/v1/refunds').length === 1, { status: retry.status, body: retry.body })
  if (retry.status === 200) await settle(retry.body.stripe_refund_id)
  check('S12', 'retry completes -> order refunded', orderRow(o).status === 'refunded', { refunds: refundRows(o), order: orderRow(o).status })
  S.S12 = { order: o, refunds: refundRows(o) }
}

// ---- S15 host cancels an event with one paid order and one open checkout (s15)
{
  const paid = await checkout('m6', 's15')
  await payPage(paid.body.session_id, 'pay')
  const open = await checkout('g6', 's15')
  const m = mark()
  const c = await rest(await tok('conn'), 'PATCH', `events?id=eq.${F.events.s15.id}`, { status: 'cancelled' })
  await sleep(500)
  const afterCancel = { paid: snapshot('s15', 'm6'), open: snapshot('s15', 'g6') }
  const stripeCalls = since(m).filter((l) => l.kind === 'api')
  const cancelMsgs = psqlJson(`select kind, status from event_messages where event_id='${F.events.s15.id}' and kind='cancelled'`)
  check('S15', 'host cancel (same PATCH as EventEditor.tsx:696) succeeds', c.status === 200 && c.body?.[0]?.status === 'cancelled', { status: c.status })
  check('S15', 'cancelled notice queued', cancelMsgs.length === 1, cancelMsgs)
  check('S15', 'OBSERVED: paid order stays paid, no refund row, no Stripe refund request (nothing refunds automatically)', afterCancel.paid.orders[0]?.status === 'paid' && afterCancel.paid.refunds.length === 0 && stripeCalls.length === 0, { order: afterCancel.paid.orders[0]?.status, refunds: afterCancel.paid.refunds.length, stripe_calls: stripeCalls.length })
  check('S15', 'OBSERVED: open checkout session is not expired at Stripe on cancel', stripeCalls.every((l) => !/expire/.test(l.path)), stripeCalls.map((l) => l.path))
  const late = await payPage(open.body.session_id, 'pay')
  const lateSnap = snapshot('s15', 'g6')
  S.S15 = { paid: afterCancel.paid, open_before_pay: afterCancel.open, late_webhook: late.log.find((l) => l.kind === 'webhook'), late: lateSnap, cancelMsgs }
  check('S15', 'payment into a cancelled event is not turned into a live place without a refund flag', !(lateSnap.orders[0]?.status === 'paid' && lateSnap.registrations[0]?.status === 'confirmed' && lateSnap.refunds.length === 0), { webhook: S.S15.late_webhook?.status, order: lateSnap.orders[0]?.status, reg: lateSnap.registrations.map((r) => r.status), tickets: lateSnap.tickets, refunds: lateSnap.refunds })
}

// ---- S9b a lapsed hold (session still open at Stripe) and a second buyer both pay the last place
{
  const connTok = await tok('conn')
  const ev = (await rest(connTok, 'POST', 'events', { host_id: F.people.conn.id, title: `${F.tag} S9b oversell`, starts_at: soon(14), ends_at: soon(14, 3), currency: 'gbp', capacity: 1, refund_terms: 'Refunds up to 48h before.' })).body[0]
  const tt = (await rest(connTok, 'POST', 'ticket_types', { event_id: ev.id, name: 'Standard', price_cents: 1000, currency: 'gbp' })).body[0]
  await rest(connTok, 'PATCH', `events?id=eq.${ev.id}`, { status: 'published' })
  F.events.s9b = { id: ev.id, ticket_type_id: tt.id, currency: 'gbp', price: 1000, capacity: 1, payment_connector_id: F.people.conn.connector_id }
  fs.writeFileSync(`${DIR}/fixtures.json`, JSON.stringify(F, null, 2))
  const a = await checkout('m2', 's9b')
  // SIMULATED TIME (psql): the 20-minute hold (stripe-checkout HOLD_MINUTES) lapses while the Stripe session (SESSION_MINUTES=30) is still open.
  psql(`update event_registrations set hold_expires_at = now() - interval '1 minute' where event_id='${ev.id}' and profile_id='${F.people.m2.id}'`)
  const capLapsed = capacity('s9b')
  const b = await checkout('g2', 's9b')
  const pa = await payPage(a.body.session_id, 'pay')
  const pb = b.status === 200 ? await payPage(b.body.session_id, 'pay') : null
  const confirmed = psqlJson(`select profile_id, status from event_registrations where event_id='${ev.id}' and status='confirmed'`)
  const tickets = psqlJson(`select id from event_tickets where event_id='${ev.id}'`)
  const needs = psqlJson(`select f.status, f.reason from event_refunds f join event_orders o on o.id=f.order_id where o.event_id='${ev.id}'`)
  const orders = psqlJson(`select profile_id, status, amount_cents from event_orders where event_id='${ev.id}'`)
  S.S9b = { capLapsed, a: { status: a.status, session: a.body?.session_id }, b: { status: b.status, reason: b.body?.reason, session: b.body?.session_id }, webhook_a: pa.log.find((l) => l.kind === 'webhook')?.status, webhook_b: pb?.log.find((l) => l.kind === 'webhook')?.status, confirmed, tickets: tickets.length, needs, orders, capacity: capacity('s9b') }
  check('S9b', 'capacity 1 never ends with 2 confirmed places / 2 tickets and no refund flag', !(confirmed.length > 1 && needs.length === 0), S.S9b)
}

fs.writeFileSync(`${DIR}/state2.json`, JSON.stringify(S, null, 2))
saveResults('results2.json')
