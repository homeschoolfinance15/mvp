import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthProvider'
import { signMedia } from '../lib/media'
import { errorMessage, supabase } from '../lib/supabase'
import {
  REPORT_KINDS,
  REPORTABLE_FIELDS,
  type DirectoryEntry,
  type ReportKind,
} from '../lib/types'
import { Button, Field, Initials, Modal, Notice, Select, Textarea } from './ui'

/**
 * Who somebody is, as the network sees them — and the way to say it looks
 * wrong.
 *
 * Everything shown here comes from member_directory: name, profession,
 * interests. No email, because a member holding another member's email is
 * exactly what the directory view exists to prevent. Raising a correction is
 * the sanctioned way to reach someone you don't have contact details for:
 * it goes to the connector who brought them in, and they make the call.
 */
export function MemberCard({
  member,
  onClose,
}: {
  member: DirectoryEntry
  onClose: () => void
}) {
  const { profile } = useAuth()
  const [raising, setRaising] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!member.avatar_path) return
    let live = true
    void signMedia([member.avatar_path])
      .then((urls) => { if (live) setAvatarUrl(urls[member.avatar_path!] ?? null) })
      .catch(() => {})
    return () => { live = false }
  }, [member.avatar_path])

  const isSelf = member.id === profile?.id

  return (
    <Modal open title={member.full_name} onClose={onClose}>
      {raising ? (
        <RaiseReport member={member} onClose={onClose} onBack={() => setRaising(false)} />
      ) : (
        <div>
          <div className="flex items-center gap-4">
            <Initials
              name={member.full_name}
              url={avatarUrl ?? undefined}
              role={member.role}
              size="lg"
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">{member.full_name}</div>
              <div className="truncate text-xs text-dim">
                {ROLE_WORD[member.role] ?? 'Member'}
                {member.current_profession ? ` · ${member.current_profession}` : ''}
              </div>
            </div>
          </div>

          {member.interests.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2">
              {member.interests.map((tag) => (
                <li
                  key={tag}
                  className="rounded-sm border border-line px-2.5 py-1 text-xs text-muted"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-7 flex gap-3">
            <Button className="flex-1" onClick={onClose}>
              Close
            </Button>
            {!isSelf && (
              <Button variant="primary" className="flex-1" onClick={() => setRaising(true)}>
                Raise something
              </Button>
            )}
          </div>

          {isSelf && (
            <p className="mt-4 text-center text-xs text-dim">
              This is how the network sees you. Edit it from your profile.
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Spelled out, so the ring on the picture never has to be guessed at. */
const ROLE_WORD: Record<string, string> = {
  admin: 'Administrator',
  connector: 'Connector',
  user: 'Member',
}

const KIND_HINT: Record<ReportKind, string> = {
  correction: "Something in their profile doesn't match what you know.",
  concern: 'Something about their conduct the connector should know.',
  endorsement: "Something good. You've worked with them, or you vouch for them.",
}

function RaiseReport({
  member,
  onClose,
  onBack,
}: {
  member: DirectoryEntry
  onClose: () => void
  onBack: () => void
}) {
  const { profile } = useAuth()

  const [kind, setKind] = useState<ReportKind>('correction')
  const [field, setField] = useState('current_profession')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile || !body.trim()) return
    setError('')
    setBusy(true)

    const { error: insertError } = await supabase.from('profile_reports').insert({
      subject_id: member.id,
      reporter_id: profile.id,
      kind,
      field: kind === 'correction' ? field : null,
      body: body.trim(),
    })

    setBusy(false)
    if (insertError) {
      // The partial unique index is the likely cause, and its raw text is
      // not something to show a person.
      setError(
        insertError.code === '23505'
          ? "You've already raised something about this person that hasn't been dealt with yet."
          : errorMessage(insertError),
      )
      return
    }
    setDone(true)
  }

  if (done) {
    return (
      <div className="text-center">
        <p className="eyebrow">Raised</p>
        <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-muted">
          This went to the connector who brought {member.full_name.split(' ')[0]} into the
          network. They'll reach out. {member.full_name.split(' ')[0]} isn't told who raised it.
        </p>
        <Button variant="primary" className="mt-7 w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="What kind">
        <Select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
          {REPORT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
      </Field>

      <p className="-mt-2 text-xs leading-relaxed text-dim">{KIND_HINT[kind]}</p>

      {kind === 'correction' && (
        <Field label="Which part">
          <Select value={field} onChange={(e) => setField(e.target.value)}>
            {REPORTABLE_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="What you know">
        <Textarea
          required
          rows={5}
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Met them at the founders dinner. They mentioned they'd moved out of engineering last year."
        />
      </Field>

      {error && <Notice tone="error">{error}</Notice>}

      <p className="text-xs leading-relaxed text-dim">
        This goes to {member.full_name.split(' ')[0]}'s connector and to administrators, not
        to {member.full_name.split(' ')[0]}. Your name is attached, so whoever acts on it can
        weigh the source.
      </p>

      <div className="flex gap-3">
        <Button type="button" className="flex-1" onClick={onBack}>
          Back
        </Button>
        <Button
          type="submit"
          variant="primary"
          className="flex-1"
          loading={busy}
          disabled={!body.trim()}
        >
          Raise it
        </Button>
      </div>
    </form>
  )
}
