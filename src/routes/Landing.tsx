import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Field, Input, Notice, Wordmark } from '../components/ui'

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
      <div className="flex min-h-[31rem] flex-col items-center justify-center rounded-3xl border border-[#ead5ad] bg-surface px-8 py-12 text-center shadow-[0_24px_80px_rgba(66,47,32,0.09)]">
        <div className="flex size-12 items-center justify-center rounded-full bg-gold text-xl text-fg">
          &#10003;
        </div>
        <p className="eyebrow mt-7">Request received</p>
        <h2 className="display mt-3 text-3xl">You’re on the list.</h2>
        <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
          Thanks, {fullName.split(' ')[0] || 'friend'}. We’ll contact you when a place opens.
        </p>
      </div>
    )
  }

  return (
    <form
      id="waitlist"
      onSubmit={submit}
      className="rounded-3xl border border-[#ead5ad] bg-surface px-6 py-8 shadow-[0_24px_80px_rgba(66,47,32,0.09)] sm:px-8 sm:py-9"
    >
      <p className="eyebrow text-gold-dim">Request access</p>
      <h2 className="display mt-3 text-3xl">Join the waitlist.</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Leave your details and we’ll be in touch.
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
        Request an invitation
      </Button>

      <p className="mt-4 text-center text-xs text-dim">
        We’ll only use this to contact you about access.
      </p>
    </form>
  )
}

export default function Landing() {
  return (
    <div className="ambient flex min-h-screen flex-col overflow-hidden bg-ink">
      <header className="relative z-20">
        <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-5 sm:px-8">
          <Wordmark />
          <Link
            to="/signin"
            className="rounded-full px-4 py-2 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center">
        <section className="mx-auto grid w-full max-w-7xl items-center gap-14 px-5 py-12 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)] lg:gap-20">
          <div className="max-w-3xl">
            <p className="eyebrow rise text-gold-dim">By invitation</p>
            <p className="display rise mt-5 text-5xl sm:text-7xl lg:text-[5.75rem]">AMAZING</p>
            <h1 className="display rise mt-7 max-w-2xl text-4xl sm:text-6xl">
              The room you’re meant to be in.
            </h1>
            <p className="rise mt-7 max-w-xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
              Bringing the right people together, in the right place, at the right time —
              creating moments worth showing up for.
            </p>

            <div className="rise mt-9 flex flex-wrap items-center gap-3">
              <Link to="/join">
                <Button variant="primary">Use invitation code</Button>
              </Link>
              <a
                href="#waitlist"
                className="inline-flex h-11 items-center rounded-full px-5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
              >
                Join the waitlist
              </a>
            </div>

            <div className="rise mt-14 flex items-end gap-3" aria-hidden>
              <div className="h-20 w-28 rounded-[1.5rem] bg-surface sm:h-24 sm:w-36" />
              <div className="h-14 w-20 rounded-[1.25rem] bg-fg sm:h-16 sm:w-24" />
              <div className="mb-1 h-3 w-14 rounded-full bg-gold" />
            </div>
          </div>

          <WaitlistForm />
        </section>
      </main>

      <footer className="relative z-10">
        <div className="mx-auto flex w-full max-w-7xl justify-end px-5 py-8 text-xs text-dim sm:px-8">
          <span>&copy; {new Date().getFullYear()} AMAZING</span>
        </div>
      </footer>
    </div>
  )
}
