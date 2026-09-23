import { useCallback, useEffect, useState } from 'react'
import { DashboardShell } from '../../components/DashboardShell'
import {
  EmptyState,
  Initials,
  LoadFailed,
  Panel,
  SectionHeader,
  Spinner,
} from '../../components/ui'
import { loadFailed, supabase } from '../../lib/supabase'
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
  const { profile } = useAuth()
  const [membership, setMembership] = useState<Membership | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!profile) return
    setFailed(false)
    const { data, error } = await supabase
      .from('connector_user_links')
      .select(
        'created_at, invite_codes(code), connectors(id, invite_status, profiles!connectors_profile_id_fkey(full_name, current_profession, semantic_summary))',
      )
      .eq('user_profile_id', profile.id)
      .maybeSingle()

    // A failed query is not "nobody invited you"; say which it was.
    if (error) {
      loadFailed(error, 'your membership')
      setFailed(true)
      setLoading(false)
      return
    }
    setMembership((data as unknown as Membership) ?? null)
    setLoading(false)
  }, [profile])

  useEffect(() => {
    void load()
  }, [load])

  const connectorProfile = membership?.connectors?.profiles ?? null

  return (
    <DashboardShell title={`Hello, ${profile?.full_name.split(' ')[0] ?? ''}`}>
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : failed ? (
        <LoadFailed what="your membership" onRetry={load} />
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
                  Ask the connector who invited you to link your account to them.
                </EmptyState>
              )}
            </section>
          </div>

          {/* Membership sidebar. The profile editor and the membership facts
              live on Profile alone; here they were a second copy of each. */}
          {membership?.invite_codes?.code && (
            <aside>
              <Panel className="px-6 py-6">
                <div className="eyebrow">Your invitation code</div>
                {/* Plain text, no Copy: it isn't theirs to pass on (NET-12). */}
                <div className="mt-4 text-lg font-medium tracking-wide text-fg">
                  {membership.invite_codes.code}
                </div>
                <p className="mt-4 text-xs leading-relaxed text-dim">
                  Please don't pass this code on.
                </p>
              </Panel>
            </aside>
          )}
        </div>
      )}
    </DashboardShell>
  )
}
