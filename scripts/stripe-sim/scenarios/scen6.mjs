// S18 Stripe's own fee (ORG-13): recorded per order, delayed methods, reconcile backfill, never overwritten.
// PLATFORM_FEE_BPS=0. Runs after scen5, on the same fixtures.
import { check, saveResults, sim, sleep, psql, psqlJson, fn, SERVICE } from './lib.mjs'
import { F, checkout } from './common.mjs'

const ids = Object.values(F.events).map((e) => `'${e.id}'`).join(',')
let L
const ledger = () => Object.fromEntries(L.entries.filter((e) => e.kind === 'charge').map((e) => [e.payment_intent, e]))
const refreshLedger = async () => { L = (await sim('GET', '/_sim/ledger')).body }
const orders = () => psqlJson(`select id, event_id, status, currency, stripe_account_id, stripe_payment_intent_id pi, stripe_fee_cents fee, stripe_fee_currency fee_cur from event_orders where event_id in (${ids}) and status in ('paid','refunded','partially_refunded')`)
const reconcile = async () => { const r = await fn(SERVICE, 'stripe-reconcile', {}); await sleep(300); return r }

// ---- S18a every paid order carries exactly the fee Stripe booked for its charge
await refreshLedger()
{
  const byPi = ledger()
  const rows = orders().filter((o) => byPi[o.pi])
  const wrong = rows.filter((o) => o.fee !== byPi[o.pi].stripe_fee || o.fee_cur !== byPi[o.pi].currency)
  const platform = rows.filter((o) => !o.stripe_account_id).length
  const connected = rows.filter((o) => o.stripe_account_id).length
  const currencies = [...new Set(rows.map((o) => o.currency))].sort()
  check('S18a', 'every paid order records the fee Stripe booked, in its currency', rows.length > 0 && wrong.length === 0, { orders: rows.length, wrong })
  check('S18a', 'covers platform and connected accounts in gbp, eur and usd', platform > 0 && connected > 0 && currencies.join() === 'eur,gbp,usd', { platform, connected, currencies })
  const unmatched = orders().filter((o) => !byPi[o.pi])
  check('S18a', 'an order with no charge Stripe booked has no fee invented for it', unmatched.every((o) => o.fee === null), unmatched)
}

// ---- S18b a delayed method: no fee while it clears, the real one once it lands
{
  const bought = new Set(psqlJson(`select profile_id from event_orders where event_id='${F.events.s1.id}'`).map((r) => r.profile_id))
  const who = Object.keys(F.people).find((k) => /^[mg]\d$/.test(k) && !bought.has(F.people[k].id))
  if (!who) {
    check('S18b', 'a buyer with no order on s1 exists', false, { bought: bought.size })
  } else {
    const co = await checkout(who, 's1')
    const sid = co.body?.session_id
    const order = co.body?.order_id
    await sim('POST', `/_sim/session/${sid}/pay_async`); await sleep(400)
    const mid = psqlJson(`select status, stripe_fee_cents fee from event_orders where id='${order}'`)[0]
    check('S18b', 'processing payment: order pending, no fee recorded', mid?.status === 'pending' && mid?.fee === null, mid)
    const settled = await sim('POST', `/_sim/session/${sid}/async_succeed`); await sleep(500)
    await refreshLedger()
    const after = psqlJson(`select status, stripe_payment_intent_id pi, stripe_fee_cents fee, stripe_fee_currency fee_cur from event_orders where id='${order}'`)[0]
    const booked = ledger()[after?.pi]
    check('S18b', 'async_payment_succeeded: order paid with the booked fee (platform account)', settled.body?.webhook?.status === 200 && after?.status === 'paid' && booked && after.fee === booked.stripe_fee && after.fee_cur === booked.currency, { webhook: settled.body?.webhook, after, booked: booked?.stripe_fee })
  }
}

// ---- S18c a lost fee read is filled by the sweep, on both kinds of account
{
  const byPi = ledger()
  const rows = orders().filter((o) => byPi[o.pi] && o.fee !== null)
  const pick = [rows.find((o) => !o.stripe_account_id), rows.find((o) => o.stripe_account_id)].filter(Boolean)
  psql(`update event_orders set stripe_fee_cents=null, stripe_fee_currency=null where id in (${pick.map((o) => `'${o.id}'`).join(',')})`)
  const r = await reconcile()
  const back = pick.map((o) => ({ ...psqlJson(`select id, stripe_fee_cents fee, stripe_fee_currency fee_cur from event_orders where id='${o.id}'`)[0], want: byPi[o.pi].stripe_fee, platform: !o.stripe_account_id }))
  check('S18c', 'stripe-reconcile 200 and reports the fee sweep', r.status === 200 && Number(r.body?.fees_swept) >= pick.length, r.body)
  check('S18c', 'platform and connected orders both get their fee back, exactly', pick.length === 2 && back.every((b) => b.fee === b.want && b.fee_cur), back)
}

// ---- S18d the sweep only fills a gap; a recorded fee is never rewritten
{
  const o = orders().find((x) => x.fee !== null)
  psql(`update event_orders set stripe_fee_cents=1 where id='${o.id}'`)
  await reconcile()
  const now = psqlJson(`select stripe_fee_cents fee from event_orders where id='${o.id}'`)[0]
  check('S18d', 'a recorded fee is left alone by the sweep', now.fee === 1, { before: o.fee, now: now.fee })
  psql(`update event_orders set stripe_fee_cents=${o.fee} where id='${o.id}'`)
}

// ---- S18e a replayed payment webhook does not change the fee
{
  const o = orders().find((x) => x.fee !== null && x.status === 'paid')
  psql(`update event_orders set stripe_fee_cents=2 where id='${o.id}'`)
  const s = psqlJson(`select stripe_checkout_session_id sid from event_orders where id='${o.id}'`)[0]
  const state = (await sim('GET', '/_sim/state')).body
  const session = (state.sessions ?? []).find((x) => x.id === s.sid)
  const { account, ...object } = session ?? {}
  const r = session ? await sim('POST', '/_sim/webhook', { type: 'checkout.session.completed', object, account: account === L.platform_account ? null : account }) : null
  await sleep(400)
  const now = psqlJson(`select stripe_fee_cents fee from event_orders where id='${o.id}'`)[0]
  check('S18e', 'replayed checkout.session.completed: 200, fee untouched', r?.body?.status === 200 && now.fee === 2, { webhook: r?.body, now: now.fee })
  psql(`update event_orders set stripe_fee_cents=${o.fee} where id='${o.id}'`)
}

saveResults('results6.json')
