import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { SiteHeader, useDrawer } from '../../components/SiteHeader'
import { FlagsPanel } from '../../components/FlagsPanel'
import { useLive } from '../../lib/live'
import { supabase } from '../../lib/supabase'
import Circles from './Circles'
import Connectors from './Connectors'
import Events from './Events'
import Log from './Log'
import Members from './Members'
import Notes from './Notes'
import Payments from './Payments'
import Waitlist from './Waitlist'

/**
 * The counts the sidebar badges put on screen.
 *
 * Deliberately a separate, tiny read rather than a by-product of the section
 * pages: a number next to "Waitlist" is only useful when you are *not* on the
 * waitlist, so it cannot come from the page that loads waitlist rows.
 */
export interface AdminCounts {
  connectors: number | null
  members: number | null
  events: number | null
  notes: number | null
  waitlist: number | null
  codes: number | null
}

const NO_COUNTS: AdminCounts = {
  connectors: null,
  members: null,
  events: null,
  notes: null,
  waitlist: null,
  codes: null,
}

export interface AdminSection {
  /** Absolute, so the sidebar and the router read the same string. */
  to: string
  label: string
  /** Sidebar heading this sits under. Sections with the same group stay together. */
  group: string
  element: ReactNode
  /** Which live count to show beside the label, if any. */
  badge?: keyof AdminCounts
  /** Unused today. Here because a twenty-item sidebar will want them. */
  icon?: ReactNode
}

/**
 * Every screen under /admin, in sidebar order.
 *
 * This array is the whole navigation: the sidebar renders it, App.tsx turns it
 * into routes, and `/admin` redirects to the first entry. Adding the ninth
 * section is one object here plus the component it names — never an edit to
 * the layout, the router, or the drawer.
 *
 * The groups matter more than they look. Eight items need no headings; twenty
 * do, and a sidebar that grows into an undifferentiated list is the failure
 * this structure exists to avoid. Grouping now costs one field and means the
 * tenth section has somewhere obvious to go.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const ADMIN_SECTIONS: AdminSection[] = [
  // Who can let people in, who is in, and who is asking.
  { to: '/admin/connectors', label: 'Connectors', group: 'People', badge: 'connectors', element: <Connectors /> },
  { to: '/admin/members', label: 'Members', group: 'People', badge: 'members', element: <Members /> },
  { to: '/admin/waitlist', label: 'Waitlist', group: 'People', badge: 'waitlist', element: <Waitlist /> },

  // What members are doing to and about each other.
  { to: '/admin/circles', label: 'Circles', group: 'Network', badge: 'connectors', element: <Circles /> },
  { to: '/admin/notes', label: 'Notes', group: 'Network', badge: 'notes', element: <Notes /> },
  { to: '/admin/raised', label: 'Raised', group: 'Network', element: <FlagsPanel /> },

  // ORG-14. The platform's own records.
  { to: '/admin/events', label: 'Events', group: 'Platform', badge: 'events', element: <Events /> },
  { to: '/admin/payments', label: 'Payments', group: 'Platform', element: <Payments /> },
  { to: '/admin/log', label: 'Log', group: 'Platform', element: <Log /> },
]

/** The section groups, in first-appearance order, each with its sections. */
function grouped(): { group: string; sections: AdminSection[] }[] {
  const out: { group: string; sections: AdminSection[] }[] = []
  for (const section of ADMIN_SECTIONS) {
    const bucket = out.find((g) => g.group === section.group)
    if (bucket) bucket.sections.push(section)
    else out.push({ group: section.group, sections: [section] })
  }
  return out
}

/**
 * Six `head: true` counts — no rows cross the wire, only the numbers.
 *
 * This replaced loading all eleven tables on mount so that a badge could say
 * "35". The whole point of splitting the sections up is that opening the log
 * must not fetch the waitlist, and a count that fetched rows would have put
 * that straight back.
 */
function useAdminCounts(): AdminCounts {
  const [counts, setCounts] = useState<AdminCounts>(NO_COUNTS)
  const { pathname } = useLocation()

  const load = useCallback(async () => {
    const head = { count: 'exact' as const, head: true }
    const [connectors, members, events, notes, waitlist, codes] = await Promise.all([
      supabase.from('connectors').select('id', head),
      supabase.from('profiles').select('id', head).eq('role', 'user'),
      supabase.from('events').select('id', head),
      supabase.from('connector_notes').select('id', head),
      // Somebody already turned down is not still waiting at the door.
      supabase.from('waitlist_entries').select('id', head).is('declined_at', null),
      supabase.from('invite_codes').select('id', head).eq('status', 'active'),
    ])

    // A failed count shows nothing rather than a wrong zero: "Waitlist 0" and
    // "Waitlist" are different claims, and only one of them can be false.
    setCounts({
      connectors: connectors.count,
      members: members.count,
      events: events.count,
      notes: notes.count,
      waitlist: waitlist.count,
      codes: codes.count,
    })
  }, [])

  useEffect(() => {
    void load()
  }, [load, pathname])

  // Live, not on navigation. These used to recount only when you changed
  // section, so approving somebody on /admin/waitlist left the badge beside it
  // reading the old number until you clicked away and back — the sidebar
  // quietly disagreeing with the page you were looking at. Counts are the one
  // thing on screen whose whole job is to be current.
  useLive(
    ['connectors', 'profiles', 'events', 'connector_notes', 'waitlist_entries', 'invite_codes'],
    load,
  )

  return counts
}

function SectionLinks({
  counts,
  onNavigate,
}: {
  counts: AdminCounts
  onNavigate?: () => void
}) {
  return (
    <>
      {grouped().map(({ group, sections }) => (
        <div key={group} className="px-3 py-3">
          <p className="px-3 pb-2 text-[0.625rem] tracking-[0.16em] text-dim uppercase">
            {group}
          </p>
          {sections.map((section) => {
            const count = section.badge ? counts[section.badge] : null
            return (
              <NavLink
                key={section.to}
                to={section.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-sm px-3 py-2 text-xs tracking-[0.1em] uppercase transition-colors ${
                    isActive ? 'bg-gold-wash text-gold' : 'text-dim hover:text-fg'
                  }`
                }
              >
                {section.icon}
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                {count !== null && (
                  <span className="shrink-0 text-[0.6875rem] tabular-nums">{count}</span>
                )}
              </NavLink>
            )
          })}
        </div>
      ))}
    </>
  )
}

/**
 * Everything under /admin: one sidebar, and a route per section.
 *
 * Sections are addresses rather than tab state, so an administrator can send
 * somebody a link to the waitlist, the back button retraces their steps, and
 * a refresh leaves them where they were. That was the actual complaint about
 * the eight-tab page, not its looks.
 *
 * Notifications are in the top bar and nowhere else — SiteHeader owns the
 * bell, and this file must never grow a second one.
 */
export default function AdminLayout() {
  const counts = useAdminCounts()
  const location = useLocation()

  // Escape, a click outside, closing on navigation and the scroll lock, all
  // from the header's own drawer rather than a second copy of them here.
  const { open: menuOpen, setOpen: setMenuOpen, close, panelRef: menuRef } = useDrawer()

  const current = ADMIN_SECTIONS.find((s) => location.pathname.startsWith(s.to))

  return (
    <div className="ambient min-h-screen bg-ink">
      {/* Logo, the notification bell, name and sign out. No link row: the
          sidebar below is this area's navigation, and two navs pointing at
          different things in the same corner is how people get lost. */}
      <SiteHeader nav={false} />

      <div className="relative z-10 mx-auto flex max-w-[92rem]">
        {/* The same lg line as DashboardShell's nav. An iPad in portrait is
            820px wide and gets the drawer, not a squeezed sidebar. */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto border-r border-line py-6 lg:block">
          <div className="px-6 pb-2">
            <p className="display text-lg">Administration</p>
            <p className="mt-2 text-xs leading-relaxed text-dim">
              Who holds the ability to invite, who they&apos;ve brought in, and who is
              waiting at the door.
            </p>
          </div>
          <nav className="mt-2 border-t border-line pt-2">
            <SectionLinks counts={counts} />
          </nav>
        </aside>

        <main className="min-w-0 flex-1 px-5 pb-24 sm:px-8">
          {/* Below lg the sidebar is a drawer, so this row is what says where
              you are and how to go somewhere else. */}
          <div className="flex items-center gap-4 border-b border-line py-4 lg:hidden">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-expanded={menuOpen}
              aria-controls="admin-sections"
              className="flex items-center gap-2 text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
            >
              <span aria-hidden className="relative block h-3 w-4">
                <span className="absolute top-0 left-0 block h-px w-4 bg-current" />
                <span className="absolute top-1.5 left-0 block h-px w-4 bg-current" />
                <span className="absolute top-3 left-0 block h-px w-4 bg-current" />
              </span>
              Sections
            </button>
            <span className="truncate text-xs tracking-[0.12em] text-dim uppercase">
              &middot; {current?.label ?? 'Administration'}
            </span>
          </div>

          <div className="border-b border-line py-8 sm:py-10">
            <h1 className="display text-3xl sm:text-4xl">
              {current?.label ?? 'Administration'}
            </h1>
          </div>

          {/* The four tiles that used to sit here are gone.

              They were right when this was one page with eight tabs: you saw
              the shape of the platform once, on arrival. Repeated above all
              eight sections they became furniture — three of the four numbers
              are already in the sidebar beside the section they count, and
              reading "Connectors 0 / Members 0" above the activity log tells
              you nothing about the activity log.

              `Live codes` was the one figure with nowhere else to live, so it
              moved to the Connectors page, which is where codes are minted and
              the only place the number is actionable. */}
          <div className="pt-10">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Slides in from the left, where the sidebar lives. Rendered outside
          the layout row so the backdrop covers the whole page. */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${menuOpen ? '' : 'pointer-events-none'}`}
        aria-hidden={!menuOpen}
        // `inert` as well as aria-hidden: parked off-screen the panel is still
        // in the tab order without it, so on a phone eight invisible section
        // links sit between the page and everything after it.
        inert={!menuOpen}
      >
        <div
          onClick={close}
          className={`absolute inset-0 bg-fg/45 backdrop-blur-[1px] transition-opacity duration-200 ${
            menuOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />

        <div
          id="admin-sections"
          ref={menuRef}
          role="dialog"
          aria-modal="true"
          aria-label="Administration sections"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-ink transition-transform duration-200 ease-out ${
            menuOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <p className="display text-lg">Administration</p>
            <button
              type="button"
              onClick={close}
              aria-label="Close sections"
              className="-mt-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center text-dim transition-colors hover:text-fg"
            >
              &#10005;
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto py-2">
            <SectionLinks counts={counts} onNavigate={close} />
          </nav>
        </div>
      </div>
    </div>
  )
}
