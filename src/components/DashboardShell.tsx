import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { homePathFor, useAuth } from '../context/AuthProvider'
import { NotificationBell } from './NotificationBell'
import { Wordmark } from './ui'

export interface Tab {
  id: string
  label: string
  count?: number
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  connector: 'Connector',
  user: 'Member',
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
function navLinks(profile: Parameters<typeof homePathFor>[0]) {
  return [
    { to: homePathFor(profile), label: 'Dashboard' },
    { to: '/feed', label: 'Feed' },
    { to: '/events', label: 'Events' },
    { to: '/circle', label: 'Circle' },
    { to: '/profile', label: 'Profile' },
  ]
}

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `shrink-0 text-xs tracking-[0.1em] uppercase transition-colors ${
          isActive ? 'text-gold' : 'text-dim hover:text-fg'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

export function DashboardShell({
  title,
  caption,
  tabs,
  activeTab,
  onTabChange,
  children,
}: {
  title: string
  caption?: string
  tabs?: Tab[]
  activeTab?: string
  onTabChange?: (id: string) => void
  children: ReactNode
}) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Following a link should close the menu behind you.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!menuOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    // preventScroll: focusing inside a fixed panel otherwise drags the
    // page behind it to the top.
    menuRef.current
      ?.querySelector<HTMLElement>('a, button')
      ?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  const links = navLinks(profile)
  const roleLabel = ROLE_LABEL[profile?.role ?? ''] ?? ''

  return (
    <div className="ambient min-h-screen bg-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="flex h-14 items-center justify-between gap-2 sm:gap-4">
            <div className="flex min-w-0 items-center gap-7">
              <Wordmark size="sm" />
              <nav className="hidden items-center gap-5 lg:flex">
                {links.map((link) => (
                  <NavItem key={link.label} to={link.to}>
                    {link.label}
                  </NavItem>
                ))}
              </nav>
            </div>

            {/* One bell, at every width. Rendering it twice — once per
                breakpoint group — gave two channels the same name, and the
                second .on() after subscribe() throws. */}
            <NotificationBell />

            {/* Wide: name, role and sign out sit in the bar. */}
            <div className="hidden shrink-0 items-center gap-4 lg:flex">
              <div className="text-right">
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
            </div>

            {/* Narrow: everything above lives in a drawer, including the
                name and role, which used to disappear entirely below 640px. */}
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
          </div>
        </div>
      </header>

      {/* Slides in from the right, where the button is. Rendered outside the
          header so the backdrop covers the whole page. */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${menuOpen ? '' : 'pointer-events-none'}`}
        aria-hidden={!menuOpen}
      >
        <div
          onClick={() => setMenuOpen(false)}
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
              <div className="truncate text-sm font-medium text-fg">{profile?.full_name}</div>
              <div className="text-[0.6875rem] tracking-wide text-dim">{roleLabel}</div>
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

          <nav className="flex-1 overflow-y-auto py-2">
            {links.map((link) => (
              <NavLink
                key={link.label}
                to={link.to}
                end
                className={({ isActive }) =>
                  `block px-5 py-3 text-xs tracking-[0.12em] uppercase transition-colors ${
                    isActive ? 'bg-gold-wash text-gold' : 'text-dim hover:text-fg'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <button
            type="button"
            onClick={handleSignOut}
            className="border-t border-line px-5 py-4 text-left text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </div>

      <main className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <div className="border-b border-line py-10 sm:py-12">
          <h1 className="display text-3xl sm:text-4xl">{title}</h1>
          {caption && <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{caption}</p>}
        </div>

        {tabs && tabs.length > 0 && (
          // Wraps rather than scrolls, for the same reason as the nav: six
          // admin tabs do not fit on a phone, and a tab you have to scroll to
          // is a tab nobody presses.
          <nav className="-mb-px flex flex-wrap gap-x-7 border-b border-line">
            {tabs.map((tab) => {
              const active = tab.id === activeTab
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange?.(tab.id)}
                  className={`shrink-0 border-b py-3.5 text-xs tracking-[0.14em] uppercase transition-colors ${
                    active
                      ? 'border-gold text-fg'
                      : 'border-transparent text-dim hover:text-muted'
                  }`}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className={`ml-2 tabular-nums ${active ? 'text-gold' : 'text-dim'}`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        )}

        <div className="pt-8">{children}</div>
      </main>
    </div>
  )
}
