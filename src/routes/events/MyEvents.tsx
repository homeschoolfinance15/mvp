import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  ConfirmModal,
  EmptyState,
  LoadFailed,
  Notice,
  Panel,
  Spinner,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import {
  attendanceAndMoney,
  eventLink,
  eventWhen,
  eventWhere,
  money,
  REFUND_WORDS,
  type EventOrder,
  type EventRecord,
  type EventRefund,
  type EventRegistration,
  type OrderStatus,
  type TicketType,
} from '../../lib/events'
import { errorMessage, supabase } from '../../lib/supabase'
import { EventShell, NeedsSignIn, useLoader } from './shared'

/**
 * Everything somebody has booked. BUY-07, BUY-08, FDB-13.
 *
 * The screen exists to answer three questions without being asked: am I still
 * going, what happened to my money, and where is my ticket. BUY-08 insists the
 * first two are answered separately — cancelling a place and getting money
 * back are different events that happen at different times, and a screen that
 * merges them into one status will eventually tell somebody they have been
 * refunded when they have not.
 *
 * So attendance and money are two sentences, from attendanceAndMoney(), and
 * the word "refunded" appears only when a refund row says `completed`.
 */

/** A registration with everything hanging off it that the reader cares about. */
interface Booking extends EventRegistration {
  events: EventRecord | null
  ticket_types: TicketType | null
  event_tickets: { id: string; revoked_at: string | null }[] | null
  event_orders: (EventOrder & { event_refunds: EventRefund[] | null })[] | null
}

interface Loaded {
  bookings: Booking[]
  /** FDB-06. Which events this person actually turned up to. */
  attended: Set<string>
}

/**
 * BUY-08. What happened to the money, in words, never in a colour alone.
 * Deliberately separate from the refund words in events.ts: an order being
 * paid and a refund being complete are two different facts about one booking.
 */
const PAYMENT_WORDS: Record<OrderStatus, string> = {
  pending: 'Payment not completed',
  paid: 'Paid',
  failed: 'Payment failed',
  refunded: 'Refunded in full',
  partially_refunded: 'Partly refunded',
  cancelled: 'Payment cancelled',
}

type Bucket = 'upcoming' | 'past' | 'cancelled'

export default function MyEvents() {
  const { session, profile, loading: authLoading } = useAuth()
  const profileId = profile?.id ?? null

  const load = useCallback(async (): Promise<Loaded> => {
    if (!profileId) return { bookings: [], attended: new Set() }

    const [regs, attendance] = await Promise.all([
      supabase
        .from('event_registrations')
        .select(
          '*, events(*), ticket_types(*), event_tickets(id, revoked_at), event_orders(*, event_refunds(*))',
        )
        .eq('profile_id', profileId)
        .order('created_at', { ascending: false }),
      supabase.from('event_attendance').select('event_id').eq('profile_id', profileId),
    ])
    if (regs.error) throw regs.error
    if (attendance.error) throw attendance.error

    return {
      bookings: (regs.data as Booking[] | null) ?? [],
      attended: new Set(
        ((attendance.data as { event_id: string }[] | null) ?? []).map((a) => a.event_id),
      ),
    }
  }, [profileId])

  const { data, loading, failed, reload } = useLoader<Loaded>(load, [profileId])
  const [tab, setTab] = useState<Bucket>('upcoming')
  const [notice, setNotice] = useState('')

  if (authLoading || loading) {
    return (
      <EventShell>
        <div className="flex justify-center py-24 text-dim">
          <Spinner />
        </div>
      </EventShell>
    )
  }

  if (!session || !profile) {
    return (
      <EventShell>
        <div className="py-12">
          <NeedsSignIn what="what you have booked" to="/events/mine" />
        </div>
      </EventShell>
    )
  }

  const bookings = data?.bookings ?? []
  const now = Date.now()

  /*
   * Cancelled wins over time. A dinner that was called off last month belongs
   * with the cancellations, not filed away under things that happened —
   * because it did not happen, and there may still be money outstanding on it.
   */
  function bucketOf(b: Booking): Bucket {
    if (b.status === 'cancelled' || b.events?.status === 'cancelled') return 'cancelled'
    // QLT-08. An event we can no longer read has no date to file it under, and
    // guessing one would bury an outstanding booking in the history tab. It
    // counts as still to come, which is where an unresolved thing belongs.
    if (!b.events) return 'upcoming'
    const ends = new Date(b.events.ends_at ?? b.events.starts_at).getTime()
    return ends < now ? 'past' : 'upcoming'
  }

  const grouped: Record<Bucket, Booking[]> = {
    upcoming: bookings.filter((b) => bucketOf(b) === 'upcoming'),
    past: bookings.filter((b) => bucketOf(b) === 'past'),
    cancelled: bookings.filter((b) => bucketOf(b) === 'cancelled'),
  }
  // Soonest first for what is still to come, most recent first for what is not.
  const startsAt = (b: Booking) => new Date(b.events?.starts_at ?? 0).getTime()
  grouped.upcoming.sort((a, b) => startsAt(a) - startsAt(b))
  grouped.past.sort((a, b) => startsAt(b) - startsAt(a))
  grouped.cancelled.sort((a, b) => startsAt(b) - startsAt(a))

  const shown = grouped[tab]

  const tabs: { id: Bucket; label: string }[] = [
    { id: 'upcoming', label: 'Coming up' },
    { id: 'past', label: 'Been to' },
    { id: 'cancelled', label: 'Cancelled' },
  ]

  return (
    <EventShell>
      <header className="border-b border-line pt-2 pb-8">
        <h1 className="display text-4xl">My events</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          Everywhere you are expected, everywhere you have been, and what happened to anything you
          paid.
        </p>
      </header>

      <nav className="-mb-px flex flex-wrap gap-x-7 border-b border-line" aria-label="My events">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={t.id === tab ? 'page' : undefined}
            className={`shrink-0 border-b py-3.5 text-xs tracking-[0.14em] uppercase transition-colors ${
              t.id === tab ? 'border-fg text-fg' : 'border-transparent text-dim hover:text-muted'
            }`}
          >
            {t.label}
            <span className={`ml-2 tabular-nums ${t.id === tab ? 'text-fg' : 'text-dim'}`}>
              {grouped[t.id].length}
            </span>
          </button>
        ))}
      </nav>

      {notice && (
        <div className="pt-6">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}

      <div className="pt-8">
        {failed ? (
          <LoadFailed what="your events" onRetry={() => void reload()} />
        ) : shown.length === 0 ? (
          <EmptyState>
            {tab === 'upcoming' ? (
              <>
                You have nothing booked yet.{' '}
                <Link to="/events" className="underline underline-offset-4">
                  See what&rsquo;s coming up
                </Link>
                .
              </>
            ) : tab === 'past' ? (
              'Nothing you have been to yet.'
            ) : (
              'Nothing of yours has been cancelled.'
            )}
          </EmptyState>
        ) : (
          <ul className="space-y-5">
            {shown.map((booking) => (
              <li key={booking.id}>
                <BookingCard
                  booking={booking}
                  attended={booking.events ? (data?.attended.has(booking.events.id) ?? false) : false}
                  onChanged={async (said) => {
                    setNotice(said)
                    await reload(true)
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </EventShell>
  )
}

/* -------------------------------------------------------------------------- */
/* One booking                                                                 */
/* -------------------------------------------------------------------------- */

function BookingCard({
  booking,
  attended,
  onChanged,
}: {
  booking: Booking
  attended: boolean
  onChanged: (notice: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const event = booking.events
  /*
   * Changing ticket type before paying leaves the earlier unpaid order behind
   * (see stripe-checkout), so there can be several and the first one back is
   * not necessarily the one that took money. A settled order — paid, refunded,
   * partly refunded — is the answer whenever there is one, because that is the
   * order this booking's money lives in. `[0]` would eventually tell somebody
   * with a paid ticket that their payment was not completed.
   */
  const orders = booking.event_orders ?? []
  const order =
    orders.find((o) => o.status !== 'pending' && o.status !== 'failed') ?? orders[0] ?? null
  /* BUY-09 lets one order carry at most one live refund, but a failed attempt
     can leave an older row behind. The most recent is the true one. */
  const refunds = [...(order?.event_refunds ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )
  const refund = refunds[0] ?? null
  const ticket = booking.event_tickets?.[0] ?? null

  /*
   * A booking whose event we cannot read. It happens when an organiser pulls
   * an event back to draft: the row is still ours, the event is no longer
   * visible to us. Saying so is better than rendering a card with holes in it.
   */
  if (!event) {
    return (
      <Panel className="px-6 py-6">
        <p className="text-sm text-muted">
          One of your bookings is for an event that is no longer published. Your place is not
          affected; ask the organisers if you need the details.
        </p>
        {/*
          QLT-08 names three things that must survive an event leaving public
          view: bookings, purchases and refund information. The card cannot
          show the event, so it shows the other two — a booking that loses its
          receipt when a host clicks unpublish is the failure the rule is
          about.
        */}
        <p className="mt-3 text-sm text-fg">
          {attendanceAndMoney(booking.status, refund?.status ?? null)}
        </p>
        {order && (
          <p className="mt-1.5 text-sm text-muted">
            {PAYMENT_WORDS[order.status]} &mdash; {money(order.amount_cents, order.currency)}.
          </p>
        )}
      </Panel>
    )
  }

  const cancelled = event.status === 'cancelled'
  const finished = new Date(event.ends_at ?? event.starts_at).getTime() < Date.now()
  const where = eventWhere(event)

  /* FDB-15. Feedback opens a set time after the event ends, not the moment the
     last person leaves the room. */
  // FDB-06. An event with no end time still finished; falling back to the
  // start is what `finished` above already does, and feedback eligibility must
  // not quietly never open for the events a host left open-ended.
  const feedbackOpensAt =
    new Date(event.ends_at ?? event.starts_at).getTime() +
    event.feedback_opens_after_minutes * 60_000
  const feedbackOpen = attended && !cancelled && Date.now() >= feedbackOpensAt

  /**
   * BUY-08. Giving up a place. The RPC frees it for somebody else and revokes
   * the ticket; it does not move money, and this dialog says so rather than
   * letting somebody infer a refund from a successful cancellation.
   */
  async function cancel() {
    setBusy(true)
    setError('')
    const { error: rpcError } = await supabase.rpc('cancel_registration', {
      p_registration: booking.id,
    })
    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    setConfirming(false)
    await onChanged(
      order && order.status === 'paid'
        ? 'Your place is cancelled. Anything owed back to you is handled by the host and will show here when it happens.'
        : 'Your place is cancelled.',
    )
  }

  return (
    <Panel className="px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-fg">
            <Link to={eventLink(event.slug)} className="hover:underline hover:underline-offset-4">
              {event.title}
            </Link>
          </h2>
          <p className="mt-1.5 text-xs text-muted">{eventWhen(event)}</p>
          {where && <p className="mt-0.5 text-xs text-dim">{where}</p>}
        </div>
        {booking.ticket_types && (
          <span className="shrink-0 text-xs text-dim">{booking.ticket_types.name}</span>
        )}
      </div>

      {cancelled && (
        <div className="mt-5">
          <Notice tone="error">
            The host cancelled this event. It is not going ahead.
          </Notice>
        </div>
      )}

      {/*
        BUY-08, in the two sentences the requirement asks for. The first is
        about the place, the second about the money, and neither is allowed to
        speak for the other.
      */}
      <div className="mt-5 border-t border-line pt-5 text-sm">
        <p className="text-fg">{attendanceAndMoney(booking.status, refund?.status ?? null)}</p>

        {order && (
          <p className="mt-1.5 text-muted">
            {PAYMENT_WORDS[order.status]} &mdash; {money(order.amount_cents, order.currency)}
            {order.fee_cents ? ` including ${money(order.fee_cents, order.currency)} in fees` : ''}.
          </p>
        )}

        {/* Never "refunded" until a refund row says completed. A refund that is
            requested, processing or failed says exactly that instead. */}
        {refund && (
          <p className="mt-1.5 text-muted">
            {REFUND_WORDS[refund.status]}
            {refund.status === 'completed'
              ? `: ${money(refund.amount_cents, order?.currency ?? 'gbp')} returned to your card.`
              : refund.status === 'failed' || refund.status === 'needs_attention'
                ? '. The host has been told, and it is being looked into.'
                : `: ${money(refund.amount_cents, order?.currency ?? 'gbp')}. Money usually takes a few working days to reach a card.`}
          </p>
        )}

        {/*
          BUY-08 and BUY-09. The gap this closes: a paid booking that has been
          cancelled and for which nobody has started a refund. "Cancelled" and
          "Paid — £25.00" are both true and both silent about the question the
          reader actually has, which is whether any money is coming back.
          Saying "no refund has been started" is an accurate status; saying
          nothing is an absent one. It promises nothing — the terms are the
          host's and we are not a policy engine (§13).
        */}
        {!refund && order?.status === 'paid' && (booking.status === 'cancelled' || cancelled) && (
          <p className="mt-1.5 text-muted">
            No refund has been started yet. Anything owed back to you is the host&rsquo;s to make,
            under the terms you agreed to when you booked. It will appear here when it happens.
          </p>
        )}

        {ticket?.revoked_at && (
          <p className="mt-1.5 text-muted">
            The ticket for this booking is no longer valid for entry.
          </p>
        )}
      </div>

      {error && (
        <div className="mt-5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {/* BUY-10. A live ticket, and nothing that looks like one when it is
            revoked — the ticket screen refuses to draw a code for those. */}
        {ticket && !ticket.revoked_at && booking.status === 'confirmed' && !cancelled && (
          <Link to={`/events/tickets/${ticket.id}`}>
            <Button variant="primary" size="sm">
              {finished ? 'Your ticket' : 'Show your ticket'}
            </Button>
          </Link>
        )}

        {/* FDB-13. A way into the feedback flow, and nothing about what anyone
            said — submitted feedback never appears on an attendee's screen. */}
        {feedbackOpen && (
          <Link to={`/events/feedback/${encodeURIComponent(event.slug)}`}>
            <Button size="sm">Share your feedback</Button>
          </Link>
        )}

        {/* You can only give up a place you still hold, at an event that has
            not happened. */}
        {!finished && !cancelled && (booking.status === 'confirmed' || booking.status === 'pending') && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="ml-auto text-xs text-dim transition-colors hover:text-negative"
          >
            Cancel my place
          </button>
        )}
      </div>

      <ConfirmModal
        open={confirming}
        title={`Cancel your place at ${event.title}?`}
        confirmLabel="Cancel my place"
        busy={busy}
        error={error}
        onConfirm={() => void cancel()}
        onClose={() => setConfirming(false)}
        body={
          <>
            <p>
              Your place goes back to whoever wants it next, and your ticket stops working. You can
              book again if there is still room.
            </p>
            {order && order.status === 'paid' && (
              <>
                <p className="mt-3">
                  <strong>This does not refund you.</strong> Whether money comes back, and how much,
                  follows the host&rsquo;s terms below. If a refund is made, it will show on this
                  page &mdash; and it will not say refunded until it is.
                </p>
                <p className="mt-3 whitespace-pre-wrap text-xs text-dim">
                  {event.refund_terms ??
                    'The host has not set out cancellation terms for this event.'}
                </p>
              </>
            )}
          </>
        }
      />
    </Panel>
  )
}
