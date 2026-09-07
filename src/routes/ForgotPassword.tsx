import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice } from '../components/ui'
import { supabase } from '../lib/supabase'

/**
 * Asks Supabase to send a recovery link.
 *
 * The result is deliberately the same whether or not the address belongs to
 * anybody. On an invitation-only network, an error saying "no such account"
 * would turn this form into a way to test whether a given person is a member,
 * which is exactly what the network is built not to reveal.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })

    setBusy(false)
    // Rate limiting is worth surfacing; "unknown address" is not.
    if (resetError && resetError.status === 429) {
      setError('Too many attempts. Wait a minute and try again.')
      return
    }
    if (resetError) {
      console.error('[amazing] password reset:', resetError)
    }
    setSent(true)
  }

  if (sent) {
    return (
      <AuthLayout
        eyebrow="Member access"
        title="Check your email"
        footer={
          <Link to="/signin" className="text-fg underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          If {email.trim()} belongs to an account, a link to set a new password is on its
          way. It expires in an hour.
        </p>
        <p className="mt-4 text-xs leading-relaxed text-dim">
          Nothing arrived? Check the spam folder, then try again. We do not say whether an
          address is on the network.
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      eyebrow="Member access"
      title="Forgotten password"
      caption="We will email you a link to set a new one."
      footer={
        <Link to="/signin" className="text-fg underline-offset-4 hover:underline">
          Back to sign in
        </Link>
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

        {error && <Notice tone="error">{error}</Notice>}

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Send the link
        </Button>
      </form>
    </AuthLayout>
  )
}
