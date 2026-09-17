import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  EmptyState,
  formatDate,
  Notice,
  SectionHeader,
  Spinner,
} from '../../components/ui'
import { useLive } from '../../lib/live'
import { errorMessage, supabase } from '../../lib/supabase'
import type { ConnectorNote, Profile } from '../../lib/types'
import { byId, loadConnectors, loadProfiles, type ConnectorRow } from './shared'

export default function Notes() {
  const [notes, setNotes] = useState<ConnectorNote[]>([])
  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [profilesById, setProfilesById] = useState<Record<string, Profile>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    const [notesRes, connectorsRes, profilesRes] = await Promise.all([
      supabase.from('connector_notes').select('*').order('created_at', { ascending: false }),
      loadConnectors(),
      loadProfiles(),
    ])

    const firstError = [notesRes.error, connectorsRes.error, profilesRes.error].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setNotes((notesRes.data as ConnectorNote[]) ?? [])
    setConnectors((connectorsRes.data as unknown as ConnectorRow[]) ?? [])
    setProfilesById(byId((profilesRes.data as Profile[]) ?? []))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A note written by a connector about somebody they met appears here as it
  // is written. This page only reads, so there is nothing a reload can take.
  useLive(['connector_notes', 'connectors', 'profiles'], () => void load())

  const connectorName = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of connectors) map[c.id] = c.profiles?.full_name ?? 'Unknown'
    return map
  }, [connectors])

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

      <SectionHeader
        title="Connector notes"
        caption="Context connectors chose to make searchable. Notes marked private are never shown here."
      />

      {notes.length === 0 ? (
        <EmptyState>No shared notes yet.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-sm border border-line bg-surface px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
                <span className="text-muted">{connectorName[note.connector_id] ?? 'Unknown'}</span>
                <span>on</span>
                <span className="text-muted">
                  {profilesById[note.user_profile_id]?.full_name ?? 'Unknown'}
                </span>
                <span>· {formatDate(note.created_at)}</span>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap text-fg">
                {note.note_text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
