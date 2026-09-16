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
    <div className="brand-experience auth-page">
      <header className="auth-header brand-container">
        <Link to="/" aria-label="Amazing home">
          <Wordmark />
        </Link>
        <Link to="/" className="brand-text-link">
          <span aria-hidden="true">←</span> Back to home
        </Link>
      </header>

      <main className="auth-main brand-container">
        <aside className="auth-story" aria-label="Meet your people">
          <img src="/brand/gathering.jpg" alt="Friends sharing conversation around a dinner table" />
          <div className="auth-story-content">
            <p className="brand-kicker">People, not profiles.</p>
            <h2>Your people.<br />Just a little<br /> closer.</h2>
            <p>A shared interest. A new perspective.<br />A conversation worth showing up for.</p>
          </div>
          <span className="auth-story-foot">One click. Meet your people.</span>
        </aside>
        <div className="auth-card">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="display mt-4 text-4xl sm:text-[2.75rem]">{title}</h1>
          {caption && (
            <div className="mt-4 text-sm leading-relaxed text-muted">{caption}</div>
          )}

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-8 text-sm text-dim">{footer}</div>}
        </div>
      </main>
      <footer className="auth-footer brand-container">People, not profiles.</footer>
    </div>
  )
}
