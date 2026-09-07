import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'
import { errorMessage, supabase } from '../lib/supabase'
import { Button, ConfirmModal, Notice, Panel, SectionHeader } from './ui'

/**
 * Take it with you, or leave.
 *
 * Both were missing. An administrator could remove somebody; nobody could
 * remove themselves, and nobody could see what was held about them. For a
 * platform whose whole substance is what people say about each other, those
 * are not optional extras.
 *
 * The export deliberately excludes the reports other people have filed about
 * you — handing those over would name the reporter and undo the one rule the
 * trust layer depends on.
 */
export function YourData() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)

  async function exportData() {
    setBusy(true)
    setError('')
    const { data, error: rpcError } = await supabase.rpc('export_my_data')
    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `amazing-${profile?.full_name.toLowerCase().replace(/\s+/g, '-') ?? 'export'}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function deleteAccount() {
    setConfirming(false)
    setBusy(true)
    setError('')
    const { error: rpcError } = await supabase.rpc('delete_my_account')
    if (rpcError) {
      setBusy(false)
      setError(errorMessage(rpcError))
      return
    }
    await signOut()
    navigate('/')
  }

  return (
    <section className="mt-12">
      <SectionHeader
        title="Your data"
        caption="What the network holds about you, and how to leave."
      />

      <Panel className="divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div className="min-w-0">
            <div className="text-sm text-fg">Download everything</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-dim">
              Your profile, posts, comments, messages, RSVPs and your own
              activity, as one file. What others have raised about you isn't
              included, because it would name who raised it.
            </p>
          </div>
          <Button size="sm" disabled={busy} onClick={exportData}>
            Export
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div className="min-w-0">
            <div className="text-sm text-fg">Close your account</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-dim">
              Removes your profile and everything attached to it. The record
              that an account was closed is kept, without your name on it.
            </p>
          </div>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            Close account
          </Button>
        </div>
      </Panel>

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <ConfirmModal
        open={confirming}
        title="Close your account?"
        body="Your profile, posts, comments, likes, messages and RSVPs are deleted. Your connector keeps no notes on you. This cannot be undone, and an invitation cannot be reissued to you automatically."
        confirmLabel="Close my account"
        busy={busy}
        onConfirm={deleteAccount}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}
