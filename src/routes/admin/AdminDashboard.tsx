import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { DashboardShell, type Tab } from '../../components/DashboardShell'
import { DeleteProfileModal } from '../../components/DeleteProfileModal'
import { FlagsPanel } from '../../components/FlagsPanel'
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
  StatusBadge,
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
  type ActivityLogEntry,
  type CircleMessage,
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
  const [activity, setActivity] = useState<ActivityLogEntry[]>([])
  const [circleMessages, setCircleMessages] = useState<CircleMessage[]>([])
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
      activityRes,
      circlesRes,
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
      // ponytail: newest 200, no pagination. The log is a record to consult,
      // not a screen to scroll forever; add a range() when someone asks.
      supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('circle_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(500),
    ])

    const firstError = [
      connectorsRes.error,
      invitationsRes.error,
      profilesRes.error,
      linksRes.error,
      codesRes.error,
      waitlistRes.error,
      notesRes.error,
      activityRes.error,
      circlesRes.error,
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
    setActivity((activityRes.data as ActivityLogEntry[]) ?? [])
    setCircleMessages((circlesRes.data as CircleMessage[]) ?? [])
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

  const codesById = useMemo(
    () => Object.fromEntries(codes.map((c) => [c.id, c])),
    [codes],
  )

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
    { id: 'circles', label: 'Circles', count: connectors.length },
    { id: 'flags', label: 'Raised' },
    { id: 'log', label: 'Log' },
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
            {tab === 'circles' && (
              <CirclesTab
                connectors={connectors}
                links={links}
                profilesById={profilesById}
                messages={circleMessages}
              />
            )}
            {tab === 'flags' && <FlagsPanel />}
            {tab === 'log' && <LogTab entries={activity} profilesById={profilesById} />}
            {tab === 'waitlist' && (
              <WaitlistTab
                entries={waitlist}
                connectors={connectors}
                codesById={codesById}
                onChanged={load}
              />
            )}
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
              <Initials name={connector.profiles?.full_name ?? '?'} role="connector" />
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
              <Initials name={member.full_name} role={member.role} />
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

function WaitlistTab({
  entries,
  connectors,
  codesById,
  onChanged,
}: {
  entries: WaitlistEntry[]
  connectors: ConnectorRow[]
  codesById: Record<string, InviteCode>
  onChanged: () => Promise<void>
}) {
  const [assigning, setAssigning] = useState<WaitlistEntry | null>(null)

  const connectorNameById = useMemo(
    () =>
      Object.fromEntries(
        connectors.map((c) => [c.id, c.profiles?.full_name ?? 'Unknown']),
      ) as Record<string, string>,
    [connectors],
  )

  return (
    <>
      <SectionHeader
        title="Waitlist"
        caption="People who asked to be let in from the public page. Vet them, then hand them to a connector."
      />

      {entries.length === 0 ? (
        <EmptyState>Nobody on the waitlist yet.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {entries.map((entry) => {
            const code = entry.assigned_code_id ? codesById[entry.assigned_code_id] : undefined
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">{entry.full_name}</div>
                  <div className="truncate text-xs text-dim">
                    {entry.email}
                    {entry.assigned_connector_id
                      ? ` · assigned to ${connectorNameById[entry.assigned_connector_id] ?? 'a removed connector'}`
                      : ''}
                  </div>
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
                  {entry.assigned_at ? (
                    code ? (
                      <CopyCode code={code.code} size="sm" />
                    ) : (
                      <span className="text-dim">code withdrawn</span>
                    )
                  ) : (
                    <Button variant="primary" size="sm" onClick={() => setAssigning(entry)}>
                      Assign
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </Panel>
      )}

      {assigning && (
        <AssignWaitlistModal
          key={assigning.id}
          entry={assigning}
          connectors={connectors}
          onClose={() => setAssigning(null)}
          onAssigned={onChanged}
        />
      )}
    </>
  )
}

function AssignWaitlistModal({
  entry,
  connectors,
  onClose,
  onAssigned,
}: {
  entry: WaitlistEntry
  connectors: ConnectorRow[]
  onClose: () => void
  onAssigned: () => Promise<void>
}) {
  // ponytail: only the obvious filter here. Capacity is enforced by
  // assign_waitlist_entry, not re-derived in the browser.
  const eligible = connectors.filter((c) => c.invite_status === 'active' && c.profiles)

  const [connectorId, setConnectorId] = useState(eligible[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState<string | null>(null)

  const firstName = entry.full_name.split(' ')[0] || 'them'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    const { data, error: rpcError } = await supabase.rpc('assign_waitlist_entry', {
      p_entry_id: entry.id,
      p_connector_id: connectorId,
    })

    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    setCode((data as { code: string }).code)
    await onAssigned()
  }

  return (
    <Modal open title={`Assign ${entry.full_name}`} onClose={onClose}>
      {code ? (
        <div className="text-center">
          <p className="eyebrow">Invitation code for {entry.full_name}</p>
          <div className="mt-4 flex justify-center">
            <CopyCode code={code} size="lg" />
          </div>
          <p className="mx-auto mt-5 max-w-sm text-sm leading-relaxed text-muted">
            Send this to {firstName}. They'll enter it at the join page to create their account
            under this connector.
          </p>
          <Button variant="primary" className="mt-7 w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : eligible.length === 0 ? (
        <div>
          <Notice tone="error">
            No connector is currently active. Activate one before assigning anybody.
          </Notice>
          <Button className="mt-6 w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <Field label="Connector">
            <Select
              required
              value={connectorId}
              onChange={(e) => setConnectorId(e.target.value)}
            >
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.profiles?.full_name ?? 'Unknown'}
                </option>
              ))}
            </Select>
          </Field>

          <p className="text-sm leading-relaxed text-muted">
            This mints a single-use invitation code out of that connector's remaining capacity.
            {' '}{firstName} joins as their member once they redeem it.
          </p>

          {error && <Notice tone="error">{error}</Notice>}

          <div className="flex gap-3 pt-1">
            <Button type="button" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={busy}>
              {busy ? 'Assigning…' : 'Assign'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Activity log                                                                */
/* -------------------------------------------------------------------------- */

/** `profiles.update` -> `update`, for the badge. */
function verbOf(action: string): string {
  return action.split('.').pop() ?? action
}

const VERB_TONE: Record<string, string> = {
  insert: 'text-gold',
  update: 'text-muted',
  delete: 'text-red-400',
}

/**
 * Everything the platform did, newest first. Written by the log_activity()
 * trigger rather than by application code, so it records a change made
 * straight against the database too — and cannot be forgotten at a call site.
 */
function LogTab({
  entries,
  profilesById,
}: {
  entries: ActivityLogEntry[]
  profilesById: Record<string, Profile>
}) {
  return (
    <>
      <SectionHeader
        title="Activity"
        caption="An append-only record of every change. Nothing writes here but the database itself."
      />

      {entries.length === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {entries.map((entry) => {
            const actor = entry.actor_id ? profilesById[entry.actor_id] : undefined
            const verb = verbOf(entry.action)
            const changed = verb === 'update' ? Object.keys(entry.detail ?? {}) : []

            return (
              <div key={entry.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0 text-sm text-fg">
                    <span className={`${VERB_TONE[verb] ?? 'text-muted'} tabular-nums`}>
                      {verb}
                    </span>{' '}
                    <span className="text-muted">{entry.entity}</span>
                    {changed.length > 0 && (
                      <span className="text-dim"> · {changed.join(', ')}</span>
                    )}
                  </div>
                  <div className="text-xs whitespace-nowrap text-dim">
                    {actor?.full_name ?? (entry.actor_id ? 'a removed account' : 'the system')} ·{' '}
                    {formatDate(entry.created_at)}
                  </div>
                </div>

                {entry.detail && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-dim hover:text-muted">
                      Detail
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-ink/40 p-3 text-[0.6875rem] leading-relaxed text-muted">
                      {JSON.stringify(entry.detail, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )
          })}
        </Panel>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Circles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The network as it is actually shaped: every connector, and beneath each one
 * the people they brought in.
 *
 * The hierarchy is not stored anywhere. connector_user_links already records
 * who invited whom, so this is that fact drawn out rather than a second copy
 * of it. Collapsing uses a native <details>, which needs no state.
 *
 * Conversations appear here because an administrator was given read access on
 * purpose (20260907000007_admin_reads_circles.sql). Reading a room is still
 * not speaking in it: the insert policy requires being inside one, and an
 * admin belongs to no circle.
 */
function CirclesTab({
  connectors,
  links,
  profilesById,
  messages,
}: {
  connectors: ConnectorRow[]
  links: LinkRow[]
  profilesById: Record<string, Profile>
  messages: CircleMessage[]
}) {
  return (
    <>
      <SectionHeader
        title="Circles"
        caption="Every connector, the people beneath them, and what is being said in each room."
      />

      {connectors.length === 0 ? (
        <EmptyState>No connectors yet, so there are no circles.</EmptyState>
      ) : (
        <div className="space-y-4">
          {connectors.map((connector) => {
            const members = links
              .filter((l) => l.connector_id === connector.id)
              .map((l) => profilesById[l.user_profile_id])
              .filter(Boolean)
            const said = messages.filter((m) => m.connector_id === connector.id)

            return (
              <Panel key={connector.id} className="overflow-hidden">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 transition-colors hover:bg-fg/[0.02]">
                    <Initials name={connector.profiles?.full_name ?? '?'} role="connector" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {connector.profiles?.full_name ?? 'Unknown'}
                      </span>
                      <span className="block truncate text-xs text-dim">
                        {members.length} of {connector.invite_capacity} invited{' '}
                        &middot; {said.length}{' '}
                        {said.length === 1 ? 'message' : 'messages'}
                      </span>
                    </span>
                    <StatusBadge status={connector.invite_status} />
                  </summary>

                  <div className="border-t border-line">
                    {members.length === 0 ? (
                      <p className="px-5 py-4 text-sm text-dim">
                        Nobody has joined on their codes yet.
                      </p>
                    ) : (
                      <ul className="divide-y divide-line">
                        {members.map((member) => (
                          <li key={member.id} className="flex items-center gap-3 py-3 pr-5 pl-10">
                            <Initials name={member.full_name} role={member.role} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-fg">
                                {member.full_name}
                              </span>
                              <span className="block truncate text-xs text-dim">
                                {member.current_profession ?? '—'}
                              </span>
                            </span>
                            <span className="ml-auto shrink-0">
                              <StatusBadge status={member.profile_status} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {said.length > 0 && (
                      <details className="border-t border-line">
                        <summary className="cursor-pointer px-5 py-3 text-xs tracking-[0.1em] text-dim uppercase hover:text-fg">
                          Conversation &middot; {said.length}
                        </summary>
                        <ul className="space-y-3 bg-fg/[0.015] px-5 py-4">
                          {said.map((message) => (
                            <li key={message.id} className="text-sm">
                              <span className="text-xs text-dim">
                                {profilesById[message.author_id]?.full_name ?? 'Someone'}{' '}
                                &middot; {formatDate(message.created_at)}
                              </span>
                              <p className="mt-0.5 leading-relaxed break-words whitespace-pre-wrap text-muted">
                                {message.body}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </details>
              </Panel>
            )
          })}
        </div>
      )}
    </>
  )
}
