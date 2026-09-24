import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isNetworkMember, useAuth } from '../context/AuthProvider'
import { errorMessage, supabase } from '../lib/supabase'
import { DeleteScopeChoice, removeMediaFor, scopeConfirmed, type DeleteScope } from './DeleteScopeChoice'
import { Button, Modal, Notice, Panel, SectionHeader } from './ui'

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
  const [scope, setScope] = useState<DeleteScope>('account')
  const [typed, setTyped] = useState('')

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

  function openConfirm() {
    setScope('account')
    setTyped('')
    setConfirming(true)
  }

  async function deleteAccount() {
    if (!profile || !scopeConfirmed(scope, typed)) return
    setBusy(true)
    setError('')
    // Files first: once the account is gone the bucket no longer lets anybody
    // but an administrator remove them.
    await removeMediaFor(profile.id, scope)
    const { error: rpcError } = await supabase.rpc('delete_my_account', { p_scope: scope })
    // ACC-12. Closed already, from another device: this session is all that is left.
    if (rpcError && rpcError.message !== 'This account no longer exists.') {
      setBusy(false)
      setConfirming(false)
      setError(errorMessage(rpcError))
      return
    }
    // ACC-11. Leave the guarded page first; signing out under it lets
    // RequireSession replace the address with a bare /signin.
    navigate('/signin', { replace: true, state: { notice: 'Your account is closed.' } })
    await signOut()
  }

  return (
    <section className="mt-12">
      <SectionHeader title="Your data" />

      <Panel className="divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div className="min-w-0">
            <div className="text-sm text-fg">Download everything</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-dim">
              Download a copy of your data. Reports others filed about you are not included.
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
              Delete just the account, or the account and everything you
              added. Payment records are kept without your name, as the law
              requires.
            </p>
          </div>
          <Button variant="danger" size="sm" disabled={busy} onClick={openConfirm}>
            Close account
          </Button>
        </div>
      </Panel>

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <Modal
        open={confirming}
        title="Close your account?"
        onClose={() => {
          if (!busy) setConfirming(false)
        }}
      >
        <DeleteScopeChoice
          value={scope}
          onChange={(next, text) => {
            setScope(next)
            setTyped(text)
          }}
          subjectName={profile?.full_name ?? ''}
          self
        />
        <p className="mt-4 text-sm font-medium text-negative">
          This cannot be undone{isNetworkMember(profile) ? ', and an invitation cannot be reissued to you automatically' : ''}.
        </p>

        <div className="mt-7 flex gap-3">
          <Button className="flex-1" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            loading={busy}
            disabled={!scopeConfirmed(scope, typed)}
            onClick={() => void deleteAccount()}
          >
            Close my account
          </Button>
        </div>
      </Modal>
    </section>
  )
}
