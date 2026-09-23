import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../../components/AppShell'
import { SiteHeader } from '../../components/SiteHeader'
import { Button, PageLoader } from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import {
  CAPACITY_WORDS,
  eventWhen,
  eventWhere,
  type CapacityState,
  type PublicEvent,
  type PublicEventRow,
  type TicketType,
} from '../../lib/events'
import { signMedia } from '../../lib/media'
import { loadFailed, supabase } from '../../lib/supabase'

/**
 * What the five attendee screens share, and nothing else.
 *
 * The attendee journey is one continuous thing — a stranger opens a link
 * somebody sent them, reads about an evening, signs up, pays, and arrives at a
 * door holding a ticket. They should not notice a seam anywhere along it, so
 * all five screens wear the same public brand language (`brand-experience`,
 * the one Landing.tsx and the sign-in pages already wear) rather than
 * switching to the member dashboard's chrome halfway through checkout.
 *
 * What the brand chrome must NOT do is strand a member, and for a while it
 * did: pressing "Events" dropped the whole app nav and moved what was left to
 * the other side of the screen. The header is no longer this file's business
 * at all — SiteHeader is the same header on every page, and it is the one
 * place that decides what an anonymous visitor, an event-only account and a
 * member each get. What is left here is the layout around it.
 */

/* -------------------------------------------------------------------------- */
/* Page chrome                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The frame every attendee screen sits in, signed in or not. Signed in, it
 * sits inside AppShell, so a member never loses the sidebar on the way to a
 * ticket; anonymous, it keeps the public header.
 *
 * `brand-experience` carries the public layout — rounder controls, the wider
 * `brand-container` measure, the softer focus ring — which the shared
 * primitives in ui.tsx pick up without any of them knowing this file exists.
 * The same trick AuthLayout uses. The palette itself is site-wide now, which
 * is why SiteHeader can be dropped in here and look like it belongs.
 */
export function EventShell({
  children,
  back,
}: {
  children: ReactNode
  /** Where the back link goes, when this screen is somewhere you came from. */
  back?: { to: string; label: string }
}) {
  const { session, profile, loading } = useAuth()
  const signedIn = Boolean(session && profile)

  // Nothing of the page until auth settles, so its children mount once, in
  // the frame they belong to, rather than again when the sidebar arrives.
  if (loading) return <PageLoader />

  const main = (
    <main id="event-main" className="brand-container flex-1 pb-24">
      {back && (
        <Link to={back.to} className="brand-text-link mb-6 inline-flex py-2">
          <span aria-hidden="true">&larr;</span> {back.label}
        </Link>
      )}
      {children}
    </main>
  )

  // Signed in, AppShell carries the skip link and the only navigation.
  if (signedIn) {
    return (
      <AppShell>
        <div className="brand-experience flex flex-col">{main}</div>
      </AppShell>
    )
  }
  return (
    <div className="brand-experience flex min-h-screen flex-col">
      <a className="brand-skip-link" href="#event-main">
        Skip to content
      </a>
      <SiteHeader />
      {main}
      <footer className="brand-container flex items-center justify-between gap-4 border-t border-line py-7 text-xs text-dim">
        <span>People, not profiles.</span>
        <span>amazing &copy; {new Date().getFullYear()}</span>
      </footer>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Which of my events pages a booking lives on                                 */
/* -------------------------------------------------------------------------- */

export type BookingBucket = 'upcoming' | 'past' | 'cancelled'

/** The three My events pages, each its own sidebar link. */
export const BOOKING_PAGES: Record<BookingBucket, { title: string; path: string }> = {
  upcoming: { title: 'Coming up', path: '/events/mine' },
  past: { title: 'Been to', path: '/events/mine/past' },
  cancelled: { title: 'Cancelled', path: '/events/mine/cancelled' },
}

/**
 * Where a booking is filed, so every link to it names and opens that page.
 * Cancelled wins over time: a dinner called off last month did not happen, and
 * there may still be money outstanding on it. An event we cannot read counts
 * as still to come, which is where an unresolved thing belongs.
 */
export function bookingBucket(
  event: { status: string; starts_at: string; ends_at: string | null } | null,
  registration?: { status: string } | null,
  now = Date.now(),
): BookingBucket {
  if (registration?.status === 'cancelled' || event?.status === 'cancelled') return 'cancelled'
  if (!event) return 'upcoming'
  return new Date(event.ends_at ?? event.starts_at).getTime() < now ? 'past' : 'upcoming'
}

export function bookingPage(
  ...args: Parameters<typeof bookingBucket>
): { title: string; path: string } {
  return BOOKING_PAGES[bookingBucket(...args)]
}

/* -------------------------------------------------------------------------- */
/* States, in words                                                            */
/* -------------------------------------------------------------------------- */

/**
 * QLT-04 and ORG-03A. Sold out and registration closed are different facts and
 * a reader acts on them differently — one means "you are too late", the other
 * means "the organiser has stopped taking people". So they get different words
 * from CAPACITY_WORDS, and the words do the work. The tone is decoration and
 * is never the only thing carrying the meaning.
 *
 * ponytail: a colour map, not a component library. If a sixth state appears,
 * add a row.
 */
const STATE_TONE: Record<CapacityState, string> = {
  open: 'border-[#b9d8c4] bg-[#dcf0e4] text-positive',
  sold_out: 'border-[#efc98f] bg-[#f6ecd9] text-[#8a4b00]',
  closed: 'border-[#efc98f] bg-[#f6ecd9] text-[#8a4b00]',
  cancelled: 'border-[#e6b5ad] bg-[#fff0ec] text-negative',
  finished: 'border-line-strong bg-raised text-dim',
}

export function StateBadge({ state }: { state: CapacityState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap ${STATE_TONE[state]}`}
    >
      {CAPACITY_WORDS[state]}
    </span>
  )
}

/**
 * How many places are left, said the way a person would say it.
 *
 * An unlimited event says nothing rather than inventing a number, and an event
 * with plenty of room says nothing either — "412 places remaining" is not
 * information, it is noise. The count only appears once it is the reason to
 * decide now.
 */
export function remainingWords(
  event: Pick<PublicEvent, 'capacity_state' | 'remaining'>,
): string | null {
  if (event.capacity_state !== 'open') return null
  const left = event.remaining
  if (left === null || left > 10 || left <= 0) return null
  return left === 1 ? 'One place left' : `${left} places left`
}

/* -------------------------------------------------------------------------- */
/* The when and the where                                                      */
/* -------------------------------------------------------------------------- */

/**
 * EVT-02. The same two lines wherever an event is described, so the public
 * page, the checkout summary and the ticket cannot drift apart about when and
 * where somebody is expected. eventWhen() names the timezone, because an
 * event happens in its own, not in the reader's.
 */
export function WhenWhere({ event }: { event: PublicEventRow }) {
  const where = eventWhere(event)
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="eyebrow">When</dt>
        <dd className="mt-1 text-fg">{eventWhen(event)}</dd>
      </div>
      {where && (
        <div>
          <dt className="eyebrow">Where</dt>
          <dd className="mt-1 whitespace-pre-wrap text-fg">{where}</dd>
        </div>
      )}
    </dl>
  )
}

/* -------------------------------------------------------------------------- */
/* Reading events                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The anon-readable views, composed into the one shape the screens want.
 *
 * `event_public` carries the event and its host names with no email addresses;
 * `event_availability` carries the live capacity picture; `ticket_types` is
 * read directly under the same visibility as its event (CONTRACT §3). Three
 * reads rather than one, because they have three different freshness
 * requirements — an event changes rarely, availability changes while somebody
 * is looking at it.
 */
async function attachAvailability(rows: PublicEventRow[]): Promise<PublicEvent[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  const [availability, types, perType] = await Promise.all([
    supabase.from('event_availability').select('*').in('event_id', ids),
    supabase
      .from('ticket_types')
      .select('*')
      .in('event_id', ids)
      .eq('is_active', true)
      .order('position'),
    // ORG-04. `ticket_types.quantity` is the cap the organiser set, not what
    // is left — nothing decrements it and a check constraint keeps it above
    // zero, so rendering it as "N left" said twenty when one remained. This
    // view counts what `enforce_event_capacity` counts, so the page and the
    // trigger agree about which option has gone.
    supabase.from('ticket_type_availability').select('*').in('event_id', ids),
  ])
  if (availability.error) throw availability.error
  if (types.error) throw types.error
  if (perType.error) throw perType.error

  const leftOnType = new Map(
    (((perType.data as { ticket_type_id: string; remaining: number | null }[] | null) ?? []).map(
      (t) => [t.ticket_type_id, t.remaining],
    )),
  )

  const byEvent = new Map(
    (
      (availability.data as
        | { event_id: string; remaining: number | null; state: CapacityState }[]
        | null) ?? []
    ).map((a) => [a.event_id, a]),
  )

  return rows.map((event) => ({
    ...event,
    host_names: (event as PublicEvent).host_names ?? [],
    // A view that has not answered for this event is not a reason to offer
    // entry to it. Falling back to `closed` fails towards not selling a place
    // we cannot prove exists, which is the direction to fail in.
    capacity_state: byEvent.get(event.id)?.state ?? 'closed',
    remaining: byEvent.get(event.id)?.remaining ?? null,
    ticket_types: ((types.data as TicketType[] | null) ?? [])
      .filter((t) => t.event_id === event.id)
      // `remaining` is what is left; `quantity` stays the cap it always was,
      // so anything reading it for "how big is this option" is unaffected.
      .map((t) => ({ ...t, remaining: leftOnType.get(t.id) ?? null })),
  }))
}

/** EVT-01. Null means no such event, which is a different screen from a failure. */
export async function loadPublicEvent(slug: string): Promise<PublicEvent | null> {
  const { data, error } = await supabase
    .from('event_public')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const [composed] = await attachAvailability([data as PublicEventRow])
  return composed ?? null
}

/**
 * EVT-05, ATT-10. What is still to come, soonest first, plus anything already
 * under way that is still taking registrations — a weekend festival or an
 * evening with late entry does not vanish from the list at its first minute,
 * the way Eventbrite and Luma keep a running event listed while it sells.
 * Anything that has ended is not somewhere you can go, so it is not on the
 * list — browse is for deciding where to be, not for reading history.
 *
 * "Ended" is the end time, or the start time when the host left the end
 * open, which is the same line event_capacity_state draws for `finished`.
 */
export async function loadUpcomingEvents(): Promise<PublicEvent[]> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('event_public')
    .select('*')
    .eq('status', 'published')
    .or(`ends_at.gte.${now},and(ends_at.is.null,starts_at.gte.${now})`)
    .order('starts_at', { ascending: true })
  if (error) throw error
  const events = await attachAvailability((data as PublicEventRow[] | null) ?? [])
  // Started and not open (sold out, closed) is not somewhere you can still go.
  return events.filter(
    (e) => new Date(e.starts_at).getTime() >= Date.parse(now) || e.capacity_state === 'open',
  )
}

/* -------------------------------------------------------------------------- */
/* Covers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The media bucket is private, so a cover needs signing before it renders.
 * A missing signature is not an error worth showing anybody — the page is
 * about the event, and it reads perfectly well without a photograph.
 */
export function useCovers(paths: (string | null | undefined)[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  // A stable string, so the effect fires when the set of covers changes and
  // not on every render that rebuilds the array.
  const key = paths.filter(Boolean).sort().join('|')

  useEffect(() => {
    const wanted = key ? key.split('|') : []
    if (wanted.length === 0) return
    let active = true
    signMedia(wanted)
      .then((signed) => {
        if (active) setUrls(signed)
      })
      .catch((e) => loadFailed(e, 'event covers'))
    return () => {
      active = false
    }
  }, [key])

  return urls
}

/* -------------------------------------------------------------------------- */
/* Clocks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A ticking now, for the things that expire while somebody is looking at them:
 * a place held during checkout (BUY-06), and a payment being waited on.
 * Everything else takes the time once and leaves it alone.
 */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** "19:48", or null once there is nothing left to count. */
export function countdown(until: string | null, now: number): string | null {
  if (!until) return null
  const left = new Date(until).getTime() - now
  if (left <= 0) return null
  const total = Math.floor(left / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/* -------------------------------------------------------------------------- */
/* Holding on to a choice across a signup                                      */
/* -------------------------------------------------------------------------- */

/**
 * ACC-07. Somebody picks a ticket, discovers they need an account, goes away
 * to make one, and comes back. They should find the thing they picked still
 * picked — and if the price or the availability moved while they were filling
 * in a form, they should be told in words rather than discovering it at the
 * card screen.
 *
 * sessionStorage rather than the URL: a ticket choice is not worth putting in
 * a link somebody might share, and it should not outlive the tab. Every access
 * is wrapped, because storage throws outright in some private browsing modes
 * and a quota error must not take the event page down with it.
 */
export interface RememberedChoice {
  ticketTypeId: string | null
  /** What it cost when they chose it, so a change can be named precisely. */
  priceCents: number | null
  state: CapacityState
}

function choiceKey(slug: string): string {
  return `amazing.event.choice.${slug}`
}

export function rememberChoice(slug: string, choice: RememberedChoice): void {
  try {
    sessionStorage.setItem(choiceKey(slug), JSON.stringify(choice))
  } catch {
    // Storage unavailable. They lose the selection, not the event.
  }
}

/** Reads and clears — a remembered choice is for exactly one return trip. */
export function takeChoice(slug: string): RememberedChoice | null {
  try {
    const raw = sessionStorage.getItem(choiceKey(slug))
    if (!raw) return null
    sessionStorage.removeItem(choiceKey(slug))
    return JSON.parse(raw) as RememberedChoice
  } catch {
    return null
  }
}

/*
 * BUY-04's idempotency key used to live here, held in sessionStorage so a
 * refresh could not open a second Stripe session. It has been deleted: the
 * key is derived server-side in stripe-checkout from the event, the person,
 * the ticket type and the live registration id, so the same attempt computes
 * the same key with no help from the browser — and a key the browser could
 * lose was a promise this file was in no position to keep.
 */

/* -------------------------------------------------------------------------- */
/* Loading a page                                                              */
/* -------------------------------------------------------------------------- */

/**
 * QLT-02. The three answers every one of these screens has to give — still
 * loading, could not load, loaded — with the retry wired up once.
 *
 * `reload` is handed back so a screen can refresh itself after an action
 * without re-implementing the whole dance, and takes a `quietly` flag for the
 * refreshes nobody asked for: a poll that blanks the page every few seconds is
 * worse than no poll at all.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const run = useCallback(
    async (quietly = false) => {
      if (!quietly) setLoading(true)
      setFailed(false)
      try {
        setData(await load())
      } catch (e) {
        loadFailed(e, 'this page')
        setFailed(true)
      } finally {
        setLoading(false)
      }
    },
    // The caller declares what the load depends on; `load` itself is a fresh
    // closure on every render and would spin forever as a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  )

  useEffect(() => {
    void run()
  }, [run])

  return { data, loading, failed, reload: run, setData }
}

/* -------------------------------------------------------------------------- */
/* Session expired                                                             */
/* -------------------------------------------------------------------------- */

/**
 * QLT-02. What to show when a screen needs an account and there is not one —
 * on a page somebody reached by following a link from an email, days later,
 * after their session quietly lapsed. BUY-12: losing the email is not losing
 * the ticket, and this is the way back to it.
 *
 * It carries where they were going, so signing in puts them back there rather
 * than on a dashboard.
 */
export function NeedsSignIn({ what, to }: { what: string; to: string }) {
  return (
    <div className="mx-auto max-w-md rounded-[6px] border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="text-sm text-muted">Sign in to see {what}.</p>
      <p className="mt-2 text-xs text-dim">
        You may have been signed out. Nothing has been lost.
      </p>
      <Button
        variant="primary"
        className="mt-6"
        onClick={() => {
          // A full navigation rather than a router push: sign-in decides where
          // to send people afterwards, and the address is how we tell it.
          window.location.assign(`/signin?next=${encodeURIComponent(to)}`)
        }}
      >
        Sign in
      </Button>
    </div>
  )
}
