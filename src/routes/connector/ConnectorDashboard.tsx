import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { DashboardShell } from '../../components/DashboardShell'
import { DeleteProfileModal } from '../../components/DeleteProfileModal'
import {
  Button,
  CopyCode,
  ConfirmModal,
  EmptyState,
  Field,
  formatDate,
  Initials,
  Input,
  Modal,
  Notice,
  Panel,
  SectionHeader,
  Spinner,
  StatusBadge,
  Textarea,
} from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'
import { useLive } from '../../lib/live'
import { SendInvite } from '../../components/SendInvite'
import { useAuth } from '../../context/AuthProvider'
import type { ConnectorNote, InviteCode, Profile } from '../../lib/types'
import type { ConnectorPayments } from './payouts'

/**
 * What the connector's People, Invitations and Raised pages share: one loader
 * and its live updates, so the three pages cannot drift apart.
 */

export interface Person {
  linkId: string
  joinedAt: string
  codeUsed: string | null
  profile: Profile
}

export function useConnectorData() {
  const { profile } = useAuth()
  // `select('*')` already returns the Stripe columns; ConnectorPayments is the
  // type that says so until they land on `Connector` in src/lib/types.ts.
  const [connector, setConnector] = useState<ConnectorPayments | null>(null)
  const [codes, setCodes] = useState<InviteCode[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [notes, setNotes] = useState<ConnectorNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!profile) return
    setError('')

    const { data: connectorRow, error: connectorError } = await supabase
      .from('connectors')
      .select('*')
      .eq('profile_id', profile.id)
      .maybeSingle()

    if (connectorError || !connectorRow) {
      setError(errorMessage(connectorError) || 'No connector record found for this account. Ask an administrator to check your connector account.')
      setLoading(false)
      return
    }
    setConnector(connectorRow as ConnectorPayments)

    const [codesRes, linksRes, notesRes] = await Promise.all([
      supabase
        .from('invite_codes')
        .select('*')
        .eq('connector_id', connectorRow.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('connector_user_links')
        .select('id, created_at, profiles(*), invite_codes(code)')
        .eq('connector_id', connectorRow.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('connector_notes')
        .select('*')
        .eq('connector_id', connectorRow.id)
        .order('created_at', { ascending: false }),
    ])

    setCodes((codesRes.data as InviteCode[]) ?? [])
    setNotes((notesRes.data as ConnectorNote[]) ?? [])

    const rows = (linksRes.data ?? []) as unknown as Array<{
      id: string
      created_at: string
      profiles: Profile | null
      invite_codes: { code: string } | null
    }>

    setPeople(
      rows
        .filter((r) => r.profiles)
        .map((r) => ({
          linkId: r.id,
          joinedAt: r.created_at,
          codeUsed: r.invite_codes?.code ?? null,
          profile: r.profiles as Profile,
        })),
    )
    setLoading(false)
  }, [profile])

  useEffect(() => {
    void load()
  }, [load])

  // A reload never unmounts the note form, so a half-written note survives it.
  useLive(['invite_codes', 'connector_user_links', 'connector_notes'], () => void load(), {
    enabled: Boolean(connector),
    filter: `connector_id=eq.${connector?.id}`,
  })
  // An administrator pausing invitations or changing capacity.
  useLive(['connectors'], () => void load(), {
    enabled: Boolean(profile),
    filter: `profile_id=eq.${profile?.id}`,
  })

  return { connector, codes, people, notes, loading, error, load }
}

/** The page chrome, with the loader's spinner and error handled once. */
export function ConnectorShell({
  title,
  loading,
  error,
  children,
}: {
  title: string
  loading: boolean
  error: string
  children: ReactNode
}) {
  return (
    <DashboardShell title={title}>
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        children
      )}
    </DashboardShell>
  )
}

/* -------------------------------------------------------------------------- */

export function CapacityBar({
  status,
  joined,
  capacity,
  liveCodes,
}: {
  status: string
  joined: number
  capacity: number
  liveCodes: number
}) {
  const joinedPct = capacity ? Math.min(100, (joined / capacity) * 100) : 0
  const remaining = Math.max(0, capacity - joined)

  return (
    <Panel className="px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="eyebrow">Invitation capacity</div>
          <div className="mt-2 text-2xl font-light tracking-tight tabular-nums">
            {joined}
            <span className="text-dim"> of {capacity} joined</span>
          </div>
        </div>
        <StatusBadge status={status as 'active'} />
      </div>

      <div className="mt-5 h-1 w-full overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-gold transition-[width]" style={{ width: `${joinedPct}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-dim">
        <span>
          {remaining} invitation{remaining === 1 ? '' : 's'} remaining
        </span>
        <span>
          {liveCodes} live code{liveCodes === 1 ? '' : 's'}
        </span>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */

export function PersonDetail({
  person,
  connectorId,
  notes,
  onChanged,
}: {
  person: Person
  connectorId: string
  notes: ConnectorNote[]
  onChanged: () => Promise<void>
}) {
  const [text, setText] = useState('')
  // Private unless the connector chooses to share (NET-13); the column
  // default agrees.
  const [shareWithAdmin, setShareWithAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  // A note is somebody's written record of a person. Removing one asks first,
  // like every other delete in the app.
  const [noteToDelete, setNoteToDelete] = useState<ConnectorNote | null>(null)
  const [noteBusy, setNoteBusy] = useState(false)

  async function addNote(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setError('')
    setBusy(true)

    const { error: insertError } = await supabase.from('connector_notes').insert({
      connector_id: connectorId,
      user_profile_id: person.profile.id,
      note_text: text.trim(),
      is_searchable_by_admin: shareWithAdmin,
    })

    setBusy(false)
    if (insertError) {
      setError(errorMessage(insertError))
      return
    }
    setText('')
    // Private by default: sharing is chosen per note, never carried over.
    setShareWithAdmin(false)
    await onChanged()
  }

  async function removeNote() {
    if (!noteToDelete) return
    setError('')
    setNoteBusy(true)
    const { error: deleteError } = await supabase
      .from('connector_notes')
      .delete()
      .eq('id', noteToDelete.id)
    setNoteBusy(false)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    setNoteToDelete(null)
    await onChanged()
  }

  return (
    <>
      <SectionHeader
        title="Context"
        action={
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete profile
          </Button>
        }
      />

      <Panel className="px-6 py-6">
        <div className="flex items-start gap-4">
          <Initials name={person.profile.full_name} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-base font-medium tracking-tight text-fg">
                {person.profile.full_name}
              </span>
              <StatusBadge status={person.profile.profile_status} />
            </div>
            {person.profile.current_profession && (
              <div className="mt-0.5 text-sm text-muted">{person.profile.current_profession}</div>
            )}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-dim">
              <span>Joined {formatDate(person.joinedAt)}</span>
              {person.codeUsed && <span>Code {person.codeUsed}</span>}
            </div>
          </div>
        </div>

        {person.profile.semantic_summary && (
          <p className="mt-5 border-t border-line pt-5 text-sm leading-relaxed text-muted">
            {person.profile.semantic_summary}
          </p>
        )}
      </Panel>

      <div className="mt-8">
        <SectionHeader
          title="Your private notes"
          caption="Only you can read these. Marked notes are also searchable by an administrator."
        />

        <Panel className="px-6 py-6">
          <form onSubmit={addNote} className="space-y-4">
            <Textarea
              rows={3}
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={`Private note about ${person.profile.full_name}`}
              placeholder={`What should you remember about ${person.profile.full_name.split(' ')[0]}?`}
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={shareWithAdmin}
                  onChange={(e) => setShareWithAdmin(e.target.checked)}
                  className="size-3.5 accent-gold-dim"
                />
                Make searchable by an administrator
              </label>
              <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!text.trim()}>
                Add note
              </Button>
            </div>

            {error && <Notice tone="error">{error}</Notice>}
          </form>
        </Panel>

        {notes.length > 0 && (
          <ul className="mt-4 space-y-3">
            {notes.map((note) => (
              <li key={note.id} className="rounded-sm border border-line bg-surface px-5 py-4">
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
                  {note.note_text}
                </p>
                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-dim">
                  <span>
                    {formatDate(note.created_at)}
                    {note.is_searchable_by_admin ? ' · visible to admin' : ' · private to you'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setNoteToDelete(note)}
                    className="transition-colors hover:text-negative"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmModal
        open={Boolean(noteToDelete)}
        title="Delete this note?"
        body="The note is removed for good. If it was visible to an admin, it disappears from their view too."
        busy={noteBusy}
        onConfirm={() => void removeNote()}
        onClose={() => setNoteToDelete(null)}
      />

      <DeleteProfileModal
        open={confirmDelete}
        profileId={person.profile.id}
        name={person.profile.full_name}
        impact="This permanently removes this member's account, your link to them, their notes, and their search data."
        onClose={() => setConfirmDelete(false)}
        onDeleted={onChanged}
      />
    </>
  )
}

/* -------------------------------------------------------------------------- */

export function InviteCodes({
  codes,
  remaining,
  canInvite,
  onChanged,
}: {
  codes: InviteCode[]
  remaining: number
  canInvite: boolean
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [maxUses, setMaxUses] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [minted, setMinted] = useState<string | null>(null)

  async function create(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    const { data, error: rpcError } = await supabase.rpc('create_invite_code', {
      p_max_uses: maxUses,
    })

    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    setMinted((data as { code: string }).code)
    await onChanged()
  }

  async function toggle(code: InviteCode) {
    setError('')
    const next = code.status === 'active' ? 'disabled' : 'active'
    const { error: rpcError } = await supabase.rpc('set_invite_code_status', {
      p_id: code.id,
      p_status: next,
    })
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    await onChanged()
  }

  function close() {
    setOpen(false)
    setMinted(null)
    setError('')
    setMaxUses(1)
  }

  return (
    <div className="mt-10">
      {/* The page title is the heading; this row is only the control. */}
      <div className="mb-4 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={!canInvite || remaining <= 0}
        >
          New code
        </Button>
      </div>

      {!canInvite && (
        <div className="mb-4">
          <Notice tone="error">
            Your inviting privileges are paused. Contact an administrator to restore them.
          </Notice>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {codes.length === 0 ? (
        <EmptyState>
          {canInvite && remaining > 0
            ? 'No invitation codes yet. Press New code to create one.'
            : 'No invitation codes yet.'}
        </EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {codes.map((code) => {
            // Decision 21. A code can only admit as many as the connector
            // still has room for, whatever its own limit says.
            const left = Math.min(code.max_uses - code.use_count, remaining)
            const closed = code.status === 'exhausted' || code.status === 'expired'
            return (
              <div
                key={code.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <CopyCode code={code.code} />
                  <div className="text-xs text-dim">
                    {code.use_count} of {code.max_uses} used
                    {code.status === 'active' && left > 0 && ` · ${left} left`}
                    {' · created '}
                    {formatDate(code.created_at)}
                  </div>
                  {code.sent_to && (
                    <div className="text-xs text-dim">
                      Emailed to <span className="text-fg">{code.sent_to}</span>
                      {code.sent_at && ` · ${formatDate(code.sent_at)}`}
                    </div>
                  )}
                  {code.status === 'active' && left > 0 && (
                    <div className="mt-1 max-w-sm">
                      <SendInvite code={code.code} onSent={onChanged} />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <StatusBadge status={code.status} />
                  {!closed && (
                    <button
                      type="button"
                      onClick={() => toggle(code)}
                      className="text-xs text-dim transition-colors hover:text-fg"
                    >
                      {code.status === 'active' ? 'Disable' : 'Re-activate'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </Panel>
      )}

      <Modal open={open} title="New invitation code" onClose={close}>
        {minted ? (
          <div className="text-center">
            <p className="eyebrow">Your new code</p>
            <div className="mt-4 flex justify-center">
              <CopyCode code={minted} size="lg" />
            </div>
            <p className="mx-auto mt-5 max-w-sm text-sm leading-relaxed text-muted">
              Email it to the person you're inviting and the link will fill the code in for
              them, or copy it above and send it yourself.
            </p>

            <div className="mt-6 text-left">
              <SendInvite code={minted} onSent={onChanged} />
            </div>
            <Button variant="primary" className="mt-7 w-full" onClick={close}>
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={create} className="space-y-5">
            <p className="text-sm leading-relaxed text-muted">
              You have <span className="text-fg">{remaining}</span> invitation
              {remaining === 1 ? '' : 's'} remaining.
            </p>

            <Field
              label="How many people may use it"
              hint="One code can be shared with several people, up to this number."
            >
              <Input
                type="number"
                min={1}
                max={Math.max(1, remaining)}
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
              />
            </Field>

            {error && <Notice tone="error">{error}</Notice>}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Generate code
            </Button>
          </form>
        )}
      </Modal>
    </div>
  )
}
