/**
 * Who is coming, who was asked, and who actually turned up.
 *
 * Three separate questions that organisers conflate, so this screen keeps
 * them apart on purpose:
 *
 *   ORG-07   a registration is somebody with a place.
 *   ORG-08B  an invitation is somebody who was asked. It confirms nothing and
 *            reserves nothing, and saying otherwise on a dashboard is how a
 *            room ends up double booked.
 *   ATT-04   a blank check-in is only a no-show if somebody was running the
 *            door. If nobody was, the blank means nothing at all.
 *   ORG-09   somebody cancelled a paid ticket and their money is still here.
 *            Nothing emails a host about that — `event-refund` is host and
 *            admin only, so an attendee cannot return their own money, and
 *            EML-01 sends the cancellation notice to the attendee alone. This
 *            screen is the only place a host ever finds out there is a
 *            decision waiting for them, so it says so at the top rather than
 *            hiding it in a column.
 *
 * ORG-08 draws the line on what a host may read: the contact details needed
 * to run the event, and not one thing more. No connector notes, no
 * questionnaire answers, no profile a host has no business in.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  ConfirmModal,
  EmptyState,
  Field,
  Initials,
  Input,
  Modal,
  Notice,
  SectionHeader,
  Select,
  StatTile,
  Textarea,
  formatDateTime,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { useLive } from '../../lib/live'
import { errorMessage, functionError, loadFailed, supabase } from '../../lib/supabase'
import {
  REFUND_WORDS,
  money,
  type EventOrder,
  type EventRefund,
  type RegistrationStatus,
} from '../../lib/events'
import { useParams } from 'react-router-dom'
import {
  MONEY_STATE_WORDS,
  attendanceLabel,
  awaitsRefundDecision,
  mayMarkAttended,
  moneyState,
  type MoneyState,
} from './rules'
import {
  Explainer,
  ManageShell,
  ManagedEventGate,
  Row,
  Rows,
  refusal,
  useManagedEvent,
  type ManagedEvent,
} from './shared'

export default function EventGuests() {
  const { id } = useParams()
  const { result, reload } = useManagedEvent(id)
  return (
    <ManagedEventGate result={result} reload={reload}>
      {(data) => <Guests key={data.event.id} data={data} />}
    </ManagedEventGate>
  )
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * ORG-08. Exactly the columns a door needs: who they are, how to reach them,
 * what they bought, and where their place and their money stand. Everything a
 * host has no business reading is absent because the view it comes from does
 * not have it, which is a stronger guarantee than this screen choosing not to
 * ask.
 */
interface Guest {
  registrationId: string
  profileId: string
  name: string
  email: string | null
  ticket: string
  status: RegistrationStatus
  order: EventOrder | null
  /** BUY-08/BUY-09. Where their money stands, separately from their place. */
  money: MoneyState
  refunds: EventRefund[]
  attendedAt: string | null
  attendanceCorrected: boolean
}

interface Invite {
  id: string
  profileId: string
  name: string
  sendStatus: 'queued' | 'sent' | 'failed'
  sentAt: string | null
  createdAt: string
  isResend: boolean
  registered: boolean
}

/** QLT-02. Every registration state in a sentence a host can act on. */
const REGISTRATION_WORDS: Record<RegistrationStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Holding a place while payment finishes',
  cancelled: 'Cancelled',
  expired: 'Expired — the hold ran out',
}

/**
 * BUY-08. What was paid is a different question from whether they are coming,
 * and on a cancelled row it is the only question left. The four money states
 * are the ones the attendee sees on their own screen, so the two can never
 * contradict each other.
 */
function paymentWords(guest: Guest): string {
  const order = guest.order
  if (!order) return 'Free place'
  const amount = money(order.amount_cents, order.currency)

  if (guest.status === 'cancelled' || guest.status === 'expired') {
    return {
      not_paid: `Nothing was charged`,
      none: `Paid ${amount} — no refund raised`,
      processing: `Paid ${amount} — refund on its way`,
      completed: `Paid ${amount} — refunded`,
      needs_attention: `Paid ${amount} — refund needs attention`,
    }[guest.money]
  }

  return {
    paid: `Paid ${amount}`,
    pending: `${amount} not completed`,
    failed: `Payment failed (${amount})`,
    refunded: `Refunded ${amount}`,
    partially_refunded: `Partly refunded from ${amount}`,
    cancelled: `Payment cancelled (${amount})`,
  }[order.status]
}

/* -------------------------------------------------------------------------- */

function Guests({ data }: { data: ManagedEvent }) {
  const { profile } = useAuth()
  const { event, tickets } = data

  const [guests, setGuests] = useState<Guest[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [problem, setProblem] = useState('')
  const [outcome, setOutcome] = useState('')
  const [inviting, setInviting] = useState(false)
  const [marking, setMarking] = useState<Guest | null>(null)
  const [refunding, setRefunding] = useState<Guest | null>(null)
  const [resending, setResending] = useState<Invite | null>(null)

  // `quiet` skips the "Loading the guest list…" swap, for the reloads nobody
  // asked for. It is the same distinction `useLoader` already draws on the
  // public screens: a reload somebody triggered should say it is working, and
  // a reload caused by a stranger registering should not take the list away
  // from the host reading it.
  const load = useCallback(async (quiet = false) => {
    setFailed(false)
    if (!quiet) setLoading(true)

    /*
     * ORG-07 and ORG-08 in one view.
     *
     * `event_guest_list` is gated on `hosts_event(event_id) or is_admin()` and
     * exposes exactly the operating list: who registered, which ticket, the
     * registration, payment and check-in states, and the email address. It
     * reads past `profiles_select`, which is what makes it the answer — that
     * policy shows a connector only their own community, so a host whose guest
     * list contains anybody from outside it used to get a name and no way to
     * reach them.
     *
     * What it leaves out is the point, and is why this screen does not go near
     * `profiles` for a guest: no connector notes, no questionnaire answers, no
     * semantic summary, no ticket codes. ORG-08 names the first two as
     * excluded and this is precisely where that leak would have happened.
     */
    const [regRes, orderRes, attendRes, inviteRes] = await Promise.all([
      supabase
        .from('event_guest_list')
        .select('*')
        .eq('event_id', event.id)
        .order('registered_at', { ascending: true }),
      supabase.from('event_orders').select('*').eq('event_id', event.id),
      supabase
        .from('event_attendance')
        .select('profile_id, recorded_at, method, corrected')
        .eq('event_id', event.id),
      supabase
        .from('event_invites')
        .select('id, profile_id, send_status, sent_at, created_at, resend_of')
        .eq('event_id', event.id)
        .order('created_at', { ascending: false }),
    ])

    if (regRes.error) {
      loadFailed(regRes.error, 'the guest list')
      setFailed(true)
      setLoading(false)
      return
    }

    const orders = (orderRes.data as EventOrder[]) ?? []

    // BUY-09. Refunds hang off orders rather than off the event, so they are
    // fetched by order. Without them a cancelled paid place cannot be told
    // apart from one that has already been put right.
    let refunds: EventRefund[] = []
    if (orders.length > 0) {
      const { data: refundRows } = await supabase
        .from('event_refunds')
        .select('*')
        .in('order_id', orders.map((o) => o.id))
      refunds = (refundRows as EventRefund[]) ?? []
    }

    const attendance = ((attendRes.data as Array<{
      profile_id: string
      recorded_at: string
      method: 'scan' | 'manual'
      corrected: boolean
    }>) ?? [])

    type RegRow = {
      registration_id: string
      profile_id: string
      full_name: string
      email: string | null
      ticket_type_id: string | null
      ticket_type_name: string | null
      registration_status: RegistrationStatus
      registered_at: string
    }
    type InviteRow = {
      id: string
      profile_id: string
      send_status: 'queued' | 'sent' | 'failed'
      sent_at: string | null
      created_at: string
      resend_of: string | null
    }

    const regRows = (regRes.data as unknown as RegRow[]) ?? []
    const inviteRows = (inviteRes.data as unknown as InviteRow[]) ?? []

    /*
     * Names for the invitations only. Everybody registered already came back
     * named by the view; an invitee has not registered, so there is no view row
     * for them. ORG-08A means every invitee is somebody in a community this
     * organiser manages, which is exactly who `profiles_select` already lets
     * them read — so this always resolves, and it can never reach further than
     * the invite list it is built from.
     */
    const inviteeIds = [...new Set(inviteRows.map((i) => i.profile_id))]
    const { data: inviteeRows } = inviteeIds.length
      ? await supabase.from('profiles').select('id, full_name').in('id', inviteeIds)
      : { data: [] }
    const invitees = new Map(
      ((inviteeRows as Array<{ id: string; full_name: string }>) ?? []).map((p) => [
        p.id,
        p.full_name,
      ]),
    )

    const rows = regRows.map((r): Guest => {
      const seen = attendance.find((a) => a.profile_id === r.profile_id)
      const order = orders.find((o) => o.registration_id === r.registration_id) ?? null
      return {
        registrationId: r.registration_id,
        profileId: r.profile_id,
        name: r.full_name,
        email: r.email,
        ticket:
          r.ticket_type_name ??
          tickets.find((t) => t.id === r.ticket_type_id)?.name ??
          'Free place',
        status: r.registration_status,
        order,
        money: moneyState(order, refunds),
        refunds: order ? refunds.filter((f) => f.order_id === order.id) : [],
        attendedAt: seen?.recorded_at ?? null,
        attendanceCorrected: seen?.corrected ?? false,
      }
    })

    setGuests(rows)
    setInvites(
      inviteRows.map((i) => ({
        id: i.id,
        profileId: i.profile_id,
        name: invitees.get(i.profile_id) ?? 'Somebody you invited',
        sendStatus: i.send_status,
        sentAt: i.sent_at,
        createdAt: i.created_at,
        isResend: Boolean(i.resend_of),
        registered: rows.some(
          (g) => g.profileId === i.profile_id && g.status !== 'cancelled' && g.status !== 'expired',
        ),
      })),
    )
    setLoading(false)
  }, [event.id, tickets])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * A host watching people arrive should not have to refresh to see them.
   * Registrations, the orders and refunds behind the money column, the door's
   * scans and the invitations all land here, so all five are watched.
   *
   * QLT-03 is why this switches off. Every modal on this page holds something
   * typed that is not saved anywhere — the refund's reason, the correction's
   * reason, the invitation's note and who was ticked — and `load` puts the
   * list back to "Loading the guest list…" while it runs. The refund one is
   * the sharp case: it is money, and it can be mid-flight. So while any of
   * them is open nothing reloads underneath it, and closing it reloads
   * immediately because the actions all call `load` themselves.
   */
  useLive(
    ['event_registrations', 'event_orders', 'event_refunds', 'event_attendance', 'event_invites'],
    () => void load(true),
    { enabled: !marking && !refunding && !resending && !inviting },
  )

  /** ATT-04. Nobody ran the door on an event with no attendance rows at all. */
  const checkInRan = guests.some((g) => g.attendedAt !== null)

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return guests.filter((g) => {
      if (needle && !`${g.name} ${g.email ?? ''}`.toLowerCase().includes(needle)) return false
      if (filter === 'confirmed') return g.status === 'confirmed'
      if (filter === 'pending') return g.status === 'pending'
      if (filter === 'cancelled') return g.status === 'cancelled' || g.status === 'expired'
      if (filter === 'attended') return g.attendedAt !== null
      if (filter === 'absent') return g.status === 'confirmed' && g.attendedAt === null
      if (filter === 'unpaid') return g.order !== null && g.order.status !== 'paid'
      if (filter === 'awaiting_refund') return awaitsRefundDecision(g.status, g.money)
      if (filter === 'refund_open') return g.money === 'processing' || g.money === 'needs_attention'
      return true
    })
  }, [guests, query, filter])

  const confirmed = guests.filter((g) => g.status === 'confirmed').length
  const attended = guests.filter((g) => g.attendedAt !== null).length

  /*
   * ORG-09. The people whose place is gone and whose money is not. This is the
   * only inbound signal a host gets about them, so it is computed here and put
   * at the top of the page rather than being something a host has to go
   * looking for with a filter they would have to know existed.
   */
  const awaiting = guests.filter((g) => awaitsRefundDecision(g.status, g.money))

  async function markAttended(guest: Guest, reason: string) {
    setProblem('')
    const { error } = await supabase.rpc('mark_attended', {
      p_event: event.id,
      p_profile: guest.profileId,
      p_reason: reason.trim() || null,
    })
    if (error) {
      setProblem(errorMessage(error))
      return
    }
    setMarking(null)
    /*
     * ATT-06 and FDB-06. Attendance is the gate on giving and receiving
     * feedback, so a correction is not only a tidier record — it puts somebody
     * back into a round they were wrongly left out of. A trigger adds them to
     * the feedback request if it has already gone out, for them alone, and
     * nobody who received it gets it twice. Worth saying, because a host who
     * does not know that will go looking for a way to do it by hand.
     */
    setOutcome(
      `${guest.name} is recorded as having attended, as a correction made by you just now — kept as a ` +
        'correction, not as a scan that never happened. They now count towards attendance, and they ' +
        'can give and receive feedback for this event like anybody else who was there.',
    )
    await load()
  }

  return (
    <ManageShell event={event} current="guests">
      {outcome && (
        <div className="mb-6">
          <Notice tone="success">{outcome}</Notice>
        </div>
      )}
      {problem && (
        <div className="mb-6">
          <Notice tone="error">{problem}</Notice>
        </div>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Confirmed places" value={confirmed} />
        <StatTile label="Checked in" value={checkInRan ? attended : '—'} />
        <StatTile label="Invitations sent" value={invites.filter((i) => i.sendStatus === 'sent').length} />
        <StatTile label="Waiting on you" value={awaiting.length} />
      </div>

      {/*
        ORG-09, BUY-08. The one thing on this page nothing will ever email a
        host about. An attendee who cancels a paid ticket loses their place
        immediately and their money does not move — `event-refund` is host and
        admin only, because the terms they agreed to are the host's to apply.
        EML-01 sends that cancellation to the attendee alone. So unless it is
        the first thing on this page, a host opening it cold a week later has
        no way of knowing somebody is waiting on them.
      */}
      {awaiting.length > 0 && (
        <div className="mb-10">
          <SectionHeader
            title="Waiting on a decision from you"
            caption="These people cancelled a place they had paid for. Their money has not moved, and nothing has told them what happens next."
          />
          <Rows>
            {awaiting.map((g) => (
              <Row key={`awaiting-${g.registrationId}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{g.name}</span>
                  <span className="block truncate text-xs text-dim">
                    {g.ticket}
                    {g.email ? ` · ${g.email}` : ''}
                  </span>
                </span>
                <span className="text-xs text-fg sm:w-52">
                  {g.order ? money(g.order.amount_cents, g.order.currency) : ''} paid, not returned
                  <span className="block text-dim">
                    {g.status === 'expired'
                      ? 'Their hold ran out after the money was taken'
                      : 'They cancelled their own place'}
                  </span>
                </span>
                <Button size="sm" onClick={() => setRefunding(g)}>
                  Refund or decide
                </Button>
              </Row>
            ))}
          </Rows>
          <div className="mt-4">
            <Explainer>
              Refunding and cancelling are separate acts, and this is the second one. Their place is
              already gone and giving the money back does not bring it back; equally, deciding not
              to refund under your terms is a legitimate answer and leaves their cancellation
              exactly as it is. Whichever you choose, the refund terms they agreed to when they
              bought are kept with their order.
            </Explainer>
          </div>
        </div>
      )}

      <SectionHeader
        title="Guest list"
        caption="Everybody who has a place, or had one. Search by name or email address."
        action={
          <Button variant="primary" size="sm" onClick={() => setInviting(true)}>
            Invite people
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="min-w-48 flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search the guest list"
          />
        </div>
        <div className="w-56">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter the guest list"
          >
            <option value="all">Everybody ({guests.length})</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Holding a place</option>
            <option value="cancelled">Cancelled or expired</option>
            <option value="unpaid">Payment outstanding</option>
            <option value="awaiting_refund">
              Cancelled, paid, no refund yet ({awaiting.length})
            </option>
            <option value="refund_open">Refund in progress or stuck</option>
            <option value="attended">Checked in</option>
            <option value="absent">Confirmed, no check-in</option>
          </Select>
        </div>
      </div>

      {!checkInRan && guests.length > 0 && (
        <div className="mb-4">
          <Explainer>
            ATT-04. Nobody has been checked in for this event, so a blank check-in here does not
            mean somebody stayed away — it means the door was never run. Marking somebody as having
            attended below records it as a correction by you, with the reason.
          </Explainer>
        </div>
      )}

      {loading ? (
        <EmptyState>Loading the guest list…</EmptyState>
      ) : failed ? (
        <EmptyState>
          We couldn't load the guest list just now.{' '}
          <button type="button" onClick={() => void load()} className="underline underline-offset-2">
            Try again
          </button>
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>
          {guests.length === 0
            ? 'Nobody has registered yet. Invitations you send appear below, and anybody who registers lands here.'
            : 'Nobody on the guest list matches that.'}
        </EmptyState>
      ) : (
        <Rows>
          {shown.map((g) => (
            <Row key={g.registrationId}>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <Initials name={g.name} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{g.name}</span>
                  <span className="block truncate text-xs text-dim">
                    {g.email ?? 'No email address on this account'}
                  </span>
                </span>
              </span>

              <span className="text-xs text-muted sm:w-40">{g.ticket}</span>
              <span className="text-xs text-muted sm:w-52">
                {REGISTRATION_WORDS[g.status]}
                <span
                  className={`block ${
                    awaitsRefundDecision(g.status, g.money)
                      ? 'text-[#8a4b00]'
                      : g.money === 'needs_attention'
                        ? 'text-negative'
                        : 'text-dim'
                  }`}
                >
                  {paymentWords(g)}
                </span>
                {g.money === 'needs_attention' &&
                  g.refunds.find((f) => f.failure_message)?.failure_message && (
                    <span className="block text-negative">
                      {g.refunds.find((f) => f.failure_message)?.failure_message}
                    </span>
                  )}
              </span>
              <span className="text-xs text-muted sm:w-44">
                {attendanceLabel(g.attendedAt !== null, checkInRan)}
                {g.attendedAt && (
                  <span className="block text-dim">
                    {formatDateTime(g.attendedAt)}
                    {g.attendanceCorrected ? ' · recorded by hand' : ''}
                  </span>
                )}
              </span>

              <span className="flex shrink-0 gap-4">
                {/*
                  ATT-06 as corrected: the question is whether this account
                  runs the event, not whether it is naming itself. Everybody
                  who reaches this screen has passed that check already — a
                  host recording their own presence is the FDB-06 case and is
                  meant to work.
                */}
                {g.attendedAt === null && mayMarkAttended(true) && (
                  <button
                    type="button"
                    onClick={() => setMarking(g)}
                    className="text-xs text-dim transition-colors hover:text-fg"
                  >
                    Mark attended
                  </button>
                )}
                {g.money !== 'not_paid' && g.money !== 'completed' && (
                  <button
                    type="button"
                    onClick={() => setRefunding(g)}
                    className="text-xs text-dim transition-colors hover:text-fg"
                  >
                    {g.money === 'none' ? 'Refund' : 'Refund status'}
                  </button>
                )}
              </span>
            </Row>
          ))}
        </Rows>
      )}

      {/* ---------------------------------------------------------------- */}

      <div className="mt-12">
        <SectionHeader
          title="Invitations"
          caption="ORG-08B. An invitation is an ask. It holds no place and confirms nothing until the person registers."
        />

        {invites.length === 0 ? (
          <EmptyState>Nobody has been invited to this event yet.</EmptyState>
        ) : (
          <Rows>
            {invites.map((i) => (
              <Row key={i.id}>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {i.name}
                  {i.isResend && <span className="ml-2 text-xs text-dim">resend</span>}
                </span>
                <span className="text-xs text-muted sm:w-44">
                  {
                    {
                      queued: 'Queued to send',
                      sent: 'Sent to the mail provider',
                      failed: 'Could not be sent',
                    }[i.sendStatus]
                  }
                  <span className="block text-dim">
                    {i.sentAt ? formatDateTime(i.sentAt) : formatDateTime(i.createdAt)}
                  </span>
                </span>
                <span className="text-xs sm:w-40">
                  {i.registered ? (
                    <span className="text-positive">Registered since</span>
                  ) : (
                    <span className="text-dim">Has not registered</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setResending(i)}
                  className="text-xs text-dim transition-colors hover:text-fg"
                >
                  Send again
                </button>
              </Row>
            ))}
          </Rows>
        )}

        <div className="mt-4">
          <Explainer>
            EML-05A. Each invitation is its own email — the people you invite never see each other's
            names or addresses. Pressing invite twice for the same person does not send two copies;
            a resend is a deliberate, separate act and is labelled as one here.
          </Explainer>
        </div>
      </div>

      <InviteModal
        open={inviting}
        eventId={event.id}
        alreadyInvited={invites.map((i) => i.profileId)}
        onClose={() => setInviting(false)}
        onDone={async (message) => {
          setInviting(false)
          setOutcome(message)
          await load()
        }}
        onProblem={setProblem}
      />

      <RefundModal
        guest={refunding}
        onClose={() => setRefunding(null)}
        onDone={async (message, failed) => {
          setRefunding(null)
          if (failed) setProblem(message)
          else setOutcome(message)
          await load()
        }}
      />

      <MarkAttendedModal
        guest={marking}
        onClose={() => setMarking(null)}
        onConfirm={(reason) => marking && void markAttended(marking, reason)}
      />

      <ConfirmModal
        open={Boolean(resending)}
        title={`Send ${resending?.name ?? 'this person'} another invitation?`}
        tone="primary"
        confirmLabel="Send again"
        body="This sends a second copy, recorded as a deliberate resend. Nobody else is emailed, and it still reserves no place."
        onConfirm={async () => {
          const target = resending
          setResending(null)
          if (!target || !profile) return
          const { error } = await supabase.from('event_invites').insert({
            event_id: event.id,
            profile_id: target.profileId,
            invited_by: profile.id,
            resend_of: target.id,
          })
          if (error) {
            setProblem(errorMessage(error))
            return
          }
          const { error: mailError } = await supabase.functions.invoke('event-email', {
            body: {
              kind: 'invite',
              event_id: event.id,
              profile_id: target.profileId,
              send_now: true,
            },
          })
          if (mailError) {
            setProblem(`The resend was recorded but not emailed: ${await functionError(mailError)}`)
          } else {
            setOutcome(`A second invitation has been sent to ${target.name}.`)
          }
          await load()
        }}
        onClose={() => setResending(null)}
      />
    </ManageShell>
  )
}

/* -------------------------------------------------------------------------- */
/* BUY-08 / BUY-09 / ORG-09 — giving the money back                            */
/* -------------------------------------------------------------------------- */

/**
 * The host's side of a cancelled paid place.
 *
 * Two things this deliberately does not do. It does not touch the
 * registration: BUY-08 keeps attendance and money apart, so refunding somebody
 * does not cancel them and cancelling somebody does not refund them, and a
 * host waiving a fee for somebody who is still coming has to be expressible.
 * And it never says "refunded" — `event-refund` hands back `processing`
 * because Stripe accepting a refund is not the same as money being back in an
 * account, and only the webhook turns one into the other.
 */
function RefundModal({
  guest,
  onClose,
  onDone,
}: {
  guest: Guest | null
  onClose: () => void
  onDone: (message: string, failed: boolean) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  if (!guest || !guest.order) return null
  const order = guest.order
  const full = money(order.amount_cents, order.currency)

  async function send() {
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('event-refund', {
      body: { order_id: order.id, reason: reason.trim() || null },
    })
    setBusy(false)
    setReason('')

    if (error) {
      const refused = await refusal(error)

      // BUY-09. Not a fault — the index caught a second attempt, which is what
      // it is there to do. Saying "failed" would send a host looking for a
      // problem that is actually the safety net working.
      if (refused.body.reason === 'refund_in_progress') {
        await onDone(
          `That refund is already in hand — ${MONEY_STATE_WORDS[
            (refused.body.status as MoneyState) ?? 'processing'
          ].toLowerCase()}. Nothing was charged or returned twice.`,
          false,
        )
        return
      }

      // QLT-09. Stripe refused. The row exists at `needs_attention` with the
      // reason, so this is findable rather than lost, and the attendee's place
      // is untouched either way.
      await onDone(
        `The refund was not taken: ${refused.message} It is recorded against this order as needing attention, and ${guest!.name}'s cancellation is unchanged.`,
        true,
      )
      return
    }

    const reply = data as { status?: string; amount_cents?: number } | null
    const amount = reply?.amount_cents
      ? money(reply.amount_cents, order.currency)
      : full
    await onDone(
      `${amount} is on its way back to ${guest!.name}. It is not counted as returned until the money actually lands, and the Results tab follows it. Their registration is unchanged.`,
      false,
    )
  }

  const settled = guest.money === 'processing' || guest.money === 'needs_attention'

  return (
    <Modal open title={`${guest.name}'s payment`} onClose={busy ? () => {} : onClose}>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-dim">They paid</dt>
          <dd className="text-fg">{full}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-dim">Their place</dt>
          <dd className="text-fg">{REGISTRATION_WORDS[guest.status]}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-dim">Their money</dt>
          <dd className="text-fg">{MONEY_STATE_WORDS[guest.money]}</dd>
        </div>
      </dl>

      {guest.refunds.length > 0 && (
        <ul className="mt-5 space-y-2 border-t border-line pt-5 text-xs text-muted">
          {guest.refunds.map((f) => (
            <li key={f.id}>
              {money(f.amount_cents, order.currency)} — {REFUND_WORDS[f.status].toLowerCase()} ·{' '}
              {formatDateTime(f.updated_at)}
              {f.failure_message && (
                <span className="block text-negative">{f.failure_message}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {settled ? (
        <>
          <p className="mt-5 text-sm leading-relaxed text-muted">
            A refund is already open against this order, so there is nothing more to start here —
            the same money is never sent back twice. Its status follows Stripe and updates itself.
          </p>
          <div className="mt-7">
            <Button className="w-full" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-5 text-sm leading-relaxed text-muted">
            Refunding returns {full} through the account that took it. It does not change their
            registration — their place is already gone and this will not bring it back. Deciding
            not to refund under your event's terms is also an answer; close this and nothing
            happens.
          </p>

          <div className="mt-5">
            <Field
              label="Reason"
              hint="Optional. Kept with the refund record, not shown to the attendee."
            >
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Cancelled eight days out, inside the full-refund window."
              />
            </Field>
          </div>

          <div className="mt-7 flex gap-3">
            <Button className="flex-1" onClick={onClose} disabled={busy}>
              Not now
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              loading={busy}
              onClick={() => void send()}
            >
              Refund {full}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* ATT-04 / ATT-06                                                             */
/* -------------------------------------------------------------------------- */

/**
 * ATT-06. A correction is signed. Who made it and when comes from the server;
 * why is the one thing only the person doing it knows, so it is asked for.
 */
function MarkAttendedModal({
  guest,
  onClose,
  onConfirm,
}: {
  guest: Guest | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <Modal
      open={Boolean(guest)}
      title={`Record ${guest?.name ?? 'this guest'} as having attended?`}
      onClose={onClose}
    >
      <p className="text-sm leading-relaxed text-muted">
        This is recorded as a correction made by you, now — not as a scan at the door. Your name,
        the time and your reason are kept with it.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        It also makes them eligible for this event's feedback. If the request has already gone out,
        they are added to it; nobody who has already received it gets a second copy.
      </p>
      <div className="mt-5">
        <Field label="Why" hint="Optional, but it is what makes the record make sense later.">
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Arrived late, after we had stopped scanning."
          />
        </Field>
      </div>
      <div className="mt-7 flex gap-3">
        <Button className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          onClick={() => {
            onConfirm(reason)
            setReason('')
          }}
        >
          Record attendance
        </Button>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* ORG-08A — inviting from a community you actually manage                     */
/* -------------------------------------------------------------------------- */

interface Candidate {
  id: string
  name: string
  profession: string | null
  community: string
}

/**
 * The people this organiser may invite, and nobody else.
 *
 * ORG-08A: an administrator invites from any community; a connector invites
 * from theirs. Somebody in another connector's community is not filtered out
 * of a longer list — they are never fetched, so there is no list to leak and
 * nothing on screen to try to select.
 */
function InviteModal({
  open,
  eventId,
  alreadyInvited,
  onClose,
  onDone,
  onProblem,
}: {
  open: boolean
  eventId: string
  alreadyInvited: string[]
  onClose: () => void
  onDone: (message: string) => Promise<void>
  onProblem: (message: string) => void
}) {
  const { profile } = useAuth()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [connectorId, setConnectorId] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !profile) return
    let active = true
    setLoading(true)

    void (async () => {
      const mine = await supabase
        .from('connectors')
        .select('id')
        .eq('profile_id', profile.id)
        .maybeSingle()
      const myConnector = (mine.data as { id: string } | null)?.id ?? null

      let links = supabase.from('connector_user_links').select('user_profile_id, connector_id')
      // A connector reads their own community. An admin reads the lot, which
      // is what "communities the admin manages" means on this platform.
      if (profile.role !== 'admin') {
        if (!myConnector) {
          if (active) {
            setCandidates([])
            setLoading(false)
          }
          return
        }
        links = links.eq('connector_id', myConnector)
      }

      const { data, error } = await links
      if (!active) return
      if (error) {
        loadFailed(error, 'the people you can invite')
        setCandidates([])
        setLoading(false)
        return
      }

      type LinkRow = { user_profile_id: string; connector_id: string }
      const rows = (data as unknown as LinkRow[]) ?? []

      // Names come in a second query for the same reason as the guest list:
      // one ambiguous embed would take the whole picker down. Row level
      // security is what keeps another connector's members out of the answer,
      // so somebody outside this organiser's reach is never even listed.
      const { data: profileRows } = rows.length
        ? await supabase
            .from('profiles')
            .select('id, full_name, current_profession')
            .in('id', [...new Set(rows.map((r) => r.user_profile_id))])
        : { data: [] }
      if (!active) return

      const named = new Map(
        (
          (profileRows as Array<{
            id: string
            full_name: string
            current_profession: string | null
          }>) ?? []
        ).map((p) => [p.id, p]),
      )

      const seen = new Set<string>()
      const people: Candidate[] = []
      for (const row of rows) {
        const person = named.get(row.user_profile_id)
        if (!person || seen.has(row.user_profile_id)) continue
        seen.add(row.user_profile_id)
        people.push({
          id: row.user_profile_id,
          name: person.full_name,
          profession: person.current_profession,
          community: row.connector_id === myConnector ? 'Your community' : 'A connector community',
        })
      }
      people.sort((a, b) => a.name.localeCompare(b.name))

      setConnectorId(myConnector)
      setCandidates(people)
      setLoading(false)
    })()

    return () => {
      active = false
    }
  }, [open, profile])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? candidates.filter((c) => c.name.toLowerCase().includes(needle)) : candidates
  }, [candidates, query])

  async function send() {
    if (!profile || chosen.length === 0) return
    setBusy(true)

    // ORG-08B. Anybody already on the list is dropped here rather than being
    // sent twice; the partial unique index in the schema says the same thing
    // and is what actually holds when two organisers press this at once.
    const fresh = chosen.filter((id) => !alreadyInvited.includes(id))
    const skipped = chosen.length - fresh.length

    if (fresh.length === 0) {
      setBusy(false)
      await onDone('Everybody you picked had already been invited, so nothing was sent again.')
      return
    }

    const { error } = await supabase.from('event_invites').insert(
      fresh.map((id) => ({
        event_id: eventId,
        profile_id: id,
        invited_by: profile.id,
        via_connector_id: connectorId,
        message: note.trim() || null,
      })),
    )

    if (error) {
      setBusy(false)
      onProblem(errorMessage(error))
      return
    }

    const { error: mailError } = await supabase.functions.invoke('event-email', {
      body: { kind: 'invite', event_id: eventId, send_now: true },
    })

    setBusy(false)
    setChosen([])
    setNote('')

    if (mailError) {
      onProblem(
        `${fresh.length} ${fresh.length === 1 ? 'invitation was' : 'invitations were'} recorded, but the emails did not go out: ${await functionError(mailError)}`,
      )
      await onDone('')
      return
    }

    await onDone(
      `${fresh.length} ${fresh.length === 1 ? 'invitation is' : 'invitations are'} on their way.` +
        (skipped > 0
          ? ` ${skipped} ${skipped === 1 ? 'person had' : 'people had'} already been invited and were not sent another copy.`
          : '') +
        ' An invitation reserves no place — they still have to register.',
    )
  }

  return (
    <Modal open={open} title="Invite people to this event" onClose={busy ? () => {} : onClose}>
      <p className="text-sm leading-relaxed text-muted">
        {profile?.role === 'admin'
          ? 'Everybody in a connector community on the platform.'
          : 'The people in your own community. Another connector’s members are not yours to invite.'}
      </p>

      <div className="mt-5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          aria-label="Search the people you can invite"
        />
      </div>

      <div className="mt-4 max-h-64 overflow-y-auto rounded-sm border border-line">
        {loading ? (
          <p className="px-4 py-6 text-center text-sm text-dim">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-dim">
            {candidates.length === 0
              ? 'There is nobody in your community to invite yet.'
              : 'Nobody matches that.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((c) => {
              const already = alreadyInvited.includes(c.id)
              return (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.id)}
                      disabled={already}
                      onChange={(e) =>
                        setChosen((ids) =>
                          e.target.checked ? [...ids, c.id] : ids.filter((i) => i !== c.id),
                        )
                      }
                      className="size-3.5 accent-gold-dim"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{c.name}</span>
                      <span className="block truncate text-xs text-dim">
                        {c.profession ?? c.community}
                      </span>
                    </span>
                    {already && <span className="text-xs text-dim">already invited</span>}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-5">
        <Field label="A line from you" hint="Optional. Goes at the top of the invitation.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      <div className="mt-7 flex gap-3">
        <Button className="flex-1" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          loading={busy}
          disabled={chosen.length === 0}
          onClick={() => void send()}
        >
          Invite {chosen.length || ''}
        </Button>
      </div>
    </Modal>
  )
}
