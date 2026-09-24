// Extra probes on the S16 pending order (s1 platform event, buyer g6).
import fs from 'node:fs'
import { check, saveResults, sim, sleep, psqlJson, DIR } from './lib.mjs'
import { snapshot } from './common.mjs'
const S1 = JSON.parse(fs.readFileSync(`${DIR}/state1.json`, 'utf8'))
const order = S1.S16.order
const S = {}
// X1: payment_intent.payment_failed carrying our order id in metadata (as stripe-checkout sets payment_intent_data.metadata)
{
  const r = await sim('POST', '/_sim/webhook', { type: 'payment_intent.payment_failed', object: { id: 'pi_sim_declined_x1', object: 'payment_intent', status: 'requires_payment_method', metadata: { order_id: order } } })
  await sleep(300)
  const o = psqlJson(`select status, stripe_payment_intent_id from event_orders where id='${order}'`)[0]
  S.X1 = { webhook: r.body?.status, order: o }
  check('X1', 'payment_intent.payment_failed for a pending Checkout order is matched (order has no PI id yet)', o.status !== 'pending', S.X1)
}
// X2: a completed+paid session whose amount_total/currency differ from the order, naming our order id
{
  const obj = { id: 'cs_test_sim_foreign_x2', object: 'checkout.session', status: 'complete', payment_status: 'paid', amount_total: 1, currency: 'usd', client_reference_id: order, metadata: { order_id: order }, payment_intent: 'pi_sim_foreign_x2' }
  const r = await sim('POST', '/_sim/webhook', { type: 'checkout.session.completed', object: obj })
  await sleep(400)
  const o = psqlJson(`select status, amount_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id from event_orders where id='${order}'`)[0]
  const snap = snapshot('s1', 'g6')
  S.X2 = { webhook: r.body?.status, order: o, tickets: snap.tickets.length }
  check('X2', 'a paid session for 1 USD cent does not confirm a 2500 GBP order', !(o.status === 'paid'), S.X2)
}
fs.writeFileSync(`${DIR}/state5.json`, JSON.stringify(S, null, 2))
saveResults('results5.json')
