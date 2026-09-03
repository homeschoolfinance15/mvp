import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { Button, Field, Input, Modal, Notice, Wordmark } from '../components/ui'
import type { CodeLookup } from '../lib/types'

function WaitlistForm({ onClose }: { onClose: () => void }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    const { error: insertError } = await supabase.from('waitlist_entries').insert({
      full_name: fullName.trim(),
      email: email.trim().toLowerCase(),
      linkedin_url: linkedin.trim() || null,
    })

    setBusy(false)

    if (insertError) {
      setError(
        insertError.code === '23505'
          ? "You're already on the list. We'll be in touch."
          : insertError.message,
      )
      return
    }
    setDone(true)
  }

  if (done) {
    return (
      <div className="py-10 text-center">
        <p className="eyebrow">Request received</p>
        <h2 className="display mt-4 text-4xl">You’re on the list.</h2>
        <p className="mx-auto mt-5 max-w-sm text-sm leading-6 text-muted">
          Thanks, {fullName.split(' ')[0] || 'friend'}. We’ll contact you when a place opens.
        </p>
        <Button type="button" variant="secondary" onClick={onClose} className="mt-8">
          Close
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-8 text-sm leading-6 text-muted">
        Tell us a little about yourself. Every application is reviewed personally.
      </p>

      <div className="space-y-5">
        <Field label="Full name">
          <Input
            required
            autoFocus
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Okonkwo"
            autoComplete="name"
          />
        </Field>

        <Field label="Email address">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@company.com"
            autoComplete="email"
          />
        </Field>

        <Field label="LinkedIn" hint="Optional">
          <Input
            type="url"
            value={linkedin}
            onChange={(e) => setLinkedin(e.target.value)}
            placeholder="linkedin.com/in/..."
            autoComplete="url"
          />
        </Field>
      </div>

      {error && (
        <div className="mt-5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <Button type="submit" variant="primary" loading={busy} className="mt-7 w-full">
        Submit application
      </Button>
      <p className="mt-4 text-center text-xs text-dim">
        Your information is only used to review your application.
      </p>
    </form>
  )
}

function NetworkMark({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-10 items-center justify-center border border-line text-fg">
      {children}
    </span>
  )
}

export default function Landing() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeError, setCodeError] = useState('')
  const [codeFocused, setCodeFocused] = useState(false)
  const [waitlistOpen, setWaitlistOpen] = useState(false)

  async function enterNetwork(e: FormEvent) {
    e.preventDefault()
    setCodeError('')
    setCodeBusy(true)

    const normalizedCode = code.trim().toUpperCase()
    const { data, error } = await supabase.rpc('lookup_code', { p_code: normalizedCode })
    setCodeBusy(false)

    if (error) {
      setCodeError(errorMessage(error))
      return
    }

    const lookup = data as CodeLookup
    if (!lookup.valid) {
      setCodeError(lookup.reason)
      return
    }

    navigate('/join', { state: { code: normalizedCode, lookup } })
  }

  return (
    <div className="flex min-h-screen flex-col bg-ink">
      {codeFocused && (
        <div className="pointer-events-none fixed inset-0 z-20 bg-fg/[0.055] transition-opacity" />
      )}

      <header className="relative z-10 border-b border-line/70">
        <div className="mx-auto flex h-[4.75rem] w-full max-w-7xl items-center justify-between px-5 sm:px-8">
          <Wordmark size="sm" />
          <nav className="flex items-center gap-2 sm:gap-4" aria-label="Primary navigation">
            <Link
              to="/signin"
              className="px-3 py-2 text-sm text-muted transition-colors duration-300 hover:text-fg"
            >
              Sign in
            </Link>
            <Button type="button" variant="primary" size="sm" onClick={() => setWaitlistOpen(true)}>
              Join waitlist
            </Button>
          </nav>
        </div>
      </header>

      <main className="relative flex-1">
        <section className="mx-auto flex min-h-[calc(100svh-4.75rem)] max-w-5xl flex-col items-center justify-center px-5 py-20 text-center sm:px-8 sm:py-28">
          <p className="eyebrow rise">By invitation</p>
          <h1 className="display rise mt-7 max-w-4xl text-[clamp(3rem,8vw,6.75rem)] leading-[0.94]">
            The room you’re meant to be in.
          </h1>
          <p className="rise mt-8 max-w-2xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
            Bringing the right people together, in the right place, at the right time —
            creating moments worth showing up for.
          </p>

          <div className="relative z-30 mt-12 w-full max-w-xl text-left sm:mt-14">
            <form onSubmit={enterNetwork}>
              <label htmlFor="invitation-code" className="sr-only">
                Invitation code
              </label>
              <div className="flex border border-line-strong bg-white p-1.5 transition-colors duration-300 focus-within:border-fg">
                <input
                  id="invitation-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onFocus={() => setCodeFocused(true)}
                  onBlur={() => setCodeFocused(false)}
                  placeholder="Enter your invitation code"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-12 min-w-0 flex-1 bg-transparent px-4 text-sm tracking-[0.08em] text-fg uppercase placeholder:normal-case placeholder:tracking-normal placeholder:text-dim focus:outline-none sm:px-5"
                />
                <button
                  type="submit"
                  disabled={codeBusy}
                  aria-label="Continue with invitation code"
                  className="flex size-12 shrink-0 items-center justify-center rounded-[3px] bg-fg text-lg text-white transition-colors duration-300 hover:bg-[#353532] disabled:cursor-wait disabled:opacity-60"
                >
                  {codeBusy ? <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" /> : '→'}
                </button>
              </div>
              {codeError && <p role="alert" className="mt-3 text-sm text-negative">{codeError}</p>}
            </form>

            <button
              type="button"
              onClick={() => setWaitlistOpen(true)}
              className="mx-auto mt-5 block text-sm text-dim underline decoration-line-strong underline-offset-4 transition-colors duration-300 hover:text-fg"
            >
              Don’t have a code? Apply for the waitlist.
            </button>
          </div>
        </section>

        <section className="border-y border-line" aria-labelledby="network-heading">
          <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-32">
            <div className="max-w-xl">
              <p className="eyebrow">The network</p>
              <h2 id="network-heading" className="display mt-5 text-4xl sm:text-5xl">
                Built on trust, not volume.
              </h2>
            </div>

            <div className="mt-16 grid border-t border-line md:grid-cols-3">
              <article className="border-b border-line py-10 md:border-r md:border-b-0 md:pr-10">
                <NetworkMark>
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden>
                    <path d="M5 12h14M12 5v14" />
                  </svg>
                </NetworkMark>
                <h3 className="mt-8 font-medium text-fg">The Waitlist</h3>
                <p className="mt-3 text-sm leading-6 text-muted">Carefully vetted entry.</p>
              </article>
              <article className="border-b border-line py-10 md:border-r md:border-b-0 md:px-10">
                <NetworkMark>
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden>
                    <circle cx="12" cy="8" r="3" /><path d="M5.5 19c.8-3.3 3-5 6.5-5s5.7 1.7 6.5 5" />
                  </svg>
                </NetworkMark>
                <h3 className="mt-8 font-medium text-fg">The Connectors</h3>
                <p className="mt-3 text-sm leading-6 text-muted">Guided by trusted leaders.</p>
              </article>
              <article className="py-10 md:pl-10">
                <NetworkMark>
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden>
                    <circle cx="8" cy="10" r="3" /><circle cx="16.5" cy="8" r="2.5" /><path d="M2.5 19c.7-3 2.6-4.5 5.5-4.5s4.8 1.5 5.5 4.5M14 13c3.8 0 6.1 1.7 6.8 5" />
                  </svg>
                </NetworkMark>
                <h3 className="mt-8 font-medium text-fg">The Members</h3>
                <p className="mt-3 text-sm leading-6 text-muted">An intentionally small community.</p>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 py-8 text-xs text-dim sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>&copy; {new Date().getFullYear()} AMAZING.</span>
          <div className="flex items-center gap-6">
            <Link to="/signin" className="transition-colors duration-300 hover:text-fg">Sign in</Link>
            <button type="button" onClick={() => setWaitlistOpen(true)} className="transition-colors duration-300 hover:text-fg">Apply</button>
          </div>
        </div>
      </footer>

      <Modal open={waitlistOpen} title="Apply for the waitlist" onClose={() => setWaitlistOpen(false)}>
        <WaitlistForm onClose={() => setWaitlistOpen(false)} />
      </Modal>
    </div>
  )
}
