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
import { useNavigate } from 'react-router-dom'
import { DashboardShell, type Tab } from '../../components/DashboardShell'
import { LoadFailed, Notice, PageLoader, Panel } from '../../components/ui'
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
  | { state: 'denied' }
  | { state: 'ready'; data: ManagedEvent }

export function useManagedEvent(eventId: string | undefined) {
  const { profile } = useAuth()
  const [result, setResult] = useState<LoadState>({ state: 'loading' })

  const load = useCallback(async () => {
    if (!eventId || !profile) return
    setResult({ state: 'loading' })

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

    if (eventRes.error || !eventRes.data) {
      loadFailed(eventRes.error, 'this event')
      setResult({ state: 'failed' })
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
 * `DashboardShell` with the event's own sub-navigation. The tabs are routes
 * rather than local state so the address bar is always the truth about where
 * you are — a guest list you can send to a co-host is worth more than a tab.
 */
export function ManageShell({
  event,
  current,
  caption,
  children,
}: {
  event: EventRecord
  current: string
  caption?: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  const tabs: Tab[] = SUB_TABS.map((t) => ({ id: t.id, label: t.label }))

  return (
    <DashboardShell
      title={event.title}
      caption={caption ?? statusSentence(event)}
      tabs={tabs}
      activeTab={current}
      onTabChange={(id) => {
        const tab = SUB_TABS.find((t) => t.id === id)
        if (tab) navigate(tab.path(event.id))
      }}
    >
      <div className="mb-8">
        <button
          type="button"
          onClick={() => navigate('/manage/events')}
          className="text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
        >
          &#8592; All events
        </button>
      </div>
      {children}
    </DashboardShell>
  )
}

/**
 * The four screens all begin the same way: wait, explain, refuse, or render.
 * QLT-01 — none of these states is a blank page.
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
  if (result.state === 'loading') return <PageLoader />
  if (result.state === 'failed') {
    return (
      <div className="mx-auto max-w-2xl px-5 py-20">
        <LoadFailed what="this event" onRetry={() => void reload()} />
      </div>
    )
  }
  if (result.state === 'denied') {
    return (
      <div className="mx-auto max-w-2xl px-5 py-20">
        <Notice tone="error">
          This event belongs to somebody else. You can only open events you host.
        </Notice>
      </div>
    )
  }
  return <>{children(result.data)}</>
}

/* -------------------------------------------------------------------------- */
/* Words for states                                                            */
/* -------------------------------------------------------------------------- */

/** QLT-02. Status in a sentence, not a colour and not a bare enum value. */
export function statusSentence(event: EventRecord): string {
  if (event.status === 'cancelled') return 'Cancelled. Attendees have been told and entry is void.'
  if (event.status === 'draft') return 'Draft. Nobody can find this event until you publish it.'
  const finished = new Date(event.ends_at ?? event.starts_at).getTime() < Date.now()
  return finished ? 'Published, and now finished.' : 'Published and visible to attendees.'
}

const STATUS_TONE: Record<EventStatus, string> = {
  draft: 'text-dim border-line bg-raised',
  published: 'text-positive border-[#b9d8c4] bg-[#eff8f2]',
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
