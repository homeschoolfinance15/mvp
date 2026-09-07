import { useCallback, useEffect, useState } from 'react'
import { DashboardShell } from '../../components/DashboardShell'
import { ProfileEditor } from '../../components/ProfileEditor'
import {
  CopyCode,
  EmptyState,
  formatDate,
  Initials,
  Panel,
  SectionHeader,
  Spinner,
  StatusBadge,
} from '../../components/ui'
import { supabase } from '../../lib/supabase'
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
                    <Initials name={connectorProfile.full_name} role="connector" />
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
