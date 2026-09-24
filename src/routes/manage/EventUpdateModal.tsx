import { useCallback, useEffect, useState } from 'react'
import { Button, Field, Modal, Notice, Textarea } from '../../components/ui'
import { eventWhen, type EventRecord } from '../../lib/events'
import { errorMessage, functionError, supabase } from '../../lib/supabase'
import { NOTIFIABLE_FIELDS, type ChangedDetails } from './rules'

type Snapshot = Pick<EventRecord, 'title' | 'slug' | 'status' | 'starts_at' | 'ends_at' | 'timezone' | 'venue_name' | 'address' | 'location' | 'attendee_instructions'>
interface Preview {
  snapshot: Snapshot
  changed_details: ChangedDetails
  audience_count: number
}

/** Preview the saved event, including changes kept after Save without notifying. */
export function EventUpdateModal({ open, eventId, onClose, onSent }: {
  open: boolean
  eventId: string
  onClose: () => void
  onSent: (message: string) => Promise<void>
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState('')
  const [stale, setStale] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setProblem('')
    try {
      const { data, error } = await supabase.rpc('event_update_preview', { p_event: eventId })
      if (error) throw error
      setPreview(data as Preview)
      setStale(false)
    } catch (error) {
      setProblem(`We could not build the preview. ${errorMessage(error)}`)
      setStale(true)
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    if (open) {
      setPreview(null)
      void refresh()
    }
  }, [open, refresh])

  async function send() {
    if (!preview || busy || stale) return
    setBusy(true)
    setProblem('')
    try {
      const { data, error } = await supabase.functions.invoke('event-email', {
        body: {
          kind: 'update', event_id: eventId,
          subject: subject.trim() || null, body: body.trim() || null,
          changed_details: preview.changed_details,
          preview_snapshot: preview.snapshot,
          send_now: true,
        },
      })
      if (error) {
        const message = await functionError(error)
        if (/preview|changed again/i.test(message)) setStale(true)
        throw new Error(message)
      }
      const count = Number(data?.audience_count ?? 0)
      setSubject('')
      setBody('')
      await onSent(count === 0
        ? 'There is nobody to notify. No email was queued.'
        : `Queued for ${count} ${count === 1 ? 'person' : 'people'}.`)
    } catch (error) {
      setProblem(`The update was not confirmed as queued. ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const event = preview?.snapshot
  const title = subject.trim() || `${event?.title ?? 'The event'} has changed`
  const labels: Record<string, string> = { ...NOTIFIABLE_FIELDS, title: 'Event name', location: 'Location' }
  function show(field: string, value: unknown) {
    if (value == null || value === '') return 'Not set'
    if ((field === 'starts_at' || field === 'ends_at') && event) {
      return new Date(String(value)).toLocaleString(undefined, { timeZone: event.timezone })
    }
    return String(value)
  }

  return (
    <Modal open={open} title="Send an update to attendees" onClose={busy ? () => {} : onClose}>
      {problem && <Notice tone="error">{problem}</Notice>}
      {loading && <p className="text-sm text-muted" role="status">Building the latest preview…</p>}
      <div className="space-y-5">
        <Field label="Subject" hint="Optional. The preview shows the default subject when this is blank.">
          <Textarea rows={1} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What you want to say" hint="Optional. Your explanation appears alongside the saved event details.">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {event && preview && (
          <section aria-label="Email preview" className="rounded-sm border border-line bg-raised p-5 text-sm">
            <h3 className="eyebrow">Email preview</h3>
            <p className="mt-3 font-medium">Subject: {title}</p>
            <p className="mt-3">Hello [attendee's first name],</p>
            <p className="mt-3 whitespace-pre-wrap">{body.trim() || `Something about ${event.title} has changed.`}</p>
            <p className="mt-3">Your place still stands — nothing is needed from you.</p>
            <dl className="mt-4 space-y-3">
              {Object.entries(preview.changed_details).map(([field, change]) => (
                <div key={field}>
                  <dt className="font-medium">{labels[field] ?? field}</dt>
                  <dd>Previously: {show(field, change.from)}<br />Now: {show(field, change.to)}</dd>
                </div>
              ))}
              <div><dt className="font-medium">Current date and time</dt><dd>{eventWhen(event)} ({event.timezone})</dd></div>
              <div><dt className="font-medium">Current venue/address</dt><dd>{[event.venue_name, event.address].filter(Boolean).join(', ') || event.location || 'Not set'}</dd></div>
              {event.attendee_instructions && <div><dt className="font-medium">Attendee instructions</dt><dd className="whitespace-pre-wrap">{event.attendee_instructions}</dd></div>}
            </dl>
            <a className="mt-4 inline-block underline" href={`/e/${encodeURIComponent(event.slug)}`}>See the event</a>
            <p className="mt-4 border-t border-line pt-3">
              Goes to {preview.audience_count} {preview.audience_count === 1 ? 'person' : 'people'} with a confirmed place, one private email each.
            </p>
          </section>
        )}
        {stale && <Notice tone="warning">Review a fresh preview before sending. Your explanation has been kept.</Notice>}
        <Button onClick={() => void refresh()} disabled={busy || loading}>Refresh preview</Button>
        <div className="flex gap-3">
          <Button className="flex-1" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="flex-1" variant="primary" loading={busy}
            disabled={!preview || loading || stale || preview.audience_count === 0 || event?.status !== 'published'}
            onClick={() => void send()}>
            Send update to {preview?.audience_count ?? 0} {preview?.audience_count === 1 ? 'person' : 'people'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
