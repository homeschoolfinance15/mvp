import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  EmptyState,
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

/** What an admin reads instead of a verb from the trigger. */
const VERB_LABEL: Record<string, string> = {
  insert: 'Added',
  update: 'Changed',
  delete: 'Removed',
}

/** Table names an admin should not have to decode. The rest fall to plain(). */
const ENTITY_LABEL: Record<string, string> = {
  connector_user_links: 'connector member',
  connector_notes: 'connector note',
  profile_answers: 'questionnaire answer',
  profile_reports: 'raised report',
  peer_feedback: 'feedback on a member',
  event_invites: 'event invitation',
  feedback_subjects: 'feedback question',
  data_subject_erasures: 'account deletion',
  activity_log: 'log entry',
}

/** `can_create_events` -> `can create events`. */
function plain(name: string): string {
  return name.replace(/[_-]+/g, ' ')
}

/** `connectors` -> `connector`; a logged row is one row. */
function entityLabel(entity: string): string {
  return ENTITY_LABEL[entity] ?? plain(entity).replace(/(ies|s)$/, (m) => (m === 'ies' ? 'y' : ''))
}

/** Decision 11. A log entry is a moment, so every one carries its time of day. */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Entries per "Show older". */
const PAGE = 200

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
  // Decision 11. How many pages are on screen. "Show older" asks for one more,
  // and the reload fetches them all from the top, so entries written in the
  // meantime push older ones down rather than duplicating or skipping them.
  const [pages, setPages] = useState(1)
  const [more, setMore] = useState(false)

  const load = useCallback(async () => {
    setLoadError('')
    const [activityRes, profilesRes] = await Promise.all([
      // ponytail: refetches every shown page on "Show older"; switch to a
      // keyset range() if someone reads back thousands of entries.
      supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(PAGE * pages),
      loadProfiles(),
    ])

    const firstError = [activityRes.error, profilesRes.error].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setEntries((activityRes.data as ActivityLogEntry[]) ?? [])
    setProfilesById(byId((profilesRes.data as Profile[]) ?? []))
    setLoading(false)
    setMore(false)
  }, [pages])

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
                      {VERB_LABEL[verb] ?? plain(verb)}
                    </span>{' '}
                    <span className="text-muted">{entityLabel(entry.entity)}</span>
                    {changed.length > 0 && (
                      <span className="text-dim"> · {changed.map(plain).join(', ')}</span>
                    )}
                  </div>
                  <div className="text-xs whitespace-nowrap text-dim">
                    {actor?.full_name ?? (entry.actor_id ? 'a removed account' : 'the system')} ·{' '}
                    {when(entry.created_at)}
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

      {/* A full last page means there may be more behind it. */}
      {entries.length === PAGE * pages && (
        <div className="mt-6 flex justify-center">
          <Button
            size="sm"
            loading={more}
            onClick={() => {
              setMore(true)
              setPages((n) => n + 1)
            }}
          >
            Show older
          </Button>
        </div>
      )}
    </>
  )
}
