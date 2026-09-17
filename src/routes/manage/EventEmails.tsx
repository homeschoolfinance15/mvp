/**
 * Everything this event will email, has emailed, or failed to email.
 *
 * The distinction this screen exists to hold on to (EML-08): saving a setting,
 * queueing a message and sending a message are three different things, and
 * none of them is "delivered". The strongest claim anywhere on this page is
 * that a mail provider accepted a copy. Whether it landed in an inbox, and
 * whether anybody read it, we do not know and do not pretend to.
 *
 * EML-02 is the other one. Reminders are the only emails an organiser
 * switches off, and turning them off is not turning email off — the
 * confirmations, receipts, cancellations, refunds and feedback requests are
 * the platform keeping its promises to attendees, not the organiser's
 * marketing. So the full list is on screen with its triggers, said plainly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Notice,
  Panel,
  SectionHeader,
  Select,
  Textarea,
  formatDateTime,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { useLive } from '../../lib/live'
import { errorMessage, functionError, loadFailed, supabase } from '../../lib/supabase'
import { eventWhen, type EventMessage, type EventRecord } from '../../lib/events'
import {
  AUTOMATIC_MESSAGES,
  MESSAGE_AUDIENCE,
  MESSAGE_STATUS_TONE,
  MESSAGE_STATUS_WORDS,
  NOTIFIABLE_FIELDS,
  REMINDER_CHOICES,
  reminderAt,
  reminderLabel,
  reminderWillSkip,
  skippedSentence,
} from './rules'
import {
  Explainer,
  ManageShell,
  ManagedEventGate,
  Row,
  Rows,
  SaveState,
  useManagedEvent,
  useWarnOnUnsaved,
  type ManagedEvent,
} from './shared'

export default function EventEmails() {
  const { id } = useParams()
  const { result, reload } = useManagedEvent(id)
  return (
    <ManagedEventGate result={result} reload={reload}>
      {(data) => <Emails key={data.event.id} data={data} />}
    </ManagedEventGate>
  )
}

/**
 * EML-08. Four readings, not two. `inert` is what keeps "cancelled" and
 * "skipped" out of the red reserved for something that actually went wrong.
 */
const STATUS_TEXT: Record<'good' | 'waiting' | 'bad' | 'inert', string> = {
  good: 'text-positive',
  waiting: 'text-muted',
  bad: 'text-negative',
  inert: 'text-dim',
}

interface ReminderDraft {
  id: string
  key: string
  minutes: number
  enabled: boolean
}

interface HistoryRow extends EventMessage {
  sentCount: number
  failedCount: number
  pendingCount: number
  triggeredByName: string | null
}

function Emails({ data }: { data: ManagedEvent }) {
  const { profile } = useAuth()
  const { event } = data

  const [enabled, setEnabled] = useState(true)
  const [reminders, setReminders] = useState<ReminderDraft[]>([])
  const [stored, setStored] = useState<{ enabled: boolean; reminders: ReminderDraft[] }>({
    enabled: true,
    reminders: [],
  })
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  const [outcome, setOutcome] = useState('')
  const [previewing, setPreviewing] = useState<ReminderDraft | null>(null)
  const [updating, setUpdating] = useState(false)

  const dirty =
    enabled !== stored.enabled || JSON.stringify(reminders) !== JSON.stringify(stored.reminders)
  useWarnOnUnsaved(dirty)

  // `quiet` keeps the page on screen for a reload nobody asked for. The send
  // status below is a thing hosts sit and watch; swapping it for a spinner
  // every few seconds would make watching it impossible.
  const load = useCallback(async (quiet = false) => {
    setFailed(false)
    if (!quiet) setLoading(true)

    const [settingsRes, reminderRes, messageRes] = await Promise.all([
      supabase
        .from('event_email_settings')
        .select('reminders_enabled')
        .eq('event_id', event.id)
        .maybeSingle(),
      supabase
        .from('event_reminders')
        .select('id, minutes_before, enabled')
        .eq('event_id', event.id)
        .order('minutes_before', { ascending: true }),
      supabase
        .from('event_messages')
        .select('*, event_message_recipients(status)')
        .eq('event_id', event.id)
        .order('created_at', { ascending: false })
        .limit(100),
    ])

    if (reminderRes.error && messageRes.error) {
      loadFailed(reminderRes.error, 'this event’s emails')
      setFailed(true)
      setLoading(false)
      return
    }

    const on = (settingsRes.data as { reminders_enabled?: boolean } | null)?.reminders_enabled ?? true
    const rows: ReminderDraft[] = (
      (reminderRes.data as Array<{ id: string; minutes_before: number; enabled: boolean }>) ?? []
    ).map((r) => ({ id: r.id, key: r.id, minutes: r.minutes_before, enabled: r.enabled }))

    setEnabled(on)
    setReminders(rows)
    setStored({ enabled: on, reminders: rows })

    type MessageRow = EventMessage & {
      event_message_recipients: Array<{ status: string }> | null
    }
    const messages = (messageRes.data as unknown as MessageRow[]) ?? []

    // EML-08. Who set an organiser-written update going is part of the record,
    // and it is a separate query because `event_messages` is not the only
    // table on this screen pointing at `profiles`.
    const actorIds = [...new Set(messages.map((m) => m.triggered_by).filter(Boolean))] as string[]
    const { data: actorRows } = actorIds.length
      ? await supabase.from('profiles').select('id, full_name').in('id', actorIds)
      : { data: [] }
    const actors = new Map(
      ((actorRows as Array<{ id: string; full_name: string }>) ?? []).map((a) => [a.id, a.full_name]),
    )

    setHistory(
      messages.map((m) => {
        const people = m.event_message_recipients ?? []
        return {
          ...m,
          sentCount: people.filter((r) => r.status === 'sent').length,
          failedCount: people.filter((r) => r.status === 'failed').length,
          pendingCount: people.filter((r) => r.status === 'scheduled' || r.status === 'queued')
            .length,
          triggeredByName: m.triggered_by ? (actors.get(m.triggered_by) ?? null) : null,
        }
      }),
    )
    setLoading(false)
  }, [event.id])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * EML-08. "Sent 41, failed 2" is the one number on this screen somebody
   * actually waits in front of: a send is queued, worked through and finished
   * over the following minutes, and until now watching it meant refreshing.
   * Recipients are watched as well as messages, because the counts are
   * composed from the recipient rows and the message row does not change as
   * they land.
   *
   * QLT-03 is why this is conditional, and this page is the sharpest case of
   * it in the product. `load` calls `setEnabled` and `setReminders`, which is
   * the host's reminder schedule — a draft, with `dirty` and an unsaved-work
   * warning already built around it. A reload while they are part-way through
   * changing it would silently put it back, and they would find out when the
   * reminders they thought they had set never went. So: only while there is
   * nothing unsaved, and not at all while they are composing an update to
   * everybody registered. Saving clears `dirty` and the watch resumes.
   */
  useLive(['event_messages', 'event_message_recipients'], () => void load(true), {
    enabled: !dirty && !updating,
  })

  /* ---------------------------------------------------------------------- */

  async function save() {
    if (!profile) return
    setProblem('')
    setSaving(true)

    const problems: string[] = []

    const { error: settingsError } = await supabase.from('event_email_settings').upsert(
      {
        event_id: event.id,
        reminders_enabled: enabled,
        updated_by: profile.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'event_id' },
    )
    if (settingsError) problems.push(errorMessage(settingsError))

    const gone = stored.reminders.filter((r) => !reminders.some((n) => n.id === r.id))
    if (gone.length > 0) {
      const { error } = await supabase
        .from('event_reminders')
        .delete()
        .in('id', gone.map((r) => r.id))
      if (error) problems.push(`A reminder time could not be removed: ${errorMessage(error)}`)
    }

    for (const r of reminders) {
      const row = { event_id: event.id, minutes_before: r.minutes, enabled: r.enabled }
      const { error } = r.id
        ? await supabase.from('event_reminders').update(row).eq('id', r.id)
        : await supabase.from('event_reminders').insert(row)
      if (error) {
        problems.push(`${reminderLabel(r.minutes)} could not be saved: ${errorMessage(error)}`)
      }
    }

    setSaving(false)
    if (problems.length > 0) {
      setProblem(problems.join(' '))
      return
    }
    setSavedAt(new Date().toISOString())
    setOutcome(
      'Reminder settings saved. Saving only changes what is scheduled — nothing has been sent.',
    )
    await load()
  }

  /**
   * EML-08. A retry re-opens the message. The dispatcher only ever picks up
   * recipients still sitting at `scheduled` or `failed`, so the people who
   * already received a copy are not written to a second time — which is why
   * this is one status update rather than a resend.
   */
  async function retry(message: HistoryRow) {
    setProblem('')

    const { data, error } = await supabase.rpc('retry_failed_recipients', {
      p_message: message.id,
    })
    if (error) {
      setProblem(errorMessage(error))
      return
    }

    const reopened = Number(data ?? 0)
    if (reopened === 0) {
      setOutcome('Nothing was still outstanding on that message, so nothing was queued again.')
      await load()
      return
    }

    /*
     * An admin can push it straight out; a connector-host cannot, because the
     * dispatcher takes an admin token or the shared cron secret and neither is
     * theirs. That refusal is not a failure and must not read as one — the
     * recipients are already re-opened in the database, and the schedule takes
     * them on its next sweep. So the nudge is best effort and its outcome is
     * deliberately not reported.
     */
    await supabase.functions.invoke('event-mailer', { body: { message_id: message.id } })

    setOutcome(
      `Queued to send again for the ${reopened} ${reopened === 1 ? 'person' : 'people'} it failed for. ` +
        'Nobody who already received it is written to again. It goes out on the next sweep, within a few minutes.',
    )
    await load()
  }

  const capacityNote = useMemo(
    () => eventWhen({ starts_at: event.starts_at, ends_at: event.ends_at, timezone: event.timezone }),
    [event.starts_at, event.ends_at, event.timezone],
  )

  return (
    <ManageShell event={event} current="emails">
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

      {/* ORG-16. The reminder schedule is meaningless without the event's own
          clock next to it, so both are stated before anything is set. */}
      <Panel className="mb-8 px-6 py-5">
        <div className="eyebrow">This event runs</div>
        <p className="mt-2 text-sm text-fg">{capacityNote}</p>
        <p className="mt-1 text-xs text-dim">
          Timezone {event.timezone}. Reminder times below are counted back from the start and are
          shown in that zone.
        </p>
      </Panel>

      <SectionHeader
        title="Reminders before the event"
        caption="ORG-16. Off, on, and how far ahead. Nothing here changes anything until you save."
        action={<SaveState dirty={dirty} saving={saving} savedAt={savedAt} />}
      />

      <Panel className="space-y-6 px-6 py-6">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-1 size-3.5 accent-gold-dim"
          />
          <span>
            Send reminder emails for this event
            <span className="block text-xs text-dim">
              Currently {enabled ? 'on' : 'off'}
              {dirty ? ' in this form — not yet saved' : ''}.
            </span>
          </span>
        </label>

        {loading ? (
          <EmptyState>Loading the schedule…</EmptyState>
        ) : failed ? (
          <EmptyState>
            We couldn't load the reminder schedule just now.{' '}
            <button
              type="button"
              onClick={() => void load()}
              className="underline underline-offset-2"
            >
              Try again
            </button>
          </EmptyState>
        ) : reminders.length === 0 ? (
          <EmptyState>No reminder times set. Nobody will be reminded about this event.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {reminders.map((r, i) => {
              const at = reminderAt(event.starts_at, r.minutes)
              const skips = reminderWillSkip(event.starts_at, r.minutes)
              return (
                <li key={r.key} className="rounded-sm border border-line px-5 py-4">
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="w-48">
                      <Field label="How far ahead">
                        <Select
                          value={String(r.minutes)}
                          onChange={(e) =>
                            setReminders((rows) =>
                              rows.map((row, j) =>
                                j === i ? { ...row, minutes: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        >
                          {[...new Set([...REMINDER_CHOICES, r.minutes])]
                            .sort((a, b) => a - b)
                            .map((m) => (
                              <option key={m} value={m}>
                                {reminderLabel(m)}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    </div>

                    <div className="min-w-0 flex-1 text-xs">
                      <div className="eyebrow">Would go out</div>
                      <div className="mt-1.5 text-sm text-fg">
                        {at.toLocaleString(undefined, { timeZone: event.timezone })}{' '}
                        <span className="text-dim">({event.timezone})</span>
                      </div>
                      {skips && (
                        <div className="mt-1 text-dim">
                          This event is sooner than this reminder, so it will not be sent — nothing
                          is wrong, its moment has simply already passed. Sending it now would tell
                          people about an event that has already started.
                        </div>
                      )}
                      {!enabled && (
                        <div className="mt-1 text-dim">
                          Reminders are switched off, so this will not be sent.
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-4">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={(e) =>
                            setReminders((rows) =>
                              rows.map((row, j) =>
                                j === i ? { ...row, enabled: e.target.checked } : row,
                              ),
                            )
                          }
                          className="size-3.5 accent-gold-dim"
                        />
                        On
                      </label>
                      <button
                        type="button"
                        onClick={() => setPreviewing(r)}
                        className="text-xs text-dim transition-colors hover:text-fg"
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        onClick={() => setReminders((rows) => rows.filter((_, j) => j !== i))}
                        className="text-xs text-dim transition-colors hover:text-negative"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            size="sm"
            onClick={() =>
              setReminders((rows) => [
                ...rows,
                {
                  id: '',
                  key: `new-${rows.length}-${Date.now()}`,
                  minutes:
                    REMINDER_CHOICES.find((m) => !rows.some((r) => r.minutes === m)) ?? 1440,
                  enabled: true,
                },
              ])
            }
          >
            Add a reminder time
          </Button>
          <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            Save reminder settings
          </Button>
        </div>
      </Panel>

      {/* ------------------------------------------------------------------ */}

      <div className="mt-12">
        <SectionHeader
          title="What attendees will receive"
          caption="EML-01. Every email this event sends on its own, what sets it off, who gets it, and what it tells them."
        />
        <Rows>
          {AUTOMATIC_MESSAGES.map((m) => (
            <Row key={m.situation}>
              <span className="min-w-0 flex-1 sm:max-w-64">
                <span className="block text-sm text-fg">{m.situation}</span>
                <span className="block text-xs text-dim">{m.trigger}</span>
              </span>
              <span className="min-w-0 text-xs text-muted sm:w-44">
                <span className="eyebrow block">Goes to</span>
                <span className="mt-1 block">{m.recipient}</span>
              </span>
              <span className="min-w-0 flex-1 text-xs text-muted">
                <span className="eyebrow block">Makes clear</span>
                <span className="mt-1 block leading-relaxed">{m.makesClear}</span>
              </span>
              <span className="text-xs sm:w-32">
                {m.organiserControlled ? (
                  <span className="text-[#8a4b00]">
                    {enabled ? 'You have these on' : 'You have these off'}
                  </span>
                ) : (
                  <span className="text-dim">Always sent</span>
                )}
              </span>
            </Row>
          ))}
        </Rows>
        <div className="mt-4">
          <Explainer>
            EML-02. Switching reminders off stops the reminder emails and nothing else. The
            registration confirmation, the payment confirmation, the attendee's own cancellation
            notice, refund updates, the event-cancellation notice and the feedback request all
            still go out — those are the platform keeping the promises it made to the people
            attending, not your marketing, and they are not yours to switch off.
          </Explainer>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}

      <div className="mt-12">
        <SectionHeader
          title="Scheduled and sent"
          caption="EML-08. Saved, queued and sent are three different things, and none of them is delivered or read."
          action={
            <Button size="sm" onClick={() => setUpdating(true)} disabled={event.status !== 'published'}>
              Send an update to attendees
            </Button>
          }
        />

        {history.length === 0 ? (
          <EmptyState>Nothing has been queued for this event yet.</EmptyState>
        ) : (
          <Rows>
            {history.map((m) => (
              <Row key={m.id}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg">
                    {m.subject ??
                      AUTOMATIC_MESSAGES.find((a) => a.kinds.includes(m.kind))?.situation ??
                      m.kind}
                  </span>
                  <span className="block text-xs text-dim">
                    {MESSAGE_AUDIENCE[m.kind] ?? 'The people this event concerns'}
                    {m.audience_count !== null ? ` · ${m.audience_count} intended` : ''}
                    {m.triggeredByName ? ` · sent by ${m.triggeredByName}` : ''}
                  </span>
                  {m.changed_details && Object.keys(m.changed_details).length > 0 && (
                    <span className="block text-xs text-dim">
                      About:{' '}
                      {Object.keys(m.changed_details)
                        .map(
                          (f) =>
                            NOTIFIABLE_FIELDS[f as keyof typeof NOTIFIABLE_FIELDS]?.toLowerCase() ??
                            f,
                        )
                        .join(', ')}
                    </span>
                  )}
                </span>

                {/*
                  EML-06. `skipped` gets its own quiet treatment and its own
                  sentence. It is the one status in this list that is neither a
                  success nor a problem, and an organiser who reads a bare
                  "Skipped" sitting next to "Failed" concludes something broke.
                */}
                <span className="text-xs sm:w-56">
                  <span className={STATUS_TEXT[MESSAGE_STATUS_TONE[m.status]]}>
                    {MESSAGE_STATUS_WORDS[m.status]}
                  </span>
                  <span className="block text-dim">
                    {m.sent_at
                      ? formatDateTime(m.sent_at)
                      : m.scheduled_for
                        ? `for ${formatDateTime(m.scheduled_for)}`
                        : ''}
                  </span>
                  {m.status === 'skipped' && (
                    <span className="mt-1 block leading-relaxed text-dim">
                      {skippedSentence(m.kind, m.error)}
                    </span>
                  )}
                </span>

                <span className="text-xs sm:w-44">
                  <span className="text-muted">
                    {m.sentCount} sent
                    {m.pendingCount > 0 ? ` · ${m.pendingCount} waiting` : ''}
                  </span>
                  {m.failedCount > 0 && (
                    <span className="block text-negative">{m.failedCount} failed</span>
                  )}
                  {m.error && m.status !== 'skipped' && (
                    <span className="block text-dim">{m.error}</span>
                  )}
                </span>

                {m.failedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void retry(m)}
                    className="text-xs text-dim transition-colors hover:text-fg"
                  >
                    Retry the {m.failedCount} that failed
                  </button>
                )}
              </Row>
            ))}
          </Rows>
        )}

        <div className="mt-4">
          <Explainer>
            "Sent" here means the mail provider accepted a copy for that person. It is not a
            delivery receipt and it is not a read receipt — we do not know either, and neither does
            anybody who tells you otherwise. A retry only touches the addresses that failed.
          </Explainer>
        </div>
      </div>

      <ReminderPreview event={event} reminder={previewing} onClose={() => setPreviewing(null)} />

      <UpdateModal
        open={updating}
        eventId={event.id}
        onClose={() => setUpdating(false)}
        onSent={async (message) => {
          setUpdating(false)
          setOutcome(message)
          await load()
        }}
        onProblem={(message) => {
          setUpdating(false)
          setProblem(message)
        }}
      />
    </ManageShell>
  )
}

/* -------------------------------------------------------------------------- */
/* ORG-16 — what a reminder will actually say                                  */
/* -------------------------------------------------------------------------- */

function ReminderPreview({
  event,
  reminder,
  onClose,
}: {
  event: EventRecord
  reminder: ReminderDraft | null
  onClose: () => void
}) {
  if (!reminder) return null
  const at = reminderAt(event.starts_at, reminder.minutes)

  return (
    <Modal open title="Reminder preview" onClose={onClose}>
      <div className="rounded-sm border border-line bg-raised px-5 py-4">
        <div className="eyebrow">Subject</div>
        <p className="mt-1.5 text-sm font-medium text-fg">{event.title} — {reminderLabel(reminder.minutes).replace(' before', '')} away</p>

        <div className="mt-4 eyebrow">Body</div>
        <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-fg">
          <p>A reminder that {event.title} is coming up.</p>
          <p>
            {eventWhen({
              starts_at: event.starts_at,
              ends_at: event.ends_at,
              timezone: event.timezone,
            })}
          </p>
          {(event.venue_name || event.address) && (
            <p>{[event.venue_name, event.address].filter(Boolean).join(', ')}</p>
          )}
          {event.attendee_instructions && (
            <p className="whitespace-pre-wrap">{event.attendee_instructions}</p>
          )}
          <p className="text-dim">Their ticket and a link to it travel with every reminder.</p>
        </div>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-dim">
        Goes out {at.toLocaleString(undefined, { timeZone: event.timezone })} ({event.timezone}), to
        everybody with a confirmed place at that moment — not to the list as it stands today.
        Somebody who cancels in the meantime is dropped before it sends.
      </p>

      <div className="mt-7">
        <Button className="w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* EML-08 — telling attendees something, later                                 */
/* -------------------------------------------------------------------------- */

/**
 * The standing version of the notification offered by the editor.
 *
 * ORG-10: somebody who saved a change without telling anybody comes here to
 * put it right. It carries no `changed_details`, because by now the change is
 * whatever the event already says — this is the organiser's own words about
 * an event people have registered for.
 */
function UpdateModal({
  open,
  eventId,
  onClose,
  onSent,
  onProblem,
}: {
  open: boolean
  eventId: string
  onClose: () => void
  onSent: (message: string) => Promise<void>
  onProblem: (message: string) => void
}) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  async function send() {
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('event-email', {
      body: {
        kind: 'update',
        event_id: eventId,
        subject: subject.trim() || null,
        body: body.trim(),
        send_now: true,
      },
    })
    setBusy(false)
    if (error) {
      onProblem(`Nothing was sent: ${await functionError(error)}`)
      return
    }
    /*
     * The reply's count, not the one the screen guessed. And `audience_count:
     * 0` with a null message id is a 200, not a failure: an event nobody has
     * registered for yet has nobody to write to, which is a fact rather than
     * a fault. `dispatched: false` is not surfaced either — the message is
     * queued and the schedule takes it within a few minutes.
     */
    const count = (data as { audience_count?: number } | null)?.audience_count ?? 0
    setSubject('')
    setBody('')
    await onSent(
      count === 0
        ? 'There is nobody to notify yet — no one has a confirmed place on this event. Nothing was sent.'
        : `Queued for ${count} ${count === 1 ? 'person' : 'people'}. The history below shows what happens to each copy.`,
    )
  }

  return (
    <Modal open={open} title="Send an update to attendees" onClose={busy ? () => {} : onClose}>
      <p className="text-sm leading-relaxed text-muted">
        Goes to everybody with a confirmed place, one copy each — they never see who else is on the
        list. It is recorded here against your name.
      </p>

      <div className="mt-5 space-y-5">
        <Field label="Subject" hint="Optional. The event's title is used when this is blank.">
          <Textarea rows={1} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What you want to say">
          <Textarea
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="We've moved next door — same street, bigger room. Everything else is unchanged."
          />
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
          disabled={!body.trim()}
          onClick={() => void send()}
        >
          Send it
        </Button>
      </div>
    </Modal>
  )
}
