// Uses only the temporary cast made by uat-payments.mjs, after its payment cases.
import { writeFileSync } from 'node:fs'
import { fx, svc, rpc, signIn } from './stripe-sim/scenarios/lib.mjs'
const fixtures = fx()
if (!/^qap-[a-z0-9]+$/.test(fixtures.tag)) throw Error('Expected local payment fixtures')
const guest = fixtures.people.g1
if (!guest.email.startsWith(fixtures.tag + '-')) throw Error('Not our test guest')
const must = r => { if (!r.ok) throw Error(JSON.stringify(r.body)); return r.body }
const token = await signIn(guest.email)
async function snapshot() {
  const orders = must(await svc('GET', `event_orders?profile_id=eq.${guest.id}&order=id`))
  const tickets = must(await svc('GET', `event_tickets?profile_id=eq.${guest.id}&order=id`))
  const refunds = orders.length ? must(await svc('GET', `event_refunds?order_id=in.(${orders.map(o => o.id).join(',')})&order=id`)) : []
  return { orders, tickets, refunds }
}
const before = await snapshot()
const profile = must(await svc('GET', `profiles?id=eq.${guest.id}`))[0]
const codes = must(await svc('GET', `invite_codes?connector_id=eq.${fixtures.people.conn.connector_id}&status=eq.active`))
const code = codes.find(c => c.use_count < c.max_uses)
if (!code) throw Error('No active fixture invitation code')
must(await rpc(token, 'redeem_code', { p_code: code.code, p_full_name: '' }))
const after = await snapshot()
const joined = must(await svc('GET', `profiles?id=eq.${guest.id}`))[0]
const results = [
  { name: 'ACC-06 simulated paid and refund history is preserved on network joining', pass: before.orders.length > 0 && before.refunds.length > 0 && before.tickets.length > 0 && JSON.stringify(before) === JSON.stringify(after), detail: { orders: before.orders.length, refunds: before.refunds.length, tickets: before.tickets.length } },
  { name: 'ACC-06 network joining keeps same paid attendee account and onboarding', pass: !profile.network_member && joined.network_member && joined.id === profile.id && joined.current_profession === profile.current_profession },
]
writeFileSync('docs/event-platform/uat-evidence/paid-continuity-results.json', JSON.stringify({ at: new Date().toISOString(), scope: 'Existing local simulated-payment fixtures only', results }, null, 2))
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${JSON.stringify(r.detail ?? '')}`)
process.exitCode = results.some(r => !r.pass) ? 1 : 0
