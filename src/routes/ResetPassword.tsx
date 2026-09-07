import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice } from '../components/ui'
import { PASSWORD_RULE, passwordProblem } from '../lib/password'
import { errorMessage, supabase } from '../lib/supabase'

/**
 * Where a recovery link lands.
 *
 * The client is created with detectSessionInUrl: false, so nothing picks the
 * tokens out of the URL on its own. That default is worth keeping for every
 * other page, so this one consumes the fragment itself and then clears it
 * from the address bar, because a recovery token sitting in browser history
 * is a password waiting to be reused.
 */
export default function ResetPassword() {
  const navigate = useNavigate()

  const [ready, setReady] = useState(false)
  const [linkError, setLinkError] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    async function consumeLink() {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
      const accessToken = hash.get('access_token')
      const refreshToken = hash.get('refresh_token')

      if (hash.get('error_description')) {
        setLinkError(hash.get('error_description') ?? 'That link is no longer valid.')
        return
      }

      if (accessToken && refreshToken) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        // Out of the address bar and out of history.
        window.history.replaceState(null, '', window.location.pathname)
        if (sessionError) {
          setLinkError('That link has expired. Ask for a new one.')
          return
        }
        setReady(true)
        return
      }

      // Somebody already signed in can set a new password here too.
      const { data } = await supabase.auth.getSession()
      if (data.session) setReady(true)
      else setLinkError('This page needs a recovery link. Ask for a new one.')
    }

    void consumeLink()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')

    const problem = passwordProblem(password)
    if (problem) return setError(problem)
    if (password !== confirm) return setError('The two passwords do not match.')

    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)

    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    setDone(true)
  }

  if (linkError) {
    return (
      <AuthLayout
        eyebrow="Member access"
        title="That link did not work"
        footer={
          <Link to="/forgot-password" className="text-fg underline-offset-4 hover:underline">
            Ask for a new link
          </Link>
        }
      >
        <Notice tone="error">{linkError}</Notice>
      </AuthLayout>
    )
  }

  if (done) {
    return (
      <AuthLayout eyebrow="Member access" title="Password changed">
        <p className="text-sm leading-relaxed text-muted">
          You are signed in with your new password.
        </p>
        <Button
          variant="primary"
          className="mt-7 w-full"
          onClick={() => navigate('/', { replace: true })}
        >
          Continue
        </Button>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      eyebrow="Member access"
      title="Set a new password"
      caption={PASSWORD_RULE}
    >
      {!ready ? (
        <p className="text-sm text-dim">Checking your link...</p>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <Field label="New password">
            <Input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <Field label="Repeat it">
            <Input
              required
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          {error && <Notice tone="error">{error}</Notice>}

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Save it
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
