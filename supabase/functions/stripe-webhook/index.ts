// ============================================================================
// stripe-webhook — the only thing in the system that says a payment happened
//
// BUY-03. A browser arriving at success_url has proved it can follow a
// redirect. It has not proved that money moved, and it never will: the person
// can close the tab before the redirect, the redirect can be lost on a train,
// and a URL can be typed by hand. So no screen and no other function writes
// `paid`. Stripe signs for it here, and only here.
//
// What each event does:
//
//   checkout.session.completed          order -> paid, place -> confirmed,
//   checkout.session.async_payment_succeeded
//                                       ticket issued, confirmation queued
//   checkout.session.expired            order -> failed, place released
//   payment_intent.payment_failed       order -> failed, place released
//   checkout.session.async_payment_failed
//   charge.refund.updated / refund.updated
//                                       event_refunds moved to whatever Stripe
//                                       now says, refund message queued
//   account.updated                     that connector's capability flags
//                                       refreshed, so one that Stripe has
//                                       restricted stops selling (§7.3)
//
// Everything else is acknowledged and ignored, because a 200 is how you tell
// Stripe to stop resending something we were never going to act on.
//
// **One endpoint, every connector** (CONTRACT §7.1). This is the main reason
// direct charges beat holding a secret key per connector. A sale on a super
// connector's own Stripe account arrives here, at our URL, signed with our
// webhook secret, carrying `event.account = acct_…` to say whose account it
// happened on. No connector configures a webhook. No connector's key is held.
// A connector who joins tomorrow needs no deploy, no secret and no endpoint —
// they OAuth in and their sales start arriving at this same function.
//
// `event.account` is also a guard, not only a label: an order is only ever
// matched to a delivery from the account that actually took its money
// (§7.2). A session id from one connected account can never move an order
// recorded against another, which is the shape of mistake that pays the
// wrong person.
//
// Idempotency — Stripe retries, and a retry must not cost anyone anything
// (BUY-04, QLT-10):
//
//   Every state change is a conditional update that names the state it is
//   moving *from* (`.eq('status', 'pending')`), and acts only on the rows it
//   actually changed. A replay changes nothing, so it returns nothing, so the
//   work that follows — the ticket, the email — never runs a second time.
//   Postgres does the deciding, not a flag we read and then wrote, which is
//   the version that loses to two deliveries arriving at once.
//
//   Behind that, event_tickets is unique on registration_id, so even a
//   confirmation that somehow ran twice issues one ticket.
//
// Refund status is copied, never inferred (BUY-08). `completed` is written for
// exactly one Stripe status, `succeeded`. A refund that is pending, failed or
// cancelled says so, because telling somebody their money is back when it is
// not is the worst sentence this system could write.
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
//          (Stripe signs with its own header and carries no Supabase JWT, so
//          JWT verification has to be off or every delivery 401s. The
//          signature check below is what stands in for it — an unsigned or
//          wrongly signed request never reaches a single write.)
//          config.toml carries the same setting as [functions.stripe-webhook].
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_...
//          supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
// ============================================================================

import Stripe from 'npm:stripe@18'
import { stripeClient } from '../_shared/stripe.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import {
  applyRefund,
  confirmPaidOrder,
  recordStripeFee,
  failPendingOrder,
  type Db,
  type OrderRow,
} from '../_shared/order-state.ts'

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!stripeKey || !webhookSecret) {
    // A 500 is deliberate: Stripe retries it, so a delivery that arrives during
    // a misconfigured deploy is not lost, it waits for the deploy to be fixed.
    return json(
      {
        error:
          'Stripe is not configured on this project. Set STRIPE_SECRET_KEY and ' +
          'STRIPE_WEBHOOK_SECRET (supabase secrets set ...) and deploy again.',
      },
      500,
    )
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) return json({ error: 'Unsigned.' }, 400)

  const stripe = stripeClient(stripeKey)

  // The raw body, byte for byte — the signature is over what was sent, so it
  // must not be parsed and re-serialised on the way here.
  const payload = await request.text()

  let event: Stripe.Event
  try {
    // Deno has no synchronous crypto, so this is the async variant with the
    // SubtleCrypto provider. constructEvent (sync) throws at runtime here.
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    )
  } catch (error) {
    // Anything that fails the signature check is discarded before it can touch
    // a row. 400 tells Stripe not to bother resending it.
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: `Bad signature: ${message}` }, 400)
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // §7.1. Whose account this happened on. Null is Amazing's own platform
  // account; `acct_…` is a super connector's, and every lookup below is
  // narrowed to orders that were taken on exactly that account.
  const account = event.account ?? null

  try {
    switch (event.type) {
      // A delayed method — anything that clears after the session closes —
      // completes the session before the money exists, so `completed` alone is
      // never enough (see onCompleted). These two are how such a payment ends,
      // and without them an event organiser who enables one of those methods in
      // the Stripe dashboard would silently get purchases that never confirm.
      // They need no handler of their own: succeeded is the same work as a card
      // succeeding, failed the same work as a card failing.
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await onCompleted(db, stripe, account, event.data.object as Stripe.Checkout.Session)
        break

      case 'checkout.session.async_payment_failed':
        await onNotPaid(db, account, {
          sessionId: (event.data.object as Stripe.Checkout.Session).id,
          paymentIntentId: intentId((event.data.object as Stripe.Checkout.Session).payment_intent),
        })
        break

      case 'checkout.session.expired':
        await onNotPaid(db, account, {
          sessionId: (event.data.object as Stripe.Checkout.Session).id,
          paymentIntentId: intentId((event.data.object as Stripe.Checkout.Session).payment_intent),
        })
        break

      case 'payment_intent.payment_failed':
        // A Checkout order has no intent id until it is paid, so the order id
        // stripe-checkout put on payment_intent_data.metadata is what finds it.
        await onNotPaid(db, account, {
          sessionId: null,
          paymentIntentId: (event.data.object as Stripe.PaymentIntent).id,
          orderId: (event.data.object as Stripe.PaymentIntent).metadata?.order_id ?? null,
        })
        break

      case 'charge.refund.updated':
      case 'refund.updated':
        await onRefund(db, account, event.data.object as Stripe.Refund)
        break

      case 'account.updated':
        await onAccountUpdated(db, event.data.object as Stripe.Account)
        break

      default:
        // Acknowledged, not acted on.
        break
    }
  } catch (error) {
    // A write that genuinely failed. 500 so Stripe redelivers — every handler
    // above is safe to run twice, which is what makes that the right answer.
    const message = error instanceof Error ? error.message : String(error)
    console.error(`stripe-webhook ${event.type} ${event.id}: ${message}`)
    return json({ error: message }, 500)
  }

  return json({ received: true }, 200)
})

/* -------------------------------------------------------------------------- */
/* Paid                                                                        */
/* -------------------------------------------------------------------------- */

async function onCompleted(
  db: Db,
  stripe: Stripe,
  account: string | null,
  session: Stripe.Checkout.Session,
): Promise<void> {
  // A completed session is not always a paid one — it can complete with an
  // asynchronous method still clearing. Only `paid` is paid.
  if (session.payment_status !== 'paid') return

  const order = await findOrder(db, account, {
    sessionId: session.id,
    orderId: session.client_reference_id ?? session.metadata?.order_id ?? null,
  })
  if (!order) {
    // QLT-09: "a purchase should not become untraceable because one step
    // failed". Somebody may have just been charged, so which of these two it
    // is decides whether this is an incident or noise.
    const ours = session.client_reference_id ?? session.metadata?.order_id ?? null
    if (ours) {
      // It carries our own order id, so it is our purchase and the row it
      // names is not there. Throwing makes this a 500, which Stripe retries
      // for days and lists under the endpoint's failed deliveries — a place an
      // admin can actually find it, unlike a log line that scrolls away. If
      // the cause was transient the retry resolves it with no human at all.
      throw new Error(
        `paid session ${session.id} names order ${ours}, which does not exist on ` +
          `account ${account ?? 'platform'}. Money may have moved with no order to attach ` +
          `it to — reconcile this payment in Stripe before refunding or re-selling.`,
      )
    }
    // No reference of ours anywhere on it: a session this project did not
    // create, or a CLI fixture. Acknowledged, so Stripe stops resending it.
    console.error(`stripe-webhook: no order for foreign session ${session.id}`)
    return
  }

  // What was paid has to be what the order says, on the session the order
  // opened. The order-id fallback in findOrder will match any session that
  // carries our id, and a connector holds their own account's keys, so a
  // session for 1 cent in another currency can name a real order. Confirming
  // that would issue a ticket for money that never moved, and overwrite the
  // real session id so the real payment could no longer be matched. So it is
  // not confirmed: the order stays pending and a human is told.
  const mismatch =
    session.amount_total !== Number(order.amount_cents)
      ? `amount ${session.amount_total} ${session.currency} against ${order.amount_cents} ${order.currency}`
      : session.currency !== order.currency
        ? `currency ${session.currency} against ${order.currency}`
        : order.stripe_checkout_session_id && order.stripe_checkout_session_id !== session.id
          ? `session ${session.id} is not the order's own ${order.stripe_checkout_session_id}`
          : null
  if (mismatch) {
    console.error(`stripe-webhook: paid session ${session.id} does not match order ${order.id}: ${mismatch}`)
    // Once per session, however often Stripe redelivers it.
    const { data: seen } = await db
      .from('event_refunds')
      .select('id')
      .eq('order_id', order.id)
      .like('failure_message', `%${session.id}%`)
      .limit(1)
      .maybeSingle()
    if (!seen && (session.amount_total ?? 0) > 0) {
      const { error } = await db.from('event_refunds').insert({
        order_id: order.id,
        amount_cents: session.amount_total,
        status: 'needs_attention',
        reason: 'Paid session does not match the order',
        failure_message:
          `Stripe session ${session.id} on account ${account ?? 'platform'} was paid, but ${mismatch}. ` +
          'The order was not confirmed. Refund that payment in Stripe.',
      })
      if (error) throw new Error(`could not record mismatched session ${session.id}: ${error.message}`)
    }
    return
  }

  // The transition itself lives in _shared/order-state.ts, because this is no
  // longer the only thing that can cause it — stripe-reconcile runs the same
  // confirmation for an order whose delivery never arrived (PAYMENTS.md §9).
  // The guard is inside: pending -> paid is claimed conditionally, so a replay
  // of this delivery and a concurrent sweep cannot both issue a ticket.
  await confirmPaidOrder(db, order, {
    sessionId: session.id,
    paymentIntentId: intentId(session.payment_intent),
  })
  await recordStripeFee(db, stripe, order.id, intentId(session.payment_intent), account)
}

/* -------------------------------------------------------------------------- */
/* Not paid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * BUY-03. An expired session and a declined card are the same fact to us:
 * nobody paid. The order says `failed` and the place goes back in the pool so
 * the next person can have it. Neither may ever read as a completed purchase.
 */
async function onNotPaid(
  db: Db,
  account: string | null,
  ref: { sessionId: string | null; paymentIntentId: string | null; orderId?: string | null },
): Promise<void> {
  const order = await findOrder(db, account, ref)
  if (!order) return

  // Shared with stripe-reconcile for the same reason as the confirmation above.
  await failPendingOrder(db, order)
}

/* -------------------------------------------------------------------------- */
/* Refunds                                                                     */
/* -------------------------------------------------------------------------- */

async function onRefund(db: Db, account: string | null, refund: Stripe.Refund): Promise<void> {
  const row = await refundRow(db, account, refund)
  if (!row) return
  // Shared with stripe-reconcile, which re-reads refunds whose delivery was lost.
  await applyRefund(db, row.id, refund)
}

/**
 * The refund this Stripe object belongs to. Normally event-refund wrote the row
 * and the id; a refund issued straight from the Stripe dashboard has no row at
 * all, and we record it rather than pretend it did not happen (ORG-11).
 */
async function refundRow(
  db: Db,
  account: string | null,
  refund: Stripe.Refund,
): Promise<{ id: string } | null> {
  const { data: byId } = await db
    .from('event_refunds')
    .select('id')
    .eq('stripe_refund_id', refund.id)
    .maybeSingle()
  if (byId) return byId as { id: string }

  const paymentIntent = intentId(refund.payment_intent)
  if (!paymentIntent) return null

  // Narrowed to the account that took the money, exactly like findOrder: a
  // payment intent id from one connected account must never reach an order
  // that belongs to another (§7.2).
  const byIntent = db.from('event_orders').select('id').eq('stripe_payment_intent_id', paymentIntent)
  const { data: order } = await (account
    ? byIntent.eq('stripe_account_id', account)
    : byIntent.is('stripe_account_id', null)
  ).maybeSingle()
  if (!order) return null

  // Our own row, written moments ago by event-refund, whose Stripe id has not
  // landed yet because the webhook beat the response home.
  const { data: waiting } = await db
    .from('event_refunds')
    .select('id')
    .eq('order_id', order.id)
    .is('stripe_refund_id', null)
    .in('status', ['requested', 'processing'])
    .maybeSingle()
  if (waiting) return waiting as { id: string }

  const { data: created, error } = await db
    .from('event_refunds')
    .insert({
      order_id: order.id,
      amount_cents: refund.amount,
      status: 'requested',
      stripe_refund_id: refund.id,
      reason: 'Issued in Stripe',
    })
    .select('id')
    .maybeSingle()
  // 23505 means a live refund for this order appeared between the two reads.
  // Leave it to the delivery that owns it rather than opening a second one.
  if (error) return null
  return (created as { id: string } | null) ?? null
}

/* -------------------------------------------------------------------------- */
/* A connector's account changed under them                                    */
/* -------------------------------------------------------------------------- */

/**
 * §7.3. Stripe can restrict an account at any time — a document expires, a
 * verification lapses — and it tells nobody but us. Without this, a connector
 * would keep taking cards on an account that can no longer settle them.
 *
 * `stripe-checkout` gates new paid sales on `stripe_charges_enabled`, so
 * writing that column here is the whole of stopping the sales. Nothing else is
 * touched: the events they already sold, the tickets, the check-in and the
 * refunds all keep working, which is the row of §7.3 that is easiest to get
 * wrong. A connector coming *back* into good standing is the same code path
 * with the flags the other way round, so recovery needs no separate handler.
 */
async function onAccountUpdated(db: Db, account: Stripe.Account): Promise<void> {
  if (!account?.id) return
  const charges = !!account.charges_enabled
  const payouts = !!account.payouts_enabled
  const restricted = !!account.requirements?.disabled_reason

  // Not found is not a fault: Stripe sends `account.updated` for accounts
  // connected to this platform that are not one of ours to care about.
  await db
    .from('connectors')
    .update({
      stripe_charges_enabled: charges,
      stripe_payouts_enabled: payouts,
      stripe_account_status: restricted ? 'restricted' : charges && payouts ? 'ready' : 'pending',
      stripe_checked_at: new Date().toISOString(),
    })
    .eq('stripe_account_id', account.id)
    // A connector who used Stripe and walked away stays `disconnected` until
    // they reconnect. An `account.updated` from an account we no longer have
    // permission on must not quietly put them back on sale.
    .neq('stripe_account_status', 'disconnected')
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

interface MatchedOrder extends OrderRow {
  currency: string
  stripe_checkout_session_id: string | null
}

async function findOrder(
  db: Db,
  account: string | null,
  ref: { sessionId?: string | null; paymentIntentId?: string | null; orderId?: string | null },
): Promise<MatchedOrder | null> {
  // Session id first: it is what BUY-04 keys on, and it is set before Stripe is
  // ever told about the order. The others are for the case where the checkout
  // call was interrupted between creating the session and writing its id down.
  for (const [column, value] of [
    ['stripe_checkout_session_id', ref.sessionId],
    ['stripe_payment_intent_id', ref.paymentIntentId],
    ['id', ref.orderId],
  ] as const) {
    if (!value) continue
    // §7.2. `stripe_account_id` is what stripe-checkout froze onto the order,
    // and `event.account` is what Stripe says this delivery happened on. They
    // have to be the same account or this delivery is not about this order.
    // `.is(..., null)` rather than `.eq(..., null)` because a platform-account
    // order holds SQL null, and null is not equal to anything, including null.
    const query = db
      .from('event_orders')
      .select('id, registration_id, amount_cents, status, currency, stripe_checkout_session_id')
      .eq(column, value)
    const { data } = await (account
      ? query.eq('stripe_account_id', account)
      : query.is('stripe_account_id', null)
    ).maybeSingle()
    if (data) return data as MatchedOrder
  }
  return null
}

function intentId(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
