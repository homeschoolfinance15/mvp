import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Wordmark } from './ui'
import { useAuth } from '../context/AuthProvider'

export function AuthLayout({
  eyebrow,
  title,
  caption,
  children,
  footer,
  back,
  signOut = false,
}: {
  eyebrow?: string
  title: string
  caption?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Signed in only: where Back goes. */
  back?: string
  /** Signed in only: offer a way out of a step somebody cannot finish now. */
  signOut?: boolean
}) {
  // Signed in, "/" only redirects back into the app, so the link would loop.
  const { session, signOut: endSession } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="brand-experience auth-page">
      <header className="auth-header brand-container">
        <Link to="/" aria-label="Amazing home">
          <Wordmark />
        </Link>
        {!session ? (
          <Link to="/" className="brand-text-link">
            <span aria-hidden="true">←</span> Back to home
          </Link>
        ) : (
          <span className="flex items-center gap-5">
            {back && (
              <Link to={back} className="brand-text-link">
                <span aria-hidden="true">←</span> Back
              </Link>
            )}
            {signOut && (
              <button
                type="button"
                className="brand-text-link"
                // Sign out first, then leave, as SiteHeader does: leaving
                // first lands on "/" while the session is live, and Landing
                // sends a signed-in visitor straight back into the app.
                onClick={async () => {
                  await endSession()
                  navigate('/', { replace: true })
                }}
              >
                Sign out
              </button>
            )}
          </span>
        )}
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
          {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
          <h1 className="display text-4xl sm:text-[2.75rem]">{title}</h1>
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
