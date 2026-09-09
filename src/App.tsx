import type { ReactNode } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import {
  AuthProvider,
  homePathFor,
  needsOnboarding,
  needsQuestionnaire,
  useAuth,
} from './context/AuthProvider'
import { Button, PageLoader, Panel, Wordmark } from './components/ui'
import type { AppRole } from './lib/types'

import Landing from './routes/Landing'
import Join from './routes/Join'
import SignIn from './routes/SignIn'
import ForgotPassword from './routes/ForgotPassword'
import ResetPassword from './routes/ResetPassword'
import AdminSetup from './routes/AdminSetup'
import Onboarding from './routes/Onboarding'
import Profile from './routes/Profile'
import Questions from './routes/Questions'
import Feed from './routes/feed/Feed'
import Events from './routes/events/Events'
import Circle from './routes/circle/Circle'
import AdminDashboard from './routes/admin/AdminDashboard'
import ConnectorDashboard from './routes/connector/ConnectorDashboard'
import UserDashboard from './routes/user/UserDashboard'
import { FEATURES } from './lib/features'

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
  const { pathname } = useLocation()

  if (loading) return <PageLoader />
  if (!session) return <Navigate to="/signin" replace />
  if (!profile) return <NotProvisioned />
  if (needsOnboarding(profile)) return <Navigate to="/onboarding" replace />
  // An invited member reaches the dashboard without ever having answered
  // anything; a waitlist applicant arrives with their answers already copied
  // across. Same questions for both, and nothing else opens until they are
  // answered. "Tell us more" stays optional, as it is for the waitlist.
  if (needsQuestionnaire(profile) && pathname !== '/questions') {
    return <Navigate to="/questions" replace />
  }
  if (role && profile.role !== role) return <Navigate to={homePathFor(profile)} replace />

  return <>{children}</>
}

/**
 * Where a switched-off feature sends you.
 *
 * Home for whoever you are, rather than a 404 or the public landing page: the
 * address was valid before and will be again, so an old bookmark or a stale
 * notification should land somewhere that works.
 */
function ToHome() {
  const { session, profile, loading } = useAuth()

  if (loading) return <PageLoader />
  if (!session || !profile) return <Navigate to="/" replace />
  return <Navigate to={homePathFor(profile)} replace />
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
          <Route path="/forgot-password" element={<ForgotPassword />} />
          {/* Where a recovery link lands. Public: the link is the credential. */}
          <Route path="/reset-password" element={<ResetPassword />} />

          <Route
            path="/onboarding"
            element={
              <RequireSession>
                <Onboarding />
              </RequireSession>
            }
          />
          {/* Shared by every role. RequireRole with no role prop is exactly
              the right guard: session + profile + onboarding complete. */}
          {/* Switched off in src/lib/features.ts until the client signs them
              off. Sent home rather than 404: the address was valid yesterday
              and will be again, and a member following an old link should
              land somewhere that works. */}
          <Route
            path="/feed"
            element={
              FEATURES.feed ? (
                <RequireRole>
                  <Feed />
                </RequireRole>
              ) : (
                <ToHome />
              )
            }
          />
          <Route
            path="/events"
            element={
              FEATURES.events ? (
                <RequireRole>
                  <Events />
                </RequireRole>
              ) : (
                <ToHome />
              )
            }
          />
          <Route
            path="/circle"
            element={
              <RequireRole>
                <Circle />
              </RequireRole>
            }
          />
          <Route
            path="/questions"
            element={
              <RequireRole>
                <Questions />
              </RequireRole>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireRole>
                <Profile />
              </RequireRole>
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
