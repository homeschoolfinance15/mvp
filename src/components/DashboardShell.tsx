import { type ReactNode } from 'react'
import { AppShell, type SideGroup } from './AppShell'

export function DashboardShell({
  title,
  caption,
  sideContext,
  children,
}: {
  title: string
  caption?: string
  /** Sections of the thing on screen, first in the sidebar. */
  sideContext?: SideGroup
  children: ReactNode
}) {
  return (
    // Navigation lives in AppShell's sidebar; this is only the page itself.
    <AppShell context={sideContext}>
      <main className="mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <div className="border-b border-line py-10 sm:py-12">
          <h1 className="display text-3xl sm:text-4xl">{title}</h1>
          {caption && <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{caption}</p>}
        </div>

        <div className="pt-8">{children}</div>
      </main>
    </AppShell>
  )
}
