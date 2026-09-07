import { DashboardShell } from '../components/DashboardShell'
import { ChangePassword } from '../components/ChangePassword'
import { ProfileEditor } from '../components/ProfileEditor'
import { YourData } from '../components/YourData'
import { useAuth } from '../context/AuthProvider'
import { formatDate, Panel, StatusBadge } from '../components/ui'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  connector: 'Connector',
  user: 'Member',
}

/**
 * Shared by all three roles. Members had an editor buried in their own
 * dashboard; connectors and admins had none, despite profiles_update having
 * always permitted `id = auth.uid()`. One route, one component, everyone.
 */
export default function Profile() {
  const { profile } = useAuth()

  return (
    <DashboardShell
      title="Your profile"
      caption="What the network reads you by, and the parts of it only an administrator can move."
    >
      <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
        <div>
          <ProfileEditor />
          <ChangePassword />
          <YourData />
        </div>

        <aside>
          <Panel className="divide-y divide-line">
            <Row label="Role">
              <span className="text-sm text-muted">{ROLE_LABEL[profile?.role ?? ''] ?? 'Not set'}</span>
            </Row>
            <Row label="Membership">
              <StatusBadge status={profile?.profile_status ?? 'active'} />
            </Row>
            <Row label="Email">
              <span className="truncate text-sm text-muted">{profile?.email ?? 'Not set'}</span>
            </Row>
            <Row label="Joined">
              <span className="text-sm text-muted">
                {profile ? formatDate(profile.created_at) : 'Not recorded'}
              </span>
            </Row>
          </Panel>

          <p className="mt-4 text-xs leading-relaxed text-dim">
            Role and membership status aren't yours to change. The
            protect_profile_fields trigger pins them on every update that isn't
            made by an administrator.
          </p>
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
