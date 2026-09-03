import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice } from '../components/ui'
import { errorMessage } from '../lib/supabase'
import { homePathFor, useAuth } from '../context/AuthProvider'

/**
 * Administrators have no invitation code, so they cannot come through /join.
 * This unlisted route creates the account; the `handle_new_user` trigger grants
 * the admin role only if the email is on `admin_allowlist`. Anyone else who
 * finds this page ends up with an unprovisioned account and no access.
 */
export default function AdminSetup() {
  const { session, profile, loading, createAdminAccount } = useAuth()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!loading && session && profile) {
    return <Navigate to={homePathFor(profile)} replace />
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await createAdminAccount({ fullName, email, password })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Administration"
      title="Create your admin account"
      caption="Access is limited to approved administrator email addresses."
      footer={
        <>
          Not an administrator?{' '}
          <Link to="/signin" className="text-fg underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Full name">
          <Input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
          />
        </Field>

        <Field label="Email address">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </Field>

        <Field label="Password" hint="At least 8 characters.">
          <Input
            required
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>

        {error && <Notice tone="error">{error}</Notice>}

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Create administrator account
        </Button>
      </form>
    </AuthLayout>
  )
}
