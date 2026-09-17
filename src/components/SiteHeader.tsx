import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { homePathFor, isNetworkMember, useAuth } from '../context/AuthProvider'
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
 * Anonymous visitors still get the public variant — browse and sign in, no
 * member links, no bell, no name — because /e/:slug, /events and checkout have
 * to work for somebody with no account at all (EVT-01). That is the only
 * branch in this file that matters.
 */

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  connector: 'Connector',
  user: 'Member',
}

/* -------------------------------------------------------------------------- */
/* What is in the nav                                                          */
/* -------------------------------------------------------------------------- */

interface NavLeaf {
  to: string
  label: string
}

/** One button that opens onto several addresses. Only Events is one today. */
interface NavGroup {
  label: string
  items: NavLeaf[]
}

type NavEntry = NavLeaf | NavGroup

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry
}

/** Active for the address itself and everything underneath it. */
function matches(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}

/**
 * Feed, events and the circle are shared by all three roles, so the nav lives
 * here rather than being rebuilt per dashboard.
 *
 * Inline above 1024px, a drawer below it. The line is lg rather than md
 * because an iPad in portrait is 820px wide: at md it would get the desktop
 * bar and the name would crowd the links. Phones and tablets get the menu.
 *
 * A menu, not a sideways scroll — a link you have to scroll to is a link most
 * people never find, and nothing on screen says it is there.
 */
function navLinks(profile: Profile | null): NavEntry[] {
  // ORG-01, ORG-01C. `/events` is the attendee's page — what is on, and what
  // they can book. It is not a way in to hosting, and until this link existed
  // there was none: every route into /manage/events came from inside
  // /manage/events itself or from a notification, so an administrator with no
  // events and no notifications had to type the address to create their first
  // one. A screen you can only reach by knowing the URL is a screen that does
  // not exist.
  //
  // Shown on role rather than on `may_create_events`, deliberately. A
  // connector whose permission is switched *off* still manages the events they
  // already host (ORG-01C), so the page is theirs either way; the list itself
  // asks the real question and replaces the create button with the reason when
  // the answer is no. Ordinary members are the ones excluded, and for them the
  // page would be empty in every state.
  const hosts = profile?.role === 'admin' || profile?.role === 'connector'

  // ACC-01, ACC-05. An event-only account is not allowed into the feed or the
  // circle — RequireMember meets it with a sentence, which is the right answer
  // but a poor destination. A link that is certain to bounce whoever follows it
  // is worse than no link, so it is not offered.
  const member = isNetworkMember(profile)

  // /events/mine is where a ticket is found, and BUY-12 means that has to be
  // reachable from anywhere rather than only from the confirmation email.
  // Omitted for an event-only account, whose Dashboard link is already this
  // exact address (homePathFor) — one nav should not offer the same page twice.
  const home = homePathFor(profile)

  // Three addresses, one word. Browsing what is on, looking at your own
  // tickets and running an event you host are all "events" to the person
  // reading the bar, and three sibling links spent a third of it saying so.
  // The group is only built when there is more than browsing in it — a menu
  // holding one item is a link wearing a costume.
  const eventItems: NavLeaf[] = FEATURES.events
    ? [
        { to: '/events', label: 'Browse' },
        ...(home !== '/events/mine' ? [{ to: '/events/mine', label: 'My events' }] : []),
        ...(hosts ? [{ to: '/manage/events', label: 'Hosting' }] : []),
      ]
    : []

  return [
    { to: home, label: 'Dashboard' },
    // Held back until the client signs them off. See src/lib/features.ts.
    ...(FEATURES.feed && member ? [{ to: '/feed', label: 'Feed' }] : []),
    ...(eventItems.length > 1
      ? [{ label: 'Events', items: eventItems }]
      : eventItems.map((item) => ({ ...item, label: 'Events' }))),
    // BUY-14. A connector's own Stripe setup was reachable from exactly one
    // place: the "this event cannot sell" banner on an event they had already
    // created and tried to put paid tickets on. So the only route to connecting
    // an account ran through failing to sell first. Admins are not offered it —
    // platform events pay Amazing's own account (BUY-13) and there is no
    // connector row behind an admin to set up.
    ...(FEATURES.events && profile?.role === 'connector'
      ? [{ to: '/connector/payments', label: 'Payments' }]
      : []),
    ...(member ? [{ to: '/circle', label: 'Circle' }] : []),
    { to: '/profile', label: 'Profile' },
  ]
}

/** EVT-01. What a visitor with no account is offered, and all they are offered. */
function publicLinks(): NavEntry[] {
  return FEATURES.events ? [{ to: '/events', label: 'Browse events' }] : []
}

/* -------------------------------------------------------------------------- */
/* Closing things                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Escape, or a press anywhere outside, closes it.
 *
 * The drawer and the Events menu are the same problem twice, so they are the
 * same six lines once. pointerdown rather than click: a menu that survives
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
 * The header's own menu uses it, and so does the admin sidebar's — which is
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

/**
 * The Events menu.
 *
 * A menu button rather than a hover flyout: hover cannot be pressed on a
 * phone, cannot be reached from a keyboard and opens itself when somebody is
 * only passing through on the way to Circle. Click opens, Escape closes and
 * hands focus back to the button, a press outside closes, arrows walk the
 * items and Tab leaves. Focus rings come from the global :focus-visible rule
 * in index.css, so there is nothing to style here.
 */
function NavGroupMenu({ group }: { group: NavGroup }) {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  // Set when the menu is opened from the keyboard, so focus lands on an item
  // rather than staying behind on the button that opened it.
  const wanted = useRef<'first' | 'last' | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    // Only take focus back if it is in here to take. On an outside press it
    // belongs to whatever was pressed, and stealing it would be a bug.
    if (boxRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
  }, [])
  useDismiss(open, close, boxRef)

  function itemEls(): HTMLAnchorElement[] {
    return Array.from(
      boxRef.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? [],
    )
  }

  useEffect(() => {
    const want = wanted.current
    if (!open || !want) return
    wanted.current = null
    const all = itemEls()
    ;(want === 'first' ? all[0] : all[all.length - 1])?.focus()
  }, [open])

  // Choosing an item is a press *inside* the menu, so the outside-press rule
  // never fires and the menu would still be hanging open over the page it
  // just opened. Closed on arrival instead — and without the focus hand-back,
  // which belongs to the Escape key, not to leaving the page.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  function onTriggerKey(e: ReactKeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    wanted.current = e.key === 'ArrowDown' ? 'first' : 'last'
    setOpen(true)
  }

  function onMenuKey(e: ReactKeyboardEvent) {
    const all = itemEls()
    if (all.length === 0) return
    const at = all.indexOf(document.activeElement as HTMLAnchorElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      all[(at + step + all.length) % all.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      all[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      all[all.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      // Tabbing out of a menu means leaving it, not cycling inside it.
      setOpen(false)
    }
  }

  const active = group.items.some((item) => matches(pathname, item.to))

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        className={`${ITEM} flex items-center gap-1.5 ${
          active || open ? 'text-gold' : 'text-dim hover:text-fg'
        }`}
      >
        {group.label}
        <span aria-hidden className="text-[0.5rem] leading-none">
          &#9660;
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={group.label}
          onKeyDown={onMenuKey}
          className="absolute top-full left-0 z-40 mt-2 min-w-44 border border-line bg-ink py-1 shadow-[0_18px_40px_rgba(16,46,40,0.18)]"
        >
          {group.items.map((item) => (
            <NavLink
              key={item.label}
              role="menuitem"
              to={item.to}
              end
              className={({ isActive }) =>
                `block px-4 py-2.5 text-xs tracking-[0.1em] whitespace-nowrap uppercase transition-colors ${
                  isActive ? 'bg-gold-wash text-gold' : 'text-dim hover:text-fg'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

/** One row of the drawer. Group members are indented under their heading. */
function DrawerLink({
  to,
  indent,
  children,
}: {
  to: string
  indent?: boolean
  children: ReactNode
}) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `block py-3 text-xs tracking-[0.12em] uppercase transition-colors ${
          indent ? 'pr-5 pl-8' : 'px-5'
        } ${isActive ? 'bg-gold-wash text-gold' : 'text-dim hover:text-fg'}`
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

  // `nav={false}` is for a page that carries its own navigation somewhere else
  // — the admin area puts its sections in a left sidebar. The header keeps the
  // wordmark, the bell and who you are, and stops claiming to be the way
  // around the site. No links means no drawer either: there is nothing in it.
  const entries = !nav ? [] : signedIn ? navLinks(profile) : publicLinks()
  const roleLabel = ROLE_LABEL[profile?.role ?? ''] ?? ''

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
                  {entries.map((entry) =>
                    isGroup(entry) ? (
                      <NavGroupMenu key={entry.label} group={entry} />
                    ) : (
                      <NavItem key={entry.label} to={entry.to}>
                        {entry.label}
                      </NavItem>
                    ),
                  )}
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

              {/* With a nav, this is the drawer's job below lg. Without one,
                  there is no drawer, so it stays in the bar at every width and
                  only the name steps aside on the narrowest screens. */}
              <div className={`shrink-0 items-center gap-4 ${nav ? 'hidden lg:flex' : 'flex'}`}>
                {signedIn ? (
                  <>
                    <div className={nav ? 'text-right' : 'hidden text-right sm:block'}>
                      <div className="text-xs font-medium text-fg">{profile?.full_name}</div>
                      <div className="text-[0.6875rem] tracking-wide text-dim">{roleLabel}</div>
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

              {/* Narrow: everything above lives in a drawer, including the
                  name and role, which used to disappear entirely below 640px. */}
              {nav && (
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
      {nav && (
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
              <div className="min-w-0">
                {signedIn ? (
                  <>
                    <div className="truncate text-sm font-medium text-fg">{profile?.full_name}</div>
                    <div className="text-[0.6875rem] tracking-wide text-dim">{roleLabel}</div>
                  </>
                ) : (
                  <div className="text-sm font-medium text-fg">Menu</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="-mt-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center text-dim transition-colors hover:text-fg"
              >
                &#10005;
              </button>
            </div>

            {/* No dropdown in here. A floating menu inside a drawer is two
              layers of hiding for three links, so the group is a heading with
              its items under it and everything is visible at once. */}
            <nav aria-label="Main" className="flex-1 overflow-y-auto py-2">
              {entries.map((entry) =>
                isGroup(entry) ? (
                  <div key={entry.label} className="py-1">
                    <div className="eyebrow px-5 pt-3 pb-1">{entry.label}</div>
                    {entry.items.map((item) => (
                      <DrawerLink key={item.label} to={item.to} indent>
                        {item.label}
                      </DrawerLink>
                    ))}
                  </div>
                ) : (
                  <DrawerLink key={entry.label} to={entry.to}>
                    {entry.label}
                  </DrawerLink>
                ),
              )}
            </nav>

            {signedIn ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="border-t border-line px-5 py-4 text-left text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
              >
                Sign out
              </button>
            ) : (
              <Link
                to="/signin"
                className="border-t border-line px-5 py-4 text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  )
}
