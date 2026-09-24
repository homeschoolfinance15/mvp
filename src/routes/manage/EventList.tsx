/**
 * Every event this person is allowed to run.
 *
 * ORG-06 is the rule that shapes the whole screen: an administrator sees the
 * platform's events, a connector sees the ones they host, and a connector
 * never sees another connector's event — not its guest list, not its takings,
 * not its title. Row level security enforces that; this filter is so the
 * screen never asks for what it cannot have.
 *
 * ORG-01A is the other one: when somebody may not create an event, the button
 * is not disabled, it is replaced by the reason.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { DashboardShell } from '../../components/DashboardShell'
import {
  Button,
  EmptyState,
  Input,
  LoadFailed,
  Panel,
  Spinner,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { useLive } from '../../lib/live'
import { loadFailed, supabase } from '../../lib/supabase'
import { eventWhen, type EventRecord } from '../../lib/events'
import { whyNoCreate } from './rules'

interface Row {
  event: EventRecord
  confirmed: number
}

export type HostingBucket = 'upcoming' | 'drafts' | 'past' | 'cancelled'

const TITLES: Record<HostingBucket, string> = {
  upcoming: 'Upcoming',
  drafts: 'Drafts',
  past: 'Past',
  cancelled: 'Cancelled events',
}

/** One page per bucket, each its own route and sidebar link — no tab bar. */
export default function EventList({ bucket = 'upcoming' }: { bucket?: HostingBucket }) {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [rows, setRows] = useState<Row[]>([])
  const [query, setQuery] = useState('')
  const [canCreate, setCanCreate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  // `quiet` is for the reloads nobody asked for: a live signal should not
  // take the list away and show a spinner. Same distinction `useLoader` draws.
  const load = useCallback(async (quiet = false) => {
    if (!profile) return
    setFailed(false)
    if (!quiet) setLoading(true)

    const isAdmin = profile.role === 'admin'

    // ACC-04 / ORG-01A. Two separate questions, and only the first one has a
    // usable answer on the client: whether this connector may *create*. Whether
    // they may host an event they were named on is the database's business.
    const connectorRes = isAdmin
      ? null
      : await supabase
          .from('connectors')
          .select('can_create_events')
          .eq('profile_id', profile.id)
          .maybeSingle()
    setCanCreate(
      isAdmin || Boolean((connectorRes?.data as { can_create_events?: boolean } | null)?.can_create_events),
    )

    // A connector's own co-hosted events. An admin skips this: they see all.
    const cohostRes = isAdmin
      ? null
      : await supabase.from('event_hosts').select('event_id').eq('profile_id', profile.id)

    let eventQuery = supabase.from('events').select('*').order('starts_at', { ascending: false })
    if (!isAdmin) {
      const cohosted = ((cohostRes?.data as Array<{ event_id: string }>) ?? []).map((h) => h.event_id)
      // PostgREST's `or` takes a comma-separated filter list; an empty `in`
      // list is invalid, so the host_id clause always carries the query.
      eventQuery = cohosted.length
        ? eventQuery.or(`host_id.eq.${profile.id},id.in.(${cohosted.join(',')})`)
        : eventQuery.eq('host_id', profile.id)
    }

    const { data, error } = await eventQuery
    if (error) {
      loadFailed(error, 'your events')
      setFailed(true)
      setLoading(false)
      return
    }

    const events = (data as EventRecord[]) ?? []

    // One count query for the lot, rather than one per event. Only confirmed
    // places count — a held place during checkout is not a guest yet (BUY-06).
    const counts: Record<string, number> = {}
    if (events.length) {
      const { data: regs } = await supabase
        .from('event_registrations')
        .select('event_id')
        .eq('status', 'confirmed')
        .in('event_id', events.map((e) => e.id))
      for (const reg of ((regs as Array<{ event_id: string }>) ?? [])) {
        counts[reg.event_id] = (counts[reg.event_id] ?? 0) + 1
      }
    }

    setRows(events.map((event) => ({ event, confirmed: counts[event.id] ?? 0 })))
    setLoading(false)
  }, [profile])

  useEffect(() => {
    void load()
  }, [load])

  // An event a co-host publishes, cancels or reschedules, and the confirmed
  // count beside each one, which is counted from registrations rather than
  // stored on the event. Read-only list: `query` is this reader's
  // own state and no reload writes it.
  useLive(['events', 'event_registrations'], () => void load(true))

  const now = Date.now()
  const buckets = useMemo(() => {
    const matching = rows.filter((r) =>
      query.trim() ? r.event.title.toLowerCase().includes(query.trim().toLowerCase()) : true,
    )
    const over = (e: EventRecord) => new Date(e.ends_at ?? e.starts_at).getTime() < now
    return {
      upcoming: matching.filter((r) => r.event.status === 'published' && !over(r.event)),
      drafts: matching.filter((r) => r.event.status === 'draft'),
      past: matching.filter((r) => r.event.status === 'published' && over(r.event)),
      cancelled: matching.filter((r) => r.event.status === 'cancelled'),
    }
  }, [rows, query, now])

  // A new event starts as a draft on its way to Upcoming; Past and Cancelled
  // are not where anybody goes to make one.
  const offersCreate = bucket === 'upcoming' || bucket === 'drafts'
  const whyNot = whyNoCreate(profile?.role, canCreate)
  const createAllowed = offersCreate && !whyNot
  // The reason is said once, on Upcoming; the other lists do not repeat it.
  const blockedReason = bucket === 'upcoming' && !loading ? whyNot : null
  const shown = buckets[bucket]

  // An administrator has one events list, and it is not this one.
  if (profile?.role === 'admin') return <Navigate to="/admin/events" replace />

  return (
    <DashboardShell title={TITLES[bucket]}>
      {/* The page title is the heading; this row is only the controls. */}
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <div className="w-48">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title"
            aria-label="Search your events by title"
          />
        </div>
        {createAllowed && (
          <Button variant="primary" size="sm" onClick={() => navigate('/manage/events/new')}>
            Create event
          </Button>
        )}
      </div>

      {/* ORG-01A. The reason stands where the button would have been, so
          nobody hunts for a control that was never going to work. */}
      {blockedReason && (
        <div className="mb-6">
          <Panel className="border-dashed px-5 py-4 text-sm leading-relaxed text-muted">
            {blockedReason}
          </Panel>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : failed ? (
        <LoadFailed what="your events" onRetry={() => void load()} />
      ) : shown.length === 0 ? (
        <EmptyState>{emptyWords(bucket, rows.length > 0, Boolean(query.trim()), createAllowed)}</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {shown.map(({ event, confirmed }) => (
            <button
              key={event.id}
              type="button"
              onClick={() => navigate(`/manage/events/${event.id}`)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-left transition-colors hover:bg-raised/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{event.title}</span>
                <span className="block truncate text-xs text-dim">{eventWhen(event)}</span>
              </span>
              <span className="text-xs tabular-nums text-muted">
                {confirmed} confirmed
                {event.capacity ? ` of ${event.capacity}` : ''}
              </span>
              {/* No status badge: the list itself is the status. */}
            </button>
          ))}
        </Panel>
      )}
    </DashboardShell>
  )
}

/** QLT-01. Four empty states, because "nothing here" has four causes. */
function emptyWords(
  bucket: HostingBucket,
  hasAny: boolean,
  searching: boolean,
  createAllowed: boolean,
): string {
  if (searching) return 'No event of yours matches that title. Try another title.'
  const next = createAllowed ? ' Press Create event to make one.' : ''
  if (!hasAny) return `You are not hosting anything yet.${next}`
  // Creating an event never lands in Past or Cancelled, so no instruction there.
  if (bucket === 'past') return 'No past events.'
  if (bucket === 'cancelled') return 'No cancelled events.'
  return (bucket === 'upcoming' ? 'Nothing coming up.' : 'No drafts.') + next
}
