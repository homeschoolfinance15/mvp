// ============================================================================
// order-state — the two transitions a pending order can make, in one place
//
// An order goes `pending -> paid` or `pending -> failed`. Both used to live
// inside stripe-webhook, which was right while a signed Stripe delivery was
// the only thing that could cause either. stripe-reconcile is the second
// cause: the sweep that finds orders whose delivery never arrived and asks
// Stripe directly what became of them (PAYMENTS.md §9).
//
// Two callers, one implementation, deliberately. The invariant BUY-03 protects
// is not "only one file writes paid" — it is "exactly one writer wins, and a
// replay changes nothing". That is held by the conditional update, not by the
// file layout: every transition is claimed with `.eq('status', 'pending')`, so
// whichever caller arrives second selects no row and stops before issuing a
// second ticket or queueing a second email. The webhook and the sweep can
// therefore race on the same order safely, which they will, because the sweep
// runs while Stripe is still retrying.
//
// Copying the logic into the sweep instead would have left two implementations
// to keep in step, and the one that drifted would be the one nobody watches.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

/**
 * The service-role client's type, taken from an actual call rather than from
 * `ReturnType<typeof createClient>`. With no generated `Database` type,
 * `createClient`'s schema generics fall back to their *constraints* when read
 * off the bare signature, which resolves to `never` and makes every real
 * client unassignable to it. Same shape as stripe-webhook, which hit it first.
 */
const clientOfOurs = (url: string, key: string) => createClient(url, key)
export type Db = ReturnType<typeof clientOfOurs>

/**
 * The shape both transitions need. Callers select it as one string literal of
 * their own rather than sharing a constant: with no generated `Database` type,
 * supabase-js parses the select list off the literal to type the row, and a
 * variable or a concatenation makes it plain `string`, which collapses the row
 * type to `GenericStringError`. event-refund hit this first.
 */
export interface OrderRow {
  id: string
  registration_id: string | null
  amount_cents: number
  status: string
}

/**
 * BUY-03, BUY-06, BUY-10. The order is paid, so the place becomes real.
 *
 * Throws on a database error the caller should retry — stripe-webhook turns
 * that into a 500 so Stripe redelivers, and stripe-reconcile leaves the order
 * pending so the next sweep picks it up again. Returns quietly when another
 * writer got there first, which is the common case and not a fault.
 */
export async function confirmPaidOrder(
  db: Db,
  order: OrderRow,
  ref: { sessionId: string | null; paymentIntentId: string | null },
): Promise<void> {
  // The guard. Exactly one caller moves pending -> paid; every replay updates
  // nothing, selects nothing, and stops here before issuing a second ticket or
  // queueing a second email.
  //
  // The two Stripe ids are written only when the caller has one. The webhook
  // always does; the sweep is reading the order's own session back, so writing
  // a null over a good id would lose the only handle a later refund has.
  const { data: claimed, error } = await db
    .from('event_orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      ...(ref.sessionId ? { stripe_checkout_session_id: ref.sessionId } : {}),
      ...(ref.paymentIntentId ? { stripe_payment_intent_id: ref.paymentIntentId } : {}),
    })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`could not mark order ${order.id} paid: ${error.message}`)
  if (!claimed) return

  if (!order.registration_id) return

  // BUY-06. The hold becomes a place. hold_expires_at is cleared so no sweeper
  // can later reclaim a seat somebody has paid for.
  const { data: confirmed, error: confirmError } = await db
    .from('event_registrations')
    .update({
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      hold_expires_at: null,
    })
    .eq('id', order.registration_id)
    .in('status', ['pending', 'confirmed'])
    .select('id, event_id, profile_id')
    .maybeSingle()

  if (confirmError || !confirmed) {
    // The money is real and stays recorded as paid — we do not un-say a
    // payment that happened. But the place could not be given, so this is a
    // refund somebody has to make, and it goes into the same queue an admin
    // already watches for stuck refunds (QLT-09, ORG-11).
    await db.from('event_refunds').insert({
      order_id: order.id,
      amount_cents: order.amount_cents,
      status: 'needs_attention',
      reason: 'Paid, but the place could not be confirmed',
      failure_message:
        confirmError?.message ??
        'The registration was no longer holdable when payment completed. ' +
          'Refund this order or find the attendee a place.',
    })
    return
  }

  // BUY-10/11. The ticket is not issued here. `issue_ticket_on_confirm()`
  // fires on the registration landing at `confirmed` and writes it, with an
  // unguessable code, in the same transaction as the confirmation (QLT-05).
  // One writer, and the unique registration_id means the trigger cannot be
  // made to issue two however many times this is called.

  // EML-01. Queued, not sent — event-mailer is the only thing that sends, and
  // it re-checks eligibility at send time.
  // ponytail: one message, the confirmation, which carries the ticket. Stripe
  // already emails its own receipt; a second `payment` message would be us
  // telling somebody twice that they paid.
  await queueMessage(String(confirmed.event_id), String(confirmed.profile_id), {
    kind: 'confirmation',
    subject: 'Your place is confirmed',
    body: 'Your payment went through and your ticket is ready.',
  })
}

/**
 * BUY-03. An expired session and a declined card are the same fact to us:
 * nobody paid. The order says `failed` and the place goes back in the pool so
 * the next person can have it. Neither may ever read as a completed purchase.
 *
 * Only a pending order can fail. One that is already paid is left alone — a
 * late `payment_failed` for a retried card, or a sweep reading a session
 * Stripe has since settled, must not undo a real payment.
 */
export async function failPendingOrder(db: Db, order: OrderRow): Promise<void> {
  const { data: claimed, error } = await db
    .from('event_orders')
    .update({ status: 'failed' })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`could not mark order ${order.id} failed: ${error.message}`)
  if (!claimed || !order.registration_id) return

  await db
    .from('event_registrations')
    .update({ status: 'expired', hold_expires_at: null })
    .eq('id', order.registration_id)
    .eq('status', 'pending')
}

/**
 * EML-05/06. event-email is the queue's front door: it resolves the audience,
 * writes the event_messages row and writes one event_message_recipients row
 * per person. For `confirmation`, `payment` and `refund` that audience is the
 * single named person, which is exactly what a per-person message needs — so
 * this asks it rather than re-implementing the queue with a second set of
 * rules that could drift from the first. It only accepts these three kinds
 * from the service role, because money is only ever reported by the thing
 * that moved it.
 *
 * Best effort on purpose. The payment stands whatever the mail queue does; a
 * message that could not be queued is worth a log line, never worth telling
 * Stripe to redeliver a payment that already succeeded.
 */
export async function queueMessage(
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
      console.error(`order-state: could not queue ${copy.kind}: ${await response.text()}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`order-state: could not queue ${copy.kind}: ${message}`)
  }
}
