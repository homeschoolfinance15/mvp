import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Field, Input, Notice, Wordmark } from '../components/ui'

const PILLARS = [
  {
    index: '01',
    title: 'Trusted context',
    body: 'More than a title. A clearer picture of who someone is and what they bring.',
  },
  {
    index: '02',
    title: 'Meaningful discovery',
    body: 'Find people through shared experience, curiosity, ambition, and possibility.',
  },
  {
    index: '03',
    title: 'Thoughtful growth',
    body: 'AMAZING grows through quality connections, not noise.',
  },
]

function WaitlistForm() {
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
      // 23505 is the unique index on lower(email) — already on the list.
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
      <div className="rounded-md border border-line bg-surface px-8 py-12 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full border border-gold/40 bg-gold-wash text-gold">
          &#10003;
        </div>
        <h3 className="mt-6 text-lg font-medium tracking-tight text-fg">You're on the list</h3>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted">
          Thank you, {fullName.split(' ')[0] || 'friend'}. We'll be in touch as the network
          opens. If someone remarkable comes to mind in the meantime, send them here.
        </p>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-md border border-line bg-surface px-6 py-8 sm:px-8 sm:py-10"
    >
      <h3 className="text-lg font-medium tracking-tight text-fg">Join the AMAZING waitlist</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Tell us where to find you. We'll be in touch as the network opens.
      </p>

      <div className="mt-7 space-y-5">
        <Field label="Full name">
          <Input
            required
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

        <Field
          label="LinkedIn profile"
          hint="Optional, but it helps us learn a little more about you."
        >
          <Input
            type="url"
            value={linkedin}
            onChange={(e) => setLinkedin(e.target.value)}
            placeholder="https://linkedin.com/in/..."
          />
        </Field>
      </div>

      {error && (
        <div className="mt-5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <Button type="submit" variant="primary" loading={busy} className="mt-7 w-full">
        Join the waitlist
      </Button>

      <p className="mt-4 text-center text-xs leading-relaxed text-dim">
        By joining, you agree to receive updates from AMAZING. We'll never sell your information.
      </p>
    </form>
  )
}

export default function Landing() {
  const [shared, setShared] = useState(false)

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.origin)
      setShared(true)
      setTimeout(() => setShared(false), 2000)
    } catch {
      setShared(false)
    }
  }

  return (
    <div className="ambient min-h-screen bg-ink">
      <header className="relative z-20 border-b border-line">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Wordmark />
          <nav className="flex items-center gap-6 text-xs">
            <Link to="/join" className="text-muted transition-colors hover:text-fg">
              Have a code?
            </Link>
            <Link to="/signin" className="text-muted transition-colors hover:text-fg">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative z-10">
        {/* Hero ------------------------------------------------------------ */}
        <section className="mx-auto max-w-6xl px-5 pt-24 pb-20 sm:px-8 sm:pt-36 sm:pb-28">
          <p className="eyebrow rise">By invitation</p>

          <h1 className="rise mt-7 max-w-4xl text-[2.5rem] leading-[0.98] font-medium tracking-[-0.02em] uppercase sm:text-6xl lg:text-7xl">
            The right people,
            <br />
            <span className="text-muted">made easier</span>
            <br />
            to find.
          </h1>

          <p className="rise mt-10 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            AMAZING is building a more thoughtful way for exceptional people to discover one
            another&mdash;through trusted context, shared interests, and meaningful introductions.
          </p>

          <p className="rise mt-5 max-w-xl text-sm leading-relaxed text-dim">
            We're opening access gradually. Join the waitlist to be among the first.
          </p>

          <div className="rise mt-10 flex flex-wrap items-center gap-3">
            <a href="#waitlist">
              <Button variant="primary">Join the waitlist</Button>
            </a>
            <Button variant="ghost" onClick={share}>
              {shared ? 'Link copied' : 'Share with someone remarkable'}
            </Button>
          </div>
        </section>

        {/* Waitlist -------------------------------------------------------- */}
        <section id="waitlist" className="scroll-mt-8 border-t border-line">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="mx-auto max-w-md">
              <WaitlistForm />
            </div>
          </div>
        </section>

        {/* Pillars --------------------------------------------------------- */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <h2 className="max-w-lg text-3xl leading-tight font-medium tracking-[-0.02em] uppercase sm:text-4xl">
              Built around people,
              <br />
              <span className="text-muted">not profiles.</span>
            </h2>

            <div className="mt-16 grid gap-px border border-line bg-line sm:grid-cols-3">
              {PILLARS.map((pillar) => (
                <div key={pillar.index} className="bg-ink px-6 py-10 sm:px-7">
                  <span className="text-xs tracking-[0.16em] text-gold tabular-nums">
                    {pillar.index}
                  </span>
                  <h3 className="mt-5 text-base font-medium tracking-tight text-fg">
                    {pillar.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted">{pillar.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Closing --------------------------------------------------------- */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
            <div className="max-w-2xl">
              <h2 className="text-3xl leading-tight font-medium tracking-[-0.02em] uppercase sm:text-5xl">
                A network worth
                <br />
                being part of.
              </h2>
              <p className="mt-8 text-base leading-relaxed text-muted">
                We believe the most valuable opportunities often begin with the right
                introduction. AMAZING is creating the space for more of those introductions to
                happen.
              </p>
              <a href="#waitlist" className="mt-10 inline-block">
                <Button variant="primary">Join the waitlist</Button>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Wordmark size="sm" />
          <div className="flex items-center gap-6 text-xs text-dim">
            <Link to="/join" className="transition-colors hover:text-muted">
              Redeem a code
            </Link>
            <Link to="/signin" className="transition-colors hover:text-muted">
              Sign in
            </Link>
            <span>&copy; {new Date().getFullYear()} AMAZING</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
