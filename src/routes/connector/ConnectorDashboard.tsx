import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { DashboardShell, type Tab } from '../../components/DashboardShell'
import {
  Button,
  CopyCode,
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
import { useAuth } from '../../context/AuthProvider'
import type { Connector, ConnectorNote, InviteCode, Profile } from '../../lib/types'

interface Person {
  linkId: string
  joinedAt: string
  codeUsed: string | null
  profile: Profile
}

export default function ConnectorDashboard() {
  const { profile } = useAuth()
  const [tab, setTab] = useState('people')
  const [connector, setConnector] = useState<Connector | null>(null)
  const [codes, setCodes] = useState<InviteCode[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [notes, setNotes] = useState<ConnectorNote[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
      setError(errorMessage(connectorError) || 'No connector record found for this account.')
      setLoading(false)
      return
    }
    setConnector(connectorRow as Connector)

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

  // Capacity is spent when someone actually joins, not when a code is issued,
  // so this mirrors public.connector_available_capacity exactly.
  const liveCodes = useMemo(() => codes.filter((c) => c.status === 'active').length, [codes])
  const capacity = connector?.invite_capacity ?? 0
  const remaining = Math.max(0, capacity - people.length)

  const tabs: Tab[] = [
    { id: 'people', label: 'Your people', count: people.length },
    { id: 'codes', label: 'Invitations', count: codes.length },
  ]

  const selected = people.find((p) => p.profile.id === selectedId) ?? null

  return (
    <DashboardShell
      title="Your corner of the network"
      caption="The people you've brought in, the context you hold on them, and the invitations you have left."
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
    >
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <>
          <CapacityBar
            status={connector?.invite_status ?? 'active'}
            joined={people.length}
            capacity={capacity}
            liveCodes={liveCodes}
          />

          {tab === 'people' ? (
            <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <section>
                <SectionHeader
                  title="People you invited"
                  caption={
                    people.length
                      ? 'Select someone to read and add private context.'
                      : undefined
                  }
                />
                {people.length === 0 ? (
                  <EmptyState>
                    Nobody has joined on your codes yet. Share one from the Invitations tab.
                  </EmptyState>
                ) : (
                  <Panel className="divide-y divide-line">
                    {people.map((person) => {
                      const noteCount = notes.filter(
                        (n) => n.user_profile_id === person.profile.id,
                      ).length
                      const active = person.profile.id === selectedId
                      return (
                        <button
                          key={person.linkId}
                          type="button"
                          onClick={() => setSelectedId(person.profile.id)}
                          className={`flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors ${
                            active ? 'bg-raised' : 'hover:bg-raised/60'
                          }`}
                        >
                          <Initials name={person.profile.full_name} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-fg">
                              {person.profile.full_name}
                            </span>
                            <span className="block truncate text-xs text-dim">
                              {person.profile.current_profession ?? 'Onboarding not finished'}
                            </span>
                          </span>
                          {noteCount > 0 && (
                            <span className="text-xs tabular-nums text-dim">
                              {noteCount} note{noteCount === 1 ? '' : 's'}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </Panel>
                )}
              </section>

              <section>
                {selected && connector ? (
                  <PersonDetail
                    person={selected}
                    connectorId={connector.id}
                    notes={notes.filter((n) => n.user_profile_id === selected.profile.id)}
                    onChanged={load}
                  />
                ) : (
                  <div className="hidden lg:block">
                    <SectionHeader title="Context" />
                    <EmptyState>Select someone to see their details and your notes.</EmptyState>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <InviteCodes
              codes={codes}
              remaining={remaining}
              canInvite={connector?.invite_status === 'active'}
              onChanged={load}
            />
          )}
        </>
      )}
    </DashboardShell>
  )
}

/* -------------------------------------------------------------------------- */

function CapacityBar({
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

function PersonDetail({
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
  const [shareWithAdmin, setShareWithAdmin] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    await onChanged()
  }

  async function removeNote(id: string) {
    const { error: deleteError } = await supabase.from('connector_notes').delete().eq('id', id)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    await onChanged()
  }

  return (
    <>
      <SectionHeader title="Context" />

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
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`What should you remember about ${person.profile.full_name.split(' ')[0]}?`}
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={shareWithAdmin}
                  onChange={(e) => setShareWithAdmin(e.target.checked)}
                  className="size-3.5 accent-[#c9a961]"
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
                    onClick={() => removeNote(note.id)}
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
    </>
  )
}

/* -------------------------------------------------------------------------- */

function InviteCodes({
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
      <SectionHeader
        title="Invitation codes"
        caption="Share a code with someone you'd like to bring into the network."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setOpen(true)}
            disabled={!canInvite || remaining <= 0}
          >
            New code
          </Button>
        }
      />

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
        <EmptyState>You have no invitation codes yet.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {codes.map((code) => {
            const remaining = code.max_uses - code.use_count
            const closed = code.status === 'exhausted' || code.status === 'expired'
            return (
              <div
                key={code.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <CopyCode code={code.code} />
                  <div className="text-xs text-dim">
                    {code.use_count} of {code.max_uses} used
                    {code.status === 'active' && remaining > 0 && ` · ${remaining} left`}
                    {' · created '}
                    {formatDate(code.created_at)}
                  </div>
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
              Send this to the person you're inviting. They'll enter it at the join page to set
              up their account.
            </p>
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
