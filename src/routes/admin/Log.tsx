import { useCallback, useEffect, useState } from 'react'
import {
  EmptyState,
  formatDate,
  Notice,
  Panel,
  Spinner,
} from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'
import type { ActivityLogEntry, Profile } from '../../lib/types'
import { byId, loadProfiles } from './shared'

/** `profiles.update` -> `update`, for the badge. */
function verbOf(action: string): string {
  return action.split('.').pop() ?? action
}

const VERB_TONE: Record<string, string> = {
  insert: 'text-gold',
  update: 'text-muted',
  delete: 'text-red-400',
}

/**
 * Everything the platform did, newest first. Written by the log_activity()
 * trigger rather than by application code, so it records a change made
 * straight against the database too — and cannot be forgotten at a call site.
 */
export default function Log() {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([])
  const [profilesById, setProfilesById] = useState<Record<string, Profile>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    const [activityRes, profilesRes] = await Promise.all([
      // ponytail: newest 200, no pagination. The log is a record to consult,
      // not a screen to scroll forever; add a range() when someone asks.
      supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      loadProfiles(),
    ])

    const firstError = [activityRes.error, profilesRes.error].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setEntries((activityRes.data as ActivityLogEntry[]) ?? [])
    setProfilesById(byId((profilesRes.data as Profile[]) ?? []))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-dim">
        <Spinner />
      </div>
    )
  }

  return (
    <>
      {loadError && (
        <div className="mb-8">
          <Notice tone="error">{loadError}</Notice>
        </div>
      )}

      {entries.length === 0 ? (
        !loadError && <EmptyState>Nothing logged.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {entries.map((entry) => {
            const actor = entry.actor_id ? profilesById[entry.actor_id] : undefined
            const verb = verbOf(entry.action)
            const changed = verb === 'update' ? Object.keys(entry.detail ?? {}) : []

            return (
              <div key={entry.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0 text-sm text-fg">
                    <span className={`${VERB_TONE[verb] ?? 'text-muted'} tabular-nums`}>
                      {verb}
                    </span>{' '}
                    <span className="text-muted">{entry.entity}</span>
                    {changed.length > 0 && (
                      <span className="text-dim"> · {changed.join(', ')}</span>
                    )}
                  </div>
                  <div className="text-xs whitespace-nowrap text-dim">
                    {actor?.full_name ?? (entry.actor_id ? 'a removed account' : 'the system')} ·{' '}
                    {formatDate(entry.created_at)}
                  </div>
                </div>

                {entry.detail && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-dim hover:text-muted">
                      Detail
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-ink/40 p-3 text-[0.6875rem] leading-relaxed text-muted">
                      {JSON.stringify(entry.detail, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )
          })}
        </Panel>
      )}
    </>
  )
}
