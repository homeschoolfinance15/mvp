import { useState, type FormEvent } from 'react'
import { functionError, supabase } from '../lib/supabase'
import { Button, Input, Notice } from './ui'

/**
 * Mail an invitation code instead of copying it out and pasting it into a
 * message by hand.
 *
 * The link in that email opens /join with the code already in it, so the
 * person invited types nothing. Who may send which code is decided by the
 * edge function, not here: this form is only as trustworthy as the browser
 * it runs in.
 */
export function SendInvite({
  code,
  defaultEmail = '',
  onSent,
}: {
  code: string
  /** Prefilled where we already know it, as with a connector's claim code. */
  defaultEmail?: string
  /** Reload the list: the send is recorded against the code. */
  onSent?: () => void | Promise<void>
}) {
  const [email, setEmail] = useState(defaultEmail)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState('')
  const [error, setError] = useState('')

  async function send(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSentTo('')
    setBusy(true)

    const to = email.trim()
    const { error: sendError } = await supabase.functions.invoke('invite-email', {
      body: { code, email: to },
    })

    setBusy(false)
    if (sendError) {
      setError(await functionError(sendError))
      return
    }
    setSentTo(to)
    setEmail('')
    await onSent?.()
  }

  return (
    <form onSubmit={send} className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setSentTo('')
            }}
            placeholder="jane@company.com"
            autoComplete="off"
            className="h-9 text-xs"
            aria-label={`Email the invitation code ${code}`}
          />
        </div>
        <Button type="submit" size="sm" loading={busy}>
          Email it
        </Button>
      </div>

      <div aria-live="polite">
        {sentTo && (
          <p className="mt-2 text-xs text-dim">
            Sent to <span className="text-fg">{sentTo}</span>.
          </p>
        )}
        {error && (
          <div className="mt-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </div>
    </form>
  )
}
