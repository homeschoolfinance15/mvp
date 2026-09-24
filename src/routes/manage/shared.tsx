/**
 * The frame every organiser screen sits in, and the one load that gets them
 * all their event.
 *
 * Five routes manage one event between them — details, guests, emails,
 * check-in, results — so the header, the sub-navigation and the "are you
 * allowed to be here" check are written once. EML-09 is the reason the check
 * is here rather than per screen: an organiser reaches their own authorised
 * events and nothing else, on every one of these paths, not on most of them.
 *
 * Row level security says the same thing in the database. This is so the
 * screen says it in words rather than rendering an empty page.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { DashboardShell } from '../../components/DashboardShell'
import { LoadFailed, Notice, Panel, Spinner } from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { loadFailed, supabase } from '../../lib/supabase'
import type { CapacityInfo, EventRecord, EventStatus, TicketType } from '../../lib/events'

/* -------------------------------------------------------------------------- */
/* Loading one event, with its answer about you                                */
/* -------------------------------------------------------------------------- */

export interface ManagedEvent {
  event: EventRecord
  tickets: TicketType[]
  /** Creator plus co-hosts — what `hosts_event()` answers in the database. */
  hostIds: string[]
  /** Null when the capacity function is unavailable; the screen degrades. */
  capacity: CapacityInfo | null
}

type LoadState =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'missing' }
  | { state: 'denied' }
  | { state: 'ready'; data: ManagedEvent }

export function useManagedEvent(eventId: string | undefined) {
  const { profile } = useAuth()
  const [result, setResult] = useState<LoadState>({ state: 'loading' })

  const load = useCallback(async () => {
    if (!eventId || !profile) return
    // A reload refreshes in place: the screen already showing the event stays
    // mounted, so what it is holding — a save result, a problem — survives.
    setResult((r) => (r.state === 'ready' && r.data.event.id === eventId ? r : { state: 'loading' }))

    const [eventRes, ticketRes, hostRes, capacityRes] = await Promise.all([
      supabase.from('events').select('*').eq('id', eventId).maybeSingle(),
      supabase
        .from('ticket_types')
        .select('*')
        .eq('event_id', eventId)
        .order('position', { ascending: true }),
      supabase.from('event_hosts').select('profile_id').eq('event_id', eventId),
      supabase.rpc('event_capacity_state', { p_event: eventId }),
    ])

    // No row (deleted, never existed, or a mangled address — 22P02 is Postgres
    // refusing a non-uuid) is an answer, not a failure: trying again cannot help.
    if (eventRes.error && eventRes.error.code !== '22P02') {
      loadFailed(eventRes.error, 'this event')
      setResult({ state: 'failed' })
      return
    }
    if (!eventRes.data) {
      setResult({ state: 'missing' })
      return
    }

    const event = eventRes.data as EventRecord
    const hostIds = [
      ...new Set([
        event.host_id,
        ...(((hostRes.data as Array<{ profile_id: string }>) ?? []).map((h) => h.profile_id)),
      ]),
    ]

    // ORG-06 / EML-09. A connector host sees their own events. Another
    // connector's event is not theirs to read, edit or email about.
    if (profile.role !== 'admin' && !hostIds.includes(profile.id)) {
      setResult({ state: 'denied' })
      return
    }

    // The capacity function may legitimately be missing on an event with no
    // limit, and a broken count must not take the whole screen down with it.
    const capacityRow = Array.isArray(capacityRes.data) ? capacityRes.data[0] : capacityRes.data

    setResult({
      state: 'ready',
      data: {
        event,
        tickets: (ticketRes.data as TicketType[]) ?? [],
        hostIds,
        capacity: capacityRes.error ? null : ((capacityRow as CapacityInfo) ?? null),
      },
    })
  }, [eventId, profile])

  useEffect(() => {
    void load()
  }, [load])

  return { result, reload: load }
}

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

const SUB_TABS: Array<{ id: string; label: string; path: (id: string) => string }> = [
  { id: 'details', label: 'Details', path: (id) => `/manage/events/${id}` },
  { id: 'guests', label: 'Guests', path: (id) => `/manage/events/${id}/guests` },
  { id: 'emails', label: 'Emails', path: (id) => `/manage/events/${id}/emails` },
  { id: 'checkin', label: 'Check-in', path: (id) => `/manage/events/${id}/checkin` },
  { id: 'results', label: 'Results', path: (id) => `/manage/events/${id}/results` },
]

/**
 * `DashboardShell` with the event's own pages as the first sidebar section.
 * They are routes rather than local state so the address bar is always the
 * truth about where you are — a guest list you can send to a co-host is worth
 * more than a tab.
 */
export function ManageShell({
  event,
  caption,
  children,
}: {
  event: EventRecord
  caption?: string
  children: ReactNode
}) {
  // No "All events" link: the sidebar's Hosting / Events group already is one.
  return (
    <DashboardShell
      title={event.title}
      caption={caption}
      sideContext={{
        label: event.title,
        links: SUB_TABS.map((t) => ({ to: t.path(event.id), label: t.label })),
      }}
    >
      {children}
    </DashboardShell>
  )
}

/** The reader's own events list: where "back" goes from any organiser screen. */
export function eventsListPath(profile: ReturnType<typeof useAuth>['profile']): string {
  if (profile?.role === 'admin') return '/admin/events'
  if (profile?.role === 'connector') return '/manage/events'
  return '/events/mine'
}

/**
 * The four screens all begin the same way: wait, explain, refuse, or render.
 * QLT-01 — none of these states is a blank page, and none is a dead end: each
 * sits in the dashboard frame, whose sidebar is the way back — the door scanner
 * included, whose focused layout is for scanning, not for being refused.
 */
export function ManagedEventGate({
  result,
  reload,
  children,
}: {
  result: ReturnType<typeof useManagedEvent>['result']
  reload: () => void | Promise<void>
  children: (data: ManagedEvent) => ReactNode
}) {
  if (result.state === 'ready') return <>{children(result.data)}</>

  const body =
    result.state === 'loading' ? (
      <div className="flex justify-center py-24 text-dim">
        <Spinner />
      </div>
    ) : (
      <>
        {result.state === 'failed' ? (
          <LoadFailed what="this event" onRetry={() => void reload()} />
        ) : result.state === 'missing' ? (
          <Notice tone="warning">No event at this address.</Notice>
        ) : (
          <Notice tone="error">
            This event belongs to somebody else. You can only open events you host.
          </Notice>
        )}
      </>
    )

  return <DashboardShell title="Event">{body}</DashboardShell>
}

/* -------------------------------------------------------------------------- */
/* Words for states                                                            */
/* -------------------------------------------------------------------------- */

const STATUS_TONE: Record<EventStatus, string> = {
  draft: 'text-dim border-line bg-raised',
  published: 'text-positive border-[#b9d8c4] bg-[#dcf0e4]',
  cancelled: 'text-negative border-[#e6b5ad] bg-[#fff0ec]',
}

export function EventStatusBadge({ event }: { event: Pick<EventRecord, 'status' | 'starts_at' | 'ends_at'> }) {
  const finished =
    event.status === 'published' &&
    new Date(event.ends_at ?? event.starts_at).getTime() < Date.now()
  const label = finished ? 'finished' : event.status
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-wide whitespace-nowrap ${
        finished ? 'text-dim border-line bg-raised' : STATUS_TONE[event.status]
      }`}
    >
      {label}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Saved / unsaved                                                             */
/* -------------------------------------------------------------------------- */

/**
 * ORG-02 and QLT-03. A long form has to say, at all times, whether what is on
 * screen is what is stored. "Saving…" and "Saved" are different sentences from
 * "Unsaved changes", and none of them is a colour.
 */
export function SaveState({
  dirty,
  saving,
  savedAt,
}: {
  dirty: boolean
  saving: boolean
  savedAt: string | null
}) {
  const text = saving
    ? 'Saving…'
    : dirty
      ? 'Unsaved changes'
      : savedAt
        ? `Saved at ${new Date(savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
        : 'No changes yet'

  return (
    <span
      role="status"
      aria-live="polite"
      className={`text-xs ${dirty && !saving ? 'text-[#8a4b00]' : 'text-dim'}`}
    >
      {text}
    </span>
  )
}

/**
 * QLT-03. The browser's own "leave this page?" prompt, which is the only one
 * that can interrupt a back button or a closed tab. Cheaper than rebuilding
 * navigation blocking, and people already know what it means.
 */
export function useWarnOnUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    function warn(e: BeforeUnloadEvent) {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

/* -------------------------------------------------------------------------- */
/* Small shared furniture                                                      */
/* -------------------------------------------------------------------------- */

/** A labelled fact. Used wherever a screen states something rather than edits it. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 text-sm leading-relaxed text-fg">{children}</div>
    </div>
  )
}

/**
 * A quiet box for something the organiser needs to understand before acting —
 * how capacity is shared, what a cohost may do, what saving did not do.
 * Deliberately not an error: none of this is wrong, it is just easy to assume.
 */
export function Explainer({ children }: { children: ReactNode }) {
  return (
    <Panel className="border-dashed px-5 py-4 text-xs leading-relaxed text-muted">{children}</Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* Local datetime boxes                                                        */
/* -------------------------------------------------------------------------- */

/*
 * `<input type="datetime-local">` — rung four of the ladder. A date picker
 * library would be a dependency, a keyboard trap and a translation job; the
 * browser already ships one that every platform's assistive technology knows.
 *
 * It speaks the *reader's* local time, which is not the event's timezone. The
 * boxes are labelled with the event timezone, and `EventEditor` prints the
 * event-time reading underneath so somebody scheduling a London dinner from
 * New York can see both (EVT-02).
 *
 * ponytail: local-time boxes, event timezone stated alongside. Swap for a
 * zone-aware picker if organisers start scheduling outside their own zone
 * often enough to complain.
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The guest and history tables, at phone width.
 *
 * A table that scrolls sideways hides the column somebody came for, so these
 * screens stack each row into a labelled block below `sm` and become a real
 * table above it. One wrapper so the guest list and the email history cannot
 * drift apart.
 */
export function Rows({ children }: { children: ReactNode }) {
  return <Panel className="divide-y divide-line">{children}</Panel>
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Reading what an edge function actually refused                              */
/* -------------------------------------------------------------------------- */

/**
 * `functionError` in lib/supabase pulls the sentence out of a refusal, which
 * is all most callers want. These screens want the rest of the body too: the
 * EML-04 stale-preview refusal carries `refresh_preview` and the list of
 * fields that moved, and a refund conflict carries the refund already in hand.
 * A screen that can only read the sentence has to parse English to decide what
 * to do next, which is how a "try again" button ends up retrying something
 * that will fail identically every time.
 *
 * The body can only be read once, so this is the single place that reads it.
 */
export async function refusal(
  error: unknown,
): Promise<{ status: number; body: Record<string, unknown>; message: string }> {
  const context = (error as { context?: Response }).context
  const status = context?.status ?? 0
  let body: Record<string, unknown> = {}
  if (context && typeof context.json === 'function') {
    try {
      body = ((await context.json()) as Record<string, unknown>) ?? {}
    } catch {
      // Not JSON — a gateway error page, or nothing at all.
    }
  }
  const message =
    typeof body.error === 'string' && body.error
      ? body.error
      : ((error as { message?: string }).message ?? 'Something went wrong.')
  return { status, body, message }
}
