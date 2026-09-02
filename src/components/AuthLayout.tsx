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
      <header className="relative z-20 border-b border-line">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link to="/">
            <Wordmark />
          </Link>
          <Link to="/" className="text-xs text-muted transition-colors hover:text-fg">
            Back to home
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-14">
        <div className="w-full max-w-md">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="display mt-4 text-3xl">{title}</h1>
          {caption && (
            <div className="mt-4 text-sm leading-relaxed text-muted">{caption}</div>
          )}

          <div className="mt-9">{children}</div>

          {footer && <div className="mt-8 text-sm text-dim">{footer}</div>}
        </div>
      </main>
    </div>
  )
}
