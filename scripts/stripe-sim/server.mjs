#!/usr/bin/env node
// ============================================================================
// stripe-sim — a LOCAL-ONLY fake of the slice of the Stripe API that
// supabase/functions/* call. No dependencies. Never talks to api.stripe.com.
//
// The functions reach it through _shared/stripe.ts, which points stripe-node at
// STRIPE_API_BASE when (and only when) that variable is set. Production never
// sets it. See README.md.
//
// Covered (grep of supabase/functions/*/index.ts, stripe-node 18):
//   POST /v1/checkout/sessions               stripe-checkout
//   GET  /v1/checkout/sessions/:id           stripe-checkout, stripe-reconcile
//   POST /v1/checkout/sessions/:id/expire    (not called today; cheap)
//   POST /v1/refunds                         event-refund
//   GET  /v1/refunds/:id
//   GET  /v1/account, /v1/accounts/:id       payments-status, stripe-connect
//   GET  /v1/webhook_endpoints               payments-status
//   POST /oauth/token, /oauth/deauthorize    stripe-connect (see README: the
//                                            SDK sends these to
//                                            connect.stripe.com, not the host)
//
// Control API (not Stripe): see README.md.
// ============================================================================

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT ?? 12111)
const PUBLIC_BASE = process.env.SIM_PUBLIC_BASE ?? `http://localhost:${PORT}`
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://127.0.0.1:54321/functions/v1/stripe-webhook'
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_sim'
const LOG = process.env.SIM_LOG ??
  'C:/Users/srima/AppData/Local/Temp/claude/C--Dev-Code-Repo-Amazing-AI-mvp/8867e1cc-d376-480c-a101-9d90bcc40d94/scratchpad/pay/stripe-requests.jsonl'
const PLATFORM = process.env.SIM_PLATFORM_ACCOUNT ?? 'acct_sim_platform'
const API_VERSION = '2025-02-24.acacia' // informational only; echoed on events

// ---------------------------------------------------------------------------
// ASSUMPTIONS — Stripe processing fees, the one place they live.
// Not read from Stripe: these are the published standard rates as briefed
// (UK standard card; EUR; USD). Stripe charges its processing fee to whichever
// account RECEIVES the charge — with a direct charge (Stripe-Account header)
// that is the connected account, otherwise the platform.
// Refunds: assumed Stripe does not return the original processing fee.
// ---------------------------------------------------------------------------
const FEE_ASSUMPTIONS = {
  gbp: { pct: 0.015, fixed: 20, label: '1.5% + 20p (standard UK card) — ASSUMPTION' },
  eur: { pct: 0.015, fixed: 25, label: '1.5% + €0.25 — ASSUMPTION' },
  usd: { pct: 0.029, fixed: 30, label: '2.9% + 30¢ — ASSUMPTION' },
}
function stripeFee(amount, currency) {
  const f = FEE_ASSUMPTIONS[currency]
  if (!f) return null
  return Math.round(amount * f.pct) + f.fixed
}

// ---------------------------------------------------------------------------
// State (memory only). Every object is keyed by id and remembers its account.
// ---------------------------------------------------------------------------
const sessions = new Map() // id -> { account, obj }
const intents = new Map() // pi id -> { account, obj }
const refunds = new Map() // re id -> { account, obj }
const idem = new Map() // `${account}|${key}` -> { status, body }
const ledger = [] // money movements, per receiving account
const accounts = new Map() // acct id -> account object
accounts.set(PLATFORM, account(PLATFORM, { charges_enabled: true, payouts_enabled: true }))

const now = () => Math.floor(Date.now() / 1000)
const rid = (prefix) => `${prefix}_sim_${crypto.randomBytes(12).toString('hex')}`

function account(id, flags = {}) {
  return {
    id,
    object: 'account',
    type: 'standard',
    country: 'GB',
    default_currency: 'gbp',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    ...flags,
  }
}

// ---------------------------------------------------------------------------
// Form decoding the way stripe-node encodes: a[b][0][c]=v (qs, indices).
// ---------------------------------------------------------------------------
function parseForm(text) {
  const root = {}
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const m = rawKey.match(/^([^[]+)((?:\[[^\]]*\])*)$/)
    if (!m) continue
    const keys = [m[1], ...[...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])]
    let node = root
    keys.forEach((k, i) => {
      if (k === '') k = String(Object.keys(node).length) // a[]=x
      if (i === keys.length - 1) node[k] = value
      else node = node[k] ??= {}
    })
  }
  return arrays(root)
}
function arrays(v) {
  if (v === null || typeof v !== 'object') return v
  const keys = Object.keys(v)
  for (const k of keys) v[k] = arrays(v[k])
  if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => v[k])
  return v
}

// ---------------------------------------------------------------------------
// Logging and webhooks
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(LOG), { recursive: true })
function log(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

function sign(payload, secret, t = now()) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex')
  return `t=${t},v1=${v1}`
}

async function sendEvent(type, object, acct) {
  const event = {
    id: rid('evt'),
    object: 'event',
    api_version: API_VERSION,
    created: now(),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    // Connect events carry the connected account; platform events do not.
    ...(acct && acct !== PLATFORM ? { account: acct } : {}),
  }
  const payload = JSON.stringify(event)
  let status = null
  let body = null
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload, WEBHOOK_SECRET) },
      body: payload,
    })
    status = res.status
    body = (await res.text()).slice(0, 500)
  } catch (e) {
    body = String(e?.message ?? e)
  }
  log({ kind: 'webhook', type, event_id: event.id, account: event.account ?? null, object_id: object.id, url: WEBHOOK_URL, status, response: body })
  return { event_id: event.id, status, response: body }
}

// ---------------------------------------------------------------------------
// Stripe-shaped errors
// ---------------------------------------------------------------------------
const err = (status, message, extra = {}) => ({
  status,
  body: { error: { type: 'invalid_request_error', message, ...extra } },
})
const missing = (what, id) =>
  err(404, `No such ${what}: '${id}'`, { code: 'resource_missing', param: 'id' })

// Objects are only visible on the account they live on — exactly the property
// a refund routed to the wrong account (PAYMENTS.md §7.2) would trip over.
function own(map, id, acct) {
  const hit = map.get(id)
  return hit && hit.account === acct ? hit : null
}

// ---------------------------------------------------------------------------
// Stripe API handlers
// ---------------------------------------------------------------------------
function createSession(p, acct) {
  if (p.mode !== 'payment') return err(400, `sim: only mode=payment is simulated (got ${p.mode})`, { param: 'mode' })
  const items = p.line_items ?? []
  if (!Array.isArray(items) || !items.length) return err(400, 'Missing required param: line_items.', { param: 'line_items' })
  const currencies = new Set(items.map((li) => li.price_data?.currency))
  if (currencies.size !== 1 || [...currencies][0] == null)
    return err(400, 'All line_items must share one currency (price_data.currency).', { param: 'line_items' })
  let total = 0
  const lines = []
  for (const li of items) {
    const unit = Number(li.price_data?.unit_amount)
    const qty = Number(li.quantity ?? 1)
    if (!Number.isInteger(unit) || unit < 0 || !Number.isInteger(qty) || qty < 1)
      return err(400, 'Invalid line item amount or quantity.', { param: 'line_items' })
    total += unit * qty
    lines.push({ name: li.price_data?.product_data?.name ?? null, unit_amount: unit, quantity: qty, amount_total: unit * qty })
  }
  if (!p.success_url) return err(400, 'Missing required param: success_url.', { param: 'success_url' })
  const id = rid('cs_test')
  const obj = {
    id,
    object: 'checkout.session',
    mode: 'payment',
    status: 'open',
    payment_status: 'unpaid',
    amount_subtotal: total,
    amount_total: total,
    currency: [...currencies][0],
    client_reference_id: p.client_reference_id ?? null,
    customer_email: p.customer_email ?? null,
    customer_details: p.customer_email ? { email: p.customer_email } : null,
    metadata: p.metadata ?? {},
    // Since API 2022-08-01 a payment-mode session has no PaymentIntent until
    // it is paid. The sim follows that, so code that stores it at create time
    // sees null exactly as it would in production.
    payment_intent: null,
    success_url: String(p.success_url).replaceAll('{CHECKOUT_SESSION_ID}', id),
    cancel_url: p.cancel_url ?? null,
    expires_at: p.expires_at ? Number(p.expires_at) : now() + 24 * 3600,
    created: now(),
    livemode: false,
    url: `${PUBLIC_BASE}/pay/${id}`,
  }
  sessions.set(id, {
    account: acct,
    obj,
    lines,
    intentData: p.payment_intent_data ?? {},
    application_fee_amount: Number(p.payment_intent_data?.application_fee_amount ?? 0),
    transfer_data: p.payment_intent_data?.transfer_data ?? null,
  })
  return { status: 200, body: obj }
}

function createRefund(p, acct) {
  const piId = p.payment_intent ?? null
  if (!piId) return err(400, 'sim: refunds need payment_intent (charge= is not used by this codebase).', { param: 'payment_intent' })
  const pi = own(intents, piId, acct)
  if (!pi) return missing('payment_intent', piId)
  const already = [...refunds.values()]
    .filter((r) => r.obj.payment_intent === piId && ['pending', 'succeeded'].includes(r.obj.status))
    .reduce((s, r) => s + r.obj.amount, 0)
  const amount = p.amount != null ? Number(p.amount) : pi.obj.amount - already
  if (!Number.isInteger(amount) || amount <= 0) return err(400, 'Invalid refund amount.', { param: 'amount' })
  if (amount + already > pi.obj.amount)
    return err(400, `Refund amount (${amount}) is greater than unrefunded amount on charge (${pi.obj.amount - already}).`, { code: 'amount_too_large', param: 'amount' })
  const obj = {
    id: rid('re'),
    object: 'refund',
    amount,
    currency: pi.obj.currency,
    charge: pi.obj.latest_charge,
    payment_intent: piId,
    status: 'pending',
    failure_reason: null,
    metadata: p.metadata ?? {},
    reason: p.reason ?? null,
    created: now(),
  }
  refunds.set(obj.id, { account: acct, obj })
  return { status: 200, body: obj }
}

function webhookEndpoints() {
  return {
    object: 'list',
    url: '/v1/webhook_endpoints',
    has_more: false,
    data: [{
      id: 'we_sim_local',
      object: 'webhook_endpoint',
      url: WEBHOOK_URL,
      status: 'enabled',
      connect: true,
      enabled_events: [
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
        'checkout.session.expired',
        'payment_intent.payment_failed',
        'charge.refund.updated',
        'refund.updated',
        'account.updated',
      ],
    }],
  }
}

async function stripeApi(method, route, p, acct) {
  let m
  if (method === 'POST' && route === '/v1/checkout/sessions') return createSession(p, acct)
  if (method === 'GET' && (m = route.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
    const s = own(sessions, m[1], acct)
    return s ? { status: 200, body: s.obj } : missing('checkout.session', m[1])
  }
  if (method === 'POST' && (m = route.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
    const s = own(sessions, m[1], acct)
    if (!s) return missing('checkout.session', m[1])
    if (s.obj.status !== 'open') return err(400, `Only Checkout Sessions with a status in ["open"] can be expired.`)
    await expireSession(s)
    return { status: 200, body: s.obj }
  }
  if (method === 'POST' && route === '/v1/refunds') return createRefund(p, acct)
  if (method === 'GET' && (m = route.match(/^\/v1\/refunds\/([^/]+)$/))) {
    const r = own(refunds, m[1], acct)
    return r ? { status: 200, body: r.obj } : missing('refund', m[1])
  }
  if (method === 'GET' && (m = route.match(/^\/v1\/payment_intents\/([^/]+)$/))) {
    const pi = own(intents, m[1], acct)
    if (!pi) return missing('payment_intent', m[1])
    // expand[]=latest_charge.balance_transaction, as recordStripeFee asks. A
    // charge has a balance transaction only once it has succeeded; the fee is
    // the same assumed figure the ledger books, settled in the charge currency.
    if ([p.expand ?? []].flat().includes('latest_charge.balance_transaction')) {
      const fee = pi.obj.status === 'succeeded' ? stripeFee(pi.obj.amount, pi.obj.currency) : null
      const txn = fee == null ? null : { id: `txn_${pi.obj.latest_charge}`, object: 'balance_transaction', amount: pi.obj.amount, currency: pi.obj.currency, fee, net: pi.obj.amount - fee }
      return { status: 200, body: { ...pi.obj, latest_charge: { id: pi.obj.latest_charge, object: 'charge', balance_transaction: txn } } }
    }
    return { status: 200, body: pi.obj }
  }
  if (method === 'GET' && route === '/v1/account') return { status: 200, body: accounts.get(acct) ?? account(acct) }
  if (method === 'GET' && (m = route.match(/^\/v1\/accounts\/([^/]+)$/))) {
    const a = accounts.get(m[1])
    return a ? { status: 200, body: a } : err(403, `The provided key does not have access to account '${m[1]}' (or that account does not exist).`, { code: 'account_invalid' })
  }
  if (method === 'GET' && route === '/v1/webhook_endpoints') return { status: 200, body: webhookEndpoints() }
  if (method === 'POST' && route === '/oauth/token') {
    if (p.grant_type !== 'authorization_code' || !p.code) return err(400, 'invalid_grant', { error: 'invalid_grant' })
    // A code named like acct_… connects that account (handy for tests);
    // anything else mints a fresh one. Codes are single-use, as at Stripe.
    if (usedCodes.has(p.code)) return { status: 400, body: { error: 'invalid_grant', error_description: `Authorization code already used: ${p.code}` } }
    usedCodes.add(p.code)
    const id = /^acct_/.test(p.code) ? p.code : rid('acct')
    if (!accounts.has(id)) accounts.set(id, account(id))
    return { status: 200, body: { access_token: 'sk_test_sim_connected', livemode: false, refresh_token: 'rt_sim', token_type: 'bearer', scope: 'read_write', stripe_user_id: id, stripe_publishable_key: 'pk_test_sim' } }
  }
  if (method === 'POST' && route === '/oauth/deauthorize') {
    if (!accounts.has(p.stripe_user_id)) return { status: 400, body: { error: 'invalid_client', error_description: `No such user: ${p.stripe_user_id}` } }
    return { status: 200, body: { stripe_user_id: p.stripe_user_id } }
  }
  return err(404, `sim: unrecognised request URL (${method}: ${route}). Add it to scripts/stripe-sim/server.mjs.`)
}
const usedCodes = new Set()

// ---------------------------------------------------------------------------
// Payment outcomes (driven by the pay page or the control API)
// ---------------------------------------------------------------------------
function makeIntent(s, status) {
  const piId = rid('pi')
  const chId = rid('ch')
  const pi = {
    id: piId,
    object: 'payment_intent',
    amount: s.obj.amount_total,
    amount_received: status === 'succeeded' ? s.obj.amount_total : 0,
    currency: s.obj.currency,
    status,
    latest_charge: chId,
    metadata: s.intentData.metadata ?? {},
    application_fee_amount: s.application_fee_amount || null,
    created: now(),
  }
  intents.set(piId, { account: s.account, obj: pi })
  s.obj.payment_intent = piId
  return pi
}

function book(s, pi) {
  const fee = stripeFee(pi.amount, pi.currency)
  const receiver = s.account // null never happens: platform requests use PLATFORM
  const appFee = s.application_fee_amount || 0
  ledger.push({
    kind: 'charge',
    session: s.obj.id,
    payment_intent: pi.id,
    charged_on: receiver,
    direct_charge: receiver !== PLATFORM,
    currency: pi.currency,
    gross: pi.amount,
    lines: s.lines,
    stripe_fee: fee,
    stripe_fee_basis: FEE_ASSUMPTIONS[pi.currency]?.label ?? 'no assumption for this currency',
    stripe_fee_paid_by: receiver,
    application_fee_to_platform: appFee,
    transfer_data: s.transfer_data,
    net_to_receiver: fee == null ? null : pi.amount - fee - appFee,
  })
}

async function paySession(s, { async = false } = {}) {
  if (s.obj.status !== 'open') return { error: `session is ${s.obj.status}` }
  const pi = makeIntent(s, async ? 'processing' : 'succeeded')
  s.obj.status = 'complete'
  s.obj.payment_status = async ? 'unpaid' : 'paid'
  if (!async) book(s, pi)
  return { webhook: await sendEvent('checkout.session.completed', s.obj, s.account) }
}

async function settleAsync(s, ok) {
  const pi = intents.get(s.obj.payment_intent)?.obj
  if (!pi || pi.status !== 'processing') return { error: 'session has no processing payment' }
  if (ok) {
    pi.status = 'succeeded'
    pi.amount_received = pi.amount
    s.obj.payment_status = 'paid'
    book(s, pi)
    return { webhook: await sendEvent('checkout.session.async_payment_succeeded', s.obj, s.account) }
  }
  pi.status = 'requires_payment_method'
  return { webhook: await sendEvent('checkout.session.async_payment_failed', s.obj, s.account) }
}

async function expireSession(s) {
  s.obj.status = 'expired'
  return { webhook: await sendEvent('checkout.session.expired', s.obj, s.account) }
}

async function settleRefund(r, ok) {
  if (r.obj.status !== 'pending') return { error: `refund is ${r.obj.status}` }
  r.obj.status = ok ? 'succeeded' : 'failed'
  r.obj.failure_reason = ok ? null : 'expired_or_canceled_card'
  if (ok) ledger.push({ kind: 'refund', refund: r.obj.id, payment_intent: r.obj.payment_intent, debited_from: r.account, currency: r.obj.currency, amount: r.obj.amount, stripe_fee_returned: 0 })
  return { webhook: await sendEvent('refund.updated', r.obj, r.account) }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
function payPage(s) {
  const money = (n) => `${(n / 100).toFixed(2)} ${s.obj.currency.toUpperCase()}`
  const rows = s.lines.map((l) => `<tr><td>${esc(l.name)} × ${l.quantity}</td><td>${money(l.amount_total)}</td></tr>`).join('')
  const open = s.obj.status === 'open'
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stripe sim checkout</title>
<style>body{font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 16px}td{padding:.25rem .5rem}button{font:inherit;padding:.6rem 1rem;margin:.25rem}</style>
<p><strong>LOCAL STRIPE SIMULATOR</strong> — no real money moves.</p>
<p>Session <code>${esc(s.obj.id)}</code> on <code>${esc(s.account)}</code> — status <b>${esc(s.obj.status)}</b> / ${esc(s.obj.payment_status)}</p>
<table>${rows}<tr><td><b>Total</b></td><td><b>${money(s.obj.amount_total)}</b></td></tr></table>
${open ? `<form method="post"><button name="action" value="pay">Pay</button><button name="action" value="pay_async">Pay (delayed method)</button><button name="action" value="decline">Decline</button></form>` : '<p>This session is closed.</p>'}`
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string'
  res.writeHead(status, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', ...headers })
  res.end(isStr ? body : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://sim')
    const route = url.pathname
    const raw = await readBody(req)

    // ---- pay page ---------------------------------------------------------
    let m = route.match(/^\/pay\/([^/]+)$/)
    if (m) {
      const s = sessions.get(m[1])
      if (!s) return send(res, 404, '<p>No such session.</p>')
      if (req.method === 'GET') return send(res, 200, payPage(s))
      const action = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw || '{}').action : parseForm(raw).action
      log({ kind: 'control', method: 'POST', path: route, action })
      let out
      if (action === 'pay') out = await paySession(s)
      else if (action === 'pay_async') out = await paySession(s, { async: true })
      else if (action === 'decline') out = s.obj.status === 'open' ? await expireSession(s) : { error: `session is ${s.obj.status}` }
      else return send(res, 400, { error: 'action must be pay | pay_async | decline' })
      if (out.error) return send(res, 409, out)
      const to = action === 'decline' ? s.obj.cancel_url : s.obj.success_url
      return send(res, 303, { ...out, redirect: to }, to ? { location: to } : {})
    }

    // ---- control API ------------------------------------------------------
    if (route.startsWith('/_sim/')) {
      const p = raw ? JSON.parse(raw) : {}
      log({ kind: 'control', method: req.method, path: route, body: p })
      if (req.method === 'POST' && route === '/_sim/webhook') {
        if (!p.type || !p.object) return send(res, 400, { error: 'need {type, object, account?}' })
        return send(res, 200, await sendEvent(p.type, p.object, p.account ?? null))
      }
      if (req.method === 'POST' && (m = route.match(/^\/_sim\/refund\/([^/]+)\/(succeed|fail)$/))) {
        const r = refunds.get(m[1])
        if (!r) return send(res, 404, { error: 'no such refund' })
        const out = await settleRefund(r, m[2] === 'succeed')
        return send(res, out.error ? 409 : 200, { ...out, refund: r.obj })
      }
      if (req.method === 'POST' && (m = route.match(/^\/_sim\/session\/([^/]+)\/(pay|pay_async|async_succeed|async_fail|expire)$/))) {
        const s = sessions.get(m[1])
        if (!s) return send(res, 404, { error: 'no such session' })
        const op = m[2]
        const out = op === 'pay' ? await paySession(s)
          : op === 'pay_async' ? await paySession(s, { async: true })
          : op === 'expire' ? (s.obj.status === 'open' ? await expireSession(s) : { error: `session is ${s.obj.status}` })
          : await settleAsync(s, op === 'async_succeed')
        return send(res, out.error ? 409 : 200, { ...out, session: s.obj })
      }
      if (req.method === 'POST' && (m = route.match(/^\/_sim\/account\/([^/]+)$/))) {
        const prev = accounts.get(m[1]) ?? account(m[1])
        const next = { ...prev, ...p, requirements: { ...prev.requirements, ...(p.requirements ?? {}) } }
        accounts.set(m[1], next)
        const out = p.silent ? {} : { webhook: await sendEvent('account.updated', next, m[1]) }
        return send(res, 200, { ...out, account: next })
      }
      if (req.method === 'GET' && route === '/_sim/ledger') return send(res, 200, { fee_assumptions: FEE_ASSUMPTIONS, platform_account: PLATFORM, entries: ledger })
      if (req.method === 'GET' && route === '/_sim/state')
        return send(res, 200, {
          sessions: [...sessions.values()].map((s) => ({ account: s.account, ...s.obj })),
          payment_intents: [...intents.values()].map((x) => ({ account: x.account, ...x.obj })),
          refunds: [...refunds.values()].map((x) => ({ account: x.account, ...x.obj })),
          accounts: [...accounts.values()],
        })
      return send(res, 404, { error: 'unknown control route' })
    }

    // ---- Stripe API -------------------------------------------------------
    const auth = req.headers.authorization ?? ''
    const key = auth.replace(/^Bearer\s+/i, '')
    const acct = req.headers['stripe-account'] ?? PLATFORM
    const idemKey = req.headers['idempotency-key'] ?? null
    const params = parseForm(req.method === 'GET' ? url.search.slice(1) : raw)
    const entry = { kind: 'api', method: req.method, path: route, stripe_account: req.headers['stripe-account'] ?? null, idempotency_key: idemKey, body: params }

    let result
    if (route.startsWith('/oauth/')) {
      // OAuth authenticates with client_secret (= the platform secret key).
      result = await stripeApi(req.method, route, params, acct)
    } else if (!/^sk_test_/.test(key)) {
      // A live key here means someone pointed production config at the sim.
      result = err(401, key.startsWith('sk_live_') ? 'sim refuses live keys.' : 'Invalid API Key provided.')
    } else if (idemKey && req.method === 'POST' && idem.has(`${acct}|${idemKey}`)) {
      result = { ...idem.get(`${acct}|${idemKey}`), replayed: true }
    } else {
      result = await stripeApi(req.method, route, params, acct)
      if (idemKey && req.method === 'POST') idem.set(`${acct}|${idemKey}`, { status: result.status, body: result.body })
    }
    log({ ...entry, status: result.status, replayed: !!result.replayed, response_id: result.body?.id ?? null })
    return send(res, result.status, result.body, {
      'request-id': rid('req'),
      ...(result.replayed ? { 'idempotent-replayed': 'true' } : {}),
      ...(req.headers['stripe-account'] ? { 'stripe-account': acct } : {}),
    })
  } catch (e) {
    log({ kind: 'crash', path: req.url, error: String(e?.stack ?? e) })
    send(res, 500, { error: { type: 'api_error', message: `sim crashed: ${e?.message ?? e}` } })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`stripe-sim listening on 0.0.0.0:${PORT}; webhooks -> ${WEBHOOK_URL}; log -> ${LOG}`)
})
