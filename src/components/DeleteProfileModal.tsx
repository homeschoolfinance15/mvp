import { useState } from 'react'
import { errorMessage, supabase } from '../lib/supabase'
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

  function close() {
    if (busy) return
    setError('')
    onClose()
  }

  async function confirm() {
    if (!profileId) return

    setBusy(true)
    setError('')
    const { error: deleteError } = await supabase.rpc('delete_managed_profile', {
      p_profile_id: profileId,
    })

    if (deleteError) {
      setBusy(false)
      setError(errorMessage(deleteError))
      return
    }

    await onDeleted()
    setBusy(false)
    onClose()
  }

  return (
    <Modal open={open} title={`Delete ${name}?`} onClose={close}>
      <p className="text-sm leading-relaxed text-muted">{impact}</p>
      <p className="mt-3 text-sm font-medium text-negative">This cannot be undone.</p>

      {error && (
        <div className="mt-5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <Button type="button" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant="danger" loading={busy} onClick={confirm}>
          Delete profile
        </Button>
      </div>
    </Modal>
  )
}
