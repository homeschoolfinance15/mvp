/**
 * What an event actually did, in figures that do not flatter it.
 *
 * ORG-13 is the whole brief. Ticket sales are not profit — the venue, the
 * food, the staff and the wine are not in this database and never will be, so
 * the strongest word here is "receipts". Gross, fees and refunds are three
 * separate lines rather than one net figure, because an organiser reading a
 * single number reads the flattering one.
 *
 * Every figure comes from the payment records, never from today's ticket
 * prices: a price edited after somebody bought does not change what they paid.
 *
 * FDB-09 is absolute on this screen. A host who is not an administrator sees
 * no feedback — not a review, not a score, not an average, and not a count
 * that would let them work one out.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  EmptyState,
  Notice,
  Panel,
  SectionHeader,
  StatTile,
  formatDateTime,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { loadFailed, supabase } from '../../lib/supabase'
import {
  REFUND_WORDS,
  money,
  type EventOrder,
  type EventRefund,
  type RegistrationStatus,
} from '../../lib/events'
import { receipts, type Receipts } from './rules'
import {
  Explainer,
  Fact,
  ManageShell,
  ManagedEventGate,
  Row,
  Rows,
  useManagedEvent,
  type ManagedEvent,
} from './shared'

export default function EventResults() {
  const { id } = useParams()
  const { result, reload } = useManagedEvent(id)
  return (
    <ManagedEventGate result={result} reload={reload}>
      {(data) => <Results key={data.event.id} data={data} />}
    </ManagedEventGate>
  )
}

interface Figures {
  everRegistered: number
  confirmed: number
  cancelled: number
  expired: number
  attended: number
  checkInRan: boolean
  orders: EventOrder[]
  refunds: EventRefund[]
  receipts: Receipts
  /** BUY-14. Whose Stripe account the payments were actually taken on. */
  accountName: string | null
  accountIsAmazing: boolean
}

function Results({ data }: { data: ManagedEvent }) {
  const { profile } = useAuth()
  const { event } = data
  const isAdmin = profile?.role === 'admin'

  const [figures, setFigures] = useState<Figures | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    setLoading(true)

    const [regRes, attendRes, orderRes, connectorRes] = await Promise.all([
      supabase.from('event_registrations').select('status').eq('event_id', event.id),
      supabase.from('event_attendance').select('profile_id').eq('event_id', event.id),
      supabase.from('event_orders').select('*').eq('event_id', event.id),
      event.payment_connector_id
        ? supabase
            .from('connectors')
            .select('id, profile_id')
            .eq('id', event.payment_connector_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

    if (regRes.error) {
      loadFailed(regRes.error, 'this event’s results')
      setFailed(true)
      setLoading(false)
      return
    }

    const registrations = ((regRes.data as Array<{ status: RegistrationStatus }>) ?? [])
    const orders = (orderRes.data as EventOrder[]) ?? []

    // BUY-09. Refunds hang off orders, so they are fetched by order rather
    // than by event — an order refunded after the event still belongs here.
    let refunds: EventRefund[] = []
    if (orders.length > 0) {
      const { data: refundRows } = await supabase
        .from('event_refunds')
        .select('*')
        .in('order_id', orders.map((o) => o.id))
      refunds = (refundRows as EventRefund[]) ?? []
    }

    const attendance = ((attendRes.data as Array<{ profile_id: string }>) ?? [])

    // Whose account took the money, by name. A second query rather than an
    // embed, for the same reason as everywhere else on these screens.
    const connector = connectorRes.data as { profile_id: string } | null
    const { data: ownerRow } = connector
      ? await supabase.from('profiles').select('full_name').eq('id', connector.profile_id).maybeSingle()
      : { data: null }
    const owner = ownerRow as { full_name: string } | null

    setFigures({
      everRegistered: registrations.length,
      confirmed: registrations.filter((r) => r.status === 'confirmed').length,
      cancelled: registrations.filter((r) => r.status === 'cancelled').length,
      expired: registrations.filter((r) => r.status === 'expired').length,
      attended: attendance.length,
      checkInRan: attendance.length > 0,
      orders,
      refunds,
      receipts: receipts(orders, refunds, event.currency),
      accountName: owner?.full_name ?? null,
      accountIsAmazing: event.payment_connector_id === null,
    })
    setLoading(false)
  }, [event.id, event.currency, event.payment_connector_id])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <ManageShell event={event} current="results">
        <EmptyState>Working out the figures…</EmptyState>
      </ManageShell>
    )
  }

  if (failed || !figures) {
    return (
      <ManageShell event={event} current="results">
        <EmptyState>
          We couldn't load the results just now.{' '}
          <button type="button" onClick={() => void load()} className="underline underline-offset-2">
            Try again
          </button>
        </EmptyState>
      </ManageShell>
    )
  }

  const r = figures.receipts
  const finished = new Date(event.ends_at ?? event.starts_at).getTime() < Date.now()
  const pendingRefunds = figures.refunds.filter((f) => f.status !== 'completed')

  return (
    <ManageShell event={event} current="results">
      {!finished && (
        <div className="mb-6">
          <Notice tone="success">
            This event has not finished yet, so these figures are where things stand right now
            rather than a final account.
          </Notice>
        </div>
      )}

      {event.status === 'cancelled' && (
        <div className="mb-6">
          <Notice tone="error">
            This event was cancelled. What people paid is still shown below, along with whatever has
            been refunded so far — a cancelled event does not erase the money that changed hands.
          </Notice>
        </div>
      )}

      {/* ORG-12. Four different questions, four different numbers. Registered
          is not attended, and neither of them is sold. */}
      <SectionHeader title="People" caption="ORG-12. Registering, turning up and cancelling are three different things." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Registered at some point" value={figures.everRegistered} />
        <StatTile label="Confirmed places" value={figures.confirmed} />
        <StatTile label="Cancelled by the attendee" value={figures.cancelled} />
        <StatTile
          label="Checked in"
          value={figures.checkInRan ? figures.attended : 'Not run'}
        />
      </div>

      {!figures.checkInRan && figures.confirmed > 0 && (
        <div className="mt-4">
          <Explainer>
            ATT-04. Nobody was checked in at this event, so there is no attendance figure — that is
            different from nobody turning up, and this screen will not turn one into the other.
            Attendance can still be recorded by hand from the guest list.
          </Explainer>
        </div>
      )}

      {figures.expired > 0 && (
        <div className="mt-4">
          <Explainer>
            {figures.expired} {figures.expired === 1 ? 'place was' : 'places were'} held during
            checkout and released when the hold ran out. Those are not cancellations and nobody was
            charged for them.
          </Explainer>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}

      <div className="mt-12">
        <SectionHeader
          title="Receipts"
          caption="ORG-13. What was taken, what was deducted, and what came back. Read from the payment records, not from today's prices."
        />

        {r.paidOrders === 0 ? (
          <EmptyState>
            Nothing was charged for this event. Every place on it was free.
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Tickets sold" value={r.paidOrders} />
              <StatTile label="Gross taken" value={money(r.grossCents, r.currency)} />
              <StatTile label="Fees" value={money(r.feesCents, r.currency)} />
              <StatTile label="Refunded" value={money(r.refundedCents, r.currency)} />
            </div>

            <Panel className="mt-4 px-6 py-5">
              <Fact label="Net receipts">
                <span className="text-2xl font-light tracking-tight tabular-nums">
                  {money(r.netCents, r.currency)}
                </span>
                <span className="mt-2 block text-xs leading-relaxed text-muted">
                  Gross, less Stripe's fees, less the money already returned. This is what the
                  payment account received and kept — it is not profit. Nothing this event cost to
                  put on is in this database.
                </span>
              </Fact>
            </Panel>
          </>
        )}
      </div>

      {/* BUY-14. The honest answer to "what did this event make, and for whom". */}
      {r.paidOrders > 0 && (
        <div className="mt-6">
          <Panel className="border-dashed px-6 py-5">
            <div className="eyebrow">Where the money went</div>
            <p className="mt-2 text-sm leading-relaxed text-fg">
              {figures.accountIsAmazing
                ? 'These payments were taken on Amazing’s own Stripe account.'
                : `These payments were taken on ${figures.accountName ?? 'the hosting community'}’s own Stripe account, not on Amazing’s. They received the money, they paid Stripe’s fees on it, and refunds come out of their balance.`}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Each order records the account that actually took it, so a refund always goes back
              through the same account — even if this event's payment settings change later.
            </p>
          </Panel>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}

      {figures.refunds.length > 0 && (
        <div className="mt-12">
          <SectionHeader
            title="Refunds"
            caption="BUY-09. A requested refund is a promise. Only a completed one is money that has gone back."
          />
          <Rows>
            {figures.refunds.map((f) => (
              <Row key={f.id}>
                <span className="min-w-0 flex-1 text-sm text-fg">
                  {money(f.amount_cents, r.currency)}
                  {f.reason && <span className="block text-xs text-dim">{f.reason}</span>}
                </span>
                <span className="text-xs text-muted sm:w-52">
                  {REFUND_WORDS[f.status]}
                  <span className="block text-dim">{formatDateTime(f.updated_at)}</span>
                </span>
                {f.failure_message && (
                  <span className="text-xs text-negative sm:w-64">{f.failure_message}</span>
                )}
              </Row>
            ))}
          </Rows>
          {pendingRefunds.length > 0 && (
            <div className="mt-4">
              <Explainer>
                {pendingRefunds.length}{' '}
                {pendingRefunds.length === 1 ? 'refund has' : 'refunds have'} not completed yet, so
                that money is still counted as taken above. Net receipts will fall when they do.
              </Explainer>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* FDB-09. Not a summary, not an average, not a count. Nothing. */}

      <div className="mt-12">
        <SectionHeader title="Feedback" />
        <Panel className="border-dashed px-6 py-5 text-sm leading-relaxed text-muted">
          {isAdmin ? (
            <>
              Feedback about this event and between the people at it is administrator business and
              is read on the administrator's own event page. It is deliberately not shown here,
              because this screen is the one hosts open.
            </>
          ) : (
            <>
              What attendees said about this event, and what they said about each other, is not
              shown to hosts — not as reviews, not as scores, and not as an average that would let
              anybody work them out. People answer honestly because they know the person they are
              describing will never read it, and that only stays true if it is never shown.
            </>
          )}
        </Panel>
      </div>
    </ManageShell>
  )
}
