#!/usr/bin/env node
// Self-test for stripe-sim. Starts the sim on a spare port against a dummy
// local webhook receiver, walks a direct-charge purchase and a refund, and
// verifies every webhook signature the way stripe-node does. If `deno` is on
// PATH it also drives the sim with the real stripe-node 18 SDK (the one the
// functions import) and runs the SDK's own constructEventAsync on a delivery.
// Touches nothing outside this machine.
//
//   node scripts/stripe-sim/selftest.mjs

import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const SECRET = 'whsec_selftest'
const PORT = 12199
const BASE = `http://127.0.0.1:${PORT}`
const LOG = path.join(os.tmpdir(), `stripe-sim-selftest-${process.pid}.jsonl`)
const ACCT = 'acct_selftest_connector'
const KEY = { authorization: 'Bearer sk_test_sim' }
let passed = 0
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ok  ${msg}`) }

// Same algorithm as stripe-node's Webhooks.signature.verifyHeader: parse
// t= and every v1=, HMAC-SHA256(secret, `${t}.${payload}`) hex, constant-time
// compare against any v1, reject outside a 300 s tolerance.
function verify(payload, header, secret, tolerance = 300) {
  const parts = header.split(',').map((kv) => kv.split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || !sigs.length) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex')
  const match = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)))
  return match && Math.abs(Date.now() / 1000 - t) <= tolerance
}

// ---- dummy webhook receiver ---------------------------------------------------
const deliveries = []
const receiver = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    deliveries.push({ payload: body, sig: req.headers['stripe-signature'] })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}')
  })
})
await new Promise((r) => receiver.listen(0, '127.0.0.1', r))
const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`

// ---- sim ------------------------------------------------------------------------
const sim = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), WEBHOOK_URL: hookUrl, STRIPE_WEBHOOK_SECRET: SECRET, SIM_LOG: LOG },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((resolve, reject) => {
  sim.stdout.on('data', (d) => d.toString().includes('listening') && resolve())
  sim.on('exit', (code) => reject(new Error(`sim exited ${code}`)))
})

const form = (o, prefix = '') =>
  Object.entries(o).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k
    return v !== null && typeof v === 'object' ? form(v, key) : [[key, String(v)]]
  })
const api = async (method, p, { body, acct, idem } = {}) => {
  const headers = { ...KEY, 'content-type': 'application/x-www-form-urlencoded' }
  if (acct) headers['stripe-account'] = acct
  if (idem) headers['idempotency-key'] = idem
  const res = await fetch(BASE + p, { method, headers, body: body ? new URLSearchParams(form(body)).toString() : undefined })
  return { status: res.status, json: await res.json() }
}

try {
  console.log('stripe-sim selftest')

  // 1. Create a direct-charge session: £25.00 ticket + £0.50 booking fee.
  const params = {
    mode: 'payment',
    client_reference_id: 'order-1',
    line_items: [
      { quantity: 1, price_data: { currency: 'gbp', unit_amount: 2500, product_data: { name: 'Ticket' } } },
      { quantity: 1, price_data: { currency: 'gbp', unit_amount: 50, product_data: { name: 'Booking fee' } } },
    ],
    metadata: { order_id: 'order-1', event_id: 'ev-1' },
    payment_intent_data: { metadata: { order_id: 'order-1' } },
    success_url: 'http://localhost:5173/ok?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'http://localhost:5173/cancel',
  }
  const created = await api('POST', '/v1/checkout/sessions', { body: params, acct: ACCT, idem: 'order-1' })
  const s = created.json
  ok(created.status === 200 && s.object === 'checkout.session', 'session created')
  ok(s.amount_total === 2550 && s.currency === 'gbp', `amount_total is the sum of line items (${s.amount_total})`)
  ok(s.metadata.order_id === 'order-1' && s.client_reference_id === 'order-1', 'metadata and client_reference_id kept')
  ok(s.url === `http://localhost:${PORT}/pay/${s.id}`, 'url points at the pay page')
  ok(s.success_url.endsWith(`session_id=${s.id}`), '{CHECKOUT_SESSION_ID} substituted')
  ok(s.payment_intent === null && s.status === 'open' && s.payment_status === 'unpaid', 'open, unpaid, no intent yet')

  const replay = await api('POST', '/v1/checkout/sessions', { body: params, acct: ACCT, idem: 'order-1' })
  ok(replay.json.id === s.id, 'same idempotency key replays the same session')

  // 2. Account scoping: invisible on the platform, visible on the connector.
  ok((await api('GET', `/v1/checkout/sessions/${s.id}`)).status === 404, 'session not visible without Stripe-Account')
  ok((await api('GET', `/v1/checkout/sessions/${s.id}`, { acct: ACCT })).status === 200, 'session visible on its account')

  // 3. Pay through the page's endpoint; expect a redirect to success_url.
  const pay = await fetch(`${BASE}/pay/${s.id}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=pay',
  })
  ok(pay.status === 303 && pay.headers.get('location') === s.success_url, 'Pay redirects to success_url')
  const d1 = deliveries.at(-1)
  const e1 = JSON.parse(d1.payload)
  ok(verify(d1.payload, d1.sig, SECRET), 'webhook signature verifies (stripe-node algorithm)')
  ok(!verify(d1.payload, d1.sig, 'whsec_wrong'), 'signature fails with the wrong secret')
  ok(!verify(d1.payload + ' ', d1.sig, SECRET), 'signature fails on a changed body')
  ok(e1.type === 'checkout.session.completed' && e1.account === ACCT, 'completed event carries account')
  ok(e1.data.object.payment_status === 'paid' && /^pi_/.test(e1.data.object.payment_intent), 'paid session has a payment_intent')
  const pi = e1.data.object.payment_intent

  // 4. Refunds follow the account the money came into.
  const wrong = await api('POST', '/v1/refunds', { body: { payment_intent: pi, amount: 1000 } })
  ok(wrong.status === 404 && wrong.json.error.code === 'resource_missing', 'refund on the platform account fails')
  const tooMuch = await api('POST', '/v1/refunds', { body: { payment_intent: pi, amount: 9999 }, acct: ACCT })
  ok(tooMuch.status === 400 && tooMuch.json.error.code === 'amount_too_large', 'over-refund refused')
  const re = await api('POST', '/v1/refunds', { body: { payment_intent: pi, amount: 1000, metadata: { refund_id: 'r1' } }, acct: ACCT, idem: 'refund:r1' })
  ok(re.status === 200 && re.json.status === 'pending' && re.json.amount === 1000, 'refund created pending')
  const settled = await fetch(`${BASE}/_sim/refund/${re.json.id}/succeed`, { method: 'POST' }).then((r) => r.json())
  const e2 = JSON.parse(deliveries.at(-1).payload)
  ok(settled.refund.status === 'succeeded' && e2.type === 'refund.updated' && e2.account === ACCT, 'refund succeeded, refund.updated sent on the account')
  ok(verify(deliveries.at(-1).payload, deliveries.at(-1).sig, SECRET), 'refund webhook signature verifies')

  // 5. Ledger: fee charged to the receiving (connected) account.
  const ledger = await fetch(`${BASE}/_sim/ledger`).then((r) => r.json())
  const charge = ledger.entries.find((x) => x.kind === 'charge')
  const fee = Math.round(2550 * 0.015) + 20
  ok(charge.charged_on === ACCT && charge.stripe_fee_paid_by === ACCT, 'direct charge: receiver pays the Stripe fee')
  ok(charge.stripe_fee === fee && charge.net_to_receiver === 2550 - fee && charge.application_fee_to_platform === 0,
    `ledger: gross 2550, fee ${fee} (assumed), net ${2550 - fee}, platform 0`)

  // 6. Account control -> account.updated.
  await fetch(`${BASE}/_sim/account/${ACCT}`, { method: 'POST', body: JSON.stringify({ charges_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } }) })
  const e3 = JSON.parse(deliveries.at(-1).payload)
  ok(e3.type === 'account.updated' && e3.data.object.charges_enabled === false && e3.account === ACCT, 'account.updated sent')
  const acct = await api('GET', `/v1/accounts/${ACCT}`)
  ok(acct.json.requirements.disabled_reason === 'requirements.past_due', 'account read reflects control change')

  // 7. Decline -> expired + cancel_url.
  const s2 = (await api('POST', '/v1/checkout/sessions', { body: params })).json
  const dec = await fetch(`${BASE}/pay/${s2.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: '{"action":"decline"}' })
  const e4 = JSON.parse(deliveries.at(-1).payload)
  ok(dec.status === 303 && dec.headers.get('location') === params.cancel_url && e4.type === 'checkout.session.expired' && !('account' in e4),
    'Decline expires the session, redirects to cancel_url; platform event has no account')

  // 8. Request log.
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse)
  const first = lines.find((l) => l.kind === 'api' && l.path === '/v1/checkout/sessions')
  ok(first.stripe_account === ACCT && first.body.line_items[1].price_data.unit_amount === '50', 'request log holds parsed body and Stripe-Account')

  // 9. Real SDK cross-check (optional: needs deno).
  const deno = spawnSync('deno --version', { shell: true })
  if (deno.status === 0) {
    const code = `
      import Stripe from 'npm:stripe@18'
      const stripe = new Stripe('sk_test_sim', { httpClient: Stripe.createFetchHttpClient(), host: '127.0.0.1', port: ${PORT}, protocol: 'http' })
      const s = await stripe.checkout.sessions.create(${JSON.stringify(params)}, { stripeAccount: '${ACCT}', idempotencyKey: 'sdk-1' })
      const again = await stripe.checkout.sessions.retrieve(s.id, { stripeAccount: '${ACCT}' })
      const me = await stripe.accounts.retrieve()
      const other = await stripe.accounts.retrieve('${ACCT}')
      const eps = await stripe.webhookEndpoints.list({ limit: 100 })
      const paid = await stripe.paymentIntents.retrieve('${pi}', { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: '${ACCT}' })
      const txn = paid.latest_charge?.balance_transaction
      let missing = null
      try { await stripe.checkout.sessions.retrieve(s.id) } catch (e) { missing = e.code }
      const ev = await stripe.webhooks.constructEventAsync(Deno.env.get('P'), Deno.env.get('S'), '${SECRET}', undefined, Stripe.createSubtleCryptoProvider())
      console.log(JSON.stringify({ total: s.amount_total, same: again.id === s.id, me: me.id, charges: other.charges_enabled, eps: eps.data.length, missing, evType: ev.type, evAccount: ev.account, fee: txn?.fee, feeCur: txn?.currency }))
    `
    const file = path.join(os.tmpdir(), `stripe-sim-sdk-${process.pid}.ts`)
    fs.writeFileSync(file, code)
    const run = spawnSync(`deno run --quiet --allow-net=127.0.0.1 --allow-env "${file}"`, { env: { ...process.env, P: d1.payload, S: d1.sig }, encoding: 'utf8', shell: true })
    fs.rmSync(file, { force: true })
    if (run.status !== 0) throw new Error(`deno SDK check failed:\n${run.stderr}`)
    const r = JSON.parse(run.stdout.trim().split('\n').at(-1))
    ok(r.total === 2550 && r.same && r.me === 'acct_sim_platform' && r.charges === false && r.eps === 1, 'stripe-node 18 SDK round-trips through the sim')
    ok(r.missing === 'resource_missing', 'SDK sees resource_missing for a wrong-account read')
    ok(r.fee === 58 && r.feeCur === 'gbp', 'SDK expand latest_charge.balance_transaction returns the booked fee')
    ok(r.evType === 'checkout.session.completed' && r.evAccount === ACCT, 'stripe-node constructEventAsync accepts the sim signature')
  } else {
    console.log('  --  deno not found; skipped the real-SDK cross-check')
  }

  console.log(`PASS ${passed} checks`)
} catch (e) {
  console.error(`FAIL after ${passed} checks: ${e.message}`)
  process.exitCode = 1
} finally {
  sim.kill()
  receiver.close()
  fs.rmSync(LOG, { force: true })
}
