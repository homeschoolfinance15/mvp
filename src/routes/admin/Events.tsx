import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  EmptyState,
  Input,
  Notice,
  Panel,
  Spinner,
} from '../../components/ui'
import { useLive } from '../../lib/live'
import { errorMessage, supabase } from '../../lib/supabase'
import type { Profile } from '../../lib/types'
import { eventWhen, type EventRecord } from '../../lib/events'
import { EventStatusBadge } from '../manage/shared'
import { byId, loadProfiles } from './shared'

/**
 * ORG-14 and ORG-15. Every event on the platform, drafts included, and one
 * click to its full operational record.
 *
 * Deliberately a plain index rather than a management console: an
 * administrator opens an event to read what happened to it, and this is the
 * door. Nothing here is framed as the administrator's own events, because
 * these are the platform's records and most of them belong to somebody else.
 */
export default function Events() {
  const [events, setEvents] = useState<EventRecord[]>([])
  const [profilesById, setProfilesById] = useState<Record<string, Profile>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    const [eventsRes, profilesRes] = await Promise.all([
      // ORG-14/ORG-15. Events are platform records, so administration lists
      // all of them — drafts included, which the RLS policy allows an admin
      // and nobody else outside the hosting team.
      supabase.from('events').select('*').order('starts_at', { ascending: false }),
      loadProfiles(),
    ])

    const firstError = [eventsRes.error, profilesRes.error].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setEvents((eventsRes.data as EventRecord[]) ?? [])
    setProfilesById(byId((profilesRes.data as Profile[]) ?? []))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // ORG-14/ORG-15. An event published, cancelled or rescheduled by any host on
  // the platform. Nothing on this page is unsaved — `query` filters what is
  // already loaded — so this runs unconditionally.
  useLive(['events', 'profiles'], () => void load())

  const filtered = events.filter((event) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      event.title.toLowerCase().includes(q) ||
      event.slug.toLowerCase().includes(q) ||
      (profilesById[event.host_id]?.full_name ?? '').toLowerCase().includes(q)
    )
  })

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

      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <div className="w-56">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search events"
            aria-label="Search events by title, link or host"
          />
        </div>
        {/* ORG-01. This section is the administrator's read-only record of
                the platform (ORG-14) and stays that way — but it was also the
                only place an administrator ever saw the word "Events", so with
                no control here the create screen had no door at all. The button
                leaves rather than opening an editor in place: hosting lives
                under /manage/events for administrators and connectors alike,
                and one editor for both is what keeps ORG-01 and ORG-01B the
                same code path. */}
        {/* The only door. An administrator manages every event, so the
                "Hosting" list that used to sit beside this ran the identical
                query and showed the identical rows — the same platform, listed
                twice, differing only in which page a row opened. Creating
                starts here; opening a row gives the record, and the record
                links on to the editor. */}
        <Link to="/manage/events/new">
          <Button variant="primary" size="sm">
            Create event
          </Button>
        </Link>
      </div>

      {filtered.length === 0 ? (
        <EmptyState>
          {events.length === 0
            ? 'No events yet. Press Create event to add the first.'
            : 'No events match that search. Try a title, link or host name.'}
        </EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {filtered.map((event) => (
            <Link
              key={event.id}
              to={`/admin/events/${event.id}`}
              className="flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:bg-raised/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{event.title}</span>
                <span className="block truncate text-xs text-dim">
                  {eventWhen(event)} · hosted by{' '}
                  {profilesById[event.host_id]?.full_name ?? 'a removed account'}
                </span>
              </span>
              <EventStatusBadge event={event} />
            </Link>
          ))}
        </Panel>
      )}
    </>
  )
}
