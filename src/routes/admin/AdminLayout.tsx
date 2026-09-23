import type { ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AppShell } from '../../components/AppShell'
import { FlagsPanel } from '../../components/FlagsPanel'
import { ADMIN_LINKS, type AdminLink } from '../../lib/adminNav'
import Circles from './Circles'
import Connectors from './Connectors'
import Events from './Events'
import Log from './Log'
import Members from './Members'
import Notes from './Notes'
import Payments from './Payments'
import Waitlist from './Waitlist'

export interface AdminSection extends AdminLink {
  element: ReactNode
  /** Unused today, and not drawn: AppShell's sidebar has no icon slot. */
  icon?: ReactNode
}

const ELEMENTS: Record<string, ReactNode> = {
  '/admin/connectors': <Connectors />,
  '/admin/members': <Members />,
  '/admin/waitlist': <Waitlist />,
  '/admin/circles': <Circles />,
  '/admin/notes': <Notes />,
  '/admin/raised': <FlagsPanel />,
  '/admin/events': <Events />,
  '/admin/payments': <Payments />,
  '/admin/log': <Log />,
}

/**
 * Every screen under /admin, in sidebar order: ADMIN_LINKS (src/lib/adminNav)
 * with the page each one renders. App.tsx turns it into routes, and `/admin`
 * redirects to the first entry. A new section is one link there plus its
 * element here.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const ADMIN_SECTIONS: AdminSection[] = ADMIN_LINKS.map((link) => ({
  ...link,
  element: ELEMENTS[link.to],
}))

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
  const location = useLocation()

  const current = ADMIN_SECTIONS.find((s) => location.pathname.startsWith(s.to))

  // AppShell owns the sidebar, its live counts, the phone drawer and the top bar.
  return (
    <AppShell title="Administration">
      <main className="px-5 pb-24 sm:px-8">
        <div className="border-b border-line py-8 sm:py-10">
          <h1 className="display text-3xl sm:text-4xl">{current?.label ?? 'Administration'}</h1>
        </div>

        {/* The four tiles that used to sit here are gone.

            They were right when this was one page with eight tabs: you saw
            the shape of the platform once, on arrival. Repeated above all
            eight sections they became furniture — three of the four numbers
            are already in the sidebar beside the section they count, and
            reading "Connectors 0 / Members 0" above the activity log tells
            you nothing about the activity log. */}
        <div className="pt-10">
          <Outlet />
        </div>
      </main>
    </AppShell>
  )
}
