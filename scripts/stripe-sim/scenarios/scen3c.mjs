// S14 part 3 (lost webhook -> retry -> reconcile) and S3 (PLATFORM_FEE_BPS=500). Functions serve runs env.sim.fee500.
import fs from 'node:fs'
import { check, saveResults, sim, sleep, psqlJson, psql, fn, mark, since, SERVICE, URL, DIR } from './lib.mjs'
import { F, tok, checkout, payPage, snapshot, createReq, hasAppFee } from './common.mjs'

const A = JSON.parse(fs.readFileSync(`${DIR}/state3a.json`, 'utf8'))
const B = JSON.parse(fs.readFileSync(`${DIR}/state3b.json`, 'utf8'))
const acct = F.people.conn.stripe_account_id
const S = {}

// ---- S14
{
  check('S14', 'both deliveries were lost (receiver not 2xx)', B.conn.webhook.status >= 500 && B.plat.webhook.status >= 500, [B.conn.webhook, B.plat.webhook])
  const pre = { conn: snapshot('s2', 'g2'), plat: snapshot('s1', 'm4') }
  check('S14', 'Stripe says paid, our orders still pending, no ticket', pre.conn.orders[0]?.status === 'pending' && pre.plat.orders[0]?.status === 'pending' && pre.conn.tickets.length === 0 && pre.plat.tickets.length === 0, { conn: pre.conn.orders[0]?.status, plat: pre.plat.orders[0]?.status })
  // SIMULATED TIME (psql): the connector buyer's 20-minute hold lapses, then they press Pay again.
  psql(`update event_registrations set hold_expires_at = now() - interval '1 minute' where event_id='${F.events.s2.id}' and profile_id='${F.people.g2.id}' and status='pending'`)
  const retry = await checkout('g2', 's2')
  const retrieve = retry.stripe.find((l) => l.method === 'GET' && l.path.startsWith('/v1/checkout/sessions/'))
  check('S14', 'retry after lapsed hold -> 409 payment_confirming, asked Stripe on the connector account, no new session', retry.status === 409 && retry.body?.reason === 'payment_confirming' && retrieve?.stripe_account === acct && !retry.stripe.some((l) => l.method === 'POST'), { status: retry.status, reason: retry.body?.reason, calls: retry.stripe.map((l) => `${l.method} ${l.path} acct=${l.stripe_account}`) })
  const m = mark()
  const rec = await fetch(`${URL}/functions/v1/stripe-reconcile`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE}` }, body: JSON.stringify({ older_than_minutes: 0 }) }).then(async (r) => ({ status: r.status, body: await r.json() }))
  await sleep(500)
  const calls = since(m).filter((l) => l.kind === 'api')
  const post = { conn: snapshot('s2', 'g2'), plat: snapshot('s1', 'm4') }
  const connGet = calls.find((l) => l.path === `/v1/checkout/sessions/${A.conn.session}`)
  const platGet = calls.find((l) => l.path === `/v1/checkout/sessions/${A.plat.session}`)
  check('S14', 'stripe-reconcile 200 and confirmed >= 2', rec.status === 200 && rec.body.confirmed >= 2, rec.body)
  check('S14', 'reconcile read each session on the account that took it', connGet?.stripe_account === acct && platGet && platGet.stripe_account === null, { conn: connGet?.stripe_account, plat: platGet?.stripe_account })
  check('S14', 'both orders paid with PI, registrations confirmed, one ticket each', post.conn.orders[0]?.status === 'paid' && post.plat.orders[0]?.status === 'paid' && /^pi_sim/.test(post.conn.orders[0]?.stripe_payment_intent_id ?? '') && post.conn.registrations[0]?.status === 'confirmed' && post.plat.registrations[0]?.status === 'confirmed' && post.conn.tickets.length === 1 && post.plat.tickets.length === 1, { conn: post.conn, plat: post.plat })
  // the late delivery finally arrives: nothing doubles
  const st = (await sim('GET', '/_sim/state')).body
  const { account, ...obj } = st.sessions.find((x) => x.id === A.conn.session)
  const late = await sim('POST', '/_sim/webhook', { type: 'checkout.session.completed', object: obj, account })
  await sleep(300)
  const fin = snapshot('s2', 'g2')
  check('S14', 'late original delivery after reconcile -> 200, still one ticket', late.body?.status === 200 && fin.tickets.length === 1 && fin.orders.length === 1, { webhook: late.body?.status, tickets: fin.tickets.length })
  const rec2 = await fetch(`${URL}/functions/v1/stripe-reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)
  check('S14', 'reconcile without service key / admin token -> 401', rec2 === 401, rec2)
  S.S14 = { reconcile: rec.body, conn_order: post.conn.orders[0], plat_order: post.plat.orders[0] }
}

// ---- S3 connector event with PLATFORM_FEE_BPS=500 (s3, buyer m1)
{
  const co = await checkout('m1', 's3')
  const req = createReq(co.stripe)
  const li = req?.body?.line_items ?? []
  check('S3', 'checkout 200: amount 4200, fee 200, gbp', co.status === 200 && co.body.amount_cents === 4200 && co.body.fee_cents === 200 && co.body.currency === 'gbp', co.body)
  check('S3', 'two line items: ticket 4000 + "Booking fee" 200, both gbp, qty 1', li.length === 2 && Number(li[0].price_data.unit_amount) === 4000 && Number(li[1].price_data.unit_amount) === 200 && li[1].price_data.product_data.name === 'Booking fee' && li.every((l) => l.price_data.currency === 'gbp' && Number(l.quantity) === 1), li.map((l) => ({ name: l.price_data?.product_data?.name, unit_amount: l.price_data?.unit_amount, currency: l.price_data?.currency, qty: l.quantity })))
  check('S3', 'charged on connector account; no application_fee_amount / transfer_data', req?.stripe_account === acct && !hasAppFee(req?.body) && !JSON.stringify(req?.body).includes('transfer_data'), { stripe_account: req?.stripe_account, pid: Object.keys(req?.body?.payment_intent_data ?? {}) })
  const pay = await payPage(co.body.session_id, 'pay')
  const snap = snapshot('s3', 'm1')
  check('S3', 'paid: order amount 4200, fee_cents 200, application_fee_cents 0, account frozen', snap.orders[0]?.status === 'paid' && snap.orders[0].amount_cents === 4200 && snap.orders[0].fee_cents === 200 && snap.orders[0].application_fee_cents === 0 && snap.orders[0].stripe_account_id === acct && snap.tickets.length === 1, snap.orders[0])
  const ledger = (await sim('GET', '/_sim/ledger')).body.entries.find((e) => e.session === co.body.session_id)
  check('S3', 'sim ledger: gross 4200 on connector account, platform application fee 0', ledger?.charged_on === acct && ledger?.gross === 4200 && ledger?.application_fee_to_platform === 0, ledger)
  S.S3 = { session: co.body.session_id, order: co.body.order_id, ledger, webhook: pay.log.find((l) => l.kind === 'webhook')?.status }
}

fs.writeFileSync(`${DIR}/state3.json`, JSON.stringify(S, null, 2))
saveResults('results3.json')
