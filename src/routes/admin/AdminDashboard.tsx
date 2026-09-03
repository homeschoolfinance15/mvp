import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { DashboardShell, type Tab } from '../../components/DashboardShell'
import { DeleteProfileModal } from '../../components/DeleteProfileModal'
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
  Select,
  Spinner,
  StatTile,
} from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'
import {
  CONNECTOR_STATUSES,
  PROFILE_STATUSES,
  type Connector,
  type ConnectorInvitation,
  type ConnectorNote,
  type ConnectorStatus,
  type InviteCode,
  type Profile,
  type ProfileStatus,
  type WaitlistEntry,
} from '../../lib/types'

interface ConnectorRow extends Connector {
  profiles: Profile | null
}

interface LinkRow {
  id: string
  created_at: string
  connector_id: string
  user_profile_id: string
  connectors: { profiles: { full_name: string } | null } | null
}

export default function AdminDashboard() {
  const [tab, setTab] = useState('connectors')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [invitations, setInvitations] = useState<ConnectorInvitation[]>([])
  const [members, setMembers] = useState<Profile[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [codes, setCodes] = useState<InviteCode[]>([])
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([])
  const [notes, setNotes] = useState<ConnectorNote[]>([])
  const [profilesById, setProfilesById] = useState<Record<string, Profile>>({})

  const load = useCallback(async () => {
    setError('')
    const [
      connectorsRes,
      invitationsRes,
      profilesRes,
      linksRes,
      codesRes,
      waitlistRes,
      notesRes,
    ] = await Promise.all([
      supabase.from('connectors').select('*, profiles(*)').order('created_at', { ascending: false }),
      supabase.from('connector_invitations').select('*').order('created_at', { ascending: false }),
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase
        .from('connector_user_links')
        .select('id, created_at, connector_id, user_profile_id, connectors(profiles(full_name))'),
      supabase.from('invite_codes').select('*'),
      supabase.from('waitlist_entries').select('*').order('created_at', { ascending: false }),
      supabase.from('connector_notes').select('*').order('created_at', { ascending: false }),
    ])

    const firstError = [
      connectorsRes.error,
      invitationsRes.error,
      profilesRes.error,
      linksRes.error,
      codesRes.error,
      waitlistRes.error,
      notesRes.error,
    ].find(Boolean)
    if (firstError) setError(errorMessage(firstError))

    const allProfiles = (profilesRes.data as Profile[]) ?? []

    setConnectors((connectorsRes.data as unknown as ConnectorRow[]) ?? [])
    setInvitations((invitationsRes.data as ConnectorInvitation[]) ?? [])
    setMembers(allProfiles.filter((p) => p.role === 'user'))
    setProfilesById(Object.fromEntries(allProfiles.map((p) => [p.id, p])))
    setLinks((linksRes.data as unknown as LinkRow[]) ?? [])
    setCodes((codesRes.data as InviteCode[]) ?? [])
    setWaitlist((waitlistRes.data as WaitlistEntry[]) ?? [])
    setNotes((notesRes.data as ConnectorNote[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const invitedCount = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const link of links) {
      counts[link.connector_id] = (counts[link.connector_id] ?? 0) + 1
    }
    return counts
  }, [links])

  const connectorByMember = useMemo(() => {
    const map: Record<string, string> = {}
    for (const link of links) {
      map[link.user_profile_id] = link.connectors?.profiles?.full_name ?? '—'
    }
    return map
  }, [links])

  const pendingInvitations = invitations.filter((i) => !i.claimed_at)
  const activeCodes = codes.filter((c) => c.status === 'active').length

  const tabs: Tab[] = [
    { id: 'connectors', label: 'Connectors', count: connectors.length },
    { id: 'members', label: 'Members', count: members.length },
    { id: 'notes', label: 'Notes', count: notes.length },
    { id: 'waitlist', label: 'Waitlist', count: waitlist.length },
  ]

  return (
    <DashboardShell
      title="Administration"
      caption="Who holds the ability to invite, who they've brought in, and who is waiting at the door."
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
    >
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-8">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Connectors" value={connectors.length} />
            <StatTile label="Members" value={members.length} />
            <StatTile label="Live codes" value={activeCodes} />
            <StatTile label="Waitlist" value={waitlist.length} />
          </div>

          <div className="mt-12">
            {tab === 'connectors' && (
              <ConnectorsTab
                connectors={connectors}
                pendingInvitations={pendingInvitations}
                invitedCount={invitedCount}
                onChanged={load}
              />
            )}
            {tab === 'members' && (
              <MembersTab
                members={members}
                connectorByMember={connectorByMember}
                onChanged={load}
              />
            )}
            {tab === 'notes' && (
              <NotesTab notes={notes} connectors={connectors} profilesById={profilesById} />
            )}
            {tab === 'waitlist' && <WaitlistTab entries={waitlist} />}
          </div>
        </>
      )}
    </DashboardShell>
  )
}

/* -------------------------------------------------------------------------- */
/* Connectors                                                                  */
/* -------------------------------------------------------------------------- */

function ConnectorsTab({
  connectors,
  pendingInvitations,
  invitedCount,
  onChanged,
}: {
  connectors: ConnectorRow[]
  pendingInvitations: ConnectorInvitation[]
  invitedCount: Record<string, number>
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [connectorToDelete, setConnectorToDelete] = useState<ConnectorRow | null>(null)

  async function setStatus(id: string, status: ConnectorStatus) {
    setError('')
    const { error: updateError } = await supabase
      .from('connectors')
      .update({ invite_status: status })
      .eq('id', id)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    await onChanged()
  }

  return (
    <>
      <SectionHeader
        title="Connectors"
        caption="Connectors are the only people who can bring new members in."
        action={
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Create connector
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {connectors.length === 0 ? (
        <EmptyState>No connectors yet. Create the first one to open the network.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {connectors.map((connector) => (
            <div
              key={connector.id}
              className="flex flex-wrap items-center gap-4 px-5 py-4 sm:flex-nowrap"
            >
              <Initials name={connector.profiles?.full_name ?? '?'} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">
                  {connector.profiles?.full_name ?? 'Unknown'}
                </div>
                <div className="truncate text-xs text-dim">
                  {connector.profiles?.email ?? '—'}
                  {connector.profiles?.current_profession
                    ? ` · ${connector.profiles.current_profession}`
                    : ''}
                </div>
              </div>
              <div className="text-right text-xs whitespace-nowrap text-muted tabular-nums">
                {invitedCount[connector.id] ?? 0} of {connector.invite_capacity} invited
              </div>
              <div className="w-32 shrink-0">
                <Select
                  value={connector.invite_status}
                  onChange={(e) => setStatus(connector.id, e.target.value as ConnectorStatus)}
                >
                  {CONNECTOR_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variant="danger"
                size="sm"
                disabled={!connector.profiles}
                onClick={() => setConnectorToDelete(connector)}
              >
                Delete
              </Button>
            </div>
          ))}
        </Panel>
      )}

      {pendingInvitations.length > 0 && (
        <div className="mt-10">
          <SectionHeader
            title="Awaiting claim"
            caption="These people have a claim code but haven't set up their account yet."
          />
          <Panel className="divide-y divide-line">
            {pendingInvitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">
                    {invitation.full_name}
                  </div>
                  <div className="truncate text-xs text-dim">
                    {invitation.email} · {invitation.invite_capacity} invitations · created{' '}
                    {formatDate(invitation.created_at)}
                  </div>
                </div>
                <CopyCode code={invitation.claim_code} size="sm" />
              </div>
            ))}
          </Panel>
        </div>
      )}

      <CreateConnectorModal open={open} onClose={() => setOpen(false)} onCreated={onChanged} />
      <DeleteProfileModal
        open={Boolean(connectorToDelete?.profiles)}
        profileId={connectorToDelete?.profile_id ?? null}
        name={connectorToDelete?.profiles?.full_name ?? 'connector'}
        impact={`This permanently removes the connector account, its invitation codes, and ${
          invitedCount[connectorToDelete?.id ?? ''] ?? 0
        } member profile${
          (invitedCount[connectorToDelete?.id ?? ''] ?? 0) === 1 ? '' : 's'
        } beneath it.`}
        onClose={() => setConnectorToDelete(null)}
        onDeleted={onChanged}
      />
    </>
  )
}

function CreateConnectorModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [capacity, setCapacity] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [claimCode, setClaimCode] = useState<string | null>(null)

  function close() {
    setFullName('')
    setEmail('')
    setCapacity(10)
    setError('')
    setClaimCode(null)
    onClose()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    const { data, error: rpcError } = await supabase.rpc('create_connector_invitation', {
      p_full_name: fullName,
      p_email: email,
      p_capacity: capacity,
    })

    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    setClaimCode((data as { claim_code: string }).claim_code)
    await onCreated()
  }

  return (
    <Modal open={open} title="Create a connector" onClose={close}>
      {claimCode ? (
        <div className="text-center">
          <p className="eyebrow">Claim code for {fullName}</p>
          <div className="mt-4 flex justify-center">
            <CopyCode code={claimCode} size="lg" />
          </div>
          <p className="mx-auto mt-5 max-w-sm text-sm leading-relaxed text-muted">
            Send this to {fullName.split(' ')[0] || 'them'}. They'll enter it at the join page to
            claim their connector account and set a password.
          </p>
          <Button variant="primary" className="mt-7 w-full" onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <Field label="Full name">
            <Input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Okonkwo"
            />
          </Field>

          <Field label="Email address" hint="Pre-fills their signup. They can change it.">
            <Input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
            />
          </Field>

          <Field label="Invitation capacity" hint="How many people they may bring in.">
            <Input
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
            />
          </Field>

          {error && <Notice tone="error">{error}</Notice>}

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Create and generate claim code
          </Button>
        </form>
      )}
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

function MembersTab({
  members,
  connectorByMember,
  onChanged,
}: {
  members: Profile[]
  connectorByMember: Record<string, string>
  onChanged: () => Promise<void>
}) {
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [memberToDelete, setMemberToDelete] = useState<Profile | null>(null)

  const filtered = members.filter((m) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      m.full_name.toLowerCase().includes(q) ||
      (m.email ?? '').toLowerCase().includes(q) ||
      (m.current_profession ?? '').toLowerCase().includes(q)
    )
  })

  async function setStatus(id: string, status: ProfileStatus) {
    setError('')
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ profile_status: status })
      .eq('id', id)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    await onChanged()
  }

  return (
    <>
      <SectionHeader
        title="Members"
        caption="Everyone who joined on a connector's invitation."
        action={
          <div className="w-56">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
            />
          </div>
        }
      />

      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState>
          {members.length === 0 ? 'Nobody has joined yet.' : 'No members match that search.'}
        </EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {filtered.map((member) => (
            <div key={member.id} className="flex flex-wrap items-center gap-4 px-5 py-4 sm:flex-nowrap">
              <Initials name={member.full_name} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{member.full_name}</div>
                <div className="truncate text-xs text-dim">
                  {member.current_profession ?? 'Onboarding not finished'}
                </div>
              </div>
              <div className="min-w-0 text-right text-xs text-muted">
                <div className="truncate">via {connectorByMember[member.id] ?? '—'}</div>
                <div className="text-dim">{formatDate(member.created_at)}</div>
              </div>
              <div className="w-36 shrink-0">
                <Select
                  value={member.profile_status}
                  onChange={(e) => setStatus(member.id, e.target.value as ProfileStatus)}
                >
                  {PROFILE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </div>
              <Button variant="danger" size="sm" onClick={() => setMemberToDelete(member)}>
                Delete
              </Button>
            </div>
          ))}
        </Panel>
      )}

      <DeleteProfileModal
        open={Boolean(memberToDelete)}
        profileId={memberToDelete?.id ?? null}
        name={memberToDelete?.full_name ?? 'member'}
        impact="This permanently removes the member account, its connector link, notes, and search data."
        onClose={() => setMemberToDelete(null)}
        onDeleted={onChanged}
      />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

function NotesTab({
  notes,
  connectors,
  profilesById,
}: {
  notes: ConnectorNote[]
  connectors: ConnectorRow[]
  profilesById: Record<string, Profile>
}) {
  const connectorName = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of connectors) map[c.id] = c.profiles?.full_name ?? 'Unknown'
    return map
  }, [connectors])

  return (
    <>
      <SectionHeader
        title="Connector notes"
        caption="Context connectors chose to make searchable. Notes marked private are never shown here."
      />

      {notes.length === 0 ? (
        <EmptyState>No shared notes yet.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-sm border border-line bg-surface px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
                <span className="text-muted">{connectorName[note.connector_id] ?? 'Unknown'}</span>
                <span>on</span>
                <span className="text-muted">
                  {profilesById[note.user_profile_id]?.full_name ?? 'Unknown'}
                </span>
                <span>· {formatDate(note.created_at)}</span>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap text-fg">
                {note.note_text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Waitlist                                                                    */
/* -------------------------------------------------------------------------- */

function WaitlistTab({ entries }: { entries: WaitlistEntry[] }) {
  return (
    <>
      <SectionHeader title="Waitlist" caption="People who asked to be let in from the public page." />

      {entries.length === 0 ? (
        <EmptyState>Nobody on the waitlist yet.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{entry.full_name}</div>
                <div className="truncate text-xs text-dim">{entry.email}</div>
              </div>
              <div className="flex items-center gap-5 text-xs">
                {entry.linkedin_url && (
                  <a
                    href={entry.linkedin_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-gold underline-offset-4 hover:underline"
                  >
                    LinkedIn
                  </a>
                )}
                <span className="text-dim">{formatDate(entry.created_at)}</span>
              </div>
            </div>
          ))}
        </Panel>
      )}
    </>
  )
}
