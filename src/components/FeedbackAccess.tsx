import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'
import { eventWhen } from '../lib/events'
import { feedbackAvailability, feedbackOpensAt, type FeedbackEvent } from '../lib/feedback'
import { useLive } from '../lib/live'
import { errorMessage, supabase } from '../lib/supabase'
import { Button, ConfirmModal, Notice } from './ui'

interface Props {
  event: FeedbackEvent
  /** Refresh eligibility when the containing guest/booking list changes. */
  attended?: boolean
  onAttendanceRecorded?: () => void
}

/** One entry point for every account role, including hosts with no registration. */
export function FeedbackAccess(props: Props) {
  const { profile } = useAuth()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  // No feedback controls during registration or for cancelled events.
  if (
    props.event.status === 'cancelled' ||
    now < Date.parse(props.event.ends_at ?? props.event.starts_at)
  ) {
    return null
  }
  if (!profile) return null
  return <Access key={`${props.event.id}:${profile.id}`} {...props} profileId={profile.id} now={now} />
}

function Access({ event, attended: knownAttendance, onAttendanceRecorded, profileId, now }: Props & {
  profileId: string
  now: number
}) {
  const [eligibility, setEligibility] = useState<{ attended: boolean; host: boolean } | null>(null)
  const [revision, setRevision] = useState(0)
  const [problem, setProblem] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const [attendance, host] = await Promise.all([
          supabase.rpc('attended_event', { p_event: event.id, p_profile: profileId }),
          supabase.rpc('hosts_event', { p_event: event.id }),
        ])
        if (attendance.error) throw attendance.error
        if (host.error) throw host.error
        if (active) {
          setEligibility({ attended: Boolean(attendance.data), host: Boolean(host.data) })
          setProblem('')
        }
      } catch (error) {
        if (active) setProblem(errorMessage(error))
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [event.id, profileId, knownAttendance, revision])

  useLive(['event_attendance', 'event_hosts'], () => setRevision((r) => r + 1), {
    filter: `event_id=eq.${event.id}`,
    poll: 30_000,
  })

  // The form may already be open when a different host corrects attendance.
  // Refresh it instead of leaving a link back to the same blocked page.
  useEffect(() => {
    if (eligibility?.attended) onAttendanceRecorded?.()
  }, [eligibility?.attended, onAttendanceRecorded])

  async function recordAttendance() {
    if (busy) return
    setBusy(true)
    setSaveError('')
    try {
      const { error } = await supabase.rpc('mark_attended', {
        p_event: event.id,
        p_profile: profileId,
        p_reason: 'Host confirmed their own attendance.',
      })
      if (error) throw error
      setEligibility({ attended: true, host: true })
      setConfirming(false)
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const state = feedbackAvailability(event, eligibility?.attended ?? false, now)
  return (
    <section aria-label="Your feedback" className="my-6 space-y-3 rounded-lg border border-line p-4">
      <h2 className="eyebrow">Your feedback</h2>
      {problem ? (
        <>
          <Notice tone="error">We could not check your feedback access. {problem}</Notice>
          <Button size="sm" onClick={() => setRevision((r) => r + 1)}>Try again</Button>
        </>
      ) : !eligibility ? (
        <p className="text-sm text-muted">Checking your feedback access…</p>
      ) : (
        <>
          {state === 'waiting' && (
            <p className="text-sm text-muted">
              Feedback opens {eventWhen({
                starts_at: new Date(feedbackOpensAt(event)).toISOString(),
                ends_at: null,
                timezone: event.timezone,
              })}.
            </p>
          )}
          {state === 'open' && (
            <Link
              to={`/events/feedback/${encodeURIComponent(event.slug)}`}
              className="inline-flex rounded-md border border-line px-4 py-2 text-sm font-medium text-fg hover:underline"
            >
              Give feedback
            </Link>
          )}
          {!eligibility.attended && (
            eligibility.host ? (
              <>
                <p className="text-sm text-muted">If you attended as a host, record your attendance to give feedback.</p>
                <Button size="sm" onClick={() => {
                  setSaveError('')
                  setConfirming(true)
                }}>
                  Mark myself attended
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted">Feedback is for people who attended. If you were there, ask a host to record your attendance.</p>
            )
          )}
        </>
      )}
      <ConfirmModal
        open={confirming}
        title="Did you attend this event?"
        body="Confirm only if you were there. Your attendance will be recorded as a manual correction, with your name and the time."
        confirmLabel="Yes, I attended"
        tone="primary"
        busy={busy}
        error={saveError}
        onClose={() => setConfirming(false)}
        onConfirm={() => void recordAttendance()}
      />
    </section>
  )
}
