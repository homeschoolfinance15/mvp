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
  isNetworkMember,
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
import Circle from './routes/circle/Circle'

// The event platform. Public pages first: a shared event link has to open for
// somebody with no account at all (EVT-01), which is why these sit outside
// every guard in this file.
import PublicEvent from './routes/events/PublicEvent'
import Browse from './routes/events/Browse'
import EventSignup from './routes/EventSignup'
import Checkout from './routes/events/Checkout'
import MyEvents from './routes/events/MyEvents'
import Ticket from './routes/events/Ticket'
import Feedback from './routes/events/Feedback'
import EventList from './routes/manage/EventList'
import EventEditor from './routes/manage/EventEditor'
import EventGuests from './routes/manage/EventGuests'
import EventEmails from './routes/manage/EventEmails'
import EventResults from './routes/manage/EventResults'
import CheckIn from './routes/manage/CheckIn'
import AdminEvent from './routes/admin/AdminEvent'
import PaymentSetup from './routes/connector/PaymentSetup'
import AdminLayout, { ADMIN_SECTIONS } from './routes/admin/AdminLayout'
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

/**
 * The network's own surfaces: the feed, the circle, the member directory.
 *
 * Row level security is what actually protects these — `is_member()` is now
 * `has_account() AND network_member`, so an event-only account reads nothing
 * from them whatever this component does (ACC-05). This exists so that such an
 * account meets a sentence rather than an empty screen or a failed query
 * (QLT-02): they are not locked out of something that went wrong, they are
 * looking at a part of Amazing that is not theirs.
 *
 * Not a role check. An event-only attendee holds `role = 'user'` exactly as a
 * member does — what separates them is `network_member`, and that is the only
 * thing asked here.
 */
function RequireMember({ children }: { children: ReactNode }) {
  const { profile } = useAuth()

  return (
    <RequireRole>
      {isNetworkMember(profile) ? (
        <>{children}</>
      ) : (
        <div className="ambient flex min-h-screen items-center justify-center px-5">
          <Panel className="relative z-10 w-full max-w-md px-8 py-10 text-center">
            <Wordmark size="sm" />
            <h1 className="display mt-8 text-2xl">This part of Amazing isn't open to you</h1>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Your account is for attending events. The feed and the circles belong to
              Amazing's network, which people join through a connector's invitation —
              your events, tickets and history are unaffected.
            </p>
            <div className="mt-8 flex justify-center gap-3">
              <Button variant="primary" onClick={() => window.location.assign('/events/mine')}>
                Go to my events
              </Button>
              <Button onClick={() => window.location.assign('/events')}>Browse events</Button>
            </div>
          </Panel>
        </div>
      )}
    </RequireRole>
  )
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
                <RequireMember>
                  <Feed />
                </RequireMember>
              ) : (
                <ToHome />
              )
            }
          />
          {/* ---------------------------------------------------------------
              The event platform.

              Three tiers of access, and the difference between them is the
              whole of §2 of the requirements:

                public        no account at all — a shared link must open
                              (EVT-01, EVT-06)
                session       any account, network member or not (ACC-01)
                host          admin, or a connector managing their own events
                              (ORG-06)

              `FEATURES.events` gates the lot. Switched off, every address
              below sends you home rather than 404ing, exactly as before: an
              old link or a notification should land somewhere that works.
              --------------------------------------------------------------- */}

          {/* Public. Deliberately unguarded — a visitor has to be able to read
              an event before being asked for anything (EVT-01). Account and
              onboarding are required to register, and the registration
              screens enforce that themselves (BUY-01). */}
          <Route path="/e/:slug" element={FEATURES.events ? <PublicEvent /> : <ToHome />} />
          <Route path="/events" element={FEATURES.events ? <Browse /> : <ToHome />} />
          <Route path="/signup" element={FEATURES.events ? <EventSignup /> : <ToHome />} />

          {/* Signed in — but deliberately NOT behind RequireSession.

              RequireSession sends you to a bare /signin and forgets where you
              were going. These four are precisely the addresses where that
              costs something a requirement promises:

                BUY-12  somebody who lost the confirmation email logs in to get
                        their ticket back. Landing them on a blank sign-in page
                        having dropped the ticket they clicked is the failure
                        the requirement names.
                FDB-03  "Preserve the destination through login", in as many
                        words, for the feedback link in the post-event email.

              Each screen renders its own sign-in prompt carrying `?next=`, and
              says that nothing has been lost. That is a better answer than the
              router can give, because the screen knows what was being asked
              for and the router only knows it was refused.

              An event-only account must reach all four (ACC-01, ACC-02), and
              none of them may hold somebody at the network questionnaire.
              Checkout runs its own onboarding gate, matched server-side in
              `stripe-checkout` and `register_free` (BUY-01). Feedback
              eligibility is verified attendance, which only the database can
              answer (FDB-06), so the screen asks rather than the router. */}
          <Route path="/events/checkout/:slug" element={FEATURES.events ? <Checkout /> : <ToHome />} />
          <Route path="/events/mine" element={FEATURES.events ? <MyEvents /> : <ToHome />} />
          <Route path="/events/tickets/:id" element={FEATURES.events ? <Ticket /> : <ToHome />} />
          <Route path="/events/feedback/:slug" element={FEATURES.events ? <Feedback /> : <ToHome />} />

          {/* Managing events. RequireSession, not a role check: which events
              you may manage is per-event (`hosts_event`), and ORG-01C means a
              connector whose creation permission was switched off still runs
              the events they already host. Each screen asks that question of
              the event in front of it. */}
          <Route
            path="/manage/events"
            element={FEATURES.events ? <RequireSession><EventList /></RequireSession> : <ToHome />}
          />
          {/* `new` before `:id`, or it matches as an id. */}
          <Route
            path="/manage/events/new"
            element={FEATURES.events ? <RequireSession><EventEditor /></RequireSession> : <ToHome />}
          />
          <Route
            path="/manage/events/:id"
            element={FEATURES.events ? <RequireSession><EventEditor /></RequireSession> : <ToHome />}
          />
          <Route
            path="/manage/events/:id/guests"
            element={FEATURES.events ? <RequireSession><EventGuests /></RequireSession> : <ToHome />}
          />
          <Route
            path="/manage/events/:id/emails"
            element={FEATURES.events ? <RequireSession><EventEmails /></RequireSession> : <ToHome />}
          />
          <Route
            path="/manage/events/:id/results"
            element={FEATURES.events ? <RequireSession><EventResults /></RequireSession> : <ToHome />}
          />
          <Route
            path="/manage/events/:id/checkin"
            element={FEATURES.events ? <RequireSession><CheckIn /></RequireSession> : <ToHome />}
          />

          {/* ORG-14: every event's full operational record, admin only. */}
          <Route
            path="/admin/events/:id"
            element={
              FEATURES.events ? (
                <RequireRole role="admin">
                  <AdminEvent />
                </RequireRole>
              ) : (
                <ToHome />
              )
            }
          />

          {/* BUY-14. A super connector's own Stripe account. Both addresses
              render the same screen — the second is where Stripe returns them
              after the OAuth hand-off, and it reads the code off the query. */}
          <Route
            path="/connector/payments"
            element={
              <RequireRole role="connector">
                <PaymentSetup />
              </RequireRole>
            }
          />
          <Route
            path="/connector/stripe/return"
            element={
              <RequireRole role="connector">
                <PaymentSetup />
              </RequireRole>
            }
          />

          {/* The network's own rooms. RequireMember, so an event-only account
              is told plainly that this is not theirs rather than meeting an
              empty screen its RLS produced (ACC-05, QLT-02). */}
          <Route
            path="/circle"
            element={
              <RequireMember>
                <Circle />
              </RequireMember>
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
          {/* Administration. One layout, and a route per section rather than
              tabs on a single page: an address is linkable, survives a
              refresh, and gives the back button something to do — none of
              which local tab state can. The section list itself lives in
              ADMIN_SECTIONS, so a new screen is one entry there and never a
              change here. */}
          <Route
            path="/admin"
            element={
              <RequireRole role="admin">
                <AdminLayout />
              </RequireRole>
            }
          >
            <Route index element={<Navigate to={ADMIN_SECTIONS[0].to} replace />} />
            {ADMIN_SECTIONS.map((section) => (
              <Route key={section.to} path={section.to} element={section.element} />
            ))}
          </Route>
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
