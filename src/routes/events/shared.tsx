import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { navLinks } from '../../components/DashboardShell'
import { Button, Wordmark } from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import {
  CAPACITY_WORDS,
  eventWhen,
  eventWhere,
  type CapacityState,
  type EventRecord,
  type PublicEvent,
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
 * What the brand chrome must NOT do is strand a member. Signing in and then
 * pressing "Events" used to drop the whole app nav, leaving the browser's back
 * button and the wordmark as the only ways back — which is the bug this
 * branch fixes. So the frame is public, and the nav inside it is whoever is
 * reading: anonymous visitors get browse-and-sign-in, a signed-in person gets
 * the same links they see everywhere else in the app.
 *
 * The old objection to that — ACC-01 gives us event-only accounts, and the
 * member nav offered the feed and the circle, which they are not allowed into
 * — is answered in navLinks() itself, which no longer offers a door that will
 * not open. Showing somebody links that bounce them is worse than not showing
 * them, and it was worth fixing there rather than avoiding here.
 */

/* -------------------------------------------------------------------------- */
/* Page chrome                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The frame every attendee screen sits in, signed in or not.
 *
 * `brand-experience` re-declares the palette variables on itself, so the
 * shared primitives in ui.tsx — Button, Panel, Field — pick up the teal
 * without any of them knowing this file exists. The same trick AuthLayout uses.
 */
export function EventShell({
  children,
  back,
}: {
  children: ReactNode
  /** Where the back link goes, when this screen is somewhere you came from. */
  back?: { to: string; label: string }
}) {
  const { session, profile, signOut } = useAuth()
  const navigate = useNavigate()
  // Both, not just the session: an account with no profile row cannot use the
  // app nav (App.tsx meets it with NotProvisioned), so it reads as anonymous.
  const signedIn = Boolean(session && profile)

  return (
    <div className="brand-experience flex min-h-screen flex-col">
      <a className="brand-skip-link" href="#event-main">
        Skip to content
      </a>

      <header className="brand-container flex flex-wrap items-center justify-between gap-4 py-6">
        <Link to="/" aria-label="Amazing home">
          <Wordmark />
        </Link>
        <nav
          aria-label={signedIn ? 'Main' : 'Events'}
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]"
        >
          {signedIn ? (
            <>
              {/* The same links, in the same order, as the header on every
                  other signed-in page. Rendered here rather than by wrapping
                  the page in DashboardShell, because the shell also owns the
                  dark chrome and the page title, and these five screens are
                  the public brand experience described above. One nav, two
                  frames. */}
              {navLinks(profile).map((link) => (
                <Link
                  key={link.label}
                  to={link.to}
                  className="hover:text-fg hover:underline hover:underline-offset-4"
                >
                  {link.label}
                </Link>
              ))}
              <button
                type="button"
                onClick={async () => {
                  await signOut()
                  navigate('/')
                }}
                className="text-dim transition-colors hover:text-fg"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/events" className="hover:text-fg hover:underline hover:underline-offset-4">
                Browse events
              </Link>
              <Link to="/signin" className="hover:text-fg hover:underline hover:underline-offset-4">
                Sign in
              </Link>
            </>
          )}
        </nav>
      </header>

      <main id="event-main" className="brand-container flex-1 pb-24">
        {back && (
          <Link to={back.to} className="brand-text-link mb-6 inline-flex py-2">
            <span aria-hidden="true">&larr;</span> {back.label}
          </Link>
        )}
        {children}
      </main>

      <footer className="brand-container flex items-center justify-between gap-4 border-t border-line py-7 text-xs text-dim">
        <span>People, not profiles.</span>
        <span>amazing &copy; {new Date().getFullYear()}</span>
      </footer>
    </div>
  )
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
export function WhenWhere({ event }: { event: EventRecord }) {
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
async function attachAvailability(rows: EventRecord[]): Promise<PublicEvent[]> {
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
  const [composed] = await attachAvailability([data as EventRecord])
  return composed ?? null
}

/**
 * EVT-05. What is still to come, soonest first. Anything that has already
 * ended is not somewhere you can go, so it is not on the list — browse is for
 * deciding where to be, not for reading history.
 */
export async function loadUpcomingEvents(): Promise<PublicEvent[]> {
  const { data, error } = await supabase
    .from('event_public')
    .select('*')
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
  if (error) throw error
  return attachAvailability((data as EventRecord[] | null) ?? [])
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
        You may have been signed out. Nothing has been lost &mdash; it is waiting for you.
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
