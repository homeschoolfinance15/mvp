import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthProvider'
import { PASSWORD_RULE, passwordProblem } from '../lib/password'
import { errorMessage, supabase } from '../lib/supabase'
import { Button, Field, Input, Notice, Panel, SectionHeader } from './ui'

/**
 * Changing your password while signed in.
 *
 * The current password is asked for and actually checked, by signing in with
 * it before the change is made. Supabase's updateUser does not require it,
 * which means without this step an unattended open laptop is enough to lock
 * somebody out of their own account. Verifying costs one request and closes
 * that.
 */
export function ChangePassword() {
  const { session } = useAuth()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setDone(false)

    const email = session?.user.email
    if (!email) return setError('You need to be signed in.')

    const problem = passwordProblem(next)
    if (problem) return setError(problem)
    if (next !== confirm) return setError('The two new passwords do not match.')
    if (next === current) return setError('That is the password you already have.')

    setBusy(true)

    // Prove it is really them before anything changes.
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email,
      password: current,
    })
    if (reauthError) {
      setBusy(false)
      setError('That is not your current password.')
      return
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: next })
    setBusy(false)

    if (updateError) {
      setError(errorMessage(updateError))
      return
    }

    setCurrent('')
    setNext('')
    setConfirm('')
    setDone(true)
  }

  return (
    <section className="mt-12">
      <SectionHeader title="Password" caption={PASSWORD_RULE} />

      <Panel className="px-6 py-6">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Current password">
            <Input
              required
              type="password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setDone(false)
              }}
              autoComplete="current-password"
            />
          </Field>

          <Field label="New password">
            <Input
              required
              type="password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value)
                setDone(false)
              }}
              autoComplete="new-password"
            />
          </Field>

          <Field label="Repeat the new password">
            <Input
              required
              type="password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
                setDone(false)
              }}
              autoComplete="new-password"
            />
          </Field>

          {error && <Notice tone="error">{error}</Notice>}
          {done && <Notice tone="success">Your password has been changed.</Notice>}

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!current || !next || !confirm}
            >
              Change password
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  )
}
