import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { DashboardShell } from '../../components/DashboardShell'
import {
  Button,
  CopyCode,
  EmptyState,
  Field,
  formatDate,
  Initials,
  Input,
  Notice,
  Panel,
  SectionHeader,
  Spinner,
  StatusBadge,
  Textarea,
} from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthProvider'

interface Membership {
  created_at: string
  invite_codes: { code: string } | null
  connectors: {
    id: string
    invite_status: string
    profiles: {
      full_name: string
      current_profession: string | null
      semantic_summary: string | null
    } | null
  } | null
}

export default function UserDashboard() {
  const { profile, refreshProfile } = useAuth()
  const [membership, setMembership] = useState<Membership | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile) return
    const { data, error } = await supabase
      .from('connector_user_links')
      .select(
        'created_at, invite_codes(code), connectors(id, invite_status, profiles(full_name, current_profession, semantic_summary))',
      )
      .eq('user_profile_id', profile.id)
      .maybeSingle()

    if (error) console.error('Failed to load membership', error)
    setMembership((data as unknown as Membership) ?? null)
    setLoading(false)
  }, [profile])

  useEffect(() => {
    void load()
  }, [load])

  const connectorProfile = membership?.connectors?.profiles ?? null

  return (
    <DashboardShell
      title={`Hello, ${profile?.full_name.split(' ')[0] ?? ''}`}
      caption="Your place in the network — who brought you in, and how you're described to others."
    >
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[1.15fr_1fr]">
          <div className="space-y-10">
            {/* Who invited you --------------------------------------------- */}
            <section>
              <SectionHeader title="Invited by" />
              {connectorProfile ? (
                <Panel className="px-6 py-6">
                  <div className="flex items-start gap-4">
                    <Initials name={connectorProfile.full_name} />
                    <div className="min-w-0 flex-1">
                      <div className="text-base font-medium tracking-tight text-fg">
                        {connectorProfile.full_name}
                      </div>
                      {connectorProfile.current_profession && (
                        <div className="mt-0.5 text-sm text-muted">
                          {connectorProfile.current_profession}
                        </div>
                      )}
                      {connectorProfile.semantic_summary && (
                        <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-muted">
                          {connectorProfile.semantic_summary}
                        </p>
                      )}
                    </div>
                  </div>
                </Panel>
              ) : (
                <EmptyState>
                  We couldn't find the connector who invited you.
                </EmptyState>
              )}
            </section>

            {/* Your profile ------------------------------------------------ */}
            <ProfileEditor onSaved={refreshProfile} />
          </div>

          {/* Membership sidebar --------------------------------------------- */}
          <aside className="space-y-6">
            <Panel className="px-6 py-6">
              <div className="eyebrow">Your invitation code</div>
              {membership?.invite_codes?.code ? (
                <>
                  <div className="mt-4">
                    <CopyCode code={membership.invite_codes.code} size="lg" />
                  </div>
                  <p className="mt-4 text-xs leading-relaxed text-dim">
                    This is the code you joined with. Invitations are issued by connectors, so
                    it isn't yours to pass on.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-dim">No code recorded.</p>
              )}
            </Panel>

            <Panel className="divide-y divide-line">
              <Row label="Membership">
                <StatusBadge status={profile?.profile_status ?? 'active'} />
              </Row>
              <Row label="Joined">
                <span className="text-sm text-muted">
                  {membership ? formatDate(membership.created_at) : '—'}
                </span>
              </Row>
              <Row label="Email">
                <span className="truncate text-sm text-muted">{profile?.email ?? '—'}</span>
              </Row>
            </Panel>
          </aside>
        </div>
      )}
    </DashboardShell>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  )
}

function ProfileEditor({ onSaved }: { onSaved: () => Promise<void> }) {
  const { profile } = useAuth()
  const [profession, setProfession] = useState(profile?.current_profession ?? '')
  const [summary, setSummary] = useState(profile?.semantic_summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const dirty =
    profession !== (profile?.current_profession ?? '') ||
    summary !== (profile?.semantic_summary ?? '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')
    setSaved(false)
    setBusy(true)

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        current_profession: profession.trim(),
        semantic_summary: summary.trim() || null,
      })
      .eq('id', profile.id)

    setBusy(false)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    await onSaved()
    setSaved(true)
  }

  return (
    <section>
      <SectionHeader
        title="How you're described"
        caption="This is the context the network sees. Keep it current."
      />
      <Panel className="px-6 py-6">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Current profession">
            <Input
              required
              value={profession}
              onChange={(e) => {
                setProfession(e.target.value)
                setSaved(false)
              }}
            />
          </Field>

          <Field label="A little more">
            <Textarea
              rows={6}
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value)
                setSaved(false)
              }}
              placeholder="What you're building, what you're curious about, what you're looking for."
            />
          </Field>

          {error && <Notice tone="error">{error}</Notice>}
          {saved && !dirty && <Notice tone="success">Saved.</Notice>}

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  )
}
