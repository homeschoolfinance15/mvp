import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeleteProfileModal } from '../../components/DeleteProfileModal'
import {
  Button,
  ConfirmModal,
  EmptyState,
  formatDate,
  Initials,
  Input,
  Notice,
  Panel,
  SectionHeader,
  Select,
  Spinner,
} from '../../components/ui'
import { useLive } from '../../lib/live'
import { errorMessage, supabase } from '../../lib/supabase'
import { PROFILE_STATUSES, type Profile, type ProfileStatus } from '../../lib/types'
import { loadLinks, type LinkRow } from './shared'

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

export default function Members() {
  const [members, setMembers] = useState<Profile[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

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

  const load = useCallback(async () => {
    setLoadError('')
    const [profilesRes, linksRes] = await Promise.all([
      // `role = 'user'` asked of the database rather than filtered in the
      // browser: the whole directory used to be fetched so that six other
      // tabs could share it, and none of them is on this page any more.
      supabase
        .from('profiles')
        .select('*')
        .eq('role', 'user')
        .order('created_at', { ascending: false }),
      loadLinks(),
    ])

    const firstError = [profilesRes.error, linksRes.error].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setMembers((profilesRes.data as Profile[]) ?? [])
    setLinks((linksRes.data as unknown as LinkRow[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * Members arrive by being let in off the waitlist, and their status changes
   * from other screens. Neither used to show here until the page was
   * reloaded. `query` is a filter over what is already loaded and no reload
   * writes it, so searching is undisturbed.
   *
   * Off while a deletion or a status change is waiting to be confirmed: the
   * dialog is about one specific person, and the row behind it must not move
   * while the administrator is reading it.
   */
  useLive(['profiles', 'connector_user_links'], () => void load(), {
    enabled: !memberToDelete && !pending && !busy,
  })

  const connectorByMember = useMemo(() => {
    const map: Record<string, string> = {}
    for (const link of links) {
      map[link.user_profile_id] = link.connectors?.profiles?.full_name ?? 'an unknown connector'
    }
    return map
  }, [links])

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

      <SectionHeader
        title="Members"
        caption="Everyone who joined on a connector's invitation."
        action={
          <div className="w-56">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              aria-label="Search members by name"
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
                  aria-label={`Membership status for ${member.full_name}`}
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
        onDeleted={load}
      />
    </>
  )
}
