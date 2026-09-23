import { DashboardShell } from '../components/DashboardShell'
import { ChangePassword } from '../components/ChangePassword'
import { ProfileEditor } from '../components/ProfileEditor'
import { QuestionnaireAnswers } from '../components/QuestionnaireAnswers'
import { YourData } from '../components/YourData'
import { isNetworkMember, useAuth } from '../context/AuthProvider'
import { formatDate, Panel, StatusBadge } from '../components/ui'

/**
 * Shared by all three roles. Members had an editor buried in their own
 * dashboard; connectors and admins had none, despite profiles_update having
 * always permitted `id = auth.uid()`. One route, one component, everyone.
 */
export default function Profile() {
  const { profile } = useAuth()

  return (
    <DashboardShell title="Your profile">
      <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
        <div>
          <ProfileEditor />
          <QuestionnaireAnswers />
          <ChangePassword />
          <YourData />
        </div>

        <aside>
          <Panel className="divide-y divide-line">
            {isNetworkMember(profile) && (
              <Row label="Membership">
                <StatusBadge status={profile?.profile_status ?? 'active'} />
              </Row>
            )}
            <Row label="Email">
              <span className="truncate text-sm text-muted">{profile?.email ?? 'Not set'}</span>
            </Row>
            <Row label="Joined">
              <span className="text-sm text-muted">
                {profile ? formatDate(profile.created_at) : 'Not recorded'}
              </span>
            </Row>
          </Panel>
        </aside>
      </div>
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
