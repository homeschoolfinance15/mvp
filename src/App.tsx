import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AuthProvider, homePathFor, needsOnboarding, useAuth } from './context/AuthProvider'
import { Button, PageLoader, Panel, Wordmark } from './components/ui'
import type { AppRole } from './lib/types'

import Landing from './routes/Landing'
import Join from './routes/Join'
import SignIn from './routes/SignIn'
import AdminSetup from './routes/AdminSetup'
import Onboarding from './routes/Onboarding'
import AdminDashboard from './routes/admin/AdminDashboard'
import ConnectorDashboard from './routes/connector/ConnectorDashboard'
import UserDashboard from './routes/user/UserDashboard'

/**
 * An auth account with no profile row means signup completed but code
 * redemption did not — or someone signed up who was never invited. Neither
 * can be resolved from inside the app, so say so plainly.
 */
function NotProvisioned() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()

  return (
    <div className="ambient flex min-h-screen items-center justify-center px-5">
      <Panel className="relative z-10 w-full max-w-md px-8 py-10 text-center">
        <Wordmark size="sm" />
        <h1 className="display mt-8 text-2xl">This account isn't on the network</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          {session?.user.email} is signed in, but has no AMAZING membership attached to it.
          Membership begins with an invitation from a connector.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button
            variant="primary"
            onClick={async () => {
              await signOut()
              navigate('/join')
            }}
          >
            Enter an invitation code
          </Button>
          <Button
            onClick={async () => {
              await signOut()
              navigate('/')
            }}
          >
            Sign out
          </Button>
        </div>
      </Panel>
    </div>
  )
}

function RequireRole({ role, children }: { role?: AppRole; children: ReactNode }) {
  const { session, profile, loading } = useAuth()

  if (loading) return <PageLoader />
  if (!session) return <Navigate to="/signin" replace />
  if (!profile) return <NotProvisioned />
  if (needsOnboarding(profile)) return <Navigate to="/onboarding" replace />
  if (role && profile.role !== role) return <Navigate to={homePathFor(profile)} replace />

  return <>{children}</>
}

function RequireSession({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()

  if (loading) return <PageLoader />
  if (!session) return <Navigate to="/signin" replace />
  if (!profile) return <NotProvisioned />

  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/join" element={<Join />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/admin-setup" element={<AdminSetup />} />

          <Route
            path="/onboarding"
            element={
              <RequireSession>
                <Onboarding />
              </RequireSession>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireRole role="admin">
                <AdminDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/connector"
            element={
              <RequireRole role="connector">
                <ConnectorDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/home"
            element={
              <RequireRole role="user">
                <UserDashboard />
              </RequireRole>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
