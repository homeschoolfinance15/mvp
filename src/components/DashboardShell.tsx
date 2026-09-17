import { type ReactNode } from 'react'
import { SiteHeader } from './SiteHeader'

export interface Tab {
  id: string
  label: string
  count?: number
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
  return (
    <div className="ambient min-h-screen bg-ink">
      <SiteHeader />

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
