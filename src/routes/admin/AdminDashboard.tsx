import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { DashboardShell, type Tab } from '../../components/DashboardShell'
import { DeleteProfileModal } from '../../components/DeleteProfileModal'
import { FlagsPanel } from '../../components/FlagsPanel'
import {
  Button,
  ConfirmModal,
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
  type ProfileTag,
  type TagAnswer,
  type WaitlistEntry,
} from '../../lib/types'
import {
  INITIAL_ORDER,
  TAG_QUESTIONS,
  TEXT_QUESTIONS,
  TRAVEL_OPTIONS,
} from '../../lib/questionnaire'

/**
 * What each status actually does, rather than what it is called.
 *
 * Worth knowing before writing these: every gate in the schema asks
 * `invite_status <> 'active'`, so limited, paused and removed are the same
 * behaviour under three names. The copy says so instead of implying a
 * gradient the database does not have.
 */
const CONNECTOR_STATUS_EFFECT: Record<ConnectorStatus, string> = {
  active:
    'They can mint invitation codes again, and can be handed people from the waitlist.',
  limited:
    'They stop being able to bring anyone new in. Their existing members, and any code already handed out, keep working. Identical to paused and removed in what it permits.',
  paused:
    'They stop being able to bring anyone new in. Their existing members, and any code already handed out, keep working. Identical to limited and removed in what it permits.',
  removed:
    'They stop being able to bring anyone new in. Nothing is deleted: their account, their members and any code already handed out are untouched. Identical to limited and paused in what it permits.',
}

/** The read gate is is_member(); the write gate is can_post(). */
const PROFILE_STATUS_EFFECT: Record<ProfileStatus, string> = {
  pending: 'They can read the network but cannot post, comment, or send messages.',
  active: 'Full access: they can read and write everywhere their membership reaches.',
  under_review:
    'They can still read everything, but cannot post, comment, or send messages.',
  restricted:
    'They can still read everything, but cannot post, comment, or send messages.',
  suspended:
    'They lose both reading and writing, and disappear from the member directory. Their account and everything they wrote stays.',
  removed:
    'They lose both reading and writing, and disappear from the member directory. This does not delete the account — use Delete for that.',
}

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
  // Labels for the chips a waitlist applicant picked, so the detail view can
  // show "Starting a business" rather than current_focus.starting_a_business.
  const [profileTags, setProfileTags] = useState<ProfileTag[]>([])

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
      tagsRes,
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
      supabase.from('profile_tags').select('*').order('field').order('position'),
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
      tagsRes.error,
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
    setProfileTags((tagsRes.data as ProfileTag[]) ?? [])
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
      map[link.user_profile_id] = link.connectors?.profiles?.full_name ?? 'an unknown connector'
    }
    return map
  }, [links])

  const pendingInvitations = invitations.filter((i) => !i.claimed_at)
  const activeCodes = codes.filter((c) => c.status === 'active').length
  // Somebody already turned down is not still waiting at the door.
  const waitingCount = waitlist.filter((w) => !w.declined_at).length

  const tabs: Tab[] = [
    { id: 'connectors', label: 'Connectors', count: connectors.length },
    { id: 'members', label: 'Members', count: members.length },
    { id: 'notes', label: 'Notes', count: notes.length },
    { id: 'waitlist', label: 'Waitlist', count: waitingCount },
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
            <StatTile label="Waitlist" value={waitingCount} />
          </div>

          <div className="mt-12">
            {tab === 'connectors' && (
              <ConnectorsTab
                connectors={connectors}
                pendingInvitations={pendingInvitations}
                invitedCount={invitedCount}
                links={links}
                profilesById={profilesById}
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
                tags={profileTags}
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
  links,
  profilesById,
  onChanged,
}: {
  connectors: ConnectorRow[]
  pendingInvitations: ConnectorInvitation[]
  invitedCount: Record<string, number>
  links: LinkRow[]
  profilesById: Record<string, Profile>
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [connectorToDelete, setConnectorToDelete] = useState<ConnectorRow | null>(null)
  // Nothing is written until this is confirmed, so the select keeps showing
  // what is actually stored.
  const [pending, setPending] = useState<{
    connector: ConnectorRow
    status: ConnectorStatus
  } | null>(null)
  const [busy, setBusy] = useState(false)

  async function applyStatus() {
    if (!pending) return
    setError('')
    setBusy(true)
    const { error: updateError } = await supabase
      .from('connectors')
      .update({ invite_status: pending.status })
      .eq('id', pending.connector.id)
    setBusy(false)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    setPending(null)
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
                  {connector.profiles?.email ?? 'No email'}
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
                  onChange={(e) =>
                    setPending({
                      connector,
                      status: e.target.value as ConnectorStatus,
                    })
                  }
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

      <ConfirmModal
        open={Boolean(pending)}
        title={
          pending
            ? `Set ${pending.connector.profiles?.full_name ?? 'this connector'} to ${pending.status}?`
            : ''
        }
        body={pending ? CONNECTOR_STATUS_EFFECT[pending.status] : ''}
        confirmLabel={pending ? `Set to ${pending.status}` : 'Confirm'}
        tone={pending?.status === 'active' ? 'primary' : 'danger'}
        busy={busy}
        onConfirm={() => void applyStatus()}
        onClose={() => setPending(null)}
      />

      <CreateConnectorModal open={open} onClose={() => setOpen(false)} onCreated={onChanged} />
      {connectorToDelete && (
        <RemoveConnectorModal
          connector={connectorToDelete}
          connectors={connectors}
          members={links
            .filter((l) => l.connector_id === connectorToDelete.id)
            .map((l) => profilesById[l.user_profile_id])
            .filter(Boolean)}
          onClose={() => setConnectorToDelete(null)}
          onChanged={onChanged}
        />
      )}
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
  // Same rule as the connector list: the select shows what is stored, and the
  // write happens only once the dialog is confirmed.
  const [pending, setPending] = useState<{
    member: Profile
    status: ProfileStatus
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const filtered = members.filter((m) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      m.full_name.toLowerCase().includes(q) ||
      (m.email ?? '').toLowerCase().includes(q) ||
      (m.current_profession ?? '').toLowerCase().includes(q)
    )
  })

  async function applyStatus() {
    if (!pending) return
    setError('')
    setBusy(true)
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ profile_status: pending.status })
      .eq('id', pending.member.id)
    setBusy(false)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    setPending(null)
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
                <div className="truncate">via {connectorByMember[member.id] ?? 'an unknown connector'}</div>
                <div className="text-dim">{formatDate(member.created_at)}</div>
              </div>
              <div className="w-36 shrink-0">
                <Select
                  value={member.profile_status}
                  onChange={(e) =>
                    setPending({ member, status: e.target.value as ProfileStatus })
                  }
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

      <ConfirmModal
        open={Boolean(pending)}
        title={pending ? `Set ${pending.member.full_name} to ${pending.status}?` : ''}
        body={pending ? PROFILE_STATUS_EFFECT[pending.status] : ''}
        confirmLabel={pending ? `Set to ${pending.status}` : 'Confirm'}
        tone={pending?.status === 'active' ? 'primary' : 'danger'}
        busy={busy}
        onConfirm={() => void applyStatus()}
        onClose={() => setPending(null)}
      />

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
  tags,
  onChanged,
}: {
  entries: WaitlistEntry[]
  connectors: ConnectorRow[]
  codesById: Record<string, InviteCode>
  tags: ProfileTag[]
  onChanged: () => Promise<void>
}) {
  const [assigning, setAssigning] = useState<WaitlistEntry | null>(null)
  const [viewing, setViewing] = useState<WaitlistEntry | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [declineError, setDeclineError] = useState('')
  const [deleting, setDeleting] = useState<WaitlistEntry | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const waiting = entries.filter((e) => !e.declined_at)
  const declined = entries.filter((e) => e.declined_at)

  async function removeEntry() {
    if (!deleting) return
    setDeleteError('')
    setDeleteBusy(true)
    const { error: rpcError } = await supabase.rpc('delete_waitlist_entry', {
      p_entry_id: deleting.id,
    })
    setDeleteBusy(false)
    if (rpcError) {
      setDeleteError(errorMessage(rpcError))
      return
    }
    setDeleting(null)
    await onChanged()
  }

  async function setDeclined(entry: WaitlistEntry, declined_: boolean) {
    setDeclineError('')
    setDecliningId(entry.id)
    const { error: rpcError } = await supabase.rpc('set_waitlist_declined', {
      p_entry_id: entry.id,
      p_declined: declined_,
    })
    setDecliningId(null)
    if (rpcError) {
      setDeclineError(errorMessage(rpcError))
      return
    }
    await onChanged()
  }

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

      {declineError && (
        <div className="mb-6">
          <Notice tone="error">{declineError}</Notice>
        </div>
      )}

      {waiting.length === 0 ? (
        <EmptyState>Nobody on the waitlist yet.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {waiting.map((entry) => {
            const code = entry.assigned_code_id ? codesById[entry.assigned_code_id] : undefined
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setViewing(entry)}
                    className="block max-w-full truncate text-left text-sm font-medium text-fg underline-offset-4 hover:underline"
                  >
                    {entry.full_name}
                  </button>
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
                    <>
                      <Button
                        size="sm"
                        loading={decliningId === entry.id}
                        onClick={() => void setDeclined(entry, true)}
                      >
                        Decline
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setDeleting(entry)}>
                        Delete
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => setAssigning(entry)}>
                        Assign
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </Panel>
      )}

      {declined.length > 0 && (
        <div className="mt-12">
          <SectionHeader
            title="Declined"
            caption="Turned down, and kept so the decision is not made twice. Their answers are still here."
          />
          <Panel className="divide-y divide-line">
            {declined.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setViewing(entry)}
                    className="block max-w-full truncate text-left text-sm text-muted underline-offset-4 hover:underline"
                  >
                    {entry.full_name}
                  </button>
                  <div className="truncate text-xs text-dim">{entry.email}</div>
                </div>
                <div className="flex items-center gap-5 text-xs">
                  <span className="text-dim">declined {formatDate(entry.declined_at ?? '')}</span>
                  <Button
                    size="sm"
                    loading={decliningId === entry.id}
                    onClick={() => void setDeclined(entry, false)}
                  >
                    Undo
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDeleting(entry)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </Panel>
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleting)}
        title={deleting ? `Delete ${deleting.full_name}'s application?` : ''}
        body={
          deleting?.assigned_at
            ? 'This removes the application and everything they answered. The invitation code they were already given still works — withdraw it from the connector if that is not what you want.'
            : 'This removes the application and everything they answered. Declining keeps the row and the record of the decision; this does not.'
        }
        confirmLabel="Delete application"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void removeEntry()}
        onClose={() => {
          setDeleting(null)
          setDeleteError('')
        }}
      />

      {viewing && (
        <WaitlistEntryModal
          key={viewing.id}
          entry={viewing}
          tags={tags}
          onClose={() => setViewing(null)}
        />
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

/**
 * Removing a connector, without removing the people they brought in.
 *
 * Deleting a connector used to delete every member beneath them. Members
 * belong to the network rather than to whoever happened to invite them, so
 * they are moved somewhere first and the connector is only deletable once
 * nobody is left under them. The database refuses the old behaviour outright;
 * this screen is how an admin satisfies it.
 */
function RemoveConnectorModal({
  connector,
  connectors,
  members,
  onClose,
  onChanged,
}: {
  connector: ConnectorRow
  connectors: ConnectorRow[]
  members: Profile[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const destinations = connectors.filter(
    (c) => c.id !== connector.id && c.invite_status === 'active' && c.profiles,
  )

  const [selected, setSelected] = useState<string[]>(() => members.map((m) => m.id))
  const [destination, setDestination] = useState(destinations[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const name = connector.profiles?.full_name ?? 'this connector'
  const allSelected = selected.length === members.length && members.length > 0

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  }

  async function move() {
    setError('')
    if (!destination) return setError('Choose a connector to move them to.')
    if (selected.length === 0) return setError('Choose at least one member to move.')

    setBusy(true)
    const { error: rpcError } = await supabase.rpc('reassign_connector_members', {
      p_from_connector: connector.id,
      p_to_connector: destination,
      p_profile_ids: selected,
    })
    setBusy(false)
    if (rpcError) return setError(errorMessage(rpcError))

    setSelected([])
    await onChanged()
  }

  async function remove() {
    setError('')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('delete_managed_profile', {
      p_profile_id: connector.profile_id,
    })
    setBusy(false)
    if (rpcError) return setError(errorMessage(rpcError))

    await onChanged()
    onClose()
  }

  return (
    <Modal open title={`Remove ${name}?`} onClose={busy ? () => {} : onClose}>
      {members.length > 0 ? (
        <>
          <p className="text-sm leading-relaxed text-muted">
            {members.length} member{members.length === 1 ? '' : 's'} joined on{' '}
            {name}&apos;s invitations. Move them to another connector before removing
            the account — their profiles, posts and circle stay with them.
          </p>

          {destinations.length === 0 ? (
            <div className="mt-5">
              <Notice tone="error">
                There is no other active connector to move them to. Create one, or set an
                existing connector back to active, first.
              </Notice>
            </div>
          ) : (
            <>
              <div className="mt-6 flex items-center justify-between">
                <p className="eyebrow">Who moves</p>
                <button
                  type="button"
                  onClick={() =>
                    setSelected(allSelected ? [] : members.map((m) => m.id))
                  }
                  className="text-xs text-gold underline-offset-4 hover:underline"
                >
                  {allSelected ? 'Clear all' : 'Select all'}
                </button>
              </div>

              <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                {members.map((member) => (
                  <li key={member.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-sm px-1 py-1.5 text-sm hover:bg-gold-wash">
                      <input
                        type="checkbox"
                        checked={selected.includes(member.id)}
                        onChange={() => toggle(member.id)}
                        className="size-4 accent-gold"
                      />
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {member.full_name}
                      </span>
                      <span className="truncate text-xs text-dim">{member.email}</span>
                    </label>
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                <Field label="Move them to">
                  <Select
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    {destinations.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.profiles?.full_name ?? 'Unknown'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="mt-2 text-xs text-dim">
                  Members count against that connector&apos;s capacity, so the move is
                  refused if there is not room for all of them.
                </p>
              </div>
            </>
          )}

          {error && (
            <div className="mt-5">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <div className="mt-8 flex flex-wrap justify-between gap-3">
            <Button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={destinations.length === 0}
              onClick={() => void move()}
            >
              Move {selected.length || ''} {selected.length === 1 ? 'member' : 'members'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-muted">
            Nobody is under {name} any more. Removing them deletes the connector account
            and its invitation codes. No member profile is touched.
          </p>
          <p className="mt-3 text-sm font-medium text-negative">This cannot be undone.</p>

          {error && (
            <div className="mt-5">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <div className="mt-8 flex flex-wrap justify-between gap-3">
            <Button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              Delete connector
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

/**
 * Everything one applicant wrote on the way in.
 *
 * The row already held all of it. The list showed a name and an email, so the
 * decision to let somebody in was made without reading what they said.
 */
function WaitlistEntryModal({
  entry,
  tags,
  onClose,
}: {
  entry: WaitlistEntry
  tags: ProfileTag[]
  onClose: () => void
}) {
  const labelById = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.label])) as Record<string, string>,
    [tags],
  )

  // A custom tag is stored as its label, so it needs no lookup. An id with no
  // label is shown as itself rather than dropped: better an ugly row than a
  // silently missing answer.
  const chipsOf = (answer: TagAnswer | null) => [
    ...(answer?.selected_tag_ids ?? []).map((id) => labelById[id] ?? id),
    ...(answer?.custom_tags ?? []),
  ]

  const answers = INITIAL_ORDER.map((field) => {
    const tagQuestion = TAG_QUESTIONS.find((q) => q.field === field)
    if (tagQuestion) {
      return {
        field,
        prompt: tagQuestion.prompt,
        chips: chipsOf(entry[tagQuestion.field]),
        text: tagQuestion.detailsField ? entry[tagQuestion.detailsField] : null,
      }
    }
    const textQuestion = TEXT_QUESTIONS.find((q) => q.field === field)
    return {
      field,
      prompt: textQuestion?.prompt ?? field,
      chips: [] as string[],
      text: textQuestion ? entry[textQuestion.field] : null,
    }
  }).filter((row) => row.chips.length > 0 || row.text)

  const travel = TRAVEL_OPTIONS.find((o) => o.id === entry.travel_preference)?.label

  return (
    <Modal open title={entry.full_name} onClose={onClose}>
      <div className="space-y-6">
        <div className="space-y-1 text-sm">
          <div className="text-muted">{entry.email}</div>
          {entry.linkedin_url && (
            <a
              href={entry.linkedin_url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-block text-xs text-gold underline-offset-4 hover:underline"
            >
              {entry.linkedin_url}
            </a>
          )}
          <div className="text-xs text-dim">Applied {formatDate(entry.created_at)}</div>
        </div>

        {(entry.home_city || travel) && (
          <div className="space-y-1">
            <p className="eyebrow">Where they are</p>
            <p className="text-sm text-fg">{entry.home_city ?? 'Not given'}</p>
            {travel && <p className="text-xs text-dim">Will travel: {travel}</p>}
          </div>
        )}

        {answers.length === 0 ? (
          <p className="text-sm leading-relaxed text-dim">
            They answered nothing past their name and email. Everything after that is
            optional, so this is a complete application.
          </p>
        ) : (
          answers.map((row) => (
            <div key={row.field} className="space-y-2">
              <p className="eyebrow">{row.prompt}</p>
              {row.chips.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {row.chips.map((label) => (
                    <li
                      key={label}
                      className="rounded-sm border border-line px-2.5 py-1 text-xs text-fg"
                    >
                      {label}
                    </li>
                  ))}
                </ul>
              )}
              {row.text && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">
                  {row.text}
                </p>
              )}
            </div>
          ))
        )}
      </div>

      <Button variant="primary" className="mt-8 w-full" onClick={onClose}>
        Close
      </Button>
    </Modal>
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
                                {member.current_profession ?? 'No profession listed'}
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
