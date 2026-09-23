import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { SendInvite } from '../../components/SendInvite'
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
} from '../../components/ui'
import { useLive } from '../../lib/live'
import { errorMessage, supabase } from '../../lib/supabase'
import {
  CONNECTOR_STATUSES,
  type ConnectorInvitation,
  type ConnectorStatus,
  type Profile,
} from '../../lib/types'
import {
  DeleteScopeChoice,
  removeMediaOf,
  scopeConfirmed,
  type DeleteScope,
} from '../../components/DeleteScopeChoice'
import { ConnectorEventPermission } from './ConnectorEventPermission'
import { byId, loadConnectors, loadLinks, loadProfiles, type ConnectorRow, type LinkRow } from './shared'

/**
 * What each status actually does, rather than what it is called.
 *
 * Worth knowing before writing these: every gate in the schema asks
 * `invite_status <> 'active'`, so limited, paused and removed are the same
 * behaviour under three names. The copy says so instead of implying a
 * gradient the database does not have. That includes redeem_code and
 * lookup_code: a code already handed out is refused while the connector is
 * anything but active (ADM-5, ACC-15).
 */
const CONNECTOR_STATUS_EFFECT: Record<ConnectorStatus, string> = {
  active:
    'They can mint invitation codes again, can be handed people from the waitlist, and codes they already handed out work again.',
  limited:
    'They stop being able to bring anyone new in, and codes they already handed out stop working until they are set back to active. Their existing members are unaffected. Identical to paused and removed in what it permits.',
  paused:
    'They stop being able to bring anyone new in, and codes they already handed out stop working until they are set back to active. Their existing members are unaffected. Identical to limited and removed in what it permits.',
  removed:
    'They stop being able to bring anyone new in, and codes they already handed out stop working. Nothing is deleted: their account and their members are untouched. Identical to limited and paused in what it permits.',
}

/** The row as stored since 20260923000201: claim codes lapse and can be revoked. */
type Invitation = ConnectorInvitation & { expires_at: string; revoked_at: string | null }

export default function Connectors() {
  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [profilesById, setProfilesById] = useState<Record<string, Profile>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [connectorToDelete, setConnectorToDelete] = useState<ConnectorRow | null>(null)
  const [capacityFor, setCapacityFor] = useState<ConnectorRow | null>(null)
  const [invitationToRevoke, setInvitationToRevoke] = useState<Invitation | null>(null)
  // Nothing is written until this is confirmed, so the select keeps showing
  // what is actually stored.
  const [pending, setPending] = useState<{
    connector: ConnectorRow
    status: ConnectorStatus
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoadError('')
    const [connectorsRes, invitationsRes, linksRes, profilesRes] = await Promise.all([
      loadConnectors(),
      supabase
        .from('connector_invitations')
        .select('*')
        .order('created_at', { ascending: false }),
      loadLinks(),
      loadProfiles(),
    ])

    const firstError = [
      connectorsRes.error,
      invitationsRes.error,
      linksRes.error,
      profilesRes.error,
    ].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setConnectors((connectorsRes.data as unknown as ConnectorRow[]) ?? [])
    setInvitations((invitationsRes.data as Invitation[]) ?? [])
    setLinks((linksRes.data as unknown as LinkRow[]) ?? [])
    setProfilesById(byId((profilesRes.data as Profile[]) ?? []))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * The connector list stops being a photograph. Somebody accepting an
   * invitation, a member joining a community — all of it
   * shows up here without a refresh, and the sidebar count beside it agrees.
   *
   * Off while anything is open. The add form holds a name, an email and a
   * capacity that are nowhere else yet; the delete dialog and the status
   * confirmation both hold a row that the confirmation is about, and deciding
   * about a row that was swapped underneath the dialog is exactly the kind of
   * thing a confirmation exists to prevent.
   */
  useLive(['connectors', 'connector_user_links', 'profiles'], () => void load(), {
    enabled: !open && !connectorToDelete && !capacityFor && !invitationToRevoke && !pending && !busy,
  })

  const invitedCount = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const link of links) {
      counts[link.connector_id] = (counts[link.connector_id] ?? 0) + 1
    }
    return counts
  }, [links])

  // Only the newest invitation per email (the list is newest first): an older
  // lapsed code beside its replacement is noise. Revoked ones are finished
  // with; lapsed ones stay listed so they can be re-issued.
  const pendingInvitations = invitations.filter(
    (i, index) =>
      !i.claimed_at &&
      !i.revoked_at &&
      invitations.findIndex((other) => other.email === i.email) === index,
  )
  const isExpired = (invitation: Invitation) => new Date(invitation.expires_at) <= new Date()

  async function revokeInvitation() {
    if (!invitationToRevoke) return
    setError('')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('revoke_connector_invitation', {
      p_invitation_id: invitationToRevoke.id,
    })
    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    setInvitationToRevoke(null)
    await load()
  }

  // Re-issuing is creating again: a new code and a fresh 30 days. The
  // database refuses it while another invitation for the email is still live.
  async function reissue(invitation: Invitation) {
    setError('')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('create_connector_invitation', {
      p_full_name: invitation.full_name,
      p_email: invitation.email,
      p_capacity: invitation.invite_capacity,
    })
    setBusy(false)
    if (rpcError) {
      setError(errorMessage(rpcError))
      return
    }
    await load()
  }

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
    await load()
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-dim">
        <Spinner />
      </div>
    )
  }

  return (
    <>
      {loadError && (
        <div className="mb-8">
          <Notice tone="error">{loadError}</Notice>
        </div>
      )}

      <div className="mb-4 flex justify-end">
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
          Create connector
        </Button>
      </div>

      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {connectors.length === 0 ? (
        <EmptyState>No connectors yet. Create the first one.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {connectors.map((connector) => (
            <div key={connector.id}>
              <div className="flex flex-wrap items-center gap-4 px-5 py-4 sm:flex-nowrap">
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
              <button
                type="button"
                onClick={() => setCapacityFor(connector)}
                title="Change capacity"
                className="text-right text-xs whitespace-nowrap text-muted tabular-nums underline-offset-4 hover:text-fg hover:underline"
              >
                {invitedCount[connector.id] ?? 0} of {connector.invite_capacity} invited
              </button>
              <div className="w-32 shrink-0">
                <Select
                  aria-label={`Invitation status for ${connector.profiles?.full_name ?? 'this connector'}`}
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

              {/*
                ORG-01A and §7.3. The two gates on the same thing — may they
                put an event on at all, and can their Stripe account take
                money for it — sit together under the connector they belong
                to, so neither is somewhere else.
              */}
              <ConnectorEventPermission
                connector={connector}
                changedByName={
                  profilesById[connector.events_permission_changed_by ?? '']?.full_name ?? null
                }
                onChanged={load}
              />
            </div>
          ))}
        </Panel>
      )}

      {pendingInvitations.length > 0 && (
        <div className="mt-10">
          <SectionHeader title="Awaiting claim" />
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
                    {formatDate(invitation.created_at)} ·{' '}
                    {isExpired(invitation) ? (
                      <span className="text-negative">
                        expired {formatDate(invitation.expires_at)}
                      </span>
                    ) : (
                      <>expires {formatDate(invitation.expires_at)}</>
                    )}
                  </div>
                </div>
                {isExpired(invitation) ? (
                  <Button size="sm" loading={busy} onClick={() => void reissue(invitation)}>
                    Re-issue code
                  </Button>
                ) : (
                  <div className="flex flex-col items-end gap-2">
                    <CopyCode code={invitation.claim_code} size="sm" />
                    <div className="w-64">
                      <SendInvite code={invitation.claim_code} defaultEmail={invitation.email} />
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setInvitationToRevoke(invitation)}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
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

      <ConfirmModal
        open={Boolean(invitationToRevoke)}
        title={invitationToRevoke ? `Revoke ${invitationToRevoke.full_name}'s claim code?` : ''}
        body="The code stops working straight away; anyone who tries it is told it was withdrawn. You can create a new invitation for the same email afterwards."
        confirmLabel="Revoke code"
        tone="danger"
        busy={busy}
        onConfirm={() => void revokeInvitation()}
        onClose={() => setInvitationToRevoke(null)}
      />

      {capacityFor && (
        <CapacityModal
          connector={capacityFor}
          joined={invitedCount[capacityFor.id] ?? 0}
          onClose={() => setCapacityFor(null)}
          onChanged={load}
        />
      )}

      <CreateConnectorModal open={open} onClose={() => setOpen(false)} onCreated={load} />
      {connectorToDelete && (
        <RemoveConnectorModal
          connector={connectorToDelete}
          connectors={connectors}
          members={links
            .filter((l) => l.connector_id === connectorToDelete.id)
            .map((l) => profilesById[l.user_profile_id])
            .filter(Boolean)}
          onClose={() => setConnectorToDelete(null)}
          onChanged={load}
        />
      )}
    </>
  )
}

/**
 * ADM-11. The modal is the confirmation: it shows the current figure and the
 * new one, and nothing is written until the button. The floor is the
 * database's (set_connector_capacity); the min here only saves a round trip.
 */
function CapacityModal({
  connector,
  joined,
  onClose,
  onChanged,
}: {
  connector: ConnectorRow
  joined: number
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [capacity, setCapacity] = useState(connector.invite_capacity)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = connector.profiles?.full_name ?? 'this connector'

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('set_connector_capacity', {
      p_connector_id: connector.id,
      p_capacity: capacity,
    })
    setBusy(false)
    if (rpcError) return setError(errorMessage(rpcError))
    await onChanged()
    onClose()
  }

  return (
    <Modal open title={`Change ${name}'s capacity?`} onClose={busy ? () => {} : onClose}>
      <form onSubmit={save} className="space-y-5">
        <p className="text-sm leading-relaxed text-muted">
          {joined} of {connector.invite_capacity} places are used. Capacity cannot go below the
          number of people who have already joined.
        </p>
        <Field label="Invitation capacity" hint="How many people they may bring in.">
          <Input
            type="number"
            required
            min={Math.max(joined, 1)}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </Field>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex flex-wrap justify-between gap-3">
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={capacity === connector.invite_capacity}
          >
            Set capacity to {capacity}
          </Button>
        </div>
      </form>
    </Modal>
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
            claim their connector account and set a password. It works for 30 days.
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
  const [scope, setScope] = useState<DeleteScope>('account')
  const [typed, setTyped] = useState('')
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
    if (scope === 'everything') await removeMediaOf(connector.profile_id)
    const { error: rpcError } = await supabase.rpc('delete_managed_profile', {
      p_profile_id: connector.profile_id,
      p_scope: scope,
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
          <div className="mt-5">
            <DeleteScopeChoice
              value={scope}
              onChange={(nextScope, nextTyped) => {
                setScope(nextScope)
                setTyped(nextTyped)
              }}
              subjectName={name}
              self={false}
            />
          </div>
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
            <Button
              variant="danger"
              loading={busy}
              disabled={!scopeConfirmed(scope, typed)}
              onClick={() => void remove()}
            >
              Delete connector
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
