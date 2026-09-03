import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice } from '../components/ui'
import { errorMessage, supabase } from '../lib/supabase'
import { homePathFor, useAuth } from '../context/AuthProvider'
import type { CodeLookup } from '../lib/types'

/**
 * One entry point for both kinds of code. Step 1 identifies the code and tells
 * the visitor what it grants; step 2 creates the account and redeems it.
 */
export default function Join() {
  const navigate = useNavigate()
  const location = useLocation()
  const { session, profile, loading, joinWithCode } = useAuth()

  const initialState = location.state as { code?: string; lookup?: CodeLookup } | null

  const [code, setCode] = useState(initialState?.code ?? '')
  const [lookup, setLookup] = useState<CodeLookup | null>(
    initialState?.lookup?.valid ? initialState.lookup : null,
  )
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!loading && session && profile) {
    return <Navigate to={homePathFor(profile)} replace />
  }

  const accepted = lookup?.valid ? lookup : null

  async function checkCode(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    const { data, error: rpcError } = await supabase.rpc('lookup_code', {
      p_code: code.trim(),
    })
    setBusy(false)

    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }

    const result = data as CodeLookup
    setLookup(result)

    if (!result.valid) {
      setError(result.reason)
      return
    }
    if (result.kind === 'connector_claim') {
      setFullName(result.full_name)
      setEmail(result.email)
    }
  }

  async function createAccount(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await joinWithCode({ code, fullName, email, password })
      navigate('/onboarding', {
        replace: true,
        state: result.role === 'connector' ? { firstCode: result.invite_code } : undefined,
      })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  /* ---------------------------------------------------------------- step 1 */
  if (!accepted) {
    return (
      <AuthLayout
        eyebrow="By invitation"
        title="Enter your invitation code"
        caption="Use the code you received to continue."
        footer={
          <>
            Already joined?{' '}
            <Link to="/signin" className="text-fg underline-offset-4 hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <form onSubmit={checkCode} className="space-y-5">
          <Field label="Invitation code">
            <Input
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="AMZ-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="text-center text-lg tracking-[0.2em] tabular-nums"
            />
          </Field>

          {error && <Notice tone="error">{error}</Notice>}

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Check code
          </Button>
        </form>
      </AuthLayout>
    )
  }

  /* ---------------------------------------------------------------- step 2 */
  const isConnector = accepted.kind === 'connector_claim'

  return (
    <AuthLayout
      eyebrow={isConnector ? 'Connector access' : 'Your invitation'}
      title={isConnector ? 'Create your connector account' : 'Create your account'}
      caption={
        isConnector ? (
          <>
            You can welcome up to{' '}
            <span className="font-medium text-fg">{accepted.invite_capacity} people</span>. Add
            your details to get started.
          </>
        ) : (
          <>
            <span className="font-medium text-fg">{accepted.connector_name}</span> invited you.
            Add your details to join.
          </>
        )
      }
      footer={
        <button
          type="button"
          onClick={() => {
            setLookup(null)
            setError('')
            navigate('/join', { replace: true, state: null })
          }}
          className="transition-colors hover:text-fg"
        >
          &larr; Use a different code
        </button>
      }
    >
      <form onSubmit={createAccount} className="space-y-5">
        <Field label="Full name">
          <Input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Okonkwo"
            autoComplete="name"
          />
        </Field>

        <Field
          label="Email address"
          hint={isConnector ? 'Pre-filled from your invitation. You can change it.' : undefined}
        >
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@company.com"
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
          {isConnector ? 'Create connector account' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  )
}
