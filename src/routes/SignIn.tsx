import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice } from '../components/ui'
import { errorMessage } from '../lib/supabase'
import { homePathFor, useAuth } from '../context/AuthProvider'

export default function SignIn() {
  const { session, profile, loading, signIn } = useAuth()
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
      await signIn(email, password)
      // The redirect above fires once AuthProvider settles the profile.
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Welcome back"
      title="Sign in"
      caption="Enter the details you used when you joined."
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

        {error && <Notice tone="error">{error}</Notice>}

        <Button type="submit" variant="primary" loading={busy || (!!session && loading)} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
