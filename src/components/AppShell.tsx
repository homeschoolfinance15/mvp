import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'
import { ADMIN_LINKS, useAdminCounts, type AdminCounts } from '../lib/adminNav'
import { isGroup, navLinks, SiteHeader, useDrawer } from './SiteHeader'

/**
 * The frame every signed-in page sits in: navigation down the left, nothing
 * but the wordmark, the bell, the reader's name and Sign out across the top.
 *
 * There used to be two frames. /admin had a sidebar; every other signed-in
 * page — the connector and member dashboards, events, circle, profile — had
 * the links in the top bar. Going from the admin area to your profile moved
 * the whole navigation from the left edge to the top, which reads as two
 * different products. One frame now, for every role.
 *
 * The sidebar lists what SiteHeader's navLinks() lists for the reader's role,
 * so who sees what is still decided in one place. An administrator also gets
 * the admin sections, on every page, above those.
 */

export interface SideLink {
  to: string
  label: string
  /** A badge beside the label; null shows nothing rather than a wrong zero. */
  count?: number | null
}

export interface SideGroup {
  /** Heading above the links, or none for the first, unlabelled group. */
  label?: string
  links: SideLink[]
}

/**
 * The reader's own links, as sidebar groups, in navLinks() order: consecutive
 * loose links share an unlabelled group, and each NavGroup is its own labelled
 * group where it stands.
 */
function roleGroups(profile: Parameters<typeof navLinks>[0], skipHome: boolean): SideGroup[] {
  const groups: SideGroup[] = []
  for (const entry of navLinks(profile)) {
    if (isGroup(entry)) groups.push({ label: entry.label, links: entry.items })
    else if (skipHome && entry.label === 'Dashboard') continue
    else {
      const last = groups[groups.length - 1]
      if (last && !last.label) last.links.push(entry)
      else groups.push({ links: [entry] })
    }
  }
  return groups
}

/** The admin sections as sidebar groups, in first-appearance order. */
function adminGroups(counts: AdminCounts): SideGroup[] {
  const out: SideGroup[] = []
  for (const section of ADMIN_LINKS) {
    const link = {
      to: section.to,
      label: section.label,
      count: section.badge ? counts[section.badge] : null,
    }
    const bucket = out.find((g) => g.label === section.group)
    if (bucket) bucket.links.push(link)
    else out.push({ label: section.group, links: [link] })
  }
  return out
}

/** Pages with no link of their own, and the link that stands for them. */
const ALIASES: [from: string, to: string][] = [
  ['/events/tickets', '/events/mine'],
  // Feedback opens once an event has ended, so it belongs to Been to.
  ['/events/feedback', '/events/mine/past'],
  ['/connector/stripe', '/connector/payments'],
  ['/e', '/events'],
]

/** An administrator's hosting screens belong to the admin Events group. */
const ADMIN_ALIASES: [from: string, to: string][] = [['/manage/events', '/admin/events']]

/**
 * The link the reader is on: the longest address that is theirs or a parent
 * of theirs. Longest, so /events/mine lights "Coming up" and not "Browse",
 * /events/mine/past lights "Been to" and not "Coming up", and
 * /manage/events/42/guests still lights Hosting's "Upcoming".
 */
function activeLink(pathname: string, groups: SideGroup[], admin: boolean): string | null {
  const under = (path: string, to: string) => path === to || path.startsWith(`${to}/`)
  const alias = [...(admin ? ADMIN_ALIASES : []), ...ALIASES].find(([from]) => under(pathname, from))
  const path = alias ? alias[1] : pathname
  let best: string | null = null
  for (const { links } of groups) {
    for (const { to } of links) {
      if (under(path, to) && (!best || to.length > best.length)) best = to
    }
  }
  return best
}

/*
 * The link a page names as its own, overriding the address match while that
 * page is mounted. A module store rather than a context: the pages that call
 * it render AppShell themselves (EventShell, DashboardShell), so they sit
 * above any provider AppShell could offer.
 */
let pinned: string | null = null
const listeners = new Set<() => void>()
function pin(path: string | null) {
  pinned = path
  listeners.forEach((l) => l())
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Tell the sidebar which link is current; null leaves it to the address. */
export function useSidebarCurrent(path: string | null) {
  useEffect(() => {
    if (path === null) return
    pin(path)
    return () => {
      if (pinned === path) pin(null)
    }
  }, [path])
}

function Links({
  groups,
  active,
  onNavigate,
}: {
  groups: SideGroup[]
  active: string | null
  onNavigate?: () => void
}) {
  return (
    <>
      {groups.map((group, i) => (
        <div key={group.label ?? i} className="px-3 py-3">
          {group.label && (
            <p className="truncate px-3 pb-2 text-[0.625rem] tracking-[0.16em] text-dim uppercase">
              {group.label}
            </p>
          )}
          {group.links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              onClick={onNavigate}
              aria-current={link.to === active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-sm px-3 py-2 text-xs tracking-[0.1em] uppercase transition-colors ${
                link.to === active ? 'bg-gold-wash text-gold' : 'text-dim hover:text-fg'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{link.label}</span>
              {link.count != null && (
                <span className="shrink-0 text-[0.6875rem] tabular-nums">{link.count}</span>
              )}
            </Link>
          ))}
        </div>
      ))}
    </>
  )
}

export function AppShell({
  children,
  title = 'Menu',
  context,
}: {
  children: ReactNode
  /** What the drawer is called on a phone. */
  title?: string
  /** The sections of the thing on screen (an event's pages), drawn first. */
  context?: SideGroup
}) {
  const { profile } = useAuth()
  const { pathname } = useLocation()
  const { open, setOpen, close, panelRef } = useDrawer()

  // An administrator's Dashboard is /admin, which is the first section anyway.
  const admin = profile?.role === 'admin'
  const counts = useAdminCounts(admin)
  const groups: SideGroup[] = [
    ...(context ? [context] : []),
    ...(admin ? adminGroups(counts) : []),
    ...roleGroups(profile, admin),
  ]
  // One address, one link: a page offered twice in the sidebar is the
  // duplication the owner ruled out. Checked in development only.
  if (import.meta.env.DEV) {
    const tos = groups.flatMap((g) => g.links.map((l) => l.to))
    const twice = tos.filter((to, i) => tos.indexOf(to) !== i)
    if (twice.length) console.error('AppShell: sidebar links repeated:', twice)
  }
  // The page's own section wins, so exactly one link is lit: the most specific.
  const override = useSyncExternalStore(subscribe, () => pinned)
  const active =
    override ??
    (context && activeLink(pathname, [context], false)) ??
    activeLink(pathname, groups, admin)
  // The group too, so Hosting's "Cancelled" and Been to's are told apart.
  const currentGroup = groups.find((g) => g.links.some((l) => l.to === active))
  const current = currentGroup?.links.find((l) => l.to === active)

  return (
    <div className="ambient min-h-screen bg-ink">
      <a className="brand-skip-link" href="#app-content">
        Skip to content
      </a>
      <SiteHeader nav={false} />

      <div className="relative z-10 mx-auto flex max-w-[92rem]">
        {/* lg, as before: an iPad in portrait is 820px and gets the drawer. */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto border-r border-line py-4 lg:block">
          <nav aria-label="Main">
            <Links groups={groups} active={active} />
          </nav>
        </aside>

        <div id="app-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          {/* Below lg the sidebar is a drawer, and this row says where you
              are and opens it. */}
          <div className="flex items-center gap-4 border-b border-line px-5 py-4 sm:px-8 lg:hidden">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-expanded={open}
              aria-controls="app-menu"
              className="flex items-center gap-2 text-xs tracking-[0.12em] text-dim uppercase transition-colors hover:text-fg"
            >
              <span aria-hidden className="relative block h-3 w-4">
                <span className="absolute top-0 left-0 block h-px w-4 bg-current" />
                <span className="absolute top-1.5 left-0 block h-px w-4 bg-current" />
                <span className="absolute top-3 left-0 block h-px w-4 bg-current" />
              </span>
              Menu
            </button>
            {current && (
              <span className="truncate text-xs tracking-[0.12em] text-dim uppercase">
                &middot; {currentGroup?.label ? `${currentGroup.label} · ` : ''}
                {current.label}
              </span>
            )}
          </div>

          {children}
        </div>
      </div>

      {/* Slides in from the left, where the sidebar lives. `inert` as well as
          aria-hidden, so a closed drawer's links are not in the tab order. */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${open ? '' : 'pointer-events-none'}`}
        aria-hidden={!open}
        inert={!open}
      >
        <div
          onClick={close}
          className={`absolute inset-0 bg-fg/45 backdrop-blur-[1px] transition-opacity duration-200 ${
            open ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          id="app-menu"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-ink transition-transform duration-200 ease-out ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <p className="display text-lg">{title}</p>
            <button
              type="button"
              onClick={close}
              aria-label="Close menu"
              className="-mt-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center text-dim transition-colors hover:text-fg"
            >
              &#10005;
            </button>
          </div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto py-2">
            <Links groups={groups} active={active} onNavigate={close} />
          </nav>
        </div>
      </div>
    </div>
  )
}
