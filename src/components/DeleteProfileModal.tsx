import { useState } from 'react'
import { errorMessage, supabase } from '../lib/supabase'
import { DeleteScopeChoice, removeMediaFor, scopeConfirmed, type DeleteScope } from './DeleteScopeChoice'
import { Button, Modal, Notice } from './ui'

export function DeleteProfileModal({
  open,
  profileId,
  name,
  impact,
  onClose,
  onDeleted,
}: {
  open: boolean
  profileId: string | null
  name: string
  impact: string
  onClose: () => void
  onDeleted: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<DeleteScope>('account')
  const [typed, setTyped] = useState('')

  function close() {
    if (busy) return
    setError('')
    setScope('account')
    setTyped('')
    onClose()
  }

  async function confirm() {
    if (!profileId || !scopeConfirmed(scope, typed)) return

    setBusy(true)
    setError('')
    await removeMediaFor(profileId, scope)
    const { error: deleteError } = await supabase.rpc('delete_managed_profile', {
      p_profile_id: profileId,
      p_scope: scope,
    })

    if (deleteError) {
      setBusy(false)
      setError(errorMessage(deleteError))
      return
    }

    await onDeleted()
    setBusy(false)
    setScope('account')
    setTyped('')
    onClose()
  }

  return (
    <Modal open={open} title={`Delete ${name}?`} onClose={close}>
      <p className="text-sm leading-relaxed text-muted">{impact}</p>
      <div className="mt-5">
        <DeleteScopeChoice
          value={scope}
          onChange={(next, text) => {
            setScope(next)
            setTyped(text)
          }}
          subjectName={name}
          self={false}
        />
      </div>
      <p className="mt-4 text-sm font-medium text-negative">This cannot be undone.</p>

      {error && (
        <div className="mt-5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <Button type="button" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={busy}
          disabled={!scopeConfirmed(scope, typed)}
          onClick={confirm}
        >
          Delete profile
        </Button>
      </div>
    </Modal>
  )
}
