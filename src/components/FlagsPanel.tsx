import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthProvider'
import { errorMessage, supabase } from '../lib/supabase'
import type { Profile, ProfileReport, ReportStatus } from '../lib/types'
import {
  Button,
  EmptyState,
  formatDate,
  Notice,
  Panel,
  SectionHeader,
  Spinner,
} from './ui'

/**
 * What members have raised about each other.
 *
 * The same component serves a connector and an admin because the row level
 * security policy already draws the line: a connector reads reports about
 * the people they invited, an admin reads all of them, and the subject of a
 * report reads none. Nothing here filters by role — filtering in the browser
 * would only be a second, weaker copy of a rule the database already holds.
 */
export function FlagsPanel() {
  const { profile } = useAuth()

  const [reports, setReports] = useState<ProfileReport[]>([])
  const [people, setPeople] = useState<Record<string, Profile>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    const [reportsRes, peopleRes] = await Promise.all([
      supabase.from('profile_reports').select('*').order('created_at', { ascending: false }),
      supabase.from('profiles').select('*'),
    ])

    const firstError = [reportsRes.error, peopleRes.error].find(Boolean)
    if (firstError) setError(errorMessage(firstError))

    setReports((reportsRes.data as ProfileReport[]) ?? [])
    setPeople(
      Object.fromEntries(((peopleRes.data as Profile[]) ?? []).map((p) => [p.id, p])),
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = useMemo(() => reports.filter((r) => r.status === 'open'), [reports])
  const settled = useMemo(() => reports.filter((r) => r.status !== 'open'), [reports])

  async function resolve(id: string, status: ReportStatus) {
    setBusyId(id)
    setError('')
    const { error: rpcError } = await supabase.rpc('resolve_profile_report', {
      p_report_id: id,
      p_status: status,
    })
    setBusyId(null)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    await load()
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-dim">
        <Spinner />
      </div>
    )
  }

  return (
    <>
      <SectionHeader
        title="Raised"
        caption="What members have said about each other's profiles. The person it's about is never shown this, and never told."
      />

      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {open.length === 0 ? (
        <EmptyState>Nothing outstanding.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {open.map((report) => (
            <ReportRow
              key={report.id}
              report={report}
              people={people}
              // Rule 4, mirrored in the UI so the button isn't offered at all.
              canAct={report.reporter_id !== profile?.id}
              busy={busyId === report.id}
              onResolve={resolve}
            />
          ))}
        </Panel>
      )}

      {settled.length > 0 && (
        <div className="mt-10">
          <SectionHeader title="Dealt with" />
          <Panel className="divide-y divide-line">
            {settled.map((report) => (
              <ReportRow key={report.id} report={report} people={people} />
            ))}
          </Panel>
        </div>
      )}
    </>
  )
}

const KIND_TONE: Record<string, string> = {
  correction: 'text-gold',
  concern: 'text-red-400',
  endorsement: 'text-muted',
}

function ReportRow({
  report,
  people,
  canAct = false,
  busy = false,
  onResolve,
}: {
  report: ProfileReport
  people: Record<string, Profile>
  canAct?: boolean
  busy?: boolean
  onResolve?: (id: string, status: ReportStatus) => Promise<void>
}) {
  const subject = people[report.subject_id]
  const reporter = people[report.reporter_id]
  const isOpen = report.status === 'open'

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-sm">
          <span className={KIND_TONE[report.kind] ?? 'text-muted'}>{report.kind}</span>
          <span className="text-dim"> about </span>
          <span className="font-medium text-fg">{subject?.full_name ?? 'someone'}</span>
          {report.field && <span className="text-dim"> · {report.field}</span>}
        </div>
        <div className="text-xs whitespace-nowrap text-dim">
          {reporter?.full_name ?? 'someone'} · {formatDate(report.created_at)}
          {!isOpen && ` · ${report.status}`}
        </div>
      </div>

      <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted">
        {report.body}
      </p>

      {isOpen && subject?.email && (
        <p className="mt-3 text-xs text-dim">
          Reach out:{' '}
          <a
            href={`mailto:${subject.email}`}
            className="text-gold underline-offset-4 hover:underline"
          >
            {subject.email}
          </a>
        </p>
      )}

      {isOpen && onResolve && (
        <div className="mt-4 flex gap-3">
          {canAct ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => onResolve(report.id, 'dismissed')}>
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => onResolve(report.id, 'resolved')}
              >
                Resolved
              </Button>
            </>
          ) : (
            <p className="text-xs text-dim">
              You raised this, so someone else has to close it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
