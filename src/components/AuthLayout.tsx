import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Wordmark } from './ui'

export function AuthLayout({
  eyebrow,
  title,
  caption,
  children,
  footer,
}: {
  eyebrow: string
  title: string
  caption?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="ambient flex min-h-screen flex-col bg-ink">
      <header className="relative z-20">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link to="/">
            <Wordmark />
          </Link>
          <Link to="/" className="text-sm text-muted transition-colors hover:text-fg">
            Home
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-lg rounded-3xl border border-line bg-surface/75 px-6 py-8 shadow-[0_24px_80px_rgba(66,47,32,0.08)] backdrop-blur-sm sm:px-10 sm:py-10">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="display mt-4 text-4xl sm:text-[2.75rem]">{title}</h1>
          {caption && (
            <div className="mt-4 text-sm leading-relaxed text-muted">{caption}</div>
          )}

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-8 text-sm text-dim">{footer}</div>}
        </div>
      </main>
    </div>
  )
}
