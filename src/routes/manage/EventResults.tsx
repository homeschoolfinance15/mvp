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
import { Link, useParams } from 'react-router-dom'
import {
  EmptyState,
  Panel,
  SectionHeader,
  StatTile,
  formatDateTime,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { useLive } from '../../lib/live'
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

  // `quiet` for the reloads nobody asked for — see the live subscription
  // below. Replacing the figures with a spinner every time a late refund
  // settles is worse than the figures being a moment old.
  const load = useCallback(async (quiet = false) => {
    setFailed(false)
    if (!quiet) setLoading(true)

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

  // These figures keep moving after the doors close: a refund settles days
  // later, a host corrects an attendance record, a cancellation arrives. All
  // four tables feed a number on this page, and there is nothing here but
  // numbers, so nothing a reload can take away.
  useLive(
    ['event_registrations', 'event_attendance', 'event_orders', 'event_refunds'],
    () => void load(true),
  )

  if (loading) {
    return (
      <ManageShell event={event}>
        <EmptyState>Working out the figures…</EmptyState>
      </ManageShell>
    )
  }

  if (failed || !figures) {
    return (
      <ManageShell event={event}>
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

  return (
    <ManageShell event={event}>
      {/* ORG-12. Four different questions, four different numbers. Registered
          is not attended, and neither of them is sold. */}
      <SectionHeader title="People" />
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
            Nobody was checked in at this event, so there is no attendance figure. To record
            attendance by hand, use Mark attended on the guest list.
          </Explainer>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}

      <div className="mt-12">
        <SectionHeader title="Receipts" />

        {r.paidOrders === 0 ? (
          <EmptyState>Nothing charged.</EmptyState>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Tickets sold" value={r.paidOrders} />
              <StatTile label="Gross taken" value={money(r.grossCents, r.currency)} />
              <StatTile label="Stripe fees" value={money(r.feesCents, r.currency)} />
              <StatTile label="Refunded" value={money(r.refundedCents, r.currency)} />
            </div>

            <Panel className="mt-4 px-6 py-5">
              <Fact label="Net receipts">
                <span className="text-2xl font-light tracking-tight tabular-nums">
                  {money(r.netCents, r.currency)}
                </span>
              </Fact>
              {r.feesPending > 0 && (
                <p className="mt-2 text-sm text-muted">
                  Stripe has not reported its fee on {r.feesPending}{' '}
                  {r.feesPending === 1 ? 'order' : 'orders'} yet. Check again later.
                </p>
              )}
            </Panel>
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}

      {figures.refunds.length > 0 && (
        <div className="mt-12">
          <SectionHeader title="Refunds" />
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
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* FDB-09. Not a summary, not an average, not a count. Nothing. */}

      {isAdmin && (
        <div className="mt-12">
          <SectionHeader title="Feedback" />
          <Panel className="border-dashed px-6 py-5 text-sm leading-relaxed text-muted">
            <Link to={`/admin/events/${event.id}`} className="text-fg underline underline-offset-4">
              Read this event's feedback
            </Link>
          </Panel>
        </div>
      )}
    </ManageShell>
  )
}
