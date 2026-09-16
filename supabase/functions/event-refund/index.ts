// ============================================================================
// event-refund — a host or an admin sends money back
//
// BUY-08. Refunding money and cancelling a place are two different actions
// with two different outcomes, and this function only does the first one. It
// never touches event_registrations. Somebody can be refunded and still be
// coming (a host waiving a fee), and somebody can cancel and not be refunded
// (terms that say so). Merging the two would make one of those impossible to
// express and the other impossible to explain.
//
// The order the writes happen in is the whole design:
//
//   1. event_refunds row, status `requested` — written first, so if anything
//      after this goes wrong there is a record that somebody tried;
//   2. Stripe;
//   3. reconcile the row with what Stripe said.
//
//   A Stripe failure at step 2 leaves the row at `needs_attention` with the
//   message Stripe gave, so it is findable by an admin rather than lost in a
//   log (QLT-09, ORG-11). The row id is the Stripe idempotency key, so a
//   retried request reuses the refund it already opened instead of paying
//   twice.
//
// BUY-09 — the same money is never returned twice. The partial unique index on
// event_refunds (order_id where status in requested/processing/completed) is
// what enforces it, in Postgres, where two simultaneous clicks both have to
// pass. Hitting it is not an error to be swallowed — it is the answer, and it
// is reported as "that refund is already in hand".
//
// `completed` is not written here. Stripe returning `succeeded` from an API
// call means the refund was accepted, and stripe-webhook is the single writer
// that turns an accepted refund into a completed one — the same rule that
// makes stripe-webhook the only thing that can say an order was paid. Until it
// lands, the refund reads "processing", which is true.
//
// So the attendee hears twice, and both are worth hearing: this queues "it is
// on its way", and stripe-webhook queues "it has arrived" when the money
// actually moves. Neither says anything about whether they are still coming.
//
// Deploy:  supabase functions deploy event-refund
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_...
// ============================================================================

import Stripe from 'npm:stripe@18'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

/** BUY-08. Accepted by Stripe is not the same as back in somebody's account. */
const ON_ACCEPTANCE: Record<string, string> = {
  succeeded: 'processing',
  pending: 'processing',
  failed: 'failed',
  canceled: 'failed',
  requires_action: 'needs_attention',
}

/** Only what a refund needs to decide anything. §7.2's account is the load-bearing field. */
interface OrderRow {
  id: string
  event_id: string
  profile_id: string
  amount_cents: number
  currency: string
  status: string
  stripe_payment_intent_id: string | null
  /** §7.2. The account that actually took this money, frozen at checkout. */
  stripe_account_id: string | null
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) {
    return json(
      {
        error:
          'Card payments are not configured yet, so there is nothing to refund through. ' +
          'Set STRIPE_SECRET_KEY on this project (supabase secrets set STRIPE_SECRET_KEY=sk_...) ' +
          'and deploy again.',
        reason: 'stripe_not_configured',
      },
      500,
    )
  }

  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in first.' }, 401)

  let orderId = ''
  let requested: number | null = null
  let reason = ''
  try {
    const body = await request.json()
    orderId = String(body?.order_id ?? '').trim()
    reason = String(body?.reason ?? '').trim()
    if (body?.amount_cents !== undefined && body?.amount_cents !== null) {
      requested = Number(body.amount_cents)
    }
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (!orderId) return json({ error: 'An order is required.' }, 400)
  if (requested !== null && (!Number.isInteger(requested) || requested <= 0)) {
    // Minor units, always. A float here is a rounding argument with a customer.
    return json({ error: 'A refund amount must be a whole number of minor units.' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData } = await asCaller.auth.getUser()
  const me = userData?.user?.id
  if (!me) return json({ error: 'Sign in first.' }, 401)

  // One string literal, not a concatenation. With no generated `Database`
  // type, supabase-js parses the select list off the literal to type the row;
  // a `+` makes it plain `string`, the parse gives up, and every field below
  // reads off `GenericStringError` instead of a row.
  const { data: orderRow, error: orderReadError } = await db
    .from('event_orders')
    .select(
      'id, event_id, profile_id, amount_cents, currency, status, stripe_payment_intent_id, stripe_account_id',
    )
    .eq('id', orderId)
    .maybeSingle()

  // A read that *failed* and a row that is *not there* are different facts and
  // must not collapse into one 404. This is the money path: if we cannot read
  // the order, we do not know which account took the payment, how much is left
  // on it, or whether it was already refunded — so we stop here, before the
  // event_refunds row is written and long before Stripe is called. Refunding
  // on a guess is the one thing worse than not refunding (QLT-09).
  if (orderReadError) {
    console.error(`event-refund: could not read order ${orderId}: ${orderReadError.message}`)
    return json(
      {
        error: 'Could not read that order, so the refund was not attempted. Nothing has changed.',
        reason: 'order_unreadable',
      },
      503,
    )
  }
  if (!orderRow) return json({ error: 'That order does not exist.' }, 404)
  const order = orderRow as OrderRow

  // ORG-09/ORG-11. Hosting the event, or being an admin. Asked of the caller's
  // own token, so the service role above can never be borrowed to refund
  // somebody else's event.
  const [{ data: hosts }, { data: isAdmin }] = await Promise.all([
    asCaller.rpc('hosts_event', { p_event: order.event_id }),
    asCaller.rpc('is_admin'),
  ])
  if (!hosts && !isAdmin) return json({ error: 'That is not yours to refund.' }, 403)

  if (order.status !== 'paid' && order.status !== 'partially_refunded') {
    // Nothing was taken, so there is nothing to give back. Saying so is kinder
    // than a Stripe error about an unknown payment intent.
    return json(
      { error: `There is no payment on this order to refund — it is ${order.status}.` },
      409,
    )
  }
  if (!order.stripe_payment_intent_id) {
    return json(
      {
        error:
          'This order has no Stripe payment recorded against it, so it cannot be refunded ' +
          'automatically. An admin needs to look at it.',
      },
      409,
    )
  }

  // What is left. Only refunds that actually completed have taken money back.
  const { data: doneRows } = await db
    .from('event_refunds')
    .select('amount_cents')
    .eq('order_id', order.id)
    .eq('status', 'completed')
  const alreadyReturned = ((doneRows ?? []) as { amount_cents: number }[]).reduce(
    (sum, row) => sum + row.amount_cents,
    0,
  )
  const remaining = Number(order.amount_cents) - alreadyReturned
  if (remaining <= 0) {
    return json({ error: 'This order has already been refunded in full.' }, 409)
  }

  const amount = requested ?? remaining
  if (amount > remaining) {
    return json(
      { error: `That is more than is left on this order — ${remaining} minor units remain.` },
      400,
    )
  }

  // ---- 1. the record, before the money ------------------------------------

  const { data: refund, error: refundError } = await db
    .from('event_refunds')
    .insert({
      order_id: order.id,
      amount_cents: amount,
      status: 'requested',
      reason: reason || null,
      requested_by: me,
    })
    .select('id')
    .maybeSingle()

  if (refundError) {
    // BUY-09. The index caught a second attempt. This is the correct outcome,
    // not a fault, and it is what stops a double-clicked button paying twice.
    if (refundError.code === '23505') {
      const { data: existing } = await db
        .from('event_refunds')
        .select('id, status, amount_cents')
        .eq('order_id', order.id)
        .in('status', ['requested', 'processing', 'completed'])
        .maybeSingle()
      return json(
        {
          error: 'That refund is already in hand.',
          reason: 'refund_in_progress',
          refund_id: existing?.id ?? null,
          status: existing?.status ?? null,
        },
        409,
      )
    }
    return json({ error: 'Could not record the refund.' }, 500)
  }
  if (!refund) return json({ error: 'Could not record the refund.' }, 500)

  // ---- 2. Stripe -----------------------------------------------------------

  const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() })

  // CONTRACT §7.2, and the reason that column exists. Money goes back out of
  // the account it came into, read off the **order** — never recomputed from
  // whatever the event says today.
  //
  // The event's answer can change: a connector can lose `can_create_events`,
  // be restricted by Stripe, or disconnect entirely, long after tickets were
  // sold. None of that is read here, and none of it may strand a refund. The
  // order remembers which account took this money, so the refund finds its way
  // home even when the connector has walked away from the platform (§7.3, last
  // row — losing payment capability must never strand people who already
  // bought). A refund attempted on the platform account for a charge taken on
  // a connector's would simply fail at Stripe, which is exactly the bug this
  // frozen column prevents.
  const options: Stripe.RequestOptions = { idempotencyKey: `refund:${refund.id}` }
  if (order.stripe_account_id) options.stripeAccount = String(order.stripe_account_id)

  let stripeRefund: Stripe.Refund
  try {
    stripeRefund = await stripe.refunds.create(
      {
        payment_intent: String(order.stripe_payment_intent_id),
        amount,
        metadata: {
          refund_id: String(refund.id),
          order_id: String(order.id),
          event_id: String(order.event_id),
        },
      },
      options,
    )
  } catch (error) {
    // QLT-09. The attempt is not lost. The row stays, holding the reason it
    // failed, and shows up wherever refunds needing attention are listed.
    const message = error instanceof Error ? error.message : String(error)
    await db
      .from('event_refunds')
      .update({
        status: 'needs_attention',
        failure_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', refund.id)
    return json(
      {
        error: `Stripe would not take the refund: ${message}`,
        reason: 'needs_attention',
        refund_id: refund.id,
        status: 'needs_attention',
      },
      502,
    )
  }

  // ---- 3. reconcile --------------------------------------------------------

  const status = ON_ACCEPTANCE[stripeRefund.status ?? ''] ?? 'needs_attention'
  await db
    .from('event_refunds')
    .update({
      status,
      stripe_refund_id: stripeRefund.id,
      failure_message: stripeRefund.failure_reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', refund.id)

  // CONTRACT §7. The refund-status message, queued through event-email so the
  // queue has one front door and one set of rules about who hears what.
  // Best effort: the money is already on its way, and a mail queue that is
  // having a bad minute must not turn a successful refund into an error.
  if (status === 'processing') {
    await queueMessage(String(order.event_id), String(order.profile_id), {
      kind: 'refund',
      subject: 'Your refund is on its way',
      body:
        `A refund of ${money(amount, String(order.currency ?? 'gbp'))} is on its way back to ` +
        'the card you paid with. We will let you know when it has landed.',
    })
  }

  return json(
    {
      refund_id: refund.id,
      status,
      stripe_refund_id: stripeRefund.id,
      amount_cents: amount,
      currency: order.currency,
      remaining_cents: remaining - amount,
      // BUY-08, said out loud so no screen has to guess. The refund does not
      // cancel anybody's attendance; cancel_registration does that, separately.
      registration_unchanged: true,
    },
    200,
  )
})

/**
 * EML-05/06. Asks event-email to queue it rather than writing the queue rows
 * here: for `refund` it resolves the audience to the one named person and
 * writes the single recipient row, and it only takes that kind from the
 * service role — money is reported by the thing that moved it.
 */
async function queueMessage(
  eventId: string,
  profileId: string,
  copy: { kind: string; subject: string; body: string },
): Promise<void> {
  const url = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  try {
    const response = await fetch(`${url}/functions/v1/event-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        kind: copy.kind,
        event_id: eventId,
        profile_id: profileId,
        subject: copy.subject,
        body: copy.body,
        send_now: true,
      }),
    })
    if (!response.ok) {
      console.error(`event-refund: could not queue ${copy.kind}: ${await response.text()}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`event-refund: could not queue ${copy.kind}: ${message}`)
  }
}

/** EVT-04. Minor units become money at the last possible moment, never before. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

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
