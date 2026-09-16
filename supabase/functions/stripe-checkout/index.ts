// ============================================================================
// stripe-checkout — holds a place, then opens a hosted Stripe Checkout session
//
// Two things happen here and they happen in this order, deliberately:
//
//   1. a `pending` event_registrations row holds the place for 20 minutes
//      (BUY-06), so the person filling in a card is not racing the person who
//      loaded the page a second later;
//   2. an event_orders row records the intent to charge, and only then does
//      Stripe hear about it.
//
// Nothing here confirms anything. stripe-webhook is the only thing that turns
// an order into `paid` and a place into `confirmed` (BUY-03). A browser that
// reaches success_url has proved it can follow a redirect, not that money
// moved — so this function never writes `paid`, and the checkout screen reads
// the order, it does not decide it.
//
// The three failures that must never happen, and what stops each (QLT-10):
//
//   false success    only stripe-webhook writes `paid`, and only after Stripe
//                    has signed for it. This function cannot produce one, on
//                    any network, because it never writes that state at all.
//
//   double charge    `idempotency_key` is derived from the event, the person,
//                    the ticket type and the live registration id, so the same
//                    attempt always computes the same key. It is unique in
//                    Postgres, so the second insert is refused; it is handed to
//                    Stripe as the idempotency key, so the second create
//                    replays the first session rather than opening another. A
//                    refresh, a retry and a double click all land on one
//                    session with one payment intent.
//
//   double ticket    the partial unique index on (event_id, profile_id) where
//                    status in ('pending','confirmed') means one live place per
//                    person per event, and event_tickets is unique on
//                    registration_id, so even two confirmations issue one.
//
// Sold out is decided before Stripe is called, never after (ORG-03A): a person
// who cannot have a place is not shown a card form. `event_capacity_state()`
// is the single judge of that, so this function and the event page cannot
// disagree about whether an event is open.
//
// BUY-13/BUY-14, CONTRACT §7.0 — whose money this is:
//
//   Read off the *event*, never off the caller. Whoever created the event owns
//   its money, and that answer is already written down as
//   `events.payment_connector_id`: null means a platform event charged on
//   Amazing's own Stripe account, set means a super connector's event charged
//   on `connectors.stripe_account_id`. A cohost buying nothing into it, an
//   admin editing it, a connector helping run somebody else's event — none of
//   them change where the money goes, because none of them are read here.
//
//   §7.1. The charge is a **direct charge**: created on the connected account
//   by passing `stripeAccount: acct_…` as a request option with our platform
//   key. That is what makes BUY-14 literally true — funds land in the
//   connector's balance, they pay Stripe's fees, they own the disputes.
//   `application_fee_amount` is never set: §13 excludes platform commission
//   from this release, and `event_orders.application_fee_cents` is written 0 to
//   say so in the data rather than only in a comment.
//
//   §7.3. A connector who has not connected Stripe, or whose account Stripe
//   will not let take charges, cannot open **new** paid sales — refused here,
//   by name, with what Stripe is still waiting for. Nothing already sold is
//   read or written on that path, so existing bookings, tickets, check-in and
//   refunds carry on working exactly as they did.
//
//   §7.2. The account that actually takes this money is frozen onto the order
//   as `stripe_account_id`. Every refund goes back through that, so a refund
//   still works after the connector disconnects or loses permission.
//
// Free events never come here. They have no Stripe anything, and `register_free`
// serves them with no configuration at all.
//
// Deploy:  supabase functions deploy stripe-checkout
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_...
//          supabase secrets set SITE_URL=https://goamazing.ai      (optional)
//          supabase secrets set PLATFORM_FEE_BPS=0                 (optional)
// ============================================================================

import Stripe from 'npm:stripe@18'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const SITE = (Deno.env.get('SITE_URL') ?? 'https://goamazing.ai').replace(/\/+$/, '')

/**
 * The service-role client's type, taken from an actual call rather than from
 * `ReturnType<typeof createClient>`. With no generated `Database` type,
 * `createClient`'s schema generics fall back to their *constraints* when read
 * off the bare signature, which resolves to `never` and makes every real
 * client unassignable to it. Inferring from a call that looks like the calls we
 * make gets the type we actually hold. `invite-email` and `waitlist-email`
 * dodge this by having no helper that takes a client; these functions do.
 */
const clientOfOurs = (url: string, key: string) => createClient(url, key)
type Db = ReturnType<typeof clientOfOurs>

/** BUY-06. Long enough to find a card, short enough that a place comes back. */
const HOLD_MINUTES = 20

/**
 * Stripe will not expire a session sooner than 30 minutes from now, which is
 * the closest it can get to our 20-minute hold. The hold is ours to enforce;
 * this only stops an abandoned session lingering for Stripe's default day.
 */
const SESSION_MINUTES = 30

/**
 * EVT-04. Basis points added on top of the ticket price and shown to the
 * attendee on its own line, so the total on the Stripe page is the total that
 * leaves the card. Unset means no fee at all, which is the state we launch in
 * and the state §13 requires — this is not platform commission, and it is not
 * an application fee. On a connector's direct charge a booking fee lands in
 * the connector's balance with the rest of the money, exactly like the ticket.
 * ponytail: one number for the whole platform. Per-event fees want a column.
 */
const FEE_BPS = Number(Deno.env.get('PLATFORM_FEE_BPS') ?? '0')

/**
 * §7.3, QLT-02, QLT-05. What an attendee is told when an event cannot take
 * payment, whatever the underlying reason.
 *
 * One sentence for every case on purpose. The differences between "not
 * connected", "restricted by Stripe" and "account could not be resolved" are
 * real and they matter — to the organiser, who has a different job to do in
 * each. To the attendee they are the same fact with the same next step, and
 * spelling them apart would only tell them about somebody else's Stripe
 * account. It says what happened, that it is not theirs to fix, and that what
 * they already hold is safe.
 */
const ATTENDEE_REFUSAL =
  'This event cannot take payments at the moment, so tickets are not on sale. ' +
  'It is nothing you have done — the organiser has been told and needs to sort it out ' +
  'with their payment provider. Any booking you have already made is unaffected.'

/** §7.3. `event_sale_readiness()` — the one definition of whether paid sales may open. */
interface SaleReadiness {
  can_sell_paid: boolean
  reason: string | null
  /** The sentence to show the organiser, seeded from this function's own wording. */
  fix_action: string | null
}

interface CapacityInfo {
  capacity: number | null
  confirmed: number
  remaining: number | null
  state: 'open' | 'sold_out' | 'closed' | 'cancelled' | 'finished'
}

/** ORG-03A. Sold out and closed are different facts and get different words. */
const REFUSALS: Record<string, string> = {
  sold_out: 'This event is sold out.',
  closed: 'Registration for this event has closed.',
  cancelled: 'This event has been cancelled.',
  finished: 'This event has already happened.',
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) {
    // Named precisely, because the person who can fix this is reading the log.
    return json(
      {
        error:
          'Card payments are not configured yet. Set STRIPE_SECRET_KEY on this project ' +
          '(supabase secrets set STRIPE_SECRET_KEY=sk_...) and deploy again. ' +
          'Free events are unaffected.',
        reason: 'stripe_not_configured',
      },
      500,
    )
  }

  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in to book a place.' }, 401)

  let eventId = ''
  let slug = ''
  let ticketTypeId = ''
  try {
    const body = await request.json()
    eventId = String(body?.event_id ?? '').trim()
    slug = String(body?.slug ?? '').trim()
    ticketTypeId = String(body?.ticket_type_id ?? '').trim()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (!eventId && !slug) return json({ error: 'An event is required.' }, 400)
  if (!ticketTypeId) return json({ error: 'A ticket type is required.' }, 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData } = await asCaller.auth.getUser()
  const me = userData?.user?.id
  if (!me) return json({ error: 'Sign in to book a place.' }, 401)

  // BUY-01. An account that has not finished signing up cannot buy a ticket —
  // there would be nobody to email the ticket to and nobody to check in.
  const { data: account } = await asCaller.rpc('has_account')
  if (!account) {
    return json(
      { error: 'Finish setting up your account before booking.', reason: 'no_account' },
      403,
    )
  }

  // BUY-01 again, and the half `has_account()` cannot answer: "finish required
  // onboarding **before completing event registration**". `has_account()` only
  // asks whether a profile exists, and /events/checkout/:slug is deliberately
  // not behind a route guard — that is what lets an anonymous visitor reach
  // /e/:slug and /events at all. So the client-side gate makes this true for
  // people who come through our UI and for nobody else. It is enforced here
  // because this is the last point before money moves.
  //
  // `onboarding_complete()` is asked rather than reimplemented. It is this
  // codebase's one definition of the phrase — a profession, or being an admin,
  // and not suspended or removed — and it is what the RLS policy and
  // `register_free()` already use. Asking it means free and paid registration
  // cannot drift apart, and it means nobody can reach the Pay button having
  // passed every other gate only to be refused here by a stricter rule of our
  // own (QLT-02: a refusal has to come with somewhere to go).
  //
  // The network questionnaire is deliberately **not** part of this. An
  // event-only account never answers it (ACC-02), and a network member who has
  // not is still entitled to buy a ticket.
  const { data: onboarded, error: onboardedError } = await asCaller.rpc('onboarding_complete')
  if (onboardedError) {
    return json(
      {
        error: 'Could not check your account setup, so the booking was not started.',
        reason: 'profile_unreadable',
      },
      503,
    )
  }
  if (!onboarded) {
    return json(
      {
        error: 'Finish setting up your profile before booking a place.',
        reason: 'onboarding_incomplete',
      },
      403,
    )
  }

  // ---- what is being bought ----------------------------------------------

  const { data: event } = await db
    .from('events')
    .select(
      'id, slug, title, status, currency, refund_terms, payment_connector_id, payment_recipient_id',
    )
    .eq(eventId ? 'id' : 'slug', eventId || slug)
    .maybeSingle()
  if (!event) return json({ error: 'That event does not exist.' }, 404)

  // ORG-02. A draft is not a thing anyone outside the host team can buy into,
  // and saying "sold out" about it would confirm that it exists.
  if (event.status === 'draft') return json({ error: 'That event does not exist.' }, 404)

  // ORG-03A, BUY-05. Decided here, before a single Stripe call, so a refusal
  // never leaves a charge or an abandoned session behind it. This read is the
  // fast, kind answer; it is not the guarantee. The guarantee is the row lock
  // in the capacity trigger, which is what the two people racing for the last
  // place actually meet — see the insert below.
  const capacity = await capacityState(db, String(event.id))
  if (!capacity) return json({ error: 'Could not check availability.' }, 500)
  if (capacity.state !== 'open') return json(refusal(capacity.state), 409)

  const { data: ticket } = await db
    .from('ticket_types')
    .select('id, event_id, name, price_cents, currency, is_active')
    .eq('id', ticketTypeId)
    .maybeSingle()
  if (!ticket || ticket.event_id !== event.id) {
    return json({ error: 'That ticket type is not on this event.' }, 404)
  }
  if (!ticket.is_active) return json({ error: 'That ticket is no longer on sale.' }, 409)

  // A free ticket has nothing to charge for. Sending it through Stripe would
  // make free events depend on Stripe configuration, which they must not.
  if (ticket.price_cents <= 0) {
    return json(
      { error: 'That ticket is free — register for it directly.', reason: 'free_ticket' },
      400,
    )
  }

  const currency = String(ticket.currency ?? event.currency ?? 'gbp').toLowerCase()

  // ---- may this event sell, and into whose account (§7.0, §7.3) -----------
  //
  // Two different questions, and only one of them lives here.
  //
  //   may it sell?   `event_sale_readiness()` — one continuously-evaluated
  //                  definition shared with the publish check and the
  //                  organiser's dashboard banner.
  //   whose money?   `events.payment_connector_id`, resolved below. The event
  //                  answers it, never the caller. Null is Amazing's account.
  //
  // **Why the gate runs here, at every checkout, and not only at publish.**
  // There is no such thing as "you were allowed when you published". A
  // connector can be restricted by Stripe, or disconnect, minutes after an
  // event goes live; a paid ticket type can be added to an event that was free
  // when it was published, which no publish-time check ever re-runs. Stripe
  // itself re-checks `charges_enabled` on every charge for exactly this reason.
  // So this is not a third layer behind the publish check — **it is the gate**,
  // and the publish check is a courtesy that fails early and kindly.
  //
  // It calls the shared function rather than reading `stripe_charges_enabled`
  // directly so that there is one definition to change and one to delete.
  // Deleting it breaks checkout, the banner and publish loudly and together,
  // instead of silently opening a hole here six months from now.
  const { data: readinessData, error: readinessError } = await db.rpc('event_sale_readiness', {
    p_event: event.id,
  })
  if (readinessError) return json({ error: 'Could not check whether this event can sell.' }, 503)
  const readiness = (Array.isArray(readinessData) ? readinessData[0] : readinessData) as
    | SaleReadiness
    | undefined
  if (!readiness) return json({ error: 'Could not check whether this event can sell.' }, 503)

  if (!readiness.can_sell_paid) {
    // Stops **new** sales only — nothing already sold is read on this path,
    // which is what keeps BUY-14's "preserve access to existing bookings and
    // payment support" true.
    //
    // `fix_action` is **not** passed on, and neither is the readiness sentence.
    // Everyone who calls this function is an attendee, and `fix_action` is by
    // definition the *organiser's* instruction: it names the host's Stripe
    // account state and points at /connector/payments, a page the reader cannot
    // open and a fact that is none of their business (QLT-05 — access
    // restrictions apply everywhere information can appear, and an error body
    // is somewhere information appears). The organiser gets that sentence on
    // their own dashboard and at publish, from the same shared function.
    //
    // What an attendee needs is narrower and identical in every case: this
    // event cannot take payment yet, it is not something they did, and their
    // existing bookings are fine. `reason` still carries the precise tag so the
    // screen can branch — it is a tag, not a sentence, and nothing renders it.
    return json(
      {
        error: ATTENDEE_REFUSAL,
        reason: readiness.reason ?? 'not_ready_for_paid_sales',
      },
      409,
    )
  }

  let stripeAccount: string | null = null
  if (event.payment_connector_id) {
    const { data: connector } = await db
      .from('connectors')
      .select('id, stripe_account_id')
      .eq('id', event.payment_connector_id)
      .maybeSingle()
    stripeAccount = (connector?.stripe_account_id as string | null) ?? null

    // Not a second gate — readiness has already said yes. This is the one thing
    // that must never be inferred: a connector event with no resolved account
    // would fall through to `stripeAccount = null`, which means *Amazing's*
    // account, and we would take a connector's revenue into the platform
    // balance while every screen said otherwise. That is precisely BUY-14's
    // "do not route revenue to another host's account", so it is refused on the
    // fact rather than trusted from the gate.
    if (!stripeAccount) {
      // Logged in full, said in outline — the detail belongs to whoever can act
      // on it, which is not the person trying to buy a ticket.
      console.error(
        `stripe-checkout: event ${event.id} names connector ${event.payment_connector_id} ` +
          `but no stripe_account_id resolved. Refused rather than charging the platform.`,
      )
      return json({ error: ATTENDEE_REFUSAL, reason: 'connector_account_unresolved' }, 409)
    }
  }

  const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() })

  // ---- hold the place (BUY-06) -------------------------------------------

  const nowIso = new Date().toISOString()
  const holdUntil = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString()

  let registration = await liveRegistration(db, event.id, me)

  if (registration?.status === 'confirmed') {
    return json(
      { error: 'You already have a place at this event.', reason: 'already_registered' },
      409,
    )
  }

  if (registration && registration.hold_expires_at && registration.hold_expires_at < nowIso) {
    // The hold lapsed. Before believing that, ask the one question that makes
    // the difference between a free place and a second charge (QLT-10, BUY-04).
    //
    // A lapsed hold normally means somebody wandered off. But it also happens
    // when they paid and our webhook could not be delivered — the money moved,
    // the order is still `pending`, and twenty minutes went by. If we retired
    // that row we would build a new registration, a new idempotency key and a
    // new Checkout session, and the same person could pay for the same place
    // twice. Postgres cannot see this; only Stripe knows whether that session
    // was paid, so we ask it.
    const paidSession = await alreadyPaid(db, stripe, registration.id, stripeAccount)
    if (paidSession) {
      // Not retired, not re-charged, not confirmed here either — stripe-webhook
      // stays the only thing that writes `paid` (BUY-03), so this reports the
      // truth and stops rather than racing it.
      console.error(
        `stripe-checkout: session ${paidSession} for registration ${registration.id} is paid at ` +
          `Stripe but its order is still pending — webhook delivery has not landed. ` +
          `Reconcile before this place is re-sold.`,
      )
      return json(
        {
          error:
            'Your payment went through and we are still confirming it. Your place is safe — ' +
            'this usually takes a few minutes. Nothing further is needed from you, and you ' +
            'have not been charged twice.',
          reason: 'payment_confirming',
          session_id: paidSession,
          registration_id: registration.id,
        },
        409,
      )
    }

    // Genuinely abandoned, so the place is back in the pool and this is a fresh
    // attempt. Retiring the row rather than reviving it matters: the idempotency
    // key is built from the registration id, and reviving one would reuse a
    // Checkout session Stripe has since expired.
    await db
      .from('event_registrations')
      .update({ status: 'expired' })
      .eq('id', registration.id)
      .eq('status', 'pending')
    registration = null
  }

  if (registration && registration.ticket_type_id !== ticket.id) {
    // They changed their mind about which ticket before paying. The place is
    // the same place; only what it costs changed. The earlier order keeps its
    // own key and is left to lapse unpaid — an unpaid order charges nobody.
    const { data: moved } = await db
      .from('event_registrations')
      .update({ ticket_type_id: ticket.id, hold_expires_at: holdUntil })
      .eq('id', registration.id)
      .eq('status', 'pending')
      .select('id, status, hold_expires_at, ticket_type_id')
      .maybeSingle()
    registration = (moved as LiveRegistration | null) ?? registration
  }

  if (!registration) {
    const { data: created, error: createError } = await db
      .from('event_registrations')
      .insert({
        event_id: event.id,
        profile_id: me,
        ticket_type_id: ticket.id,
        status: 'pending',
        hold_expires_at: holdUntil,
        // BUY-15. The terms as they read the moment this person agreed to them,
        // so a later edit to refund_terms cannot rewrite what they accepted.
        terms_snapshot: event.refund_terms,
      })
      .select('id, status, hold_expires_at, ticket_type_id')
      .maybeSingle()

    if (createError) {
      if (createError.code === '23505') {
        // The anti-duplicate index doing its job, not a fault. Two clicks that
        // arrive together converge here: the loser reads the row the winner
        // just wrote and carries on to the same session.
        registration = await liveRegistration(db, event.id, me)
        if (!registration || registration.status === 'confirmed') {
          return json(
            { error: 'You already have a place at this event.', reason: 'already_registered' },
            409,
          )
        }
      } else {
        // BUY-05, §11: "Two people try to claim the final available place —
        // only one receives it; the other sees Sold out and is not charged."
        //
        // This is where the loser of that race lands. The check above passed
        // for both of them, because at that moment the place was genuinely
        // there; what separates them is the capacity trigger, which takes a row
        // lock on the event and counts under it, so the two inserts are
        // serialised and the second is refused.
        //
        // Asking the capacity state again is how that refusal becomes the right
        // sentence. A raised exception arrives here as an opaque database
        // error, and guessing at its SQLSTATE or its wording would be inventing
        // a name the schema has not agreed to (CONTRACT §0). Re-reading answers
        // the only question that matters — is there still a place? — and is
        // correct whatever the trigger chose to raise.
        //
        // Either way nobody is charged: Stripe has not been called yet and is
        // not called on any path out of this branch.
        const now = await capacityState(db, String(event.id))
        if (now && now.state !== 'open') return json(refusal(now.state), 409)
        return json({ error: 'Could not hold a place for you.' }, 500)
      }
    } else {
      registration = (created as LiveRegistration | null) ?? null
    }
  }
  if (!registration) return json({ error: 'Could not hold a place for you.' }, 500)

  // ---- the order, and the key that makes a retry harmless (BUY-04) --------

  const fee = FEE_BPS > 0 ? Math.round((ticket.price_cents * FEE_BPS) / 10_000) : 0
  // EVT-04. amount_cents is the total actually charged; fee_cents says how much
  // of it was the fee. The attendee sees both, they add up to one number, and
  // that number is what leaves the card.
  const total = ticket.price_cents + fee

  const idempotencyKey = `evt:${event.id}:${me}:${ticket.id}:${registration.id}`

  let order = await orderByKey(db, idempotencyKey)
  if (order?.status === 'paid') {
    return json(
      { error: 'This is already paid for — your place is confirmed.', reason: 'already_paid' },
      409,
    )
  }
  if (!order) {
    const { data: created, error: orderError } = await db
      .from('event_orders')
      .insert({
        event_id: event.id,
        profile_id: me,
        registration_id: registration.id,
        amount_cents: total,
        fee_cents: fee > 0 ? fee : null,
        currency,
        status: 'pending',
        idempotency_key: idempotencyKey,
        // §7.2. Which account is taking *this* money, frozen at the moment it
        // is taken. Never recomputed from the event later, because the event's
        // answer can change and this payment's cannot. Every refund reads it.
        stripe_account_id: stripeAccount,
        // §7.1. Always 0 in this release — §13 excludes platform commission.
        // Written rather than left null so the data says "no commission was
        // taken" instead of "nobody recorded whether one was".
        application_fee_cents: 0,
        terms_snapshot: event.refund_terms,
      })
      .select('id, status, stripe_checkout_session_id')
      .maybeSingle()

    if (orderError) {
      if (orderError.code !== '23505') return json({ error: 'Could not start the payment.' }, 500)
      order = await orderByKey(db, idempotencyKey)
      if (order?.status === 'paid') {
        return json(
          { error: 'This is already paid for — your place is confirmed.', reason: 'already_paid' },
          409,
        )
      }
    } else {
      order = (created as OrderRow | null) ?? null
    }
  }
  if (!order) return json({ error: 'Could not start the payment.' }, 500)

  // ---- Stripe ------------------------------------------------------------

  const { data: profile } = await db.from('profiles').select('email').eq('id', me).maybeSingle()

  const checkoutUrl = `${SITE}/events/checkout/${encodeURIComponent(String(event.slug))}`
  const reference = {
    order_id: String(order.id),
    event_id: String(event.id),
    profile_id: me,
    registration_id: String(registration.id),
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency,
        unit_amount: ticket.price_cents,
        product_data: { name: `${event.title} — ${ticket.name}` },
      },
    },
  ]
  if (fee > 0) {
    lineItems.push({
      quantity: 1,
      price_data: { currency, unit_amount: fee, product_data: { name: 'Booking fee' } },
    })
  }

  // The same key that made the order row unique is what makes the Stripe call
  // replay rather than repeat. Stripe holds it for 24 hours, which outlives
  // every refresh, retry and double click a 20-minute hold can contain.
  const options: Stripe.RequestOptions = { idempotencyKey }
  if (stripeAccount) options.stripeAccount = stripeAccount

  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: String(order.id),
        customer_email: (profile?.email as string | null) ?? undefined,
        line_items: lineItems,
        metadata: reference,
        // §7.1. `application_fee_amount` is deliberately absent. §13 excludes
        // platform commission from this release, so a direct charge on a
        // connector's account is theirs in full — fees, disputes and all.
        // ponytail: adding commission later is this one parameter plus a
        // non-zero application_fee_cents, not a re-architecture.
        payment_intent_data: { metadata: reference },
        expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
        success_url: `${checkoutUrl}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${checkoutUrl}?cancelled=1`,
      },
      options,
    )
  } catch (error) {
    // The order row stays `pending` on purpose. Nobody was charged, the hold
    // still stands, and the next attempt computes the same key and converges on
    // one session rather than starting a second.
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: `Stripe would not open a payment page: ${message}` }, 502)
  }

  await db
    .from('event_orders')
    .update({
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
    })
    .eq('id', order.id)

  return json(
    {
      url: session.url,
      session_id: session.id,
      order_id: order.id,
      registration_id: registration.id,
      hold_expires_at: registration.hold_expires_at,
      amount_cents: total,
      fee_cents: fee,
      currency,
      // BUY-04. Always `pending` here, and that is the point: this function
      // cannot return anything else, because it never writes `paid`. The
      // checkout screen shows a waiting state off the order rather than off
      // its own arrival at success_url, which is what stops a redirect from
      // reading as a completed purchase (§11, "payment remains unresolved").
      order_status: order.status,
    },
    200,
  )
})

/* -------------------------------------------------------------------------- */
/* Reading what is already there                                               */
/* -------------------------------------------------------------------------- */

interface LiveRegistration {
  id: string
  status: string
  hold_expires_at: string | null
  ticket_type_id: string | null
}

interface OrderRow {
  id: string
  status: string
  stripe_checkout_session_id: string | null
}

/**
 * QLT-10. Did the lapsed attempt actually pay? Answered by Stripe, because
 * Stripe is the only party that knows — our own row says `pending` in both the
 * abandoned case and the undelivered-webhook case, which is exactly why reading
 * it again would prove nothing.
 *
 * Returns the session id when the money moved, null otherwise. Null on any
 * Stripe error too: an unreachable Stripe must not wedge every checkout on the
 * site, and the idempotency key downstream is the second line of defence if
 * this one is unavailable.
 *
 * ponytail: one extra Stripe call, only on the expired-hold path, which is the
 * rare one. The proper fix for an undelivered webhook is a reconciliation
 * sweep over pending orders — see PAYMENTS.md §9. This closes the
 * double-charge window; it does not replace that sweep.
 */
async function alreadyPaid(
  db: Db,
  stripe: Stripe,
  registrationId: string,
  stripeAccount: string | null,
): Promise<string | null> {
  const { data } = await db
    .from('event_orders')
    .select('id, status, stripe_checkout_session_id')
    .eq('registration_id', registrationId)
    .eq('status', 'pending')
    .maybeSingle()
  const sessionId = (data as OrderRow | null)?.stripe_checkout_session_id
  if (!sessionId) return null

  try {
    const options: Stripe.RequestOptions = {}
    if (stripeAccount) options.stripeAccount = stripeAccount
    const session = await stripe.checkout.sessions.retrieve(sessionId, options)
    return session.payment_status === 'paid' ? sessionId : null
  } catch (error) {
    console.error(
      `stripe-checkout: could not re-read session ${sessionId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    return null
  }
}

/** ORG-03A, BUY-05. The single judge of whether an event is taking bookings. */
async function capacityState(
  db: Db,
  eventId: string,
): Promise<CapacityInfo | null> {
  const { data, error } = await db.rpc('event_capacity_state', { p_event: eventId })
  if (error) return null
  return ((Array.isArray(data) ? data[0] : data) as CapacityInfo | undefined) ?? null
}

/** ORG-03A. Sold out, closed, cancelled and finished are four different facts. */
function refusal(state: string): { error: string; reason: string } {
  return { error: REFUSALS[state] ?? 'This event is not taking bookings.', reason: state }
}

/** The one live place this person may have — the partial unique index guarantees "one". */
async function liveRegistration(
  db: Db,
  eventId: string,
  profileId: string,
): Promise<LiveRegistration | null> {
  const { data } = await db
    .from('event_registrations')
    .select('id, status, hold_expires_at, ticket_type_id')
    .eq('event_id', eventId)
    .eq('profile_id', profileId)
    .in('status', ['pending', 'confirmed'])
    .maybeSingle()
  return (data as LiveRegistration | null) ?? null
}

async function orderByKey(
  db: Db,
  key: string,
): Promise<OrderRow | null> {
  const { data } = await db
    .from('event_orders')
    .select('id, status, stripe_checkout_session_id')
    .eq('idempotency_key', key)
    .maybeSingle()
  return (data as OrderRow | null) ?? null
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
