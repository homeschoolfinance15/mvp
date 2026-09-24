import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { homePathFor, isNetworkMember, needsQuestionnaire, useAuth } from '../context/AuthProvider'
import { NotificationBell } from './NotificationBell'
import { Wordmark } from './ui'
import { FEATURES } from '../lib/features'
import type { Profile } from '../lib/types'

/**
 * The one header, worn by every page on the site.
 *
 * There used to be two. DashboardShell put the links on the left beside the
 * wordmark in uppercase, with the notification bell and the reader's name and
 * role on the right; EventShell put three sentence-case links on the far right
 * with no bell and no name. Pressing "Events" therefore moved the navigation
 * across the screen, changed its typography and silently dropped the bell —
 * which is what somebody looking at it reported as the nav bar "changing from
 * right and left" and notifications "missing some time". The bell was never
 * intermittent. It was absent on every attendee screen.
 *
 * So the header is one component now and the shells choose only the frame
 * around it: DashboardShell's dark page chrome and title block, EventShell's
 * public brand layout. What changes between them is nothing a reader can see
 * up here.
 *
 * Signed in, the bar carries no links at all, whatever `nav` says: the
 * wordmark, the bell, who you are and Sign out. Where to go lives in
 * AppShell's left sidebar, built from navLinks() below, for every role.
 *
 * Anonymous visitors still get the public variant — browse and sign in, with
 * its drawer below lg, no bell, no name — because /e/:slug, /events and
 * checkout have to work for somebody with no account at all (EVT-01). That is
 * the only branch in this file that matters.
 */

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  connector: 'Connector',
  user: 'Member',
}

/** What the top bar calls the reader: an event-only account is a Guest. */
// eslint-disable-next-line react-refresh/only-export-components
export function roleLabel(profile: Profile | null): string {
  if (profile?.role === 'user' && !isNetworkMember(profile)) return 'Guest'
  return ROLE_LABEL[profile?.role ?? ''] ?? ''
}

/* -------------------------------------------------------------------------- */
/* What is in the nav                                                          */
/* -------------------------------------------------------------------------- */

export interface NavLeaf {
  to: string
  label: string
}

/** One heading over several addresses: My events, Events, Hosting. */
export interface NavGroup {
  label: string
  items: NavLeaf[]
}

export type NavEntry = NavLeaf | NavGroup

// eslint-disable-next-line react-refresh/only-export-components
export function isGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry
}

/**
 * Feed, events and the circle are shared by all three roles, so the list lives
 * here rather than being rebuilt per dashboard. AppShell draws it as the
 * sidebar; this header no longer draws it at all.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function navLinks(profile: Profile | null): NavEntry[] {
  // ORG-01, ORG-01C. `/events` is the attendee's page — what is on, and what
  // they can book. It is not a way in to hosting, and until this link existed
  // there was none: every route into /manage/events came from inside
  // /manage/events itself or from a notification, so an administrator with no
  // events and no notifications had to type the address to create their first
  // one. A screen you can only reach by knowing the URL is a screen that does
  // not exist.
  //
  // Connectors only, and an administrator deliberately not.
  //
  // `/manage/events` filters to the events you host — except for an
  // administrator, for whom it does not filter at all, because they manage
  // every event. That made it the same query as `/admin/events`: the same list
  // of every event on the platform, in two places, differing only in whether a
  // row opened the editor or the record. Two doors to one room read as two
  // rooms, and the person using it reasonably asked which was which.
  //
  // So an administrator has one door, `/admin/events`, where creating and
  // opening an event both live, and the record view links on to the editor for
  // the one they picked. A connector keeps this link, because for them it is
  // genuinely their own events and they have no admin area at all.
  //
  // Shown on role rather than on `may_create_events`, deliberately: a
  // connector whose permission is switched *off* still manages the events they
  // already host (ORG-01C), so the page is theirs either way — the list asks
  // the real question and replaces the create button with the reason.
  const hosts = profile?.role === 'connector'

  // ACC-01, ACC-05. An event-only account is not allowed into the feed or the
  // circle — RequireMember meets it with a sentence, which is the right answer
  // but a poor destination. A link that is certain to bounce whoever follows it
  // is worse than no link, so it is not offered.
  const member = isNetworkMember(profile)

  // /events/mine is where a ticket is found, and BUY-12 means that has to be
  // reachable from anywhere rather than only from the confirmation email. It
  // is three pages, one per bucket, each its own address in the sidebar.
  const home = homePathFor(profile)
  const mine: NavLeaf[] = FEATURES.events
    ? [
        { to: '/events/mine', label: 'Coming up' },
        { to: '/events/mine/past', label: 'Been to' },
        { to: '/events/mine/cancelled', label: 'Cancelled' },
      ]
    : []
  const browse: NavLeaf[] = FEATURES.events ? [{ to: '/events', label: 'Browse' }] : []

  // An event-only account's home IS /events/mine, so its sidebar is its
  // tickets, what is on, and its profile — no separate home link. Decided on
  // the account rather than on homePathFor, which answers /onboarding until
  // onboarding is done and would hand them a member's sidebar meanwhile.
  if (profile?.role === 'user' && profile.network_member === false) {
    return [
      ...(mine.length ? [{ label: 'My events', items: mine }] : []),
      ...browse,
      { to: '/profile', label: 'Profile' },
    ]
  }

  // Until the questionnaire is answered every network page bounces back to
  // it, but events never did (their routes skip RequireRole), so a member
  // still answering keeps them — as Luma and Meetup let you book first.
  if (needsQuestionnaire(profile)) {
    return [
      { to: '/questions', label: 'Questions' },
      ...(FEATURES.events ? [{ label: 'Events', items: [...browse, ...mine] }] : []),
      { to: '/profile', label: 'Profile' },
    ]
  }

  const hosting: NavLeaf[] =
    FEATURES.events && hosts
      ? [
          { to: '/manage/events', label: 'Upcoming' },
          { to: '/manage/events/drafts', label: 'Drafts' },
          { to: '/manage/events/past', label: 'Past' },
          { to: '/manage/events/cancelled', label: 'Cancelled' },
        ]
      : []

  // A connector's home is three pages rather than one with tabs; /connector
  // itself only redirects to the first, so it gets no link of its own.
  const homeLinks: NavLeaf[] =
    profile?.role === 'connector'
      ? [
          { to: '/connector/people', label: 'People' },
          { to: '/connector/invitations', label: 'Invitations' },
          { to: '/connector/raised', label: 'Raised' },
        ]
      : [{ to: home, label: 'Dashboard' }]

  return [
    ...homeLinks,
    // Held back until the client signs them off. See src/lib/features.ts.
    ...(FEATURES.feed && member ? [{ to: '/feed', label: 'Feed' }] : []),
    ...(FEATURES.events
      ? // An administrator's admin sections already have an "Events".
        [{ label: profile?.role === 'admin' ? 'Attending' : 'Events', items: [...browse, ...mine] }]
      : []),
    ...(hosting.length ? [{ label: 'Hosting', items: hosting }] : []),
    // BUY-14. A connector's own Stripe setup was reachable from exactly one
    // place: the "this event cannot sell" banner on an event they had already
    // created and tried to put paid tickets on. So the only route to connecting
    // an account ran through failing to sell first. Admins are not offered it —
    // platform events pay Amazing's own account (BUY-13) and there is no
    // connector row behind an admin to set up.
    ...(FEATURES.events && profile?.role === 'connector'
      ? [{ to: '/connector/payments', label: 'Payments' }]
      : []),
    // An administrator is in no circle, so the page would only be empty.
    ...(member && profile?.role !== 'admin' ? [{ to: '/circle', label: 'Circle' }] : []),
    { to: '/profile', label: 'Profile' },
  ]
}

/** EVT-01. What a visitor with no account is offered, and all they are offered. */
function publicLinks(): NavLeaf[] {
  return FEATURES.events ? [{ to: '/events', label: 'Browse events' }] : []
}

/* -------------------------------------------------------------------------- */
/* Closing things                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Escape, or a press anywhere outside, closes it.
 *
 * Every drawer has this problem, so it is the same six lines once.
 * pointerdown rather than click: a menu that survives
 * until the mouse comes back up flickers, and a press that begins outside was
 * never meant for what is open.
 */
function useDismiss<T extends HTMLElement>(
  open: boolean,
  close: () => void,
  ref: RefObject<T | null>,
) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    function onDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, close, ref])
}

/**
 * Everything a slide-in panel has to do, so nobody writes it twice.
 *
 * Escape and an outside press close it; following a link closes it; the page
 * behind does not scroll while it is open; opening it moves focus inside.
 * The header's public menu uses it, and so does AppShell's sidebar — which is
 * the reason it is exported rather than inlined where it is used.
 *
 * Put `panelRef` on the panel itself, not on the backdrop: "outside" means
 * outside the thing you can touch.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useDrawer() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const panelRef = useRef<HTMLDivElement>(null)
  useDismiss(open, close, panelRef)

  // Following a link should close the menu behind you.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    // preventScroll: focusing inside a fixed panel otherwise drags the
    // page behind it to the top.
    panelRef.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return { open, setOpen, close, panelRef }
}

/* -------------------------------------------------------------------------- */
/* The bar                                                                     */
/* -------------------------------------------------------------------------- */

const ITEM = 'shrink-0 text-xs tracking-[0.1em] uppercase transition-colors'

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) => `${ITEM} ${isActive ? 'text-gold' : 'text-dim hover:text-fg'}`}
    >
      {children}
    </NavLink>
  )
}

/** One row of the drawer. */
function DrawerLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `block px-5 py-3 text-xs tracking-[0.12em] uppercase transition-colors ${
          isActive ? 'bg-gold-wash text-gold' : 'text-dim hover:text-fg'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

export function SiteHeader({ nav = true }: { nav?: boolean }) {
  const { session, profile, signOut } = useAuth()
  const navigate = useNavigate()

  // Both, not just the session: an account with no profile row cannot use the
  // member nav (App.tsx meets it with NotProvisioned), so it reads as anonymous.
  const signedIn = Boolean(session && profile)

  const { open: menuOpen, setOpen: setMenuOpen, panelRef: menuRef } = useDrawer()

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  // Only an anonymous visitor is ever offered links up here. Signed in, the
  // way around the site is AppShell's sidebar, so the header keeps the
  // wordmark, the bell and who you are, and has no drawer: there is nothing to
  // put in it. `nav={false}` does the same for an anonymous page.
  const publicNav = nav && !signedIn
  const entries = publicNav ? publicLinks() : []

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="flex h-14 items-center justify-between gap-2 sm:gap-4">
            <div className="flex min-w-0 items-center gap-7">
              <Link to={signedIn ? homePathFor(profile) : '/'} aria-label="Amazing home">
                <Wordmark size="sm" />
              </Link>
              {/* Not rendered empty: an empty navigation landmark is
                  something a screen reader announces and then finds nothing
                  in, which is what `nav={false}` would otherwise leave. */}
              {entries.length > 0 && (
                <nav aria-label="Main" className="hidden items-center gap-5 lg:flex">
                  {entries.map((entry) => (
                    <NavItem key={entry.label} to={entry.to}>
                      {entry.label}
                    </NavItem>
                  ))}
                </nav>
              )}
            </div>

            {/* Everything on the right, in one group, so the bell is top right
                on every page and in both variants rather than drifting into
                the middle of a bar with few links in it.

                One bell, at every width. Rendering it twice — once per
                breakpoint group — gave two channels the same name, and the
                second .on() after subscribe() throws. Nothing to ring for
                somebody with no account. */}
            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              {signedIn && <NotificationBell />}

              {/* For an anonymous visitor this is the drawer's job below lg.
                  Otherwise there is no drawer, so it stays in the bar at every
                  width and only the name steps aside on the narrowest screens. */}
              <div
                className={`shrink-0 items-center gap-4 ${publicNav ? 'hidden lg:flex' : 'flex'}`}
              >
                {signedIn ? (
                  <>
                    <div className="hidden text-right sm:block">
                      <div className="text-xs font-medium text-fg">{profile?.full_name}</div>
                      <div className="text-[0.6875rem] tracking-wide text-dim">{roleLabel(profile)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="text-xs text-dim transition-colors hover:text-fg"
                    >
                      Sign out
                    </button>
                  </>
                ) : (
                  <Link to="/signin" className={`${ITEM} text-dim hover:text-fg`}>
                    Sign in
                  </Link>
                )}
              </div>

              {/* Narrow and anonymous: browse and sign in live in a drawer. */}
              {publicNav && (
                <button
                  type="button"
                  onClick={() => setMenuOpen(true)}
                  aria-expanded={menuOpen}
                  aria-controls="main-menu"
                  aria-label="Open menu"
                  className="-mr-2 flex h-10 w-10 shrink-0 items-center justify-center text-fg lg:hidden"
                >
                  <span aria-hidden className="relative block h-3 w-5">
                    <span className="absolute top-0 left-0 block h-px w-5 bg-current" />
                    <span className="absolute top-1.5 left-0 block h-px w-5 bg-current" />
                    <span className="absolute top-3 left-0 block h-px w-5 bg-current" />
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Slides in from the right, where the button is. Rendered outside the
          header so the backdrop covers the whole page. */}
      {/* `inert` as well as aria-hidden: the panel is always mounted so it can
          slide, and a closed drawer parked off-screen still held tabbable
          links on a phone, where nothing above it is display:none. */}
      {publicNav && (
        <div
          className={`fixed inset-0 z-50 lg:hidden ${menuOpen ? '' : 'pointer-events-none'}`}
          aria-hidden={!menuOpen}
          inert={!menuOpen}
        >
          <div
            className={`absolute inset-0 bg-fg/45 backdrop-blur-[1px] transition-opacity duration-200 ${
              menuOpen ? 'opacity-100' : 'opacity-0'
            }`}
          />

          <div
            id="main-menu"
            ref={menuRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className={`absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col border-l border-line bg-ink transition-transform duration-200 ease-out ${
              menuOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 text-sm font-medium text-fg">Menu</div>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="-mt-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center text-dim transition-colors hover:text-fg"
              >
                &#10005;
              </button>
            </div>

            <nav aria-label="Main" className="flex-1 overflow-y-auto py-2">
              {entries.map((entry) => (
                <DrawerLink key={entry.label} to={entry.to}>
                  {entry.label}
                </DrawerLink>
              ))}
            </nav>

            <Link
              to="/signin"
              className="border-t border-line px-5 py-4 text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </>
  )
}
