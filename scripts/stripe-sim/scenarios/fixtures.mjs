// Builds the cast and the events through the real RPCs / REST / stripe-connect.
import fs from 'node:fs'
import { DIR, rest, rpc, fn, psql, createAuthUser, signIn, soon, sim } from './lib.mjs'

const T = `qap-${Date.now().toString(36)}`
const email = (l) => `${T}-${l}@amazing.test`
const F = { tag: T, people: {}, events: {} }
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body }

// ---- admin: allowlist first, then the account (handle_new_user provisions) ----
psql(`insert into admin_allowlist(email) values ('${email('admin')}')`)
const adminId = await createAuthUser(email('admin'), 'QAP Admin')
const adminTok = await signIn(email('admin'))
F.people.admin = { id: adminId, email: email('admin') }
console.log('admin role:', psql(`select role from profiles where id='${adminId}'`))

// ---- connector: admin invitation -> claim ----
async function makeConnector(label, name) {
  const inv = must(await rpc(adminTok, 'create_connector_invitation', { p_full_name: name, p_email: email(label), p_capacity: 20 }), 'invitation')
  const id = await createAuthUser(email(label), name)
  const tok = await signIn(email(label))
  const claim = must(await rpc(tok, 'redeem_code', { p_code: inv.claim_code, p_full_name: name }), 'claim')
  must(await rest(tok, 'PATCH', `profiles?id=eq.${id}`, { current_profession: 'Organiser' }), 'profession')
  must(await rest(adminTok, 'PATCH', `connectors?id=eq.${claim.connector_id}`, { can_create_events: true }), 'can_create_events')
  return { id, email: email(label), connector_id: claim.connector_id, invite_code: claim.invite_code }
}
F.people.conn = await makeConnector('conn', 'QAP Connector')

// ---- members on the connector's code, guests via create_event_account ----
const connTok = await signIn(F.people.conn.email)
const code = must(await rpc(connTok, 'create_invite_code', { p_max_uses: 10 }), 'invite code').code
for (const l of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
  const id = await createAuthUser(email(l), `QAP Member ${l}`)
  const tok = await signIn(email(l))
  must(await rpc(tok, 'redeem_code', { p_code: code, p_full_name: `QAP Member ${l}` }), `redeem ${l}`)
  must(await rest(tok, 'PATCH', `profiles?id=eq.${id}`, { current_profession: 'Tester' }), `prof ${l}`)
  F.people[l] = { id, email: email(l), kind: 'member' }
}
for (const l of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']) {
  const id = await createAuthUser(email(l), `QAP Guest ${l}`)
  const tok = await signIn(email(l))
  must(await rpc(tok, 'create_event_account', { p_full_name: `QAP Guest ${l}` }), `event account ${l}`)
  must(await rest(tok, 'PATCH', `profiles?id=eq.${id}`, { current_profession: 'Tester' }), `prof ${l}`)
  F.people[l] = { id, email: email(l), kind: 'guest' }
}

// ---- connect the connector's Stripe account through the real stripe-connect flow ----
const start = await fn(connTok, 'stripe-connect', { action: 'start' })
console.log('connect start', start.status, start.body?.url?.slice(0, 60))
const acct = `acct_${T.replace(/-/g, '')}`
const cb = await fn(connTok, 'stripe-connect', { action: 'callback', code: acct, state: start.body.state })
console.log('connect callback', cb.status, JSON.stringify(cb.body))
const refresh = await fn(connTok, 'stripe-connect', { action: 'refresh' })
console.log('connect refresh', refresh.status, JSON.stringify(refresh.body))
F.connect = { start: { status: start.status, url_host: start.body?.url ? new globalThis.URL(start.body.url).host : null }, callback: { status: cb.status, body: cb.body }, refresh: { status: refresh.status, body: refresh.body } }
F.people.conn.stripe_account_id = acct

// ---- events ----
async function makeEvent(key, tok, hostId, { title, currency, price, capacity = null }) {
  const ev = must(await rest(tok, 'POST', 'events', { host_id: hostId, title: `${T} ${title}`, starts_at: soon(14), ends_at: soon(14, 3), currency, capacity, refund_terms: 'Refunds up to 48h before.' }), `event ${key}`)[0]
  const tt = must(await rest(tok, 'POST', 'ticket_types', { event_id: ev.id, name: 'Standard', price_cents: price, currency }), `ticket ${key}`)[0]
  const pub = must(await rest(tok, 'PATCH', `events?id=eq.${ev.id}`, { status: 'published' }), `publish ${key}`)[0]
  F.events[key] = { id: ev.id, slug: ev.slug, ticket_type_id: tt.id, currency, price, capacity, payment_connector_id: pub.payment_connector_id, host: hostId }
  console.log('event', key, ev.id, currency, price, 'connector', pub.payment_connector_id)
}
await makeEvent('s1', adminTok, adminId, { title: 'S1 admin GBP', currency: 'gbp', price: 2500 })
await makeEvent('s2', connTok, F.people.conn.id, { title: 'S2 connector GBP', currency: 'gbp', price: 4000 })
await makeEvent('s3', connTok, F.people.conn.id, { title: 'S3 connector GBP fee', currency: 'gbp', price: 4000 })
await makeEvent('s4', connTok, F.people.conn.id, { title: 'S4 connector EUR', currency: 'eur', price: 3000 })
await makeEvent('s5', adminTok, adminId, { title: 'S5 admin USD', currency: 'usd', price: 5000 })
await makeEvent('s9', connTok, F.people.conn.id, { title: 'S9 last place', currency: 'gbp', price: 1000, capacity: 1 })
await makeEvent('s15', connTok, F.people.conn.id, { title: 'S15 to be cancelled', currency: 'gbp', price: 2000 })

fs.writeFileSync(`${DIR}/fixtures.json`, JSON.stringify(F, null, 2))
console.log('fixtures written', T)
