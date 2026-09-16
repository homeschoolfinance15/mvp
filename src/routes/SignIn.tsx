import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice } from '../components/ui'
import { errorMessage } from '../lib/supabase'
import { homePathFor, useAuth } from '../context/AuthProvider'

/**
 * BUY-12, FDB-03. Where to go once the password is accepted.
 *
 * `NeedsSignIn` (events/shared.tsx) sends people here as
 * `/signin?next=/events/tickets/…`, and until this read it the parameter was
 * written by four screens and read by none: somebody following the ticket link
 * in their confirmation email on a signed-out phone was told "nothing has been
 * lost — it is waiting for you", signed in, and landed on a dashboard with no
 * idea where the ticket went.
 *
 * Only same-origin paths are honoured. `next` arrives from the address bar, so
 * it is attacker-controlled: without the check, `/signin?next=https://…` would
 * turn our own sign-in screen into an open redirect that sends a freshly
 * authenticated person somewhere else entirely. A leading `//` or `/\` is how
 * that is smuggled past a naive `startsWith('/')`, because browsers read both
 * as protocol-relative.
 */
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/')) return null
  if (next.startsWith('//') || next.startsWith('/\\')) return null
  return next
}

export default function SignIn() {
  const { session, profile, loading, signIn } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!loading && session && profile) {
    return <Navigate to={safeNext(params.get('next')) ?? homePathFor(profile)} replace />
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(email, password)
      // The redirect above fires once AuthProvider settles the profile.
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Member access"
      title="Welcome back"
      footer={
        <>
          Have an invitation code?{' '}
          <Link to="/join" className="text-fg underline-offset-4 hover:underline">
            Redeem it
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Email address">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="jane@company.com"
          />
        </Field>

        <Field label="Password">
          <Input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>

        <div className="-mt-2 text-right">
          <Link
            to="/forgot-password"
            className="text-xs text-dim underline-offset-4 transition-colors hover:text-fg hover:underline"
          >
            Forgotten your password?
          </Link>
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        <Button type="submit" variant="primary" loading={busy || (!!session && loading)} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
