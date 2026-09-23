import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, LoadFailed, Notice, Panel, Spinner } from '../../components/ui'
import { needsOnboarding, useAuth } from '../../context/AuthProvider'
import {
  canRegister,
  eventLink,
  money,
  priceLabel,
  type EventOrder,
  type EventRegistration,
  type PublicEvent,
  type TicketType,
} from '../../lib/events'
import { useLive } from '../../lib/live'
import { rememberSignupResume } from '../../lib/signupResume'
import { errorMessage, functionError, supabase } from '../../lib/supabase'
import {
  EventShell,
  NeedsSignIn,
  StateBadge,
  WhenWhere,
  countdown,
  loadPublicEvent,
  bookingPage,
  useLoader,
  useNow,
} from './shared'

/**
 * Taking a place. BUY-01 … BUY-06, EVT-04.
 *
 * The one rule this screen exists to keep: **a refresh must never cost
 * somebody twice.** Everything below follows from it.
 *
 * - Nothing on this page decides that a payment succeeded. Only the Stripe
 *   webhook writes `paid` (CONTRACT §7), so coming back from Stripe means
 *   "go and look", never "well done". A page that congratulated somebody on
 *   the strength of a redirect would eventually congratulate somebody whose
 *   card declined.
 * - BUY-04's idempotency key is derived by stripe-checkout from the event, the
 *   person, the ticket type and the live registration id, so the same attempt
 *   always computes the same key whatever the browser does with it. The unique
 *   index on `event_orders.idempotency_key` is what actually holds, and the
 *   same string is handed to Stripe so a second create replays the first
 *   session. Nothing here needs to remember anything.
 * - Processing is a real, drawn state with its own words and its own waiting
 *   (BUY-04, QLT-09), not a spinner that resolves into optimism.
 */

/** How long we wait quietly before saying out loud that this is taking a while. */
const PATIENCE_MS = 90_000

interface Loaded {
  event: PublicEvent | null
  /** The reader's live place, if they have one. */
  // One object, not a list: event_tickets.registration_id is unique, so
  // PostgREST embeds it one-to-one.
  registration: (EventRegistration & { event_tickets: { id: string } | null }) | null
  /** Their most recent order for this event, whatever became of it. */
  order: EventOrder | null
}

export default function Checkout() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { session, profile, loading: authLoading } = useAuth()

  const profileId = profile?.id ?? null

  const load = useCallback(async (): Promise<Loaded> => {
    const event = await loadPublicEvent(slug)
    if (!event || !profileId) return { event, registration: null, order: null }

    /*
     * Both scoped to this profile explicitly. The RLS policy also lets a host
     * read their event's registrations, so a host buying a ticket to their own
     * event would otherwise pull back the entire guest list and we would show
     * them somebody else's place. QLT-05 cuts both ways.
     */
    const [reg, ord] = await Promise.all([
      supabase
        .from('event_registrations')
        .select('*, event_tickets(id)')
        .eq('event_id', event.id)
        .eq('profile_id', profileId)
        .in('status', ['pending', 'confirmed'])
        .maybeSingle(),
      supabase
        .from('event_orders')
        .select('*')
        .eq('event_id', event.id)
        .eq('profile_id', profileId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    if (reg.error) throw reg.error
    if (ord.error) throw ord.error

    return {
      event,
      registration: (reg.data as Loaded['registration']) ?? null,
      order: (ord.data as EventOrder | null) ?? null,
    }
  }, [slug, profileId])

  const { data, loading, failed, reload } = useLoader<Loaded>(load, [slug, profileId])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waitingSince, setWaitingSince] = useState<number | null>(null)

  const now = useNow(1000)

  const event = data?.event ?? null
  const registration = data?.registration ?? null
  const order = data?.order ?? null

  const types = event?.ticket_types ?? []
  const wanted = params.get('ticket')
  const chosen: TicketType | null =
    types.find((t) => t.id === wanted) ?? (types.length === 1 ? types[0] : null)

  // ATT-3. A paid order only counts for the place it paid for. Cancelling a
  // paid place leaves the order `paid` (no refund has happened), so without
  // the match they would be told they are going and could never book again.
  const paidUp =
    registration?.status === 'confirmed' ||
    (order?.status === 'paid' && order.registration_id === registration?.id)

  // ORG-04. `remaining` is composed by `attachAvailability`; `quantity` is the
  // organiser's cap and never moves, so it could never answer this.
  //
  // Only bars somebody who does not already hold the place. A pending
  // registration is a live twenty-minute hold, and the count behind
  // `remaining` includes it — so the person who took the last one would
  // otherwise be told it had sold out while they were paying for it, and
  // BUY-14's "preserve access to existing bookings" would break on the way.
  const holdsAPlace = paidUp || registration?.status === 'pending'
  const chosenSoldOut =
    !holdsAPlace &&
    chosen !== null &&
    chosen.remaining !== null &&
    chosen.remaining !== undefined &&
    chosen.remaining <= 0

  /*
   * BUY-04. A payment in flight: they have been to Stripe and we do not yet
   * know the answer. The signal is the return itself — stripe-checkout sends
   * them back to `?paid=1&session_id=…` on success and `?cancelled=1` when
   * they walk away — not the state of the rows.
   *
   * It deliberately does *not* key off `registration.status === 'pending'`. A
   * pending registration is a held place, which is the ordinary state of
   * somebody who opened the card page and changed their mind; treating it as a
   * payment in flight would show them "do not pay again" with no way to pay at
   * all, and keep showing it until the hold lapsed. The trap is that the hold
   * only lapses on the *next* attempt, which that screen gives them no way to
   * make.
   */
  const cameBack = params.has('session_id') || params.get('paid') === '1'
  const walkedAway = params.get('cancelled') === '1'
  const processing = !paidUp && cameBack && !walkedAway

  /*
   * Poll for the webhook's verdict. Quietly — a poll that blanks the page
   * every few seconds is worse than no poll — and it slows down rather than
   * stopping, because a Stripe webhook that is late is usually not lost.
   */
  useEffect(() => {
    if (!processing) {
      setWaitingSince(null)
      return
    }
    setWaitingSince((since) => since ?? Date.now())

    // The slow-down has to be decided on each tick, not once when the effect
    // runs. It used to be computed from `waitingSince`, which is set to
    // `Date.now()` by the line above and then never changes — so on the one
    // re-run that setting it caused, the elapsed time was about zero, `slow`
    // latched false, and the 10-second branch was unreachable for as long as
    // the tab stayed open. A late webhook meant a database round trip every
    // 2.5 seconds indefinitely, while the comment above promised otherwise.
    //
    // A self-rescheduling timeout rather than setInterval, because an interval
    // cannot change its own delay, and re-creating one on every tick would
    // mean tearing the effect down and rebuilding it once a second.
    const started = Date.now()
    let timer = 0
    const tick = () => {
      void reload(true)
      timer = window.setTimeout(tick, Date.now() - started > PATIENCE_MS ? 10_000 : 2500)
    }
    timer = window.setTimeout(tick, 2500)
    return () => window.clearTimeout(timer)
  }, [processing, reload])

  /*
   * The same verdict, usually sooner. The webhook writes the order and the
   * registration, so a subscriber hears about it within a moment of it
   * happening rather than up to 2.5 seconds later — and after the slow-down
   * has kicked in, up to ten.
   *
   * This accelerates the poll above; it does not replace it, and the poll is
   * deliberately left exactly as it was. A websocket drops, a phone changes
   * network on the walk back from Stripe, and the one screen in this product
   * where somebody's money has already left is not a screen to make dependent
   * on a connection staying up. Two mechanisms, either of which is sufficient.
   *
   * Nothing is lost if this fires at a bad moment: which ticket they are
   * buying is in the URL, not in state, so there is nothing typed on this page
   * to rebuild underneath them.
   */
  useLive(['event_orders', 'event_registrations'], () => void reload(true))

  if (authLoading || loading) {
    return (
      <EventShell>
        <div className="flex justify-center py-24 text-dim">
          <Spinner />
        </div>
      </EventShell>
    )
  }

  /* QLT-03. Reached without an account, or with one that lapsed on the way. */
  if (!session || !profile) {
    return (
      <EventShell>
        <div className="py-12">
          <NeedsSignIn what="this booking" to={`/events/checkout/${slug}`} />
        </div>
      </EventShell>
    )
  }

  if (failed) {
    return (
      <EventShell>
        <div className="py-12">
          <LoadFailed what="this booking" onRetry={() => void reload()} />
        </div>
      </EventShell>
    )
  }

  if (!event) {
    return (
      <EventShell>
        <div className="mx-auto max-w-md py-20 text-center">
          <h1 className="display text-3xl">We can&rsquo;t find that event</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Nothing has been charged. Ask whoever sent you the link to send it again.
          </p>
        </div>
      </EventShell>
    )
  }

  /*
   * BUY-01 and EVT-06. "Account creation and required onboarding happen before
   * registration or payment" — free and paid alike, so this sits above both
   * actions rather than beside the paid one.
   *
   * It has to be checked here. The route is deliberately unwrapped so that
   * /e/:slug and /events can be read with no session at all, which means there
   * is no RequireRole doing this for us; and `has_account()` in the checkout
   * function only asks whether a profile exists, not whether it is finished.
   *
   * Only `needsOnboarding` — the profession the product cannot work without.
   * The member questionnaire curates the network, and an event-only account
   * (ACC-01) is not in the network; gating on that would send somebody who
   * wants one dinner ticket round a loop they never signed up for.
   */
  if (needsOnboarding(profile)) {
    return (
      <EventShell back={{ to: eventLink(event.slug), label: 'Back to the event' }}>
        <div className="mx-auto max-w-2xl">
          <Panel className="px-6 py-8 sm:px-8">
            <h1 className="display text-2xl">One thing first</h1>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Finish your profile before you take a place. The host sees it on their guest list.
              Nothing has been charged, and you&rsquo;ll come straight back here afterwards.
            </p>
            <Button
              variant="primary"
              className="mt-7"
              onClick={() => {
                // ACC-07. The same resume the signup path writes, so the end of
                // onboarding lands them back on this event either way.
                rememberSignupResume({
                  path: `/events/checkout/${encodeURIComponent(event.slug)}${
                    chosen ? `?ticket=${encodeURIComponent(chosen.id)}` : ''
                  }`,
                  eventTitle: event.title,
                  priceCents: chosen?.price_cents ?? null,
                  currency: chosen?.currency ?? event.currency,
                  capacityState: event.capacity_state,
                  at: new Date().toISOString(),
                })
                navigate('/onboarding')
              }}
            >
              Finish setting up my account
            </Button>
          </Panel>
        </div>
      </EventShell>
    )
  }

  const price = chosen?.price_cents ?? 0
  // EVT-04. The fee is whatever the order says it is once there is an order;
  // before that there is nothing to add. `ponytail: the platform charges no
  // booking fee today. If one is introduced, stripe-checkout has to quote it
  // back before the redirect — do not let this line guess.`
  const fee = order?.fee_cents ?? 0
  const currency = chosen?.currency ?? event.currency
  const total = price + fee
  const free = price === 0

  const hold = countdown(registration?.hold_expires_at ?? null, now)
  const holdLapsed = Boolean(
    registration?.status === 'pending' && registration.hold_expires_at && !hold,
  )

  /**
   * BUY-02. A free place, taken through the RPC so the capacity lock in the
   * database is the thing deciding, not this screen.
   */
  async function rsvp() {
    if (!event) return
    setBusy(true)
    setError('')
    const { error: rpcError } = await supabase.rpc('register_free', {
      p_event: event.id,
      p_ticket_type: chosen?.id ?? null,
    })
    setBusy(false)
    if (rpcError) {
      // The RPC raises sentences written to be read — "This event is sold
      // out.", "You are already registered for this event." Passed through
      // unaltered; rewording them here would only make them vaguer.
      setError(errorMessage(rpcError))
      await reload(true)
      return
    }
    await reload(true)
  }

  /**
   * BUY-03. Hand off to Stripe. The edge function creates the pending
   * registration that holds the place and the order that carries the
   * idempotency key, then gives us somewhere to send them.
   */
  async function pay() {
    if (!event || !chosen) return
    setBusy(true)
    setError('')
    const { data: created, error: fnError } = await supabase.functions.invoke('stripe-checkout', {
      body: {
        event_id: event.id,
        ticket_type_id: chosen.id,
        return_url: `${window.location.origin}/events/checkout/${encodeURIComponent(event.slug)}`,
      },
    })

    if (fnError) {
      setBusy(false)
      setError(await functionError(fnError))
      // Whatever went wrong may have changed the picture — a sold-out refusal
      // means the page beneath this message is now out of date.
      await reload(true)
      return
    }

    const url = (created as { url?: string } | null)?.url
    if (!url) {
      setBusy(false)
      setError('We could not open the payment page. Nothing has been charged — please try again.')
      return
    }
    // Leaving the app entirely, so `busy` is never cleared on this path.
    window.location.assign(url)
  }

  return (
    <EventShell back={{ to: eventLink(event.slug), label: 'Back to the event' }}>
      <div className="mx-auto max-w-2xl">
        <h1 className="display text-3xl">
          {paidUp ? "You're going" : processing ? 'Completing your payment' : 'Take your place'}
        </h1>

        {/* What they are buying, always in view. EVT-04: no surprises means
            the details sit next to the money, not on the previous page. */}
        <Panel className="mt-7 px-6 py-6 sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base font-medium text-fg">{event.title}</h2>
              {event.host_names.length > 0 && (
                <p className="mt-1 text-xs text-dim">Hosted by {event.host_names.join(', ')}</p>
              )}
            </div>
            <StateBadge state={event.capacity_state} />
          </div>
          <div className="mt-6 border-t border-line pt-6">
            <WhenWhere event={event} />
          </div>
        </Panel>

        {/* Back from Stripe without paying. A neutral fact, not a failure —
            changing your mind at a card page is an ordinary thing to do, and
            the place is usually still held while they think again. */}
        {walkedAway && !paidUp && !error && (
          <div className="mt-6">
            <Notice tone="error">
              You left the payment page without paying, so nothing has been charged.
              {hold ? ` Your place is still held for ${hold}.` : ''}
            </Notice>
          </div>
        )}

        {error && (
          <div className="mt-6">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        {paidUp ? (
          <Confirmed
            event={event}
            free={free}
            ticketId={registration?.event_tickets?.id ?? null}
            page={bookingPage(event, registration)}
          />
        ) : processing ? (
          <Processing since={waitingSince} now={now} page={bookingPage(event, registration)} />
        ) : chosenSoldOut ? (
          /* ORG-04. The event can be open while this one option has gone, and
             this screen is reachable without passing the event page that would
             have said so — a bookmark, a remembered ACC-07 choice, the back
             button from Stripe, or `?ticket=` typed by hand. It used to gate
             on `capacity_state` alone, which is the *event's* answer, so an
             exhausted option still rendered an enabled "Pay £45" and the
             refusal arrived from the capacity trigger as a 500. */
          <Panel className="mt-6 px-6 py-7 sm:px-8">
            <h2 className="text-sm font-medium text-fg">This ticket has sold out</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              The last one went before you got here. You have not been charged and no place has
              been held for you.{' '}
              {types.length > 1
                ? 'Other tickets for this event may still be available.'
                : 'Places sometimes reopen when somebody cancels.'}
            </p>
          </Panel>
        ) : !canRegister(event.capacity_state) ? (
          /* BUY-05 and ORG-03A. Arriving here after it filled up, closed or
             was called off. Each says which, and each says nothing was taken. */
          <Panel className="mt-6 px-6 py-7 sm:px-8">
            <h2 className="text-sm font-medium text-fg">
              {event.capacity_state === 'sold_out'
                ? 'This event sold out before you got here'
                : event.capacity_state === 'closed'
                  ? 'Registration has closed'
                  : event.capacity_state === 'cancelled'
                    ? 'This event has been cancelled'
                    : 'This event has already happened'}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {event.capacity_state === 'sold_out'
                ? 'The last place went while you were on your way to this page. You have not been charged, and no place has been held for you. Places sometimes reopen when somebody cancels.'
                : event.capacity_state === 'closed'
                  ? 'The organisers have stopped taking new registrations for this event. You have not been charged.'
                  : event.capacity_state === 'cancelled'
                    ? 'It is not going ahead. You have not been charged.'
                    : 'You have not been charged.'}{' '}
              Pick another event under Browse.
            </p>
          </Panel>
        ) : (
          <Panel className="mt-6 px-6 py-7 sm:px-8">
            <h2 className="eyebrow">What you&rsquo;re taking</h2>

            {/* BUY-06. A place is being held, and the holding runs out. Both
                halves said plainly: the time left, and what happens after. */}
            {hold && (
              <div className="mt-4">
                <Notice tone="success">
                  Your place is held for <strong className="tabular-nums">{hold}</strong>. After
                  that it goes back to whoever wants it next, and you would need to start again.
                </Notice>
              </div>
            )}
            {holdLapsed && (
              <div className="mt-4">
                <Notice tone="error">
                  The place we were holding for you has been released &mdash; you were not charged
                  for it. You can take another one now if there is still room.
                </Notice>
              </div>
            )}

            {types.length > 1 && !chosen ? (
              <>
                <Link to={eventLink(event.slug)} className="mt-6 inline-block">
                  <Button variant="primary">Choose a ticket</Button>
                </Link>
              </>
            ) : (
              <>
                <dl className="mt-4 space-y-2.5 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">{chosen?.name ?? 'Entry'}</dt>
                    <dd className="tabular-nums text-fg">
                      {chosen ? priceLabel(chosen) : 'Free'}
                    </dd>
                  </div>
                  {/* Named even when it is nothing. "Booking fee: none" is a
                      promise; an absent line is just an absent line. */}
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Booking fee</dt>
                    <dd className="tabular-nums text-fg">
                      {fee > 0 ? money(fee, currency) : 'None'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t border-line pt-3 text-base font-medium">
                    <dt>Total</dt>
                    <dd className="tabular-nums">{free ? 'Free' : money(total, currency)}</dd>
                  </div>
                </dl>

                {!free && (
                  <p className="mt-4 text-xs leading-relaxed text-dim">
                    You will pay on Stripe. The charge appears once, for {money(total, currency)}.
                  </p>
                )}

                <div className="mt-7">
                  <Button
                    variant="primary"
                    loading={busy}
                    onClick={() => void (free ? rsvp() : pay())}
                  >
                    {free ? 'Confirm your place' : `Pay ${money(total, currency)}`}
                  </Button>
                </div>
              </>
            )}

            {/* BUY-15 and EVT-04. The terms are agreed here, where the money
                is, and a snapshot of them is kept against the registration. */}
            <div className="mt-8 border-t border-line pt-6">
              <h3 className="eyebrow">Cancellations and refunds</h3>
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                {event.refund_terms ??
                  'The host has not set out cancellation terms for this event. You can cancel your ' +
                    'place from Coming up until the event ends; anything owed back to you is handled by the host.'}
              </p>
            </div>
          </Panel>
        )}
      </div>
    </EventShell>
  )
}

/* -------------------------------------------------------------------------- */
/* Processing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * BUY-04 and QLT-09. The state between paying and knowing.
 *
 * It is drawn honestly: we say we are waiting, we say what we are waiting for,
 * and at no point do we claim the payment worked. The one instruction that
 * matters — do not pay again — is given straight away rather than after the
 * patience runs out, because somebody who has been staring at a spinner for
 * forty seconds is already reaching for the back button.
 */
function Processing({
  since,
  now,
  page,
}: {
  since: number | null
  now: number
  page: { title: string; path: string }
}) {
  const waited = since ? now - since : 0
  const slow = waited > PATIENCE_MS

  return (
    <Panel className="mt-6 px-6 py-7 sm:px-8">
      <div className="flex items-center gap-3">
        <Spinner />
        <h2 className="text-sm font-medium text-fg">
          {slow ? 'This is taking longer than usual' : 'Confirming your payment'}
        </h2>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-muted">
        {slow
          ? 'Your payment may still be going through. We have not been told the outcome yet, and we are still checking.'
          : 'We are waiting for your bank and Stripe to confirm. This usually takes a few seconds.'}
      </p>

      <p className="mt-3 text-sm leading-relaxed text-muted">
        <strong>Please do not pay again.</strong> Refreshing this page is safe, and closing it is
        safe too &mdash; your confirmation email arrives either way.
      </p>

      {slow && (
        <div className="mt-6">
          <Link to={page.path}>
            <Button variant="primary">{page.title}</Button>
          </Link>
        </div>
      )}

      {/* A live region, so somebody not watching the screen is still told when
          the wait turns into a long one. */}
      <span aria-live="polite" className="sr-only">
        {slow ? 'Payment still processing. Please do not pay again.' : 'Confirming your payment.'}
      </span>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* Done                                                                        */
/* -------------------------------------------------------------------------- */

function Confirmed({
  event,
  free,
  ticketId,
  page,
}: {
  event: PublicEvent
  free: boolean
  ticketId: string | null
  page: { title: string; path: string }
}) {
  return (
    <Panel className="mt-6 px-6 py-7 sm:px-8">
      <h2 className="text-sm font-medium text-positive">
        {free ? 'Your place is confirmed.' : 'Your payment went through and your place is confirmed.'}
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        We have emailed you the details.{event.attendee_instructions ? '' : ' Everything you need is on your ticket.'}
      </p>

      {event.attendee_instructions && (
        <p className="mt-4 rounded-[6px] border border-line bg-raised px-4 py-3.5 text-sm leading-relaxed whitespace-pre-wrap text-muted">
          {event.attendee_instructions}
        </p>
      )}

      <div className="mt-7 flex flex-wrap gap-3">
        {/* A ticket is issued by the webhook, a beat after the order is paid.
            Until it exists, sending somebody to it would be sending them to an
            empty screen, so it only appears once we can see it. */}
        {ticketId ? (
          <Link to={`/events/tickets/${ticketId}`}>
            <Button variant="primary">See your ticket</Button>
          </Link>
        ) : (
          <Link to={page.path}>
            <Button variant="primary">{page.title}</Button>
          </Link>
        )}
      </div>
    </Panel>
  )
}
