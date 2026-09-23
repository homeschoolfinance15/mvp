import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Button,
  ConfirmModal,
  CopyCode,
  EmptyState,
  Field,
  formatDate,
  Modal,
  Notice,
  Panel,
  SectionHeader,
  Select,
  Spinner,
} from '../../components/ui'
import { useLive } from '../../lib/live'
import { errorMessage, supabase } from '../../lib/supabase'
import type { InviteCode, ProfileTag, TagAnswer, WaitlistEntry } from '../../lib/types'
import {
  INITIAL_ORDER,
  TAG_QUESTIONS,
  TEXT_QUESTIONS,
  TRAVEL_OPTIONS,
} from '../../lib/questionnaire'
import { loadConnectors, type ConnectorRow } from './shared'

export default function Waitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [codesById, setCodesById] = useState<Record<string, InviteCode>>({})
  // Labels for the chips a waitlist applicant picked, so the detail view can
  // show "Starting a business" rather than current_focus.starting_a_business.
  const [tags, setTags] = useState<ProfileTag[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [assigning, setAssigning] = useState<WaitlistEntry | null>(null)
  const [viewing, setViewing] = useState<WaitlistEntry | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [declineError, setDeclineError] = useState('')
  const [deleting, setDeleting] = useState<WaitlistEntry | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    const [waitlistRes, connectorsRes, codesRes, tagsRes] = await Promise.all([
      supabase.from('waitlist_entries').select('*').order('created_at', { ascending: false }),
      loadConnectors(),
      supabase.from('invite_codes').select('*'),
      supabase.from('profile_tags').select('*').order('field').order('position'),
    ])

    const firstError = [
      waitlistRes.error,
      connectorsRes.error,
      codesRes.error,
      tagsRes.error,
    ].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setEntries((waitlistRes.data as WaitlistEntry[]) ?? [])
    setConnectors((connectorsRes.data as unknown as ConnectorRow[]) ?? [])
    setCodesById(
      Object.fromEntries(((codesRes.data as InviteCode[]) ?? []).map((c) => [c.id, c])),
    )
    setTags((tagsRes.data as ProfileTag[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * New applications land on this page as they are made, and an entry
   * assigned or declined in another tab stops sitting here looking untouched.
   * `invite_codes` is watched too, because whether a code has been spent is
   * half of what each row says.
   *
   * Off while any of the three dialogs is open. The assign dialog is the one
   * that matters: it holds a freshly minted invite code shown once and stored
   * nowhere the administrator can go back to, so a reload underneath it would
   * destroy the only copy. The view and delete dialogs hold the entry their
   * decision is about.
   */
  useLive(['waitlist_entries', 'invite_codes', 'connectors'], () => void load(), {
    enabled: !assigning && !viewing && !deleting && !decliningId && !deleteBusy,
  })

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
    await load()
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
    await load()
  }

  const connectorNameById = useMemo(
    () =>
      Object.fromEntries(
        connectors.map((c) => [c.id, c.profiles?.full_name ?? 'Unknown']),
      ) as Record<string, string>,
    [connectors],
  )

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

      <p className="mb-4 text-sm text-muted">Review each person, then assign them to a connector.</p>

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
          <SectionHeader title="Declined" />
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
          onAssigned={load}
        />
      )}
    </>
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
            No answers beyond name and email.
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
            This uses one of that connector's invitation places. {firstName} joins as their
            member once they redeem the code.
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
