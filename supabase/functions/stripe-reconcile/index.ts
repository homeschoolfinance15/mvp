// ============================================================================
// stripe-reconcile — the sweep for payments whose webhook never arrived
//
// PAYMENTS.md §9. Stripe retries a failed delivery with backoff for up to
// three days in live mode, and every handler in stripe-webhook is safe to run
// twice, so almost every real outage resolves itself with no human involved.
// But if the retries are exhausted the delivery is gone for good, and until
// this existed the order sat `pending` for ever: the attendee had paid, held
// no ticket, and nobody was told.
//
// What it does, every few minutes: take the `event_orders` that are still
// `pending`, are older than the twenty-minute hold, and carry a Checkout
// session id; re-read each session on its own `stripe_account_id`; confirm the
// ones Stripe says are paid and fail the ones Stripe says expired. That is
// exactly the question `stripe-checkout` asks about a single order when an
// attendee comes back to a lapsed hold — asked here about all of them, without
// waiting for anybody to come back.
//
// It is not a second writer of `paid`. Both transitions live in
// _shared/order-state.ts and are claimed with `.eq('status', 'pending')`, so
// this sweep and a late webhook delivery racing over the same order produce
// one confirmation, one ticket and one email. Whichever loses selects no row
// and stops.
//
// Three things it deliberately does NOT touch:
//
//   orders with no session id     stripe-checkout writes the session id in a
//                                 second statement after `sessions.create`
//                                 returns, so a missing id can mean the
//                                 session exists and the write was
//                                 interrupted. Failing those blind would fail
//                                 an order somebody has paid for. They are
//                                 left for a human, which is what the missing
//                                 id already implies.
//   orders inside the hold        still someone's live checkout.
//   sessions Stripe still calls   `open`, or a delayed method still clearing.
//   open                          Nothing is decided until Stripe has.
//
// Gate: `verify_jwt` is left ON for this function, unlike event-mailer and
// stripe-webhook. pg_cron calls it with the service-role key, which IS a valid
// project JWT, so the platform's own wall does the first half of the job and
// there is no new shared secret to set, rotate or leak. The check below does
// the second half, because the anon key is also a valid JWT and must not be
// able to drive a money sweep.
// ============================================================================

import Stripe from 'npm:stripe@18'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { confirmPaidOrder, failPendingOrder } from '../_shared/order-state.ts'

/**
 * BUY-06's hold. An order younger than this is somebody's live checkout and
 * asking Stripe about it would be asking before there is anything to know.
 */
const HOLD_MINUTES = 20

/**
 * One Stripe call per order, so the batch is bounded. At one sweep every five
 * minutes this clears a backlog of a thousand stuck orders in under an hour,
 * and on a healthy system it does nothing at all because the query is empty.
 * ponytail: a flat cap, not a cursor. If it ever saturates, the honest fix is
 * an alert — a thousand stuck orders is an incident, not a throughput problem.
 */
const BATCH = 100

interface PendingOrder {
  id: string
  registration_id: string | null
  amount_cents: number
  status: string
  stripe_checkout_session_id: string | null
  stripe_account_id: string | null
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) {
    // Not an error worth waking anybody for: a project with no Stripe key has
    // no paid orders to reconcile. Said plainly so a cron log reads as "there
    // is nothing here", not as a failure.
    return json({ error: 'STRIPE_SECRET_KEY is not set.', reason: 'stripe_not_configured' }, 500)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const db = createClient(url, serviceKey)

  // Two ways in, both real doors. The cron carries the service-role key; a
  // human running a sweep by hand carries their own token and has to be an
  // admin. Nothing else gets to ask Stripe about other people's money.
  const authorization = request.headers.get('Authorization') ?? ''
  const presented = authorization.replace(/^Bearer\s+/i, '').trim()
  let authorised = presented.length > 0 && presented === serviceKey

  if (!authorised) {
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (authorization && anonKey) {
      const asCaller = createClient(url, anonKey, {
        global: { headers: { Authorization: authorization } },
      })
      const { data: isAdmin } = await asCaller.rpc('is_admin')
      authorised = Boolean(isAdmin)
    }
  }
  if (!authorised) return json({ error: 'Not authorised.' }, 401)

  let olderThan = HOLD_MINUTES
  let limit = BATCH
  try {
    const body = request.headers.get('content-length') === '0' ? {} : await request.json()
    if (Number.isFinite(Number(body?.older_than_minutes))) {
      olderThan = Math.max(0, Number(body.older_than_minutes))
    }
    if (Number.isFinite(Number(body?.limit))) {
      limit = Math.min(BATCH, Math.max(1, Number(body.limit)))
    }
  } catch {
    // An empty body is the normal cron call. Only a malformed one lands here,
    // and the defaults are what cron wanted anyway.
  }

  const cutoff = new Date(Date.now() - olderThan * 60_000).toISOString()

  // One string literal, not a concatenation — see OrderRow in order-state.ts
  // for why supabase-js needs it that way.
  const { data: rows, error: readError } = await db
    .from('event_orders')
    .select(
      'id, registration_id, amount_cents, status, stripe_checkout_session_id, stripe_account_id',
    )
    .eq('status', 'pending')
    .not('stripe_checkout_session_id', 'is', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (readError) {
    console.error(`stripe-reconcile: could not read pending orders: ${readError.message}`)
    return json({ error: 'Could not read pending orders.', reason: 'orders_unreadable' }, 503)
  }

  const orders = (rows ?? []) as PendingOrder[]
  const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() })

  let confirmed = 0
  let failed = 0
  let stillOpen = 0
  let errors = 0

  for (const order of orders) {
    try {
      const options: Stripe.RequestOptions = {}
      if (order.stripe_account_id) options.stripeAccount = order.stripe_account_id

      const session = await stripe.checkout.sessions.retrieve(
        String(order.stripe_checkout_session_id),
        options,
      )

      if (session.payment_status === 'paid') {
        // The money moved and the delivery that should have said so never
        // landed. Logged at error level with everything a human needs to find
        // it in Stripe, because a confirmation arriving from here rather than
        // from a webhook means deliveries are being lost.
        console.error(
          `stripe-reconcile: session ${session.id} for order ${order.id} is paid at Stripe ` +
            `but the order was still pending on account ${order.stripe_account_id ?? 'platform'} ` +
            `— confirming it here. Check the endpoint's failed deliveries.`,
        )
        await confirmPaidOrder(db, order, {
          sessionId: session.id,
          paymentIntentId:
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : (session.payment_intent?.id ?? null),
        })
        confirmed++
        continue
      }

      if (session.status === 'expired') {
        // Nobody paid and Stripe will not take the session again, so the place
        // goes back in the pool. Same transition an expired-session delivery
        // would have caused.
        await failPendingOrder(db, order)
        failed++
        continue
      }

      // `open`, or `complete` with an asynchronous method still clearing.
      // Nothing is decided yet and guessing would be the whole bug.
      stillOpen++
    } catch (error) {
      // One order's problem is not the batch's. Left pending, so the next
      // sweep tries it again.
      errors++
      const message = error instanceof Error ? error.message : String(error)
      console.error(`stripe-reconcile: order ${order.id}: ${message}`)
    }
  }

  const summary = { swept: orders.length, confirmed, failed, still_open: stillOpen, errors }
  if (confirmed > 0 || errors > 0) console.error(`stripe-reconcile: ${JSON.stringify(summary)}`)
  return json(summary, 200)
})

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    },
  })
}
