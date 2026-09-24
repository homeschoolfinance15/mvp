import { fn, sim, signIn, psqlJson, mark, since, sleep, fx } from './lib.mjs'

export const F = fx()
const toks = {}
export async function tok(who) { return (toks[who] ??= await signIn(F.people[who].email)) }

/** Call stripe-checkout as `who` for event `ev`; return the response and the Stripe requests it made. */
export async function checkout(who, ev) {
  const m = mark()
  const r = await fn(await tok(who), 'stripe-checkout', { event_id: F.events[ev].id, ticket_type_id: F.events[ev].ticket_type_id })
  await sleep(150)
  return { ...r, stripe: since(m).filter((l) => l.kind === 'api') }
}

/** Drive the sim's pay page (pay | pay_async | decline) and return its reply plus the webhook log lines. */
export async function payPage(sessionId, action = 'pay') {
  const m = mark()
  const r = await sim('POST', `/pay/${sessionId}`, { action })
  await sleep(300)
  return { ...r, log: since(m) }
}

export function snapshot(ev, who) {
  const e = F.events[ev].id
  const p = F.people[who].id
  return {
    orders: psqlJson(`select id, status, amount_cents, fee_cents, application_fee_cents, currency, stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id, paid_at is not null as has_paid_at from event_orders where event_id='${e}' and profile_id='${p}' order by created_at`),
    registrations: psqlJson(`select id, status, hold_expires_at is not null as held from event_registrations where event_id='${e}' and profile_id='${p}' order by created_at`),
    tickets: psqlJson(`select id, registration_id, revoked_at is not null as revoked from event_tickets where event_id='${e}' and profile_id='${p}'`),
    messages: psqlJson(`select m.kind, m.subject, r.status from event_messages m join event_message_recipients r on r.message_id=m.id where m.event_id='${e}' and r.profile_id='${p}' order by m.created_at`),
    refunds: psqlJson(`select f.id, f.amount_cents, f.status, f.stripe_refund_id, f.reason from event_refunds f join event_orders o on o.id=f.order_id where o.event_id='${e}' and o.profile_id='${p}' order by f.created_at`),
  }
}

export const capacity = (ev) => psqlJson(`select * from event_capacity_state('${F.events[ev].id}')`)[0]

/** The checkout-session create request among captured requests. */
export const createReq = (stripe) => stripe.find((l) => l.method === 'POST' && l.path === '/v1/checkout/sessions')
export const hasAppFee = (body) => JSON.stringify(body ?? {}).includes('application_fee')
