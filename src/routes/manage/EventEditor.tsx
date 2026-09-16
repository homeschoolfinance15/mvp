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

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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
import { useAuth } from '../../context/AuthProvider'
import { errorMessage, functionError, loadFailed, supabase } from '../../lib/supabase'
import { eventLink, eventWhen, type EventRecord, type TicketType } from '../../lib/events'
import { ACCEPT_ATTR, uploadMedia } from '../../lib/media'
import {
  COHOST_MONEY_NOTE,
  NOTIFIABLE_FIELDS,
  changedDetails,
  lockedSentence,
  paymentBlockers,
  paymentRecipientSentence,
  previewFingerprint,
  slugify,
  validateEvent,
  whyNoCreate,
  type Blocker,
  type ChangedDetails,
  type PaymentAccount,
} from './rules'
import {
  Explainer,
  Fact,
  ManageShell,
  ManagedEventGate,
  SaveState,
  fromLocalInput,
  refusal,
  toLocalInput,
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
    if (Object.keys(found).length > 0) return

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
        status: 'draft',
        // The trigger fills this when it is blank, but sending a readable one
        // means the link matches the title people were told about (EVT-01).
        slug: slugify(title),
        payment_connector_id: (connector as { id: string } | null)?.id ?? null,
        payment_recipient_id: profile.id,
      })
      .select('id')
      .single()

    setBusy(false)
    if (error || !data) {
      setFailure(errorMessage(error))
      return
    }
    navigate(`/manage/events/${(data as { id: string }).id}`, { replace: true })
  }

  const blocked = canCreate === null ? null : whyNoCreate(profile?.role, canCreate)

  return (
    <DashboardShell
      title="Create an event"
      caption="A title and a start time make a draft. Nobody can see a draft but you and your cohosts."
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
              hint="Your own local time for now. You can set the event's timezone on the next screen."
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
              <Button type="button" onClick={() => navigate('/manage/events')}>
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
    starts_at: toLocalInput(event.starts_at),
    ends_at: toLocalInput(event.ends_at),
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
    starts_at: fromLocalInput(draft.starts_at) ?? '',
    ends_at: fromLocalInput(draft.ends_at),
    timezone: draft.timezone,
    venue_name: draft.venue_name.trim() || null,
    address: draft.address.trim() || null,
    attendee_instructions: draft.attendee_instructions.trim() || null,
    refund_terms: draft.refund_terms.trim() || null,
    capacity: draft.capacity.trim() === '' ? null : Number(draft.capacity),
    registration_closed: draft.registration_closed,
    currency: draft.currency,
    feedback_opens_after_minutes: Number(draft.feedback_opens_after_minutes) || 120,
  }
}

function priceCents(price: string): number {
  return Math.round((Number(price) || 0) * 100)
}

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
  const [confirming, setConfirming] = useState<'publish' | 'unpublish' | 'cancel' | null>(null)
  const [account, setAccount] = useState<PaymentAccount | null>(null)
  const [hosts, setHosts] = useState<Array<{ id: string; name: string; role: string }>>([])
  const [audience, setAudience] = useState(0)

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftOf(event)) ||
    JSON.stringify(ticketDrafts) !== JSON.stringify(ticketsOf(tickets)) ||
    removedTickets.length > 0
  useWarnOnUnsaved(dirty)

  const locked = paymentLockedAt(event)
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
            .select('id, profile_id, stripe_account_id, stripe_charges_enabled, stripe_account_status')
            .eq('id', event.payment_connector_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('profiles').select('id, full_name, role').in('id', hostIds),
      supabase
        .from('event_registrations')
        .select('id')
        .eq('event_id', event.id)
        .eq('status', 'confirmed'),
    ])

    if (event.payment_connector_id) {
      const row = connectorRes.data as {
        id: string
        profile_id: string
        stripe_account_id: string | null
        stripe_charges_enabled: boolean
        stripe_account_status: string
      } | null
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
        row
          ? {
              connectorId: row.id,
              name: ownerName,
              stripeAccountId: row.stripe_account_id,
              chargesEnabled: row.stripe_charges_enabled,
              status: row.stripe_account_status,
            }
          : null,
      )
    } else {
      setAccount({
        connectorId: null,
        name: 'Amazing',
        stripeAccountId: null,
        chargesEnabled: true,
        status: 'ready',
      })
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
  }, [event.id, event.payment_connector_id, hostIds])

  useEffect(() => {
    void loadSurroundings()
  }, [loadSurroundings])

  const blockers: Blocker[] = useMemo(
    () =>
      paymentBlockers(
        ticketDrafts
          .filter((t) => t.is_active)
          .map(
            (t) =>
              ({
                is_active: t.is_active,
                price_cents: priceCents(t.price),
              }) as TicketType,
          ),
        account,
      ),
    [ticketDrafts, account],
  )

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
  async function save(): Promise<boolean> {
    setProblem('')
    const found = validateEvent(columns)
    for (const t of ticketDrafts) {
      if (!t.name.trim()) found.tickets = 'Every ticket option needs a name.'
      if (priceCents(t.price) < 0) found.tickets = 'A price cannot be negative.'
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return false

    setSaving(true)

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
      setProblem(errorMessage(error))
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
   * ORG-11. The order matters. The email is queued while the registrations are
   * still live, because the audience is resolved from them — cancel first and
   * there is nobody left to tell.
   */
  async function cancelEvent() {
    setProblem('')
    setSaving(true)

    const { error: mailError } = await supabase.functions.invoke('event-email', {
      body: { kind: 'cancelled', event_id: event.id, send_now: true },
    })
    const mailProblem = mailError ? await functionError(mailError) : ''

    const { error } = await supabase.from('events').update({ status: 'cancelled' }).eq('id', event.id)
    if (error) {
      setSaving(false)
      setProblem(errorMessage(error))
      return
    }

    // Reminders and the feedback request are no longer wanted. Cancelled
    // rather than deleted: the history of what was going to be sent stays.
    const { error: stopError } = await supabase
      .from('event_messages')
      .update({ status: 'cancelled', error: 'The event was cancelled.' })
      .eq('event_id', event.id)
      .eq('status', 'scheduled')
      .in('kind', ['reminder', 'feedback_open'])

    setSaving(false)
    setConfirming(null)
    await reload()
    setOutcome(
      <>
        Cancelled. Registration is closed, tickets no longer admit anybody, and pending reminders
        and feedback requests have been stopped.{' '}
        {mailProblem
          ? `Attendees were NOT emailed: ${mailProblem} You can send the cancellation again from the Emails tab.`
          : 'Attendees have been emailed.'}
        {stopError ? ` Some scheduled emails may still be queued: ${errorMessage(stopError)}` : ''}{' '}
        Paid orders and their refunds are listed under Results.
      </>,
    )
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

  const canPublish = blockers.length === 0

  return (
    <ManageShell event={event} current="details">
      {/* ORG-02 / QLT-03. The save state and the actions travel with the page
          rather than sitting at the bottom of a long form. */}
      <div className="sticky top-14 z-20 -mx-5 mb-8 border-b border-line bg-ink/90 px-5 py-3 backdrop-blur-md sm:-mx-8 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <SaveState dirty={dirty} saving={saving} savedAt={savedAt} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => window.open(eventLink(event.slug), '_blank', 'noopener')}
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
            {event.status === 'published' && !finished && (
              <Button size="sm" onClick={() => setConfirming('unpublish')}>
                Take down
              </Button>
            )}
            {event.status !== 'cancelled' && !finished && (
              <Button size="sm" variant="danger" onClick={() => setConfirming('cancel')}>
                Cancel event
              </Button>
            )}
            <Button size="sm" variant="primary" loading={saving} onClick={() => void saveClicked()}>
              Save changes
            </Button>
          </div>
        </div>
      </div>

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
        update also stands permanently on the Emails tab, so the action never
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
              Send an update from the Emails tab
            </button>{' '}
            whenever you are ready.
          </Notice>
        </div>
      )}

      {event.status === 'cancelled' && (
        <div className="mb-6">
          <Notice tone="error">
            This event was cancelled
            {event.cancelled_at ? ` on ${new Date(event.cancelled_at).toLocaleDateString()}` : ''}.
            It is kept here as a record: the guest list, the orders and the refunds all stay
            readable.
          </Notice>
        </div>
      )}

      <div className="space-y-10">
        <Section title="The event itself">
          <Field label="Title" error={errors.title}>
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>

          <Field
            label="Description"
            hint="What this is and who it is for. Editing this does not interrupt anybody."
          >
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
            {event.published_at && (
              <span className="block text-xs text-dim">
                Fixed now that the event has been published — people already have this link.
              </span>
            )}
          </Fact>
        </Section>

        <Section
          title="When and where"
          caption="Changing any of these interrupts people's plans, so saving them offers to tell attendees."
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
            hint="The boxes above are in your own local time. Attendees see the event's time, in this zone."
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

          <Field label="Venue">
            <Input
              value={draft.venue_name}
              onChange={(e) => setDraft({ ...draft, venue_name: e.target.value })}
              placeholder="The Clove Club"
            />
          </Field>

          <Field label="Address">
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

        <Section
          title="Places"
          caption="ORG-03. Every ticket option draws on the same limit — the options divide the room, they do not add to it."
        >
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
                ORG-03A. Different from selling out: the event page says you closed it, not that it
                filled up.
              </span>
            </span>
          </label>
        </Section>

        <Section
          title="Ticket options"
          caption="ORG-04. Free or paid. Prices are in the event's currency."
        >
          <div className="mb-5 w-40">
            <Field label="Currency">
              <Select
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                disabled={Boolean(locked)}
              >
                {['gbp', 'eur', 'usd'].map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {errors.tickets && (
            <div className="mb-4">
              <Notice tone="error">{errors.tickets}</Notice>
            </div>
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
                    <Field label="Availability" hint="Empty shares the event limit">
                      <Input
                        type="number"
                        min={0}
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
              ORG-10. Changing a price never changes what somebody has already paid. Their order
              keeps the amount they were charged, and any refund is calculated from that, not from
              the price shown here today.
            </Explainer>
          </div>
        </Section>

        <PaymentPanel
          account={account}
          blockers={blockers}
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
            hint="BUY-15. Shown before anybody pays, and kept with their order exactly as it read then."
          >
            <Textarea
              rows={3}
              value={draft.refund_terms}
              onChange={(e) => setDraft({ ...draft, refund_terms: e.target.value })}
            />
          </Field>
          <Field
            label="Feedback opens this many minutes after the event ends"
            hint="FDB-15. Two hours by default."
          >
            <div className="w-40">
              <Input
                type="number"
                min={0}
                value={draft.feedback_opens_after_minutes}
                onChange={(e) =>
                  setDraft({ ...draft, feedback_opens_after_minutes: e.target.value })
                }
              />
            </div>
          </Field>
        </Section>
      </div>

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
                'Nothing about the event was undone — you can send the update from the Emails tab.',
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
              'The Emails tab shows what happens to each copy.',
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
            {blockers.length > 0 && ' Paid tickets cannot go on sale yet — see the payment section.'}
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
            It goes back to a draft: nobody can find it and the link stops working. Anybody who has
            already registered keeps their place and their ticket, and nobody is emailed. Cancelling
            is the thing that tells people it is off.
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
  blockers,
  locked,
  event,
  isAdmin,
  onChanged,
  onProblem,
}: {
  account: PaymentAccount | null
  blockers: Blocker[]
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
      <SectionHeader
        title="Who receives the ticket money"
        caption="Decided by whoever created the event. Shown here before anything can be sold."
      />
      <Panel className="space-y-5 px-6 py-6">
        <div className="rounded-sm border border-line-strong bg-raised px-5 py-4">
          <div className="eyebrow">Payment account</div>
          <p className="mt-2 text-sm leading-relaxed text-fg">
            {account
              ? paymentRecipientSentence(account, overridden)
              : 'No account has been set to receive money for this event.'}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted">{COHOST_MONEY_NOTE}</p>
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
                BUY-14. Only for the case where Amazing sets an event up on a partner's behalf. It
                is never the default, and it cannot be changed once anybody has paid.
              </p>
            </div>
          )
        )}

        {blockers.length > 0 && (
          <div className="space-y-3">
            <Notice tone="error">
              Paid tickets cannot go on sale until this is sorted. Free tickets are unaffected, and
              anybody who has already bought keeps their booking, their ticket and their right to a
              refund.
            </Notice>
            {blockers.map((b) => (
              <div key={b.problem} className="rounded-sm border border-line px-5 py-4">
                <p className="text-sm text-fg">{b.problem}</p>
                <p className="mt-1.5 text-sm text-muted">{b.fix}</p>
                {b.href && (
                  <a
                    href={b.href}
                    className="mt-2 inline-block text-xs text-gold underline underline-offset-2"
                  >
                    Open payment setup
                  </a>
                )}
              </div>
            ))}
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
  const [candidates, setCandidates] = useState<Array<{ id: string; full_name: string; role: string }>>(
    [],
  )
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    void supabase
      .from('member_directory')
      .select('id, full_name, role')
      .in('role', ['connector', 'admin'])
      .order('full_name')
      .then(({ data, error }) => {
        if (error) {
          loadFailed(error, 'the people who can cohost')
          return
        }
        setCandidates((data as Array<{ id: string; full_name: string; role: string }>) ?? [])
      })
  }, [])

  const addable = candidates.filter((c) => !hosts.some((h) => h.id === c.id))

  return (
    <section>
      <SectionHeader
        title="Hosting team"
        caption="ORG-05. Everybody here is named as a host on the event page."
      />
      <Panel className="space-y-5 px-6 py-6">
        <Explainer>
          Being <span className="text-fg">listed as a host</span> is what attendees read on the
          event page. What that account <span className="text-fg">may do</span> is separate: a
          cohost can edit this event, invite people to it, check them in and email its attendees —
          on <span className="text-fg">this event only</span>. It gives them nothing on your other
          events, nothing in your community, and no share of the money.
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
            <Field label="Add a cohost" hint="Connectors and administrators can host.">
              <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Choose somebody…</option>
                {addable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}
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
                <span className="text-dim line-through">{show(change.from)}</span>
                {' → '}
                <span>{show(change.to)}</span>
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

function show(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') return 'not set'
  const text = String(value)
  // The two notifiable fields that hold a timestamp read as gibberish raw.
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? new Date(text).toLocaleString() : text
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
