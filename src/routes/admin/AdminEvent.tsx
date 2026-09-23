import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DashboardShell } from '../../components/DashboardShell'
import {
  Button,
  EmptyState,
  Initials,
  Notice,
  Panel,
  SectionHeader,
  Spinner,
  formatDateTime,
} from '../../components/ui'
import { loadFailed, supabase } from '../../lib/supabase'
import {
  CAPACITY_WORDS,
  REFUND_WORDS,
  eventWhen,
  eventWhere,
  money,
  priceLabel,
  type EventAttendance,
  type EventInvite,
  type EventMessage,
  type EventMessageRecipient,
  type EventOrder,
  type EventRecord,
  type EventRefund,
  type EventRegistration,
  type EventReminder,
  type EventTicket,
  type FeedbackQuestion,
  type FeedbackOutcome,
  type TicketType,
} from '../../lib/events'
import type { Profile } from '../../lib/types'
import { EventStatusBadge, Explainer, Fact } from '../manage/shared'
import { reminderLabel } from '../manage/rules'

/**
 * One event's complete operational record, for an administrator. ORG-14.
 *
 * The requirement is a sentence about hunting: an admin looking into an event
 * should not have to sign in as somebody else, or open six screens, to answer
 * an ordinary question about it. So everything the platform holds about this
 * event is on this page — details, hosts, registrations, attendance, ticket
 * types, payments, fees, refunds, cancellations, tickets, check-ins, emails
 * and every piece of feedback — and it is read-only. This is the record, not
 * a second organiser console; changes are made where they are made.
 *
 * ORG-15. Event records are platform data. An administrator reads them because
 * they administer the platform, not because the events belong to their
 * account, and nothing here is framed as "my events".
 *
 * Two things this page is careful about:
 *
 * **Whose money.** BUY-14 and §7.2. A connector's event is charged on the
 * connector's own Stripe account. `event_orders.stripe_account_id` records
 * which account actually took *that* payment and is never recomputed, because
 * the event's answer can change afterwards — a connector can lose hosting
 * permission or disconnect Stripe long after tickets were sold. So this page
 * shows the frozen answer per order, which is the only one that can settle
 * "whose money was this".
 *
 * **Feedback.** FDB-09, FDB-11, FDB-13: an administrator reads every review on
 * every event, including reviews about themselves when they hosted or
 * attended. The database says so too — feedback is admin-only on select. What
 * this screen must not do is imply otherwise, or turn feedback into something
 * it is not. Peer feedback is one author's observation of one subject at one
 * event, shown with the question as it was asked; it is never mirrored into
 * the subject's opinion of the author, and never totalled into a score for a
 * person. Event feedback is about the event (FDB-10), shown with the hosting
 * team as context rather than converted into a rating of any host.
 *
 * ponytail: every table is read in one pass and nothing paginates. An event
 * has an audience, not a population. Add ranges if one ever sells thousands.
 */

/* -------------------------------------------------------------------------- */
/* Rows this screen needs that the shared vocabulary does not carry yet        */
/* -------------------------------------------------------------------------- */

/** §7.2. Set when the first paid order exists; after that the recipient is frozen. */
interface EventRow extends EventRecord {
  payment_locked_at: string | null
}

interface PeerFeedbackRow {
  id: string
  event_id: string
  author_id: string
  subject_id: string
  question_id: string
  answer_text: string | null
  answer_choice: string | null
  submitted_at: string
}

interface EventFeedbackRow {
  id: string
  event_id: string
  author_id: string
  question_id: string
  answer_scale: number | null
  answer_text: string | null
  submitted_at: string
}

interface FeedbackSubjectRow {
  event_id: string
  author_id: string
  subject_id: string
  outcome: FeedbackOutcome
}

interface ConnectorRow {
  id: string
  profile_id: string
  stripe_account_id: string | null
}

/**
 * What one query came back with.
 *
 * Several of these tables land in later migrations than the one this screen
 * was written against, and a section that cannot load must not take the rest
 * of the record down with it — an admin asking about a payment should still
 * get the payment when the feedback tables are not there yet.
 */
interface Loaded<T> {
  rows: T[]
  failed: boolean
}

function took<T>(
  result: { data: unknown; error: unknown },
  what: string,
): Loaded<T> {
  if (result.error) {
    loadFailed(result.error, what)
    return { rows: [], failed: true }
  }
  return { rows: ((result.data as T[]) ?? []), failed: false }
}

interface Record_ {
  event: EventRow | null
  hosts: Loaded<{ profile_id: string }>
  types: Loaded<TicketType>
  registrations: Loaded<EventRegistration>
  orders: Loaded<EventOrder>
  refunds: Loaded<EventRefund>
  tickets: Loaded<EventTicket>
  attendance: Loaded<EventAttendance>
  invites: Loaded<EventInvite>
  questions: Loaded<FeedbackQuestion>
  peer: Loaded<PeerFeedbackRow>
  eventFeedback: Loaded<EventFeedbackRow>
  subjects: Loaded<FeedbackSubjectRow>
  emailSettings: { reminders_enabled: boolean; updated_by: string | null; updated_at: string } | null
  emailSettingsFailed: boolean
  reminders: Loaded<EventReminder>
  messages: Loaded<EventMessage>
  recipients: Loaded<EventMessageRecipient>
  people: Record<string, Profile>
  connectors: Record<string, ConnectorRow>
}

async function loadRecord(id: string): Promise<Record_> {
  const [
    eventRes,
    hostsRes,
    typesRes,
    regsRes,
    ordersRes,
    ticketsRes,
    attendanceRes,
    invitesRes,
    questionsRes,
    peerRes,
    feedbackRes,
    subjectsRes,
    settingsRes,
    remindersRes,
    messagesRes,
    peopleRes,
    connectorsRes,
  ] = await Promise.all([
    supabase.from('events').select('*').eq('id', id).maybeSingle(),
    supabase.from('event_hosts').select('profile_id').eq('event_id', id),
    supabase.from('ticket_types').select('*').eq('event_id', id).order('position'),
    supabase.from('event_registrations').select('*').eq('event_id', id).order('created_at'),
    supabase.from('event_orders').select('*').eq('event_id', id).order('created_at'),
    supabase.from('event_tickets').select('*').eq('event_id', id).order('created_at'),
    supabase.from('event_attendance').select('*').eq('event_id', id).order('recorded_at'),
    supabase.from('event_invites').select('*').eq('event_id', id).order('created_at'),
    supabase.from('feedback_questions').select('*').order('scope').order('slot'),
    supabase.from('peer_feedback').select('*').eq('event_id', id).order('submitted_at'),
    supabase.from('event_feedback').select('*').eq('event_id', id).order('submitted_at'),
    supabase.from('feedback_subjects').select('*').eq('event_id', id),
    supabase.from('event_email_settings').select('*').eq('event_id', id).maybeSingle(),
    supabase.from('event_reminders').select('*').eq('event_id', id).order('minutes_before'),
    supabase
      .from('event_messages')
      .select('*')
      .eq('event_id', id)
      .order('created_at', { ascending: false }),
    supabase.from('profiles').select('*'),
    supabase.from('connectors').select('id, profile_id, stripe_account_id'),
  ])

  const orders = took<EventOrder>(ordersRes, 'the payments for this event')
  const messages = took<EventMessage>(messagesRes, 'the messages for this event')

  // Refunds hang off orders and recipients hang off messages, so neither can
  // be asked for until the first round has come back.
  const [refundsRes, recipientsRes] = await Promise.all([
    orders.rows.length
      ? supabase
          .from('event_refunds')
          .select('*')
          .in('order_id', orders.rows.map((o) => o.id))
          .order('created_at')
      : Promise.resolve({ data: [], error: null }),
    messages.rows.length
      ? supabase
          .from('event_message_recipients')
          .select('*')
          .in('message_id', messages.rows.map((m) => m.id))
      : Promise.resolve({ data: [], error: null }),
  ])

  const people = took<Profile>(peopleRes, 'the people on this event')
  const connectors = took<ConnectorRow>(connectorsRes, 'the connectors')

  return {
    event: (eventRes.data as EventRow) ?? null,
    hosts: took(hostsRes, 'the hosts of this event'),
    types: took(typesRes, 'the ticket types'),
    registrations: took(regsRes, 'the registrations'),
    orders,
    refunds: took(refundsRes, 'the refunds'),
    tickets: took(ticketsRes, 'the tickets'),
    attendance: took(attendanceRes, 'the check-ins'),
    invites: took(invitesRes, 'the invitations'),
    questions: took(questionsRes, 'the feedback questions'),
    peer: took(peerRes, 'the peer feedback'),
    eventFeedback: took(feedbackRes, 'the feedback on this event'),
    subjects: took(subjectsRes, 'who was asked for feedback'),
    emailSettings: (settingsRes.data as Record_['emailSettings']) ?? null,
    emailSettingsFailed: Boolean(settingsRes.error),
    reminders: took(remindersRes, 'the reminders'),
    messages,
    recipients: took(recipientsRes, 'the message recipients'),
    people: Object.fromEntries(people.rows.map((p) => [p.id, p])),
    connectors: Object.fromEntries(connectors.rows.map((c) => [c.id, c])),
  }
}

/* -------------------------------------------------------------------------- */
/* Furniture                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A section of the record, with the three answers it can give: here it is,
 * there is none of it, or we could not read it.
 *
 * The third one is loud on purpose, and that is a departure from `LoadFailed`
 * in ui.tsx, which is deliberately quiet because "a person who cannot fix a
 * schema cache should not be shown one". An administrator is the person who
 * can. More to the point, this is the screen ORG-14 exists for: the whole
 * requirement is that the record an admin sees here is *complete*, and a read
 * that failed silently — a policy that stopped matching, a query that broke,
 * a table not yet migrated — would render as a calm "no payments yet" and be
 * believed. Somebody investigating a dispute would draw the wrong conclusion
 * from a screen that looked fine.
 *
 * So a failure is a red notice that names the section, says it is not the
 * same as there being none, and offers to read it again. An absence is the
 * ordinary quiet empty state. They never look alike.
 */
function Section({
  title,
  caption,
  loaded,
  count,
  empty,
  onRetry,
  children,
}: {
  title: string
  caption?: string
  loaded: { failed: boolean }
  count: number
  empty: string
  onRetry: () => void
  children: ReactNode
}) {
  return (
    <section className="mt-14">
      <SectionHeader title={title} caption={caption} />
      {loaded.failed ? (
        <Notice tone="error">
          This part didn&rsquo;t load. Try again.
          <span className="mt-3 block">
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </span>
        </Notice>
      ) : count === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        children
      )}
    </section>
  )
}

/**
 * QLT-09. What an administrator has to be able to *find* before they can fix
 * it: a payment that never confirmed, a ticket that was never issued, a refund
 * that failed, a message that did not go out.
 *
 * "A purchase should not become untraceable because one step failed" is the
 * requirement, and the way a purchase becomes untraceable is by falling
 * between two steps where nobody is looking. Everything here is derived from
 * rows already on this page — nothing is fetched again — so the cost of
 * looking is nil and the admin does not have to know to check.
 *
 * Finding only. Retrying a message, reissuing a ticket and re-attempting a
 * refund live on the screens that own those actions.
 */
function needsAttention(record: Record_): string[] {
  const ticketed = new Set(record.tickets.rows.map((t) => t.registration_id))
  const said: string[] = []

  const some = (n: number, one: string, many: string) =>
    n === 1 ? `1 ${one}` : `${n} ${many}`

  const untickected = record.registrations.rows.filter(
    (r) => r.status === 'confirmed' && !ticketed.has(r.id),
  ).length
  if (untickected) {
    said.push(
      `${some(untickected, 'confirmed place has', 'confirmed places have')} no ticket issued. ` +
        'Those people cannot get through the door until one is.',
    )
  }

  const pending = record.orders.rows.filter((o) => o.status === 'pending').length
  if (pending) {
    said.push(
      `${some(pending, 'payment is', 'payments are')} still unconfirmed. Stripe may not have ` +
        'reached the webhook, so the money may have left the buyer without a place being held.',
    )
  }

  const failedOrders = record.orders.rows.filter((o) => o.status === 'failed').length
  if (failedOrders) {
    said.push(`${some(failedOrders, 'payment', 'payments')} failed outright.`)
  }

  const badRefunds = record.refunds.rows.filter(
    (r) => r.status === 'failed' || r.status === 'needs_attention',
  ).length
  if (badRefunds) {
    said.push(
      `${some(badRefunds, 'refund needs', 'refunds need')} attention. Somebody is owed money ` +
        'that has not reached them.',
    )
  }

  const failedMessages = record.messages.rows.filter((m) => m.status === 'failed').length
  const failedRecipients = record.recipients.rows.filter((r) => r.status === 'failed').length
  if (failedMessages || failedRecipients) {
    said.push(
      `${some(failedMessages || failedRecipients, 'message', 'messages')} failed to send. ` +
        'A failed email never costs somebody their ticket — it is still in their account — ' +
        'but they have not been told what it said.',
    )
  }

  return said
}

/** One line in a list. The divided-panel idiom the dashboards already use. */
function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3.5 text-sm">
      {children}
    </div>
  )
}

function Who({ id, people }: { id: string | null; people: Record<string, Profile> }) {
  if (!id) return <span className="text-dim">nobody</span>
  const person = people[id]
  if (!person) return <span className="text-dim">an account not on file</span>
  return <span className="text-fg">{person.full_name}</span>
}

/**
 * What to call the person on a record when the person may be gone.
 *
 * Closing an account nulls the payer on a completed order and the person on an
 * attendance row rather than taking the row with it. The row survives because
 * it has to: a completed order is what an event's reported ticket sales are
 * counted from (ORG-13), and if it vanished, February's revenue would quietly
 * change when somebody closed their account in March. Same for an arrival —
 * they were in the room, and erasing the person should not un-hold the door.
 *
 * So there are three different facts here, and they must not look alike:
 *
 *   a name            the person, as normal
 *   since closed      the record is complete; the person was deliberately
 *                     erased. Nothing is wrong and nothing is missing.
 *   not on file       an id that resolves to nobody, which we cannot explain.
 *                     Rare, and worth noticing rather than smoothing over.
 *
 * None of the three is the section-level "could not be read" state, which is a
 * failure to read the record rather than a fact about it.
 */
function personName(id: string | null, people: Record<string, Profile>): string {
  if (id === null) return 'An account since closed'
  return people[id]?.full_name ?? 'An account not on file'
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                  */
/* -------------------------------------------------------------------------- */

export default function AdminEvent() {
  const { id = '' } = useParams()
  const [record, setRecord] = useState<Record_ | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setRecord(await loadRecord(id))
    } catch (err) {
      loadFailed(err, 'this event')
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const event = record?.event ?? null

  const confirmed = useMemo(
    () => record?.registrations.rows.filter((r) => r.status === 'confirmed').length ?? 0,
    [record],
  )

  if (loading) {
    return (
      <DashboardShell title="Event record">
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      </DashboardShell>
    )
  }

  if (failed || !record || !event) {
    return (
      <DashboardShell title="Event record">
        <EmptyState>
          {failed ? 'We could not load this event just now.' : 'No event at this address.'}
        </EmptyState>
        <div className="mt-6 flex gap-3">
          {failed ? (
            <Button onClick={() => void load()}>Try again</Button>
          ) : (
            <Link
              to="/admin/events"
              className="text-xs text-dim underline-offset-4 hover:text-fg hover:underline"
            >
              &larr; Events
            </Link>
          )}
        </div>
      </DashboardShell>
    )
  }

  const { people, connectors } = record
  const refundsByOrder = new Map<string, EventRefund[]>()
  for (const refund of record.refunds.rows) {
    refundsByOrder.set(refund.order_id, [...(refundsByOrder.get(refund.order_id) ?? []), refund])
  }
  const attention = needsAttention(record)
  const attendanceByProfile = new Map(
    record.attendance.rows
      .filter((a) => a.profile_id !== null)
      .map((a) => [a.profile_id as string, a]),
  )
  // Registrations cascade when an account closes; attendance does not. Those
  // arrivals have no row left to sit under, and dropping them silently would
  // make this page under-report who was actually in the room.
  const erasedArrivals = record.attendance.rows.filter((a) => a.profile_id === null).length
  const typeById = new Map(record.types.rows.map((t) => [t.id, t]))
  const questionById = new Map(record.questions.rows.map((q) => [q.id, q]))

  // §7.0. The creator owns the money. Cohosts are hosts, not recipients.
  const paymentConnector = event.payment_connector_id
    ? connectors[event.payment_connector_id]
    : null

  return (
    <DashboardShell title={event.title}>
      <div className="flex flex-wrap items-center gap-4">
        <Link
          to="/admin/events"
          className="text-xs text-dim underline-offset-4 hover:text-fg hover:underline"
        >
          &larr; Events
        </Link>
        <EventStatusBadge event={event} />
        {/* ORG-14 says this page is where an administrator sees everything
            without hunting; it did not follow that it should be a dead end.
            The caption promises "read-only: not a second place to change it",
            and that is only a kindness if there is a first place to go — until
            this link there was none, and the way to edit an event you had just
            opened was to type its other address. */}
        <Link
          to={`/manage/events/${event.id}`}
          className="text-xs text-gold underline-offset-4 hover:underline"
        >
          Manage this event
        </Link>
        <a
          href={`/e/${encodeURIComponent(event.slug)}`}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-gold underline-offset-4 hover:underline"
        >
          Open the public page
        </a>
      </div>

      {/*
        ORG-15 and §9's "Administrator view versus information storage". The
        dashboard is a window onto records Amazing holds centrally; it is not
        where they live and it is not a personal account that owns everybody's
        history. Saying so matters because the opposite reading has
        consequences — it is what makes somebody believe that replacing an
        administrator loses the history, or that a registration is not really
        recorded until an admin has looked at it.
      */}

      {/*
        QLT-09. Anything that fell between two steps, at the top, where it is
        seen without knowing to look for it.
      */}
      {attention.length > 0 && (
        <div className="mt-6">
          <Notice tone="error">
            <strong>Needs attention</strong>
            <ul className="mt-2 space-y-1.5">
              {attention.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {/* ORG-14. Details and status first: the questions asked most often. */}
      <section className="mt-8">
        <Panel className="px-6 py-6">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="When">{eventWhen(event)}</Fact>
            <Fact label="Where">{eventWhere(event) ?? 'Not given'}</Fact>
            <Fact label="Timezone">{event.timezone}</Fact>
            <Fact label="Capacity">
              {event.capacity === null
                ? `No limit · ${confirmed} confirmed`
                : `${confirmed} of ${event.capacity} confirmed`}
            </Fact>
            <Fact label="Registration">
              {event.registration_closed
                ? CAPACITY_WORDS.closed
                : event.status === 'cancelled'
                  ? CAPACITY_WORDS.cancelled
                  : CAPACITY_WORDS.open}
            </Fact>
            <Fact label="Currency">{event.currency.toUpperCase()}</Fact>
            <Fact label="Public link">/e/{event.slug}</Fact>
            <Fact label="Created">{formatDateTime(event.created_at)}</Fact>
            <Fact label="Published">
              {event.published_at ? formatDateTime(event.published_at) : 'Never published'}
            </Fact>
            <Fact label="Feedback opens">
              {event.feedback_opens_after_minutes} minutes after it ends
            </Fact>
          </div>

          {/* ORG-14 lists cancellations among the things an admin must be able
              to see here, and a cancellation is the single most consequential
              thing that can have happened to an event. */}
          {event.cancelled_at && (
            <div className="mt-6">
              <Notice tone="error">
                <strong>Cancelled {formatDateTime(event.cancelled_at)}</strong> by{' '}
                {personName(event.cancelled_by, people)}.
              </Notice>
            </div>
          )}

          {(event.description || event.attendee_instructions || event.refund_terms) && (
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              {event.description && (
                <Fact label="Description">
                  <span className="whitespace-pre-wrap">{event.description}</span>
                </Fact>
              )}
              {event.attendee_instructions && (
                <Fact label="Attendee instructions">
                  <span className="whitespace-pre-wrap">{event.attendee_instructions}</span>
                </Fact>
              )}
              {event.refund_terms && (
                <Fact label="Refund terms">
                  <span className="whitespace-pre-wrap">{event.refund_terms}</span>
                </Fact>
              )}
            </div>
          )}
        </Panel>
      </section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Hosts"
        loaded={record.hosts}
        count={record.hosts.rows.length + 1}
        onRetry={() => void load()}
        empty="No hosts recorded."
      >
        <Panel className="divide-y divide-line">
          <Row>
            <Initials name={people[event.host_id]?.full_name ?? '?'} role={people[event.host_id]?.role} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-fg">
                {personName(event.host_id, people)}
              </span>
              <span className="block truncate text-xs text-dim">
                Creator
              </span>
            </span>
          </Row>
          {record.hosts.rows
            .filter((h) => h.profile_id !== event.host_id)
            .map((host) => (
              <Row key={host.profile_id}>
                <Initials
                  name={people[host.profile_id]?.full_name ?? '?'}
                  role={people[host.profile_id]?.role}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {personName(host.profile_id, people)}
                  </span>
                  <span className="block truncate text-xs text-dim">
                    Cohost
                  </span>
                </span>
              </Row>
            ))}
        </Panel>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-14">
        <SectionHeader title="Where the money goes" />
        <Panel className="px-6 py-5">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Paid to">
              {event.payment_connector_id ? (
                <>
                  {people[paymentConnector?.profile_id ?? '']?.full_name ??
                    'a connector'}
                  <span className="text-dim"> (connector)</span>
                </>
              ) : (
                <>
                  Amazing&rsquo;s own Stripe account
                  <span className="text-dim"> (a platform event)</span>
                </>
              )}
            </Fact>
            <Fact label="Recipient account">
              <Who id={event.payment_recipient_id} people={people} />
            </Fact>
            <Fact label="Stripe account">
              {event.payment_connector_id
                ? (paymentConnector?.stripe_account_id ?? 'Not connected')
                : 'The platform account'}
            </Fact>
            <Fact label="Recipient locked">
              {event.payment_locked_at
                ? `Yes, since ${formatDateTime(event.payment_locked_at)}`
                : 'No paid order yet'}
            </Fact>
          </div>
        </Panel>
      </section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Ticket types"
        loaded={record.types}
        count={record.types.rows.length}
        onRetry={() => void load()}
        empty="No ticket types."
      >
        <Panel className="divide-y divide-line">
          {record.types.rows.map((type) => (
            <Row key={type.id}>
              <span className="min-w-0 flex-1 truncate font-medium text-fg">{type.name}</span>
              <span className="tabular-nums text-muted">{priceLabel(type)}</span>
              <span className="text-xs text-dim">
                {type.quantity === null ? 'no separate cap' : `cap ${type.quantity}`}
              </span>
              <span className="text-xs text-dim">{type.is_active ? 'on sale' : 'withdrawn'}</span>
            </Row>
          ))}
        </Panel>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Registrations and attendance"
        loaded={record.registrations}
        count={record.registrations.rows.length}
        onRetry={() => void load()}
        empty="Nobody has registered."
      >
        <Panel className="divide-y divide-line">
          {record.registrations.rows.map((reg) => {
            const arrived = attendanceByProfile.get(reg.profile_id)
            return (
              <Row key={reg.id}>
                <Initials
                  name={people[reg.profile_id]?.full_name ?? '?'}
                  role={people[reg.profile_id]?.role}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {personName(reg.profile_id, people)}
                  </span>
                  <span className="block truncate text-xs text-dim">
                    {typeById.get(reg.ticket_type_id ?? '')?.name ?? 'No ticket type'}
                    {reg.cancelled_at && (
                      <>
                        {' '}
                        &middot; cancelled {formatDateTime(reg.cancelled_at)} by{' '}
                        {reg.cancelled_by
                          ? personName(reg.cancelled_by, people)
                          : 'the system'}
                      </>
                    )}
                  </span>
                </span>
                <span className="text-xs text-muted">{reg.status}</span>
                <span className="text-xs text-dim">
                  {/* ATT-06. A correction is shown as a correction. We never
                      dress one up as a scan that did not happen. */}
                  {record.attendance.failed
                    ? 'check-in unavailable'
                    : arrived
                      ? `${arrived.method === 'scan' ? 'Scanned' : 'Marked present'}${arrived.corrected ? ' (corrected)' : ''} ${formatDateTime(arrived.recorded_at)}`
                      : 'no check-in'}
                </span>
              </Row>
            )
          })}
        </Panel>

        {/*
          §9's attendance row: "who actually arrived". Registrations cascade
          when an account closes and attendance does not, so these arrivals have
          no row left to sit under. Counting them here is the same principle as
          keeping the completed order: the headcount for a night that already
          happened must not fall because somebody closed their account later.
        */}
        {erasedArrivals > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-dim">
            {erasedArrivals === 1
              ? 'One more arrival, from a closed account.'
              : `${erasedArrivals} more arrivals, from closed accounts.`}
          </p>
        )}
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Payments, fees and refunds"
        loaded={record.orders}
        count={record.orders.rows.length}
        onRetry={() => void load()}
        empty="No orders."
      >
        <Panel className="divide-y divide-line">
          {record.orders.rows.map((order) => {
            const refunds = refundsByOrder.get(order.id) ?? []
            return (
              <div key={order.id} className="px-5 py-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {/*
                    The payer may be gone. Everything that answers "whose money
                    was this and what happened to it" is not: the amount, the
                    currency, the Stripe account that took it, the date, and
                    every refund, which hangs off the order rather than off the
                    person. So the row stays fully legible and only the name
                    changes — a blank cell here would read as missing data on
                    the one screen where that conclusion is most expensive.
                  */}
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      order.profile_id === null ? 'text-dim italic' : 'text-fg'
                    }`}
                  >
                    {personName(order.profile_id, people)}
                  </span>
                  <span className="tabular-nums text-fg">
                    {money(order.amount_cents, order.currency)}
                  </span>
                  <span className="text-xs text-dim tabular-nums">
                    fees {order.fee_cents === null ? 'unknown' : money(order.fee_cents, order.currency)}
                  </span>
                  <span className="text-xs text-muted">{order.status}</span>
                  <span className="text-xs text-dim">
                    {order.paid_at ? formatDateTime(order.paid_at) : 'not paid'}
                  </span>
                </div>

                {/*
                  BUY-14 and §7.2. "Whose money was this" has exactly one
                  correct answer per order, and it is this column — written at
                  checkout and never recomputed, because the event's answer can
                  change afterwards and a refund has to go back the way it came.
                */}
                <div className="mt-1.5 text-xs text-dim">
                  Taken by{' '}
                  <span className="text-muted">
                    {order.stripe_account_id
                      ? `Stripe account ${order.stripe_account_id}`
                      : "Amazing's own Stripe account"}
                  </span>
                  {order.stripe_payment_intent_id && (
                    <> &middot; payment {order.stripe_payment_intent_id}</>
                  )}
                </div>

                {refunds.length > 0 && (
                  <ul className="mt-2.5 space-y-1 border-l border-line pl-4">
                    {refunds.map((refund) => (
                      <li key={refund.id} className="text-xs text-muted">
                        {REFUND_WORDS[refund.status]} &middot;{' '}
                        <span className="tabular-nums">
                          {money(refund.amount_cents, order.currency)}
                        </span>{' '}
                        &middot; requested by{' '}
                        {people[refund.requested_by ?? '']?.full_name ?? 'the system'} &middot;{' '}
                        {formatDateTime(refund.created_at)}
                        {refund.reason && <> &middot; {refund.reason}</>}
                        {refund.failure_message && (
                          <span className="text-negative"> &middot; {refund.failure_message}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </Panel>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Tickets and check-in"
        loaded={record.tickets}
        count={record.tickets.rows.length}
        onRetry={() => void load()}
        empty="No tickets issued."
      >
        <Panel className="divide-y divide-line">
          {record.tickets.rows.map((ticket) => (
            <Row key={ticket.id}>
              <span className="min-w-0 flex-1 truncate text-fg">
                {personName(ticket.profile_id, people)}
              </span>
              {/* QLT-05. The code is the credential — anyone holding it holds
                  the ticket. An administrator may read it, but nothing here
                  needs the whole thing on screen to identify a row. */}
              <code className="code-chip rounded-sm px-2.5 py-1 text-xs">
                {ticket.code.slice(0, 8)}…
              </code>
              <span className="text-xs text-dim">
                {ticket.revoked_at
                  ? `revoked ${formatDateTime(ticket.revoked_at)}`
                  : attendanceByProfile.has(ticket.profile_id)
                    ? 'used'
                    : 'valid'}
              </span>
            </Row>
          ))}
        </Panel>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Invitations"
        loaded={record.invites}
        count={record.invites.rows.length}
        onRetry={() => void load()}
        empty="Nobody has been invited directly."
      >
        <Panel className="divide-y divide-line">
          {record.invites.rows.map((invite) => (
            <Row key={invite.id}>
              <span className="min-w-0 flex-1 truncate text-fg">
                {personName(invite.profile_id, people)}
              </span>
              <span className="text-xs text-dim">
                by {people[invite.invited_by]?.full_name ?? 'a removed account'}
                {invite.via_connector_id && (
                  <>
                    {' '}
                    via{' '}
                    {people[connectors[invite.via_connector_id]?.profile_id ?? '']?.full_name ??
                      'a connector'}
                  </>
                )}
                {invite.resend_of && ' · resend'}
              </span>
              <span className="text-xs text-muted">{invite.send_status}</span>
            </Row>
          ))}
        </Panel>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-14">
        <SectionHeader
          title="Email"
        />
        {record.emailSettingsFailed ? (
          <Notice tone="error">
            Email settings didn't load.
            <span className="mt-3 block">
              <Button size="sm" onClick={() => void load()}>
                Read it again
              </Button>
            </span>
          </Notice>
        ) : (
          <Panel className="px-6 py-5">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Reminders">
                {record.emailSettings?.reminders_enabled === false ? 'Off' : 'On'}
              </Fact>
              <Fact label="Last changed">
                {record.emailSettings?.updated_at
                  ? `${formatDateTime(record.emailSettings.updated_at)} by ${
                      people[record.emailSettings.updated_by ?? '']?.full_name ?? 'the system'
                    }`
                  : 'Never changed'}
              </Fact>
              <Fact label="Scheduled reminders">
                {record.reminders.rows.filter((r) => r.enabled).length === 0
                  ? 'None'
                  : record.reminders.rows
                      .filter((r) => r.enabled)
                      .map((r) => reminderLabel(r.minutes_before))
                      .join(', ')}
              </Fact>
            </div>
          </Panel>
        )}
      </section>

      <Section
        title="Message history"
        loaded={record.messages}
        count={record.messages.rows.length}
        onRetry={() => void load()}
        empty="Nothing has been queued for this event."
      >
        <Panel className="divide-y divide-line">
          {record.messages.rows.map((message) => {
            const to = record.recipients.rows.filter((r) => r.message_id === message.id)
            const failedTo = to.filter((r) => r.status === 'failed').length
            return (
              <div key={message.id} className="px-5 py-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {message.subject ?? message.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-muted">{message.kind.replace(/_/g, ' ')}</span>
                  <span className="text-xs text-muted">{message.status}</span>
                  <span className="text-xs text-dim">
                    {message.sent_at
                      ? formatDateTime(message.sent_at)
                      : message.scheduled_for
                        ? `due ${formatDateTime(message.scheduled_for)}`
                        : 'not scheduled'}
                  </span>
                </div>
                <div className="mt-1.5 text-xs text-dim">
                  {to.length || message.audience_count || 0} recipient
                  {(to.length || message.audience_count || 0) === 1 ? '' : 's'}
                  {failedTo > 0 && (
                    <span className="text-negative"> &middot; {failedTo} failed</span>
                  )}
                  {message.triggered_by && (
                    <>
                      {' '}
                      &middot; by{' '}
                      {people[message.triggered_by]?.full_name ?? 'a removed account'}
                    </>
                  )}
                  {message.error && (
                    <span className="text-negative"> &middot; {message.error}</span>
                  )}
                </div>
              </div>
            )
          })}
        </Panel>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <FeedbackSections
        onRetry={() => void load()}
        peer={record.peer}
        eventFeedback={record.eventFeedback}
        subjects={record.subjects}
        questions={questionById}
        people={people}
        hostNames={[event.host_id, ...record.hosts.rows.map((h) => h.profile_id)]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((pid) => people[pid]?.full_name ?? 'a removed account')}
      />
    </DashboardShell>
  )
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * FDB-09, FDB-10, FDB-11, FDB-13.
 *
 * An administrator reads every review on every event. That includes reviews
 * about them, written at an event they hosted or attended — there is no
 * private tier an administrator cannot see, and this screen must not suggest
 * there is one, because an administrator who believes feedback about them is
 * hidden will read it differently when they find it.
 *
 * The shape is the whole requirement. One row of peer feedback is: this
 * author, about this subject, at this event, answering this question, at this
 * time. It is not a fact about the subject in general, it is not the
 * subject's opinion of the author, and adding it up into a number for a person
 * would invent something nobody said.
 */
function FeedbackSections({
  onRetry,
  peer,
  eventFeedback,
  subjects,
  questions,
  people,
  hostNames,
}: {
  onRetry: () => void
  peer: Loaded<PeerFeedbackRow>
  eventFeedback: Loaded<EventFeedbackRow>
  subjects: Loaded<FeedbackSubjectRow>
  questions: Map<string, FeedbackQuestion>
  people: Record<string, Profile>
  hostNames: string[]
}) {
  // Grouped by the pair it is about, because that is the unit somebody reads:
  // "what Ada said about Bem", not a wall of individual answers.
  const pairs = useMemo(() => {
    const map = new Map<string, PeerFeedbackRow[]>()
    for (const row of peer.rows) {
      const key = `${row.author_id}|${row.subject_id}`
      map.set(key, [...(map.get(key) ?? []), row])
    }
    return [...map.entries()]
  }, [peer.rows])

  const outcomes = subjects.rows.reduce<Record<string, number>>((acc, s) => {
    acc[s.outcome] = (acc[s.outcome] ?? 0) + 1
    return acc
  }, {})

  return (
    <>
      <Section
        title="Peer feedback"
        loaded={peer}
        count={pairs.length}
        onRetry={onRetry}
        empty="Nobody has written about anybody yet."
      >
        <div className="space-y-3">
          <Explainer>
            Only administrators may read this &mdash; including anything exported or summarised
            from it.
            {subjects.rows.length > 0 && (
              <>
                {' '}
                Of {subjects.rows.length} pairs asked: {outcomes.submitted ?? 0} answered,{' '}
                {outcomes.did_not_meet ?? 0} said they did not meet, {outcomes.skipped ?? 0}{' '}
                skipped, {outcomes.pending ?? 0} not yet answered.
              </>
            )}
          </Explainer>

          <Panel className="divide-y divide-line">
            {pairs.map(([key, answers]) => {
              const [authorId, subjectId] = key.split('|')
              return (
                <div key={key} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium text-fg">
                      {personName(authorId, people)}
                    </span>
                    <span className="text-dim">on</span>
                    <span className="font-medium text-fg">
                      {personName(subjectId, people)}
                    </span>
                    <span className="text-xs text-dim">
                      &middot; {formatDateTime(answers[0].submitted_at)}
                    </span>
                  </div>

                  <dl className="mt-3 space-y-3">
                    {answers.map((answer) => (
                      <div key={answer.id}>
                        <dt className="eyebrow">
                          {questions.get(answer.question_id)?.wording ??
                            'The question as it was asked is no longer on file'}
                        </dt>
                        <dd className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                          {answer.answer_choice ?? answer.answer_text ?? 'No answer given'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )
            })}
          </Panel>
        </div>
      </Section>

      <Section
        title="Feedback on the event"
        loaded={eventFeedback}
        count={eventFeedback.rows.length}
        onRetry={onRetry}
        empty="Nobody has given feedback on the event yet."
      >
        <div className="space-y-3">
          {/*
            FDB-10. This is feedback about an event. The hosting team is named
            because it is context somebody reading needs — who ran it — and
            deliberately not turned into a rating of any one of them.
          */}
          <Explainer>
            Hosted by {hostNames.join(', ')}.
          </Explainer>

          <Panel className="divide-y divide-line">
            {eventFeedback.rows.map((row) => (
              <div key={row.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-dim">
                  <span className="text-muted">
                    {personName(row.author_id, people)}
                  </span>
                  <span>&middot; {formatDateTime(row.submitted_at)}</span>
                </div>
                <p className="eyebrow mt-2">
                  {questions.get(row.question_id)?.wording ??
                    'The question as it was asked is no longer on file'}
                </p>
                <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-fg">
                  {row.answer_scale !== null
                    ? `${row.answer_scale} out of 10`
                    : (row.answer_text ?? 'No answer given')}
                </p>
              </div>
            ))}
          </Panel>
        </div>
      </Section>
    </>
  )
}
