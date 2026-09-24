/**
 * Everything about one event that an organiser sets, publishes, or takes back.
 *
 * Three rules shape this screen more than the rest:
 *
 *   ORG-02  a draft exists the moment it is created, so nothing is ever held
 *           in a modal waiting to be lost. What is on screen says at all
 *           times whether it matches what is stored.
 *   ORG-10  saving and telling people are two outcomes with two buttons and
 *           two results. Saving has never sent an email and must not start.
 *   §7.0    whoever created the event owns its money. The recipient is shown
 *           before sales open, and a cohost never changes it.
 *
 * Mirrors docs/event-platform/CONTRACT.md §2, §4, §7.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DashboardShell } from '../../components/DashboardShell'
import {
  Button,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Modal,
  Notice,
  Panel,
  SectionHeader,
  Select,
  StatTile,
  Textarea,
} from '../../components/ui'
import { PlaceInput, placesEnabled } from '../../components/PlaceInput'
import { useAuth } from '../../context/AuthProvider'
import { errorMessage, functionError, loadFailed, supabase } from '../../lib/supabase'
import { useLive } from '../../lib/live'
import { eventLink, eventWhen, type EventRecord, type TicketType } from '../../lib/events'
import { ACCEPT_ATTR, uploadMedia } from '../../lib/media'
import { payoutState, type ConnectorPayments, type PayoutState } from '../connector/payouts'
import {
  COHOST_MONEY_NOTE,
  NOTIFIABLE_FIELDS,
  browserTimeZone,
  changedDetails,
  fromZonedInput,
  lockedSentence,
  paymentRecipientSentence,
  previewFingerprint,
  remedyFor,
  toZonedInput,
  validateEvent,
  whyNoCreate,
  type ChangedDetails,
  type PaymentAccount,
} from './rules'
import {
  Explainer,
  Fact,
  ManageShell,
  ManagedEventGate,
  SaveState,
  eventsListPath,
  fromLocalInput,
  refusal,
  useManagedEvent,
  useWarnOnUnsaved,
  type ManagedEvent,
} from './shared'

export default function EventEditor() {
  const { id } = useParams()
  return id ? <ExistingEvent id={id} /> : <NewEvent />
}

/* -------------------------------------------------------------------------- */
/* Creating one                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ORG-01 / ORG-02. Deliberately short: a title and a start are all it takes to
 * have somewhere to put the rest. The draft is written before anything else is
 * asked, so a phone call in the middle of filling this in costs a title rather
 * than an afternoon.
 */
function NewEvent() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [canCreate, setCanCreate] = useState<boolean | null>(null)
  const [title, setTitle] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState('')
  // A double click lands twice before `busy` re-renders; this does not.
  const creating = useRef(false)

  useEffect(() => {
    if (!profile) return
    if (profile.role === 'admin') {
      setCanCreate(true)
      return
    }
    void supabase
      .from('connectors')
      .select('can_create_events')
      .eq('profile_id', profile.id)
      .maybeSingle()
      .then(({ data }) =>
        setCanCreate(Boolean((data as { can_create_events?: boolean } | null)?.can_create_events)),
      )
  }, [profile])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setFailure('')

    const startsIso = fromLocalInput(startsAt)
    const found = validateEvent({ title, starts_at: startsIso ?? '' })
    setErrors(found)
    if (Object.keys(found).length > 0 || creating.current) return

    creating.current = true
    setBusy(true)

    // §7.0. The money follows the creator, decided here, once. An admin's
    // event pays Amazing (null connector); a super connector's pays their own
    // Stripe. Nobody added later changes either answer.
    const { data: connector } = await supabase
      .from('connectors')
      .select('id')
      .eq('profile_id', profile.id)
      .maybeSingle()

    const { data, error } = await supabase
      .from('events')
      .insert({
        host_id: profile.id,
        title: title.trim(),
        starts_at: startsIso,
        // ORG-25. The box above was typed on this browser's clock, so that is
        // the event's zone until somebody picks another — what was typed is
        // what the editor shows next.
        timezone: browserTimeZone(),
        status: 'draft',
        // No slug: the trigger makes one from the title with a random suffix,
        // so two events called "Sunday dinner" never collide (EVT-01).
        payment_connector_id: (connector as { id: string } | null)?.id ?? null,
        payment_recipient_id: profile.id,
      })
      .select('id')
      .single()

    setBusy(false)
    if (error || !data) {
      creating.current = false
      setFailure(errorMessage(error))
      return
    }
    navigate(`/manage/events/${(data as { id: string }).id}`, { replace: true })
  }

  const blocked = canCreate === null ? null : whyNoCreate(profile?.role, canCreate)

  return (
    <DashboardShell
      title="Create an event"
      caption={blocked ? undefined : 'Add a title and a start time to save a draft.'}
    >
      {blocked ? (
        <Panel className="border-dashed px-6 py-6 text-sm leading-relaxed text-muted">
          {blocked}
        </Panel>
      ) : (
        <Panel className="max-w-xl px-6 py-6">
          <form onSubmit={create} className="space-y-5">
            <Field label="Title" error={errors.title}>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sunday dinner in Shoreditch"
                autoFocus
              />
            </Field>

            <Field
              label="Starts"
              hint={`In ${browserTimeZone()}, your own timezone. You can change the event's timezone on the next screen.`}
              error={errors.starts_at}
            >
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </Field>

            {failure && <Notice tone="error">{failure}</Notice>}

            <div className="flex gap-3">
              <Button type="submit" variant="primary" loading={busy} disabled={canCreate === null}>
                Start a draft
              </Button>
              <Button type="button" onClick={() => navigate(eventsListPath(profile))}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </DashboardShell>
  )
}

/* -------------------------------------------------------------------------- */
/* Editing one                                                                 */
/* -------------------------------------------------------------------------- */

function ExistingEvent({ id }: { id: string }) {
  const { result, reload } = useManagedEvent(id)
  return (
    <ManagedEventGate result={result} reload={reload}>
      {(data) => <Editor key={data.event.id} data={data} reload={reload} />}
    </ManagedEventGate>
  )
}

/** The editable half of an event, as strings, which is what the boxes hold. */
interface Draft {
  title: string
  description: string
  starts_at: string
  ends_at: string
  timezone: string
  venue_name: string
  address: string
  attendee_instructions: string
  refund_terms: string
  capacity: string
  registration_closed: boolean
  currency: string
  feedback_opens_after_minutes: string
}

/** A ticket option being edited. `id` is empty on one that has not been saved. */
interface TicketDraft {
  id: string
  key: string
  name: string
  price: string
  quantity: string
  is_active: boolean
}

function draftOf(event: EventRecord): Draft {
  return {
    title: event.title,
    description: event.description ?? '',
    starts_at: toZonedInput(event.starts_at, event.timezone),
    ends_at: toZonedInput(event.ends_at, event.timezone),
    timezone: event.timezone,
    venue_name: event.venue_name ?? '',
    address: event.address ?? '',
    attendee_instructions: event.attendee_instructions ?? '',
    refund_terms: event.refund_terms ?? '',
    capacity: event.capacity === null ? '' : String(event.capacity),
    registration_closed: event.registration_closed,
    currency: event.currency,
    feedback_opens_after_minutes: String(event.feedback_opens_after_minutes),
  }
}

function ticketsOf(tickets: TicketType[]): TicketDraft[] {
  return tickets.map((t) => ({
    id: t.id,
    key: t.id,
    name: t.name,
    price: (t.price_cents / 100).toFixed(2),
    quantity: t.quantity === null ? '' : String(t.quantity),
    is_active: t.is_active,
  }))
}

/** What the boxes mean as columns, ready for the update. */
function columnsOf(draft: Draft): Partial<EventRecord> {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    // ORG-25. The boxes are on the event's clock. Changing the zone keeps the
    // times as typed and moves the moment, as Eventbrite and Luma do.
    starts_at: fromZonedInput(draft.starts_at, draft.timezone) ?? '',
    ends_at: fromZonedInput(draft.ends_at, draft.timezone),
    timezone: draft.timezone,
    venue_name: draft.venue_name.trim() || null,
    address: draft.address.trim() || null,
    attendee_instructions: draft.attendee_instructions.trim() || null,
    refund_terms: draft.refund_terms.trim() || null,
    capacity: draft.capacity.trim() === '' ? null : Number(draft.capacity),
    registration_closed: draft.registration_closed,
    currency: draft.currency,
    feedback_opens_after_minutes:
      draft.feedback_opens_after_minutes === '' ? 120 : Number(draft.feedback_opens_after_minutes),
  }
}

function priceCents(price: string): number {
  return Math.round((Number(price) || 0) * 100)
}

/**
 * BUY-14. Whether this event can take money right now.
 *
 * `event_sale_readiness()` is continuously evaluated and is the authority on
 * the answer — checkout asks it and refuses the sale, publish asks it and
 * fails early, and this screen asks it to decide whether to say anything.
 * Its `reason` and `fix_action` are state codes rather than sentences, so the
 * words are not taken from here: they come from `payoutState()`, which already
 * owns this vocabulary for the connector's own payment screen and for the
 * administrator's view of that connector.
 *
 * The attendee's refusal at checkout is deliberately *not* this sentence. It
 * is one fixed line that says nothing about why, because telling a stranger
 * that a host has not finished connecting Stripe is the host's business
 * leaking to somebody who just wanted a ticket.
 */
interface SaleReadiness {
  canSell: boolean
}

/** The Stripe columns `payoutState()` reads, plus who the account belongs to. */
type ConnectorStripe = Pick<
  ConnectorPayments,
  | 'stripe_account_id'
  | 'stripe_account_status'
  | 'stripe_charges_enabled'
  | 'stripe_payouts_enabled'
> & { id: string; profile_id: string }

/**
 * §7.2. `payment_locked_at` is set by the first paid order. It is read
 * defensively because it arrives with the orders migration rather than with
 * the events one, and an editor that crashes on a missing column is worse than
 * an editor that has not heard about the lock yet.
 */
function paymentLockedAt(event: EventRecord): string | null {
  return (event as unknown as { payment_locked_at?: string | null }).payment_locked_at ?? null
}

/**
 * EML-08. When attendees were last told about a change to the details. Null
 * means something is saved that nobody has been told about.
 *
 * Read the same defensive way and for the same reason as the payment lock:
 * both are columns `src/lib/events.ts` does not list yet, and an editor that
 * throws on a column it has not heard of is worse than one that has not heard
 * of it.
 */
function detailsNotifiedAt(event: EventRecord): string | null {
  return (event as unknown as { details_notified_at?: string | null }).details_notified_at ?? null
}

function Editor({ data, reload }: { data: ManagedEvent; reload: () => Promise<void> }) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const { event, tickets, hostIds, capacity } = data

  const [draft, setDraft] = useState<Draft>(() => draftOf(event))
  const [ticketDrafts, setTicketDrafts] = useState<TicketDraft[]>(() => ticketsOf(tickets))
  const [removedTickets, setRemovedTickets] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState('')
  const [outcome, setOutcome] = useState<ReactNode>(null)
  const [notifyOpen, setNotifyOpen] = useState(false)
  /*
   * EML-04. Set when the enqueue API refused a stale preview (409). It holds
   * the change list rebuilt against what the event says *now*, plus the fields
   * that had moved, so the organiser is shown the real difference rather than
   * being invited to press the same failing button again.
   */
  const [rebuilt, setRebuilt] = useState<{ changes: ChangedDetails; fields: string[] } | null>(null)
  const [confirming, setConfirming] = useState<'publish' | 'unpublish' | 'cancel' | 'delete' | null>(null)
  const [account, setAccount] = useState<PaymentAccount | null>(null)
  const [readiness, setReadiness] = useState<SaleReadiness | null>(null)
  const [stripe, setStripe] = useState<ConnectorStripe | null>(null)
  const [hosts, setHosts] = useState<Array<{ id: string; name: string; role: string }>>([])
  const [audience, setAudience] = useState(0)

  // The places the options' own limits add up to, against the event's. An
  // option with no limit shares the event's places, so it adds nothing; an
  // option off sale sells nothing, so it does not count either.
  const ticketLimitTotal = ticketDrafts
    .filter((t) => t.is_active && t.quantity.trim() !== '')
    .reduce((sum, t) => sum + Number(t.quantity), 0)
  const placesCap = draft.capacity.trim() === '' ? null : Number(draft.capacity)
  const overLimit = placesCap !== null && ticketLimitTotal > placesCap
  const overLimitWords = `Ticket limits add up to ${ticketLimitTotal}, but the event has ${placesCap} places.`

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftOf(event)) ||
    JSON.stringify(ticketDrafts.map(({ key: _key, ...t }) => t)) !==
      JSON.stringify(ticketsOf(tickets).map(({ key: _key, ...t }) => t)) ||
    removedTickets.length > 0
  useWarnOnUnsaved(dirty)

  const typedSoFar = JSON.stringify([draft, ticketDrafts, removedTickets])
  const lastAutosave = useRef('')
  useEffect(() => {
    if (event.status !== 'draft' || !dirty || saving) return
    if (typedSoFar === lastAutosave.current) return
    const timer = setTimeout(() => {
      lastAutosave.current = typedSoFar
      void save({ quiet: true })
    }, 1500)
    return () => clearTimeout(timer)
    // save() is recreated every render; the snapshot is what decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedSoFar, dirty, saving, event.status])

  const locked = paymentLockedAt(event)
  const cancelled = event.status === 'cancelled'
  const finished = new Date(event.ends_at ?? event.starts_at).getTime() < Date.now()

  /*
   * EML-08, and the reason it is derived rather than remembered.
   *
   * `events.details_notified_at` is cleared by a trigger the moment a
   * notifiable field moves, and stamped when an update email is queued. So
   * this outlives the browser tab and reaches the cohost who opens the event
   * tomorrow — which is exactly who the banner is for, because the requirement
   * is about something the organiser has *forgotten* to do. Session state
   * could never have satisfied it.
   *
   * Two gates on top of the column. A draft has announced nothing and has
   * nobody to announce to. And an event with no confirmed places has nobody
   * who could have been told the old details: anybody registering from here on
   * receives the current ones in their confirmation (EML-05), so there is no
   * backlog to apologise for.
   */
  const unannounced =
    event.status === 'published' && detailsNotifiedAt(event) === null && audience > 0
  const columns = useMemo(() => columnsOf(draft), [draft])
  const pending = useMemo(() => changedDetails(event, columns), [event, columns])

  /* ---------------------------------------------------------------------- */
  /* Who is paid, who hosts, and how many people are coming                  */
  /* ---------------------------------------------------------------------- */

  const loadSurroundings = useCallback(async () => {
    // Two round trips rather than an embedded join: several of these tables
    // hold more than one reference to `profiles`, and an ambiguous embed fails
    // the whole query rather than one column of it.
    const [connectorRes, hostRes, regRes] = await Promise.all([
      event.payment_connector_id
        ? supabase
            .from('connectors')
            .select(
              'id, profile_id, stripe_account_id, stripe_account_status,' +
                ' stripe_charges_enabled, stripe_payouts_enabled',
            )
            .eq('id', event.payment_connector_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('member_directory').select('id, full_name, role').in('id', hostIds),
      supabase
        .from('event_registrations')
        .select('id')
        .eq('event_id', event.id)
        .eq('status', 'confirmed'),
    ])

    if (event.payment_connector_id) {
      const row = connectorRes.data as ConnectorStripe | null
      let ownerName = 'The hosting community'
      if (row) {
        const { data: owner } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', row.profile_id)
          .maybeSingle()
        ownerName = (owner as { full_name: string } | null)?.full_name ?? ownerName
      }
      setAccount(
        row ? { connectorId: row.id, name: ownerName, ownerId: row.profile_id } : null,
      )
      setStripe(row)
    } else {
      setAccount({ connectorId: null, name: 'Amazing', ownerId: null })
      setStripe(null)
    }

    // Names for the hosting team. A host whose profile this account may not
    // read comes back missing rather than breaking the panel.
    const named = ((hostRes.data as Array<{ id: string; full_name: string; role: string }>) ?? [])
    setHosts(
      hostIds.map((hid) => {
        const found = named.find((p) => p.id === hid)
        return { id: hid, name: found?.full_name ?? 'A host', role: found?.role ?? '' }
      }),
    )

    setAudience(((regRes.data as unknown[]) ?? []).length)

    /*
     * BUY-14. Read every time this screen loads, not once at publication.
     *
     * The publish-time check was the whole problem: Stripe restricts an
     * account routinely while it verifies a bank account, and it does that
     * days after an event goes live. Checkout then refuses every buyer with a
     * clear message and the organiser hears about it from a confused
     * attendee. "Prevent new paid sales and show the organizer how to resolve
     * the problem" is two obligations and we were meeting one.
     */
    const { data: readinessData, error: readinessError } = await supabase.rpc(
      'event_sale_readiness',
      { p_event: event.id },
    )
    const readinessRow = (
      Array.isArray(readinessData) ? readinessData[0] : readinessData
    ) as { can_sell_paid?: boolean } | null

    setReadiness(
      readinessError || !readinessRow ? null : { canSell: readinessRow.can_sell_paid !== false },
    )
  }, [event.id, event.payment_connector_id, hostIds])

  useEffect(() => {
    void loadSurroundings()
  }, [loadSurroundings])

  // ORG-22. Whether "Take down" is offered depends on who has registered, and
  // that changes without this organiser doing anything, and so do the Places
  // counts. The event reloads in place — the draft is local state and survives
  // — and the fresh hostIds re-run loadSurroundings.
  useLive(['event_registrations'], () => void reload(), {
    filter: `event_id=eq.${event.id}`,
  })

  /*
   * A save refreshes the event in place, so the ticket rows have to be read
   * back: a newly inserted option only has an id once it is stored, and
   * keeping the id-less copy would insert it a second time on the next save.
   */
  const resync = useRef(false)
  /** The ticket rows as they were when the last save began. */
  const savedFrom = useRef('')
  useEffect(() => {
    if (!resync.current) return
    resync.current = false
    // An autosave runs while the organiser may still be typing. Rows untouched
    // since the save began take the stored version, as they always did; rows
    // edited meanwhile keep what was typed and only gain the ids the save gave
    // them, so the next save updates them rather than inserting them twice.
    // Either way each row keeps its React key, or the box being typed in is
    // remounted and the cursor lost mid-word.
    setTicketDrafts((current) =>
      JSON.stringify(current) === savedFrom.current
        ? ticketsOf(tickets).map((t, i) => ({ ...t, key: current[i]?.key ?? t.key }))
        : current.map((t, i) =>
            t.id ? t : { ...t, id: tickets.find((x) => x.position === i)?.id ?? '' },
          ),
    )
  }, [tickets])

  /*
   * Saved options and unsaved ones both count. The readiness definition knows
   * only what is stored, but an organiser adding their first paid ticket in
   * this sitting is exactly who most needs to be told that payments are not
   * connected yet — and being told a moment early costs nothing, because this
   * is information rather than a gate.
   */
  const hasPaidTicket =
    tickets.some((t) => t.is_active && t.price_cents > 0) ||
    ticketDrafts.some((t) => t.is_active && priceCents(t.price) > 0)

  /* ---------------------------------------------------------------------- */
  /* Saving                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes the event and its ticket options. Returns true when everything
   * landed, so the caller knows whether an email is even appropriate.
   *
   * ORG-10: this never emails anybody. The notification is the caller's
   * separate decision with its own separate result.
   */
  async function save({ quiet = false } = {}): Promise<boolean> {
    if (!quiet) setProblem('')
    const found = validateEvent(columns)
    for (const t of ticketDrafts) {
      if (!t.name.trim()) found.tickets = 'Every ticket option needs a name.'
      if (priceCents(t.price) < 0) found.tickets = 'A price cannot be negative.'
      if (t.quantity.trim() !== '' && !(Number.isInteger(Number(t.quantity)) && Number(t.quantity) >= 1)) {
        found.tickets = 'A ticket limit has to be a whole number, at least one, or empty.'
      }
    }
    if (overLimit) found.tickets = overLimitWords
    if (quiet && Object.keys(found).length > 0) return false
    setErrors(found)
    if (Object.keys(found).length > 0) return false

    setSaving(true)
    savedFrom.current = JSON.stringify(ticketDrafts)

    const { error } = await supabase.from('events').update(columns).eq('id', event.id)
    if (error) {
      setSaving(false)
      setProblem(errorMessage(error))
      return false
    }

    // Tickets as a difference, not a rewrite: an option that is only renamed
    // keeps its id, and so do the registrations and orders pointing at it.
    const problems: string[] = []
    if (removedTickets.length > 0) {
      const { error: delError } = await supabase
        .from('ticket_types')
        .delete()
        .in('id', removedTickets)
      if (delError) problems.push(`A ticket option could not be removed: ${errorMessage(delError)}`)
    }
    for (const [index, t] of ticketDrafts.entries()) {
      const row = {
        event_id: event.id,
        name: t.name.trim(),
        price_cents: priceCents(t.price),
        currency: draft.currency,
        quantity: t.quantity.trim() === '' ? null : Number(t.quantity),
        position: index,
        is_active: t.is_active,
      }
      const { error: rowError } = t.id
        ? await supabase.from('ticket_types').update(row).eq('id', t.id)
        : await supabase.from('ticket_types').insert(row)
      if (rowError) problems.push(`"${row.name}" was not saved: ${errorMessage(rowError)}`)
    }

    setSaving(false)
    setRemovedTickets([])
    setSavedAt(new Date().toISOString())
    resync.current = true
    await reload()

    if (problems.length > 0) {
      setProblem(problems.join(' '))
      return false
    }
    return true
  }

  /** The button an organiser presses. Asks about the email only when there is one to ask about. */
  async function saveClicked() {
    const notifiable = Object.keys(pending).length > 0 && event.status === 'published'
    if (notifiable) {
      setNotifyOpen(true)
      return
    }
    const ok = await save()
    if (ok) setOutcome('Saved. Nothing was emailed — none of these changes affect anybody’s plans.')
  }

  /* ---------------------------------------------------------------------- */
  /* Publishing, taking back, cancelling                                     */
  /* ---------------------------------------------------------------------- */

  async function setStatus(status: 'published' | 'draft') {
    setProblem('')
    setOutcome(null)
    if (status === 'published' && overLimit) {
      setProblem(`${overLimitWords} Raise the places or lower the ticket limits, then publish.`)
      return
    }
    if (dirty) {
      const ok = await save()
      if (!ok) return
    }
    /*
     * Publishing stamps `details_notified_at` in the same write.
     *
     * The column is null on a brand-new event, and null reads as "there are
     * changes nobody has been told about". Without this, an event published
     * and then never touched would carry the unannounced banner for a change
     * that never happened. At the moment of publication the details simply are
     * the details — nothing is outstanding — so saying so here is true. The
     * clearing trigger does not fire on this write, because status is not one
     * of the fields an attendee needs to be told about.
     */
    const { error } = await supabase
      .from('events')
      .update(
        status === 'published'
          ? { status, details_notified_at: new Date().toISOString() }
          : { status },
      )
      .eq('id', event.id)
    if (error) {
      // Somebody may have registered since the dialog opened: close it and
      // re-read, so the screen offers what is actually possible now.
      setConfirming(null)
      setProblem(errorMessage(error))
      void loadSurroundings()
      await reload()
      return
    }
    setConfirming(null)
    await reload()
    setOutcome(
      status === 'published'
        ? 'Published. The event is now visible to attendees and its link works.'
        : 'Taken down. Attendees can no longer find or open this event; nobody has been emailed about it.',
    )
  }

  /**
   * ORG-11. One write, and everything else follows it in the database.
   *
   * `reschedule_event_messages` fires on the status change and does all three
   * things a cancellation owes people: it cancels every message still waiting
   * to go, queues the cancellation notice, and puts it in the bell for anybody
   * holding or confirmed on a place.
   *
   * This deliberately does not queue that notice itself, and it used to.
   * EML-01 lists event cancellation as automatic — "automatically when event
   * cancellation is confirmed" — and a browser tab is not automatic. If this
   * connection drops between the update and a follow-up call, the trigger has
   * already told everybody; a client-side send would have told nobody, on the
   * one message where silence is worst. Two senders also meant two emails per
   * attendee once the dispatcher learned to resolve an audience for a claimed
   * message that had none, which is exactly what EML-06 forbids.
   *
   * So the honest report below says the cancellation succeeded and that the
   * notice is on its way. It does not claim this screen sent anything, because
   * it did not — the same saving-is-not-sending distinction as ORG-10, pointed
   * the other way.
   */
  async function cancelEvent() {
    setProblem('')
    setSaving(true)

    const { error } = await supabase
      .from('events')
      .update({ status: 'cancelled' })
      .eq('id', event.id)

    setSaving(false)
    if (error) {
      setProblem(errorMessage(error))
      return
    }

    setConfirming(null)
    await reload()
    setOutcome(
      <>
        Cancelled. Registration is closed and tickets no longer admit anybody. Everyone holding or
        confirmed on a place is being emailed automatically, and pending reminders and the feedback
        request have been stopped. Follow each copy of the notice on the Emails page, and paid orders
        and their refunds on the Results page.
      </>,
    )
  }

  /**
   * Decision 16. Only a draft nobody holds a place on offers this, and the
   * button is a courtesy: guard_event_deletion() is what decides, and its
   * refusal is shown as it stands. `.select()` because RLS refuses a delete by
   * matching nothing, not by erroring.
   */
  async function deleteDraft() {
    setProblem('')
    setSaving(true)
    const { data: gone, error } = await supabase
      .from('events')
      .delete()
      .eq('id', event.id)
      .select('id')
    setSaving(false)
    setConfirming(null)
    if (error || !gone?.length) {
      setProblem(error ? errorMessage(error) : 'This draft could not be deleted.')
      return
    }
    const list = eventsListPath(profile)
    navigate(list === '/events/mine' ? list : `${list}/drafts`, { replace: true })
  }

  /* ---------------------------------------------------------------------- */
  /* Hosting team                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * QLT-06. Adding a cohost emails them, as it always has.
   *
   * Being handed the ability to edit an event, invite people to it, scan its
   * door and refund its orders without being told is worse than not being
   * given it. The email is queued after the row exists, because the enqueue
   * API checks `event_hosts` before it will send this kind — which is what
   * stops it being used to mail an arbitrary member about an event they have
   * nothing to do with.
   *
   * A mail failure never undoes the cohost. They are a host either way; they
   * just have not heard yet, and that is what the sentence says.
   */
  async function addHost(profileId: string) {
    setProblem('')
    const { error } = await supabase
      .from('event_hosts')
      .insert({ event_id: event.id, profile_id: profileId })
    if (error) {
      setProblem(errorMessage(error))
      return
    }

    const { error: mailError } = await supabase.functions.invoke('event-email', {
      body: { kind: 'cohost', event_id: event.id, profile_id: profileId, send_now: true },
    })

    await reload()
    setOutcome(
      mailError
        ? `They are now a cohost, but we could not email them about it: ${await functionError(mailError)} They can still run the event — tell them, or remove and add them again to retry.`
        : 'They are now a cohost, and have been emailed to say so.',
    )
  }

  async function removeHost(profileId: string) {
    setProblem('')
    const { error } = await supabase
      .from('event_hosts')
      .delete()
      .eq('event_id', event.id)
      .eq('profile_id', profileId)
    if (error) {
      setProblem(errorMessage(error))
      return
    }
    await reload()
  }

  /* ---------------------------------------------------------------------- */

  /*
   * The words for a payment problem, from the module that already owns them.
   * `payoutState()` also names `disconnected` and charges-switched-off, which
   * the readiness codes do not separately distinguish — one more reason to ask
   * it rather than to keep a second vocabulary here.
   */
  const payout = stripe ? payoutState(stripe) : null

  const cannotSell = hasPaidTicket && readiness !== null && !readiness.canSell
  const canPublish = !cannotSell
  // Decision 13. Publishing a past date is allowed, only said out loud.
  const startsInPast = new Date(columns.starts_at || event.starts_at).getTime() < Date.now()
  // ORG-15: the creator or an admin, and never once somebody holds a place.
  const canDelete =
    event.status === 'draft' &&
    audience === 0 &&
    (event.host_id === profile?.id || profile?.role === 'admin')

  /* The one judgement that is this screen's: whether the reader can act. */
  const remedy = remedyFor(payout?.fix ?? null, account, profile?.id ?? null)

  return (
    <ManageShell event={event}>
      {/* ORG-02 / QLT-03. The save state and the actions travel with the page
          rather than sitting at the bottom of a long form. */}
      <div className="sticky top-14 z-20 -mx-5 mb-8 border-b border-line bg-ink/90 px-5 py-3 backdrop-blur-md sm:-mx-8 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <SaveState dirty={dirty} saving={saving} savedAt={savedAt} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={async () => {
                const tab = window.open('', '_blank')
                if (tab) tab.opener = null
                if (event.status === 'draft' && dirty) await save()
                if (tab) tab.location.href = eventLink(event.slug)
              }}
            >
              Preview attendee page
            </Button>
            {event.status === 'draft' && (
              <Button
                size="sm"
                variant="primary"
                disabled={!canPublish}
                onClick={() => setConfirming('publish')}
              >
                Publish
              </Button>
            )}
            {canDelete && (
              <Button size="sm" variant="danger" onClick={() => setConfirming('delete')}>
                Delete draft
              </Button>
            )}
            {/* ORG-22. Once somebody holds a confirmed place, taking the event
                down would strand them silently; the database refuses it and
                cancelling is the way to call it off. */}
            {event.status === 'published' && !finished && audience === 0 && (
              <Button size="sm" onClick={() => setConfirming('unpublish')}>
                Take down
              </Button>
            )}
            {event.status === 'published' && !finished && audience > 0 && (
              <span className="text-xs text-dim">
                People have registered, so this can be cancelled but not taken down.
              </span>
            )}
            {event.status !== 'cancelled' && !finished && (
              <Button size="sm" variant="danger" onClick={() => setConfirming('cancel')}>
                Cancel event
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              loading={saving}
              disabled={cancelled}
              onClick={() => void saveClicked()}
            >
              Save changes
            </Button>
          </div>
        </div>
      </div>

      {cancelled && (
        <div className="mb-6">
          <Notice tone="warning">This event is cancelled. Its details can no longer be changed.</Notice>
        </div>
      )}
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

      {/*
        EML-08. Saving did not send anything, and this says so rather than
        letting the organiser walk away assuming it did. The offer to send an
        update also stands permanently on the Emails page, so the action never
        depends on catching this banner.
      */}
      {unannounced && (
        <div className="mb-6">
          <Notice tone="error">
            Attendees have not been told about the details you changed. Nothing was emailed.{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => navigate(`/manage/events/${event.id}/emails`)}
            >
              Send an update from the Emails page
            </button>{' '}
            whenever you are ready.
          </Notice>
        </div>
      )}

      {/* A disabled fieldset turns off every box and button inside it at once. */}
      <fieldset disabled={cancelled} className="min-w-0 space-y-10">
        <Section title="The event itself">
          <Field label="Title" error={errors.title}>
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>

          <Field label="Description" hint="Say what it is and who it is for.">
            <Textarea
              rows={5}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>

          <CoverField event={event} onChanged={reload} onProblem={setProblem} />

          <Fact label="Attendee link">
            <a
              href={eventLink(event.slug)}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {eventLink(event.slug)}
            </a>
          </Fact>
        </Section>

        <Section
          title="When and where"
          caption="Saving a change here offers to tell attendees."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Starts" error={errors.starts_at}>
              <Input
                type="datetime-local"
                value={draft.starts_at}
                onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })}
              />
            </Field>
            <Field label="Ends" error={errors.ends_at}>
              <Input
                type="datetime-local"
                value={draft.ends_at}
                onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })}
              />
            </Field>
          </div>

          <Field
            label="Timezone"
            hint="The times above are in this zone, and attendees see them in it too."
          >
            <Select
              value={draft.timezone}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            >
              {timezones(draft.timezone).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>

          {columns.starts_at && (
            <Explainer>
              In {draft.timezone}, attendees will read this as{' '}
              <span className="text-fg">
                {eventWhen({
                  starts_at: columns.starts_at,
                  ends_at: columns.ends_at ?? null,
                  timezone: draft.timezone,
                })}
              </span>
              .
            </Explainer>
          )}

          <Field
            label="Venue"
            hint={placesEnabled ? "Start typing the place's name, then pick it to fill in the address." : undefined}
          >
            <PlaceInput
              value={draft.venue_name}
              onChange={(venue_name) => setDraft((d) => ({ ...d, venue_name }))}
              onPick={({ name, address }) =>
                setDraft((d) => ({ ...d, venue_name: name, address }))
              }
              // ponytail: country from the currency; EUR spans too many to pick one,
              // so it searches the world. A per-event country field if hosts need it.
              region={({ usd: 'us', gbp: 'gb' } as Record<string, string>)[draft.currency]}
              placeholder="The Clove Club"
            />
          </Field>

          <Field label="Address" hint="Edit it if the venue's entrance is somewhere else.">
            <Textarea
              rows={2}
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
          </Field>

          <Field
            label="Instructions for attendees"
            hint="How to find the door, what to bring, what to wear. Goes out with the ticket and the reminders."
          >
            <Textarea
              rows={3}
              value={draft.attendee_instructions}
              onChange={(e) => setDraft({ ...draft, attendee_instructions: e.target.value })}
            />
          </Field>
        </Section>

        <Section title="Places">
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <StatTile label="Limit" value={event.capacity ?? 'No limit'} />
            <StatTile label="Confirmed" value={capacity?.confirmed ?? 0} />
            <StatTile
              label="Remaining"
              value={event.capacity === null ? 'No limit' : (capacity?.remaining ?? event.capacity)}
            />
          </div>

          <Field
            label="Maximum places"
            hint="Leave empty for no limit. Shared across every ticket option below."
            error={errors.capacity}
          >
            <Input
              type="number"
              min={1}
              value={draft.capacity}
              onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-muted">
            <input
              type="checkbox"
              checked={draft.registration_closed}
              onChange={(e) => setDraft({ ...draft, registration_closed: e.target.checked })}
              className="mt-1 size-3.5 accent-gold-dim"
            />
            <span>
              Close registration now
              <span className="block text-xs text-dim">
                Different from selling out: the event page says you closed it, not that it
                filled up.
              </span>
            </span>
          </label>
        </Section>

        <Section title="Ticket options">
          <div className="mb-5 w-40">
            <Field label="Currency">
              <Select
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                disabled={Boolean(locked)}
              >
                {['usd', 'gbp', 'eur'].map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {overLimit ? (
            <div className="mb-4">
              <Notice tone="warning">
                {overLimitWords} Raise the places, or lower the limits below.
                <Button
                  size="sm"
                  className="mt-3 block"
                  onClick={() => setDraft((d) => ({ ...d, capacity: String(ticketLimitTotal) }))}
                >
                  Raise places to {ticketLimitTotal}
                </Button>
              </Notice>
            </div>
          ) : (
            errors.tickets && (
              <div className="mb-4">
                <Notice tone="error">{errors.tickets}</Notice>
              </div>
            )
          )}

          {ticketDrafts.length === 0 ? (
            <EmptyState>
              No ticket options. Without one this event is free to attend and registration is a
              single click.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {ticketDrafts.map((t, i) => (
                <Panel key={t.key} className="px-5 py-5">
                  <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
                    <Field label="Name">
                      <Input
                        value={t.name}
                        onChange={(e) => patchTicket(i, { name: e.target.value })}
                        placeholder="Standard"
                      />
                    </Field>
                    <Field label={`Price (${draft.currency.toUpperCase()})`} hint="0 is free">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={t.price}
                        onChange={(e) => patchTicket(i, { price: e.target.value })}
                      />
                    </Field>
                    <Field label="Limit" hint="Empty shares the event limit">
                      <Input
                        type="number"
                        min={1}
                        value={t.quantity}
                        onChange={(e) => patchTicket(i, { quantity: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={t.is_active}
                        onChange={(e) => patchTicket(i, { is_active: e.target.checked })}
                        className="size-3.5 accent-gold-dim"
                      />
                      On sale
                    </label>
                    <button
                      type="button"
                      onClick={() => dropTicket(i)}
                      className="text-xs text-dim transition-colors hover:text-negative"
                    >
                      Remove
                    </button>
                  </div>
                </Panel>
              ))}
            </div>
          )}

          <div className="mt-4">
            <Button size="sm" onClick={addTicket}>
              Add a ticket option
            </Button>
          </div>

          <div className="mt-5">
            <Explainer>
              Changing a price does not change what anybody has already paid, or what they can
              be refunded.
            </Explainer>
          </div>
        </Section>

        <PaymentPanel
          account={account}
          payout={payout}
          remedy={remedy}
          cannotSell={cannotSell}
          locked={locked}
          event={event}
          isAdmin={profile?.role === 'admin'}
          onChanged={reload}
          onProblem={setProblem}
        />

        <HostPanel
          hosts={hosts}
          creatorId={event.host_id}
          meId={profile?.id ?? ''}
          onAdd={addHost}
          onRemove={removeHost}
        />

        <Section title="Refunds and feedback">
          <Field
            label="Refund terms"
            hint="Shown before anybody pays, and kept with their order exactly as it read then."
          >
            <Textarea
              rows={3}
              value={draft.refund_terms}
              onChange={(e) => setDraft({ ...draft, refund_terms: e.target.value })}
            />
          </Field>
          <Field
            label="Feedback opens this many minutes after the event ends"
            hint="Two hours by default."
            error={errors.feedback_opens_after_minutes}
          >
            <div className="w-40">
              <Input
                type="number"
                min={0}
                max={20160}
                step={1}
                value={draft.feedback_opens_after_minutes}
                onChange={(e) =>
                  setDraft({ ...draft, feedback_opens_after_minutes: e.target.value })
                }
              />
            </div>
          </Field>
        </Section>
      </fieldset>

      <NotifyModal
        open={notifyOpen}
        event={event}
        changes={rebuilt?.changes ?? pending}
        rebuiltFields={rebuilt?.fields ?? null}
        columns={columns}
        audience={audience}
        onClose={() => {
          setNotifyOpen(false)
          setRebuilt(null)
        }}
        onSaveOnly={async () => {
          const ok = await save()
          setNotifyOpen(false)
          setRebuilt(null)
          if (ok) {
            setOutcome('Saved. Nobody has been emailed about the change.')
          }
        }}
        onSaveAndNotify={async (note) => {
          const ok = await save()
          if (!ok) {
            setNotifyOpen(false)
            return
          }

          const announcing = rebuilt?.changes ?? pending
          const { data: sent, error } = await supabase.functions.invoke('event-email', {
            body: {
              kind: 'update',
              event_id: event.id,
              body: note.trim() || null,
              changed_details: announcing,
              send_now: true,
            },
          })

          if (error) {
            const refused = await refusal(error)

            /*
             * EML-04. The one refusal that is not a failure to report and walk
             * away from. Nothing was queued, nothing was sent, nothing is
             * half-done — the event moved again between building this preview
             * and pressing send, so the email would have announced details
             * that are no longer true.
             *
             * Retrying the same body fails identically, so a "try again"
             * button would be a lie. Re-read the event, rebuild the preview
             * against what it says now, and let them look before sending. The
             * modal stays open: they are mid-decision, and closing it would
             * throw away the note they wrote.
             */
            if (refused.status === 409 || refused.body.refresh_preview === true) {
              const { data: fresh } = await supabase
                .from('events')
                .select('*')
                .eq('id', event.id)
                .maybeSingle()
              const now = (fresh as EventRecord | null) ?? event
              const fields = Array.isArray(refused.body.stale)
                ? (refused.body.stale as string[])
                : Object.keys(announcing)

              // Keep the `from` the organiser was already shown — that is
              // still where the detail started — and take the `to` from the
              // event as it stands, which is what an email may honestly say.
              const next: ChangedDetails = {}
              for (const [field, change] of Object.entries(announcing)) {
                const current = (now as unknown as Record<string, unknown>)[field] ?? null
                next[field] = { from: change.from, to: current }
              }
              for (const field of fields) {
                if (next[field]) continue
                next[field] = {
                  from: (event as unknown as Record<string, unknown>)[field] ?? null,
                  to: (now as unknown as Record<string, unknown>)[field] ?? null,
                }
              }

              setRebuilt({ changes: next, fields })
              // The form goes back to what is stored, so the boxes and the
              // preview are describing the same event.
              setDraft(draftOf(now))
              await reload()
              return
            }

            setNotifyOpen(false)
            setProblem(
              `The event was saved, but nobody was emailed: ${refused.message} ` +
                'Nothing about the event was undone — you can send the update from the Emails page.',
            )
            return
          }

          setNotifyOpen(false)
          setRebuilt(null)

          /*
           * The count in the reply is the one that was actually queued,
           * re-resolved server-side. The number the preview showed was only
           * what was true when the preview was built, and reporting that back
           * would be a small lie at the exact moment the organiser is
           * trusting the screen.
           *
           * `dispatched: false` is not shown. It means the immediate nudge did
           * not reach the dispatcher and the schedule will pick the message up
           * within a few minutes — the message is queued either way, and an
           * organiser has nothing to do about it.
           */
          const reply = sent as { message_id?: string | null; audience_count?: number } | null
          const count = reply?.audience_count ?? 0

          if (count === 0) {
              setOutcome(
              'Saved. There is nobody to notify yet — no one has a confirmed place on this event.',
            )
            return
          }

          setOutcome(
            `Saved, and an update has been queued for ${count} ${count === 1 ? 'person' : 'people'}. ` +
              'Follow each copy on the Emails page.',
          )
        }}
      />

      <ConfirmModal
        open={confirming === 'publish'}
        title="Publish this event?"
        tone="primary"
        confirmLabel="Publish"
        busy={saving}
        body={
          <>
            The event becomes visible in the attendee browse list and its link starts working.
            {cannotSell && ` ${payout?.outstanding ?? ''}`}
            {startsInPast && (
              <p className="mt-3 text-fg">
                Its start time has already passed. Check the date before publishing.
              </p>
            )}
          </>
        }
        onConfirm={() => void setStatus('published')}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        open={confirming === 'unpublish'}
        title="Take this event down?"
        tone="primary"
        confirmLabel="Take down"
        busy={saving}
        body={
          <>
            It goes back to a draft: nobody can find it and the link stops working, and nobody is
            emailed. This is only possible while nobody holds a confirmed place — after that,
            cancelling is the thing that tells people it is off.
          </>
        }
        onConfirm={() => void setStatus('draft')}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        open={confirming === 'cancel'}
        title="Cancel this event?"
        confirmLabel="Cancel the event"
        busy={saving}
        body={
          <>
            <p>
              Registration closes, tickets stop admitting anybody, and everybody holding or
              confirmed on a place is emailed straight away. Pending reminders and the feedback
              request are stopped.
            </p>
            <p className="mt-3">
              Nothing is deleted. The guest list, the orders and the refund status stay readable
              under Guests and Results. Refunding paid orders is a separate step.
            </p>
            <p className="mt-3 text-fg">This cannot be undone.</p>
          </>
        }
        onConfirm={() => void cancelEvent()}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        open={confirming === 'delete'}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        busy={saving}
        body={
          <>
            The draft, its tickets and everything typed into it are removed for good. This cannot
            be undone.
          </>
        }
        onConfirm={() => void deleteDraft()}
        onClose={() => setConfirming(null)}
      />
    </ManageShell>
  )

  function patchTicket(index: number, patch: Partial<TicketDraft>) {
    setTicketDrafts((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function addTicket() {
    setTicketDrafts((rows) => [
      ...rows,
      {
        id: '',
        key: `new-${rows.length}-${Date.now()}`,
        name: '',
        price: '0.00',
        quantity: '',
        is_active: true,
      },
    ])
  }

  function dropTicket(index: number) {
    const row = ticketDrafts[index]
    if (row?.id) setRemovedTickets((ids) => [...ids, row.id])
    setTicketDrafts((rows) => rows.filter((_, i) => i !== index))
  }
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  caption,
  children,
}: {
  title: string
  caption?: string
  children: ReactNode
}) {
  return (
    <section>
      <SectionHeader title={title} caption={caption} />
      <Panel className="space-y-5 px-6 py-6">{children}</Panel>
    </section>
  )
}

/** One image, uploaded on choosing it — there is nothing to review beforehand. */
function CoverField({
  event,
  onChanged,
  onProblem,
}: {
  event: EventRecord
  onChanged: () => Promise<void>
  onProblem: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function choose(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      const [uploaded] = await uploadMedia([file])
      const { error } = await supabase
        .from('events')
        .update({ cover_path: uploaded?.path ?? null })
        .eq('id', event.id)
      if (error) throw error
      await onChanged()
    } catch (e) {
      onProblem(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label="Cover image"
      hint={busy ? 'Uploading…' : event.cover_path ? 'One is set. Choosing another replaces it.' : 'Optional.'}
    >
      <Input
        type="file"
        accept={ACCEPT_ATTR}
        disabled={busy}
        onChange={(e) => void choose(e.target.files?.[0])}
        className="py-2.5"
      />
    </Field>
  )
}

/**
 * BUY-13 / BUY-14 / §7.0. Who receives the money, said before sales open,
 * whether or not anybody asked.
 */
function PaymentPanel({
  account,
  payout,
  remedy,
  cannotSell,
  locked,
  event,
  isAdmin,
  onChanged,
  onProblem,
}: {
  account: PaymentAccount | null
  payout: PayoutState | null
  remedy: { href?: string; label: string }
  cannotSell: boolean
  locked: string | null
  event: EventRecord
  isAdmin: boolean
  onChanged: () => Promise<void>
  onProblem: (message: string) => void
}) {
  const [picking, setPicking] = useState(false)
  const overridden = event.payment_recipient_id !== null && event.payment_recipient_id !== event.host_id

  return (
    <section>
      <SectionHeader title="Who receives the ticket money" />
      <Panel className="space-y-5 px-6 py-6">
        <div className="rounded-sm border border-line-strong bg-raised px-5 py-4">
          <div className="eyebrow">Payment account</div>
          <p className="mt-2 text-sm leading-relaxed text-fg">
            {account
              ? paymentRecipientSentence(account, overridden)
              : 'No account has been set to receive money for this event.'}
          </p>
        </div>

        {locked ? (
          <Explainer>{lockedSentence(locked)}</Explainer>
        ) : (
          isAdmin && (
            <div>
              <Button size="sm" onClick={() => setPicking(true)}>
                Name a different payment recipient
              </Button>
              <p className="mt-2 text-xs leading-relaxed text-dim">
                Use only when Amazing sets an event up for a partner. It cannot be changed once
                anybody has paid.
              </p>
            </div>
          )
        )}

        {/*
          BUY-14. Shown once, here where the payment account is set: the same
          sentence as the refusal a buyer would read at checkout — one `reason`, rendered
          wherever somebody needs it, never reworded per screen.
        */}
        {cannotSell && (
          <div className="rounded-sm border border-[#efc98f] bg-[#f6ecd9] px-5 py-4">
            <p className="text-sm leading-relaxed text-fg">
              {payout?.outstanding ?? 'Payments are not set up for this event yet.'}
            </p>
            {/* ORG-12. Same rule as the first publish, held by the database. */}
            {event.status === 'published' && (
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                Until this is fixed, a paid ticket option cannot be put on sale here: saving a new
                one, or switching one on, will be refused.
              </p>
            )}
            {remedy.href ? (
              <RemedyLink href={remedy.href} label={remedy.label} className="mt-2" />
            ) : (
              remedy.label && <p className="mt-1.5 text-sm leading-relaxed text-muted">{remedy.label}</p>
            )}
          </div>
        )}
      </Panel>

      <RecipientPicker
        open={picking}
        event={event}
        onClose={() => setPicking(false)}
        onChanged={onChanged}
        onProblem={onProblem}
      />
    </section>
  )
}

/**
 * The deliberate override. A search rather than a list, and a confirmation
 * sentence naming the account, because nothing about this should be possible
 * to do by accident.
 */
function RecipientPicker({
  open,
  event,
  onClose,
  onChanged,
  onProblem,
}: {
  open: boolean
  event: EventRecord
  onClose: () => void
  onChanged: () => Promise<void>
  onProblem: (message: string) => void
}) {
  const [rows, setRows] = useState<
    Array<{ id: string; profile_id: string; name: string; ready: boolean }>
  >([])
  const [chosen, setChosen] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void (async () => {
      const { data, error } = await supabase
        .from('connectors')
        .select('id, profile_id, stripe_charges_enabled')
        .eq('can_create_events', true)
      if (error) {
        loadFailed(error, 'the communities that can be paid')
        return
      }
      const found =
        (data as Array<{ id: string; profile_id: string; stripe_charges_enabled: boolean }>) ?? []
      const { data: owners } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', found.map((r) => r.profile_id))
      const names = new Map(
        ((owners as Array<{ id: string; full_name: string }>) ?? []).map((o) => [o.id, o.full_name]),
      )
      setRows(
        found.map((r) => ({
          id: r.id,
          profile_id: r.profile_id,
          name: names.get(r.profile_id) ?? 'Unnamed connector',
          ready: r.stripe_charges_enabled,
        })),
      )
    })()
  }, [open])

  const picked = rows.find((r) => r.id === chosen)

  async function apply() {
    setBusy(true)
    const { error } = await supabase
      .from('events')
      .update(
        chosen === 'amazing'
          ? { payment_connector_id: null, payment_recipient_id: event.host_id }
          : { payment_connector_id: picked?.id ?? null, payment_recipient_id: picked?.profile_id ?? null },
      )
      .eq('id', event.id)
    setBusy(false)
    if (error) {
      onProblem(errorMessage(error))
      return
    }
    onClose()
    await onChanged()
  }

  return (
    <Modal open={open} title="Name the payment recipient" onClose={onClose}>
      <p className="text-sm leading-relaxed text-muted">
        Every ticket sold for this event will be charged on the account you pick here. They receive
        the money, they pay Stripe's fees, and refunds come out of their balance. This cannot be
        changed once the first ticket is paid for.
      </p>

      <div className="mt-5">
        <Field label="Recipient">
          <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">Choose an account…</option>
            <option value="amazing">Amazing's own Stripe account</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.ready ? '' : ' — Stripe not ready'}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {chosen && (
        <div className="mt-5">
          <Notice tone="error">
            {chosen === 'amazing'
              ? 'Ticket money for this event will go to Amazing.'
              : `Ticket money for this event will go to ${picked?.name}. Amazing will not receive it.`}
          </Notice>
        </div>
      )}

      <div className="mt-7 flex gap-3">
        <Button className="flex-1" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          loading={busy}
          disabled={!chosen}
          onClick={() => void apply()}
        >
          Set recipient
        </Button>
      </div>
    </Modal>
  )
}

/**
 * ORG-05. More than one named host, and a straight answer to the question
 * everybody asks next — what does being named actually let them do.
 */
function HostPanel({
  hosts,
  creatorId,
  meId,
  onAdd,
  onRemove,
}: {
  hosts: Array<{ id: string; name: string; role: string }>
  creatorId: string
  meId: string
  onAdd: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const [candidates, setCandidates] = useState<
    Array<{ id: string; full_name: string; role: string; current_profession: string | null; email: string }>
  >([])
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    // Not member_directory: it has no email, and the email is what tells two
    // people with the same name apart. The function refuses anybody who is not
    // a connector or an admin.
    void supabase
      .rpc('cohost_candidates')
      .then(({ data, error }) => {
        if (error) {
          loadFailed(error, 'the people who can cohost')
          return
        }
        setCandidates((data as typeof candidates) ?? [])
      })
  }, [])

  const addable = candidates.filter((c) => !hosts.some((h) => h.id === c.id))

  return (
    <section>
      <SectionHeader title="Hosting team" />
      <Panel className="space-y-5 px-6 py-6">
        <Explainer>
          Anyone you add here can edit this event, invite people, check them in and email its
          attendees.
        </Explainer>

        <ul className="divide-y divide-line">
          {hosts.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {h.name}
                {h.id === meId && <span className="text-dim"> — you</span>}
              </span>
              <span className="text-xs text-dim">
                {h.id === creatorId ? 'Created this event; receives the money' : 'Cohost'}
              </span>
              {h.id !== creatorId && (
                <button
                  type="button"
                  onClick={() => setDropping({ id: h.id, name: h.name })}
                  className="text-xs text-dim transition-colors hover:text-negative"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <Field label="Add a cohost" hint={COHOST_MONEY_NOTE}>
              <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Choose somebody…</option>
                {addable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {/* Two people can share a name, even a profession; never an email. */}
                    {[c.full_name, c.role === 'admin' ? 'Administrator' : 'Connector', c.email]
                      .filter(Boolean)
                      .join(' · ')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            size="sm"
            disabled={!chosen}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              await onAdd(chosen)
              setChosen('')
              setBusy(false)
            }}
          >
            Add
          </Button>
        </div>
      </Panel>

      <ConfirmModal
        open={Boolean(dropping)}
        title={`Remove ${dropping?.name ?? 'this cohost'}?`}
        confirmLabel="Remove"
        body="They stop being named on the event page and lose access to its guests, emails and check-in. Nothing else about their account changes."
        onConfirm={async () => {
          if (dropping) await onRemove(dropping.id)
          setDropping(null)
        }}
        onClose={() => setDropping(null)}
      />
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* ORG-10 / EML-03 / EML-04 — the notification choice                          */
/* -------------------------------------------------------------------------- */

/**
 * The one screen in the organiser dashboard that must not be ambiguous.
 *
 * It shows what the email will say before anything is sent, and it offers two
 * outcomes with two different sentences on two different buttons. Neither is
 * the default, because "save" and "save and email forty people" are not the
 * same decision and a person under time pressure will press whatever is
 * highlighted.
 *
 * EML-04: the preview is fingerprinted against the draft it was built from. If
 * the organiser goes back and changes a detail again, this preview is
 * describing something that is no longer true, and it has to be rebuilt. The
 * enqueue API refuses a stale one as well — this is so it never gets that far.
 */
function NotifyModal({
  open,
  event,
  changes,
  rebuiltFields,
  columns,
  audience,
  onClose,
  onSaveOnly,
  onSaveAndNotify,
}: {
  open: boolean
  event: EventRecord
  changes: ChangedDetails
  /** EML-04. Non-null once the server refused a stale preview and this is the rebuild. */
  rebuiltFields: string[] | null
  columns: Partial<EventRecord>
  audience: number
  onClose: () => void
  onSaveOnly: () => Promise<void>
  onSaveAndNotify: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'save' | 'notify' | null>(null)
  const [builtFrom, setBuiltFrom] = useState<string | null>(null)

  const fingerprint = previewFingerprint(columns)

  // Built the moment the preview opens, and again whenever the organiser asks
  // for a fresh one — or whenever the server hands back a rebuild of its own.
  useEffect(() => {
    if (open) setBuiltFrom(previewFingerprint(columns))
    // The fingerprint is deliberately not a dependency: a change while the
    // preview is open is the thing this is here to catch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rebuiltFields])

  const stale = builtFrom !== null && builtFrom !== fingerprint

  return (
    <Modal open={open} title="Tell attendees what changed?" onClose={busy ? () => {} : onClose}>
      <p className="text-sm leading-relaxed text-muted">
        These details have changed on an event people have already registered for. Saving stores the
        change. It does not tell anybody.
      </p>

      {/*
        EML-04. The server refused the last attempt because the event had moved
        again. Nothing was queued and nothing was sent — this is the preview
        rebuilt against what the event says now.
      */}
      {rebuiltFields && (
        <div className="mt-5">
          <Notice tone="error">
            The event changed again while you were here, so nothing was sent — no email went out
            and nobody was written to. This preview has been rebuilt from what the event says now
            {rebuiltFields.length > 0 && (
              <>
                {' '}
                (
                {rebuiltFields
                  .map(
                    (f) =>
                      NOTIFIABLE_FIELDS[f as keyof typeof NOTIFIABLE_FIELDS]?.toLowerCase() ?? f,
                  )
                  .join(', ')}{' '}
                moved)
              </>
            )}
            . Read it, then send.
          </Notice>
        </div>
      )}

      <div className="mt-6 rounded-sm border border-line bg-raised px-5 py-4">
        <div className="eyebrow">Email preview</div>
        <p className="mt-2 text-sm font-medium text-fg">
          Subject: {event.title} — the details have changed
        </p>
        <dl className="mt-4 space-y-3">
          {Object.entries(changes).map(([field, change]) => (
            <div key={field}>
              <dt className="text-xs tracking-wide text-dim">
                {NOTIFIABLE_FIELDS[field as keyof typeof NOTIFIABLE_FIELDS] ?? field}
              </dt>
              <dd className="text-sm text-fg">
                <span className="text-dim line-through">{show(change.from, event.timezone)}</span>
                {' → '}
                <span>{show(change.to, event.timezone)}</span>
              </dd>
            </div>
          ))}
        </dl>
        {note.trim() && (
          <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed whitespace-pre-wrap text-fg">
            {note.trim()}
          </p>
        )}
        <p className="mt-4 border-t border-line pt-4 text-xs text-muted">
          Goes to {audience} {audience === 1 ? 'person' : 'people'} with a confirmed place. Each one
          gets their own copy — nobody sees who else is on the list.
        </p>
      </div>

      <div className="mt-5">
        <Field
          label="Anything you want to add"
          hint="Optional. Your words appear under the changed details."
        >
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="We've moved next door — same street, bigger room."
          />
        </Field>
      </div>

      {stale && (
        <div className="mt-5">
          <Notice tone="error">
            The event changed again after this preview was built, so it is describing details that
            are no longer what you are about to save.{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setBuiltFrom(fingerprint)}
            >
              Build the preview again
            </button>
            .
          </Notice>
        </div>
      )}

      <div className="mt-7 space-y-3">
        <Button
          variant="primary"
          className="w-full"
          loading={busy === 'notify'}
          disabled={stale || busy !== null || audience === 0}
          onClick={async () => {
            setBusy('notify')
            await onSaveAndNotify(note)
            setBusy(null)
            setNote('')
          }}
        >
          Save and email {audience} {audience === 1 ? 'person' : 'people'}
        </Button>
        <Button
          className="w-full"
          loading={busy === 'save'}
          disabled={busy !== null}
          onClick={async () => {
            setBusy('save')
            await onSaveOnly()
            setBusy(null)
            setNote('')
          }}
        >
          Save without telling anybody
        </Button>
        <Button variant="ghost" className="w-full" disabled={busy !== null} onClick={onClose}>
          Go back and keep editing
        </Button>
      </div>

      {audience === 0 && (
        <p className="mt-4 text-xs text-dim">
          There is nobody to notify yet — no one has a confirmed place on this event. Saving is the
          only thing to do here, and everybody who registers from now on sees the new details.
        </p>
      )}
    </Modal>
  )
}

function show(value: unknown, timeZone: string): string {
  if (value === null || value === undefined || String(value).trim() === '') return 'not set'
  const text = String(value)
  // The two notifiable fields that hold a timestamp read as gibberish raw.
  return /^\d{4}-\d{2}-\d{2}T/.test(text)
    ? new Date(text).toLocaleString(undefined, { timeZone, timeZoneName: 'short' })
    : text
}

/**
 * Timezones for the picker. The browser knows the full list; the fallback is
 * the handful this network actually runs events in, plus whatever the event
 * already says, so an unusual zone set elsewhere is never silently dropped.
 */
function timezones(current: string): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  const all = supported
    ? supported('timeZone')
    : ['Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'UTC']
  return all.includes(current) ? all : [current, ...all]
}

/** A remedy inside the app stays in the app; only Stripe opens a new tab. */
function RemedyLink({ href, label, className }: { href: string; label: string; className: string }) {
  const style = `${className} inline-block text-xs text-gold underline underline-offset-2`
  return href.startsWith('http') ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={style}>
      {label}
    </a>
  ) : (
    <Link to={href} className={style}>
      {label}
    </Link>
  )
}
