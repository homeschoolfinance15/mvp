import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'
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

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  return (
    <div className="ambient min-h-screen bg-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Wordmark size="sm" />
          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <div className="text-xs font-medium text-fg">{profile?.full_name}</div>
              <div className="text-[0.6875rem] tracking-wide text-dim">
                {ROLE_LABEL[profile?.role ?? ''] ?? ''}
              </div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-xs text-dim transition-colors hover:text-fg"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <div className="border-b border-line py-10 sm:py-12">
          <h1 className="display text-3xl sm:text-4xl">{title}</h1>
          {caption && <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{caption}</p>}
        </div>

        {tabs && tabs.length > 0 && (
          <nav className="-mb-px flex gap-7 overflow-x-auto border-b border-line">
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
