import { useState, type ReactNode } from 'react'
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
import { AppShell } from './components/AppShell'
import { Button, Modal, Notice, PageLoader, Panel, Wordmark } from './components/ui'
import { errorMessage, supabase } from './lib/supabase'
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
import AdminEvents from './routes/admin/Events'
import PaymentSetup from './routes/connector/PaymentSetup'
import AdminLayout, { ADMIN_SECTIONS } from './routes/admin/AdminLayout'
import ConnectorPeople from './routes/connector/ConnectorPeople'
import ConnectorInvitations from './routes/connector/ConnectorInvitations'
import ConnectorRaised from './routes/connector/ConnectorRaised'
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
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // ACC-01. A login with no profile (a half-finished event signup, or an
  // uninvited signup) still holds an email, so it can be closed like any other.
  async function closeLogin() {
    setBusy(true)
    setError('')
    const { error: rpcError } = await supabase.rpc('delete_my_account', { p_scope: 'account' })
    if (rpcError && rpcError.message !== 'This account no longer exists.') {
      setBusy(false)
      setConfirming(false)
      setError(errorMessage(rpcError))
      return
    }
    // ACC-11. Leave first, then sign out: signing out under a guarded page
    // lets RequireSession replace the address with a bare /signin.
    navigate('/signin', { replace: true, state: { notice: 'Your account is closed.' } })
    await signOut()
  }

  return (
    <div className="ambient flex min-h-screen items-center justify-center px-5">
      <Panel className="relative z-10 w-full max-w-md px-8 py-10 text-center">
        <Wordmark size="sm" />
        <h1 className="display mt-8 text-2xl">This account isn't on the network</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          {session?.user.email} has no membership. To join, enter an invitation code from a
          connector.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          {/* Keeps the session: /join redeems for this account rather than
              signing up again, which an existing email never could (ACC-2). */}
          <Button variant="primary" onClick={() => navigate('/join')}>
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
        <button
          type="button"
          className="mt-6 text-xs text-dim underline-offset-4 transition-colors hover:text-fg hover:underline"
          onClick={() => setConfirming(true)}
        >
          Close this login
        </button>
        {error && (
          <div className="mt-4 text-left">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </Panel>

      <Modal
        open={confirming}
        title="Close this login?"
        onClose={() => {
          if (!busy) setConfirming(false)
        }}
      >
        <p className="text-sm leading-relaxed text-muted">
          {session?.user.email} will no longer be able to sign in. This cannot be undone.
        </p>
        <div className="mt-7 flex gap-3">
          <Button className="flex-1" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" className="flex-1" loading={busy} onClick={() => void closeLogin()}>
            Close this login
          </Button>
        </div>
      </Modal>
    </div>
  )
}

function RequireRole({ role, children }: { role?: AppRole | AppRole[]; children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  const { pathname } = useLocation()
  const toSignIn = useSignInHere()

  if (loading) return <PageLoader />
  if (!session) return toSignIn
  if (!profile) return <NotProvisioned />
  // /profile holds "Download your data" and "Delete my account". Neither may
  // wait on onboarding or the questionnaire: somebody who wants to leave
  // halfway through signing up must be able to, as on any other platform.
  const ownData = pathname === '/profile'
  if (needsOnboarding(profile) && !ownData) return <Navigate to="/onboarding" replace />
  // An invited member reaches the dashboard without ever having answered
  // anything; a waitlist applicant arrives with their answers already copied
  // across. Same questions for both, and nothing else opens until they are
  // answered. "Tell us more" stays optional, as it is for the waitlist.
  if (needsQuestionnaire(profile) && pathname !== '/questions' && !ownData) {
    return <Navigate to="/questions" replace />
  }
  // QLT-02. A silent bounce to your own dashboard is what this used to do, and
  // it reads as a broken link rather than a closed door: a connector who
  // follows a colleague's /admin/waitlist link simply finds themselves on
  // /connector with nothing said. The admin area is about to grow a great many
  // more addresses, so the number of ways to arrive somewhere that is not
  // yours only goes up. Same shape as RequireMember below — say what happened,
  // say it is not a fault, and give somewhere to go.
  if (role && ![role].flat().includes(profile.role)) return <WrongPlace />

  return <>{children}</>
}

/**
 * QLT-02. Signed in, and this is somebody else's part of the product.
 *
 * Deliberately vague about what lives here. "Administration" would tell a
 * member that an administration area exists at the address they guessed, and
 * the row-level policies are what actually keep them out — this is only the
 * sentence that stops it reading as a fault.
 */
function WrongPlace() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  return (
    <AppShell>
      <main className="flex justify-center px-5 py-16 sm:px-8">
        <Panel className="w-full max-w-md px-8 py-10 text-center">
          <h1 className="display text-2xl">That page isn't yours to open</h1>
          <div className="mt-8 flex justify-center gap-3">
            {/* Back where they came from; a fresh tab has nowhere to go
                back to, so it goes home instead. `idx` is React Router's
                own position in this tab's history. */}
            <Button
              variant="primary"
              onClick={() =>
                (window.history.state?.idx ?? 0) > 0
                  ? navigate(-1)
                  : navigate(homePathFor(profile), { replace: true })
              }
            >
              Go back
            </Button>
          </div>
        </Panel>
      </main>
    </AppShell>
  )
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

/**
 * The four Hosting lists. An administrator's events lists are /admin/events
 * and its three siblings, so they are sent to the same one there rather than
 * shown a second copy.
 */
function HostingList({ bucket }: { bucket: 'upcoming' | 'drafts' | 'past' | 'cancelled' }) {
  const { profile } = useAuth()
  if (profile?.role === 'admin') {
    return <Navigate to={bucket === 'upcoming' ? '/admin/events' : `/admin/events/${bucket}`} replace />
  }
  // Keyed so a search typed on one bucket's page does not follow to the next.
  return <EventList key={bucket} bucket={bucket} />
}

/** /home is the member dashboard; an event-only account's home is its events. */
function MemberHome() {
  const { profile } = useAuth()
  if (profile?.network_member === false) return <Navigate to={homePathFor(profile)} replace />
  return <UserDashboard />
}

/**
 * The questionnaire curates people into the network, so an administrator, a
 * connector and an event-only account are owed none; each is sent home.
 */
function QuestionsPage() {
  const { profile } = useAuth()
  // Decided on arrival, so finishing here goes where Questions sends you,
  // not to /profile the moment the refreshed answers say done.
  const [answered] = useState(() => profile?.role === 'user' && !needsQuestionnaire(profile))
  if (profile?.role !== 'user' || profile.network_member === false) {
    return <Navigate to={homePathFor(profile)} replace />
  }
  // A member who has finished edits their answers on Profile.
  if (answered) return <Navigate to="/profile" replace />
  return <Questions />
}

/** An administrator is in no circle; theirs to see is every circle. */
function CirclePage() {
  const { profile } = useAuth()
  if (profile?.role === 'admin') return <Navigate to="/admin/circles" replace />
  return <Circle />
}

/**
 * ACC-11. /signin, plus the one-line fact a closed account leaves behind
 * (`state.notice`). The page is reached before sign-out finishes, so it waits
 * for the session to go rather than bouncing the closing account home.
 */
function SignInRoute() {
  const { session } = useAuth()
  const notice = (useLocation().state as { notice?: string } | null)?.notice
  if (notice && session) return <PageLoader />
  return (
    <>
      {notice && (
        <div className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      <SignIn />
    </>
  )
}

/**
 * Decision 4. Signed out, a guarded address sends you to sign in and back
 * again: a deep link from an email or a colleague survives the login.
 * SignIn honours `next` only when it resolves to this origin.
 */
function useSignInHere() {
  const { pathname, search } = useLocation()
  return <Navigate to={`/signin?next=${encodeURIComponent(pathname + search)}`} replace />
}

function RequireSession({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  const toSignIn = useSignInHere()

  if (loading) return <PageLoader />
  if (!session) return toSignIn
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
        <AppShell>
          <main className="flex justify-center px-5 py-16 sm:px-8">
            <Panel className="w-full max-w-md px-8 py-10 text-center">
              <h1 className="display text-2xl">This part of Amazing isn't open to you</h1>
              <p className="mt-4 text-sm leading-relaxed text-muted">
                To join the network, you need an invitation code from a connector.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button variant="primary" onClick={() => window.location.assign('/join')}>
                  Enter an invitation code
                </Button>
              </div>
            </Panel>
          </main>
        </AppShell>
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
          <Route path="/signin" element={<SignInRoute />} />
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
          <Route path="/events/mine" element={FEATURES.events ? <MyEvents bucket="upcoming" /> : <ToHome />} />
          <Route path="/events/mine/past" element={FEATURES.events ? <MyEvents bucket="past" /> : <ToHome />} />
          <Route
            path="/events/mine/cancelled"
            element={FEATURES.events ? <MyEvents bucket="cancelled" /> : <ToHome />}
          />
          <Route path="/events/tickets/:id" element={FEATURES.events ? <Ticket /> : <ToHome />} />
          <Route path="/events/feedback/:slug" element={FEATURES.events ? <Feedback /> : <ToHome />} />

          {/* Managing events. The list and a new event are for hosts only
              (admin or connector); a single event is RequireSession, because
              which events you may manage is per-event (`hosts_event`), and
              ORG-01C means a connector whose creation permission was switched
              off still runs the events they already host. Each screen asks
              that question of the event in front of it. */}
          {(['upcoming', 'drafts', 'past', 'cancelled'] as const).map((bucket) => (
            <Route
              key={bucket}
              path={bucket === 'upcoming' ? '/manage/events' : `/manage/events/${bucket}`}
              element={
                FEATURES.events ? (
                  <RequireRole role={['admin', 'connector']}>
                    <HostingList bucket={bucket} />
                  </RequireRole>
                ) : (
                  <ToHome />
                )
              }
            />
          ))}
          {/* `new` and the lists before `:id`, or they match as an id. */}
          <Route
            path="/manage/events/new"
            element={FEATURES.events ? <RequireRole role={['admin', 'connector']}><EventEditor /></RequireRole> : <ToHome />}
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
                <CirclePage />
              </RequireMember>
            }
          />
          <Route
            path="/questions"
            element={
              <RequireRole>
                <QuestionsPage />
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
              <Route
                key={section.to}
                path={section.to}
                element={section.bucket ? <AdminEvents key={section.bucket} bucket={section.bucket} /> : section.element}
              />
            ))}
          </Route>
          {/* A connector's home is three pages, one per sidebar link;
              /connector stays their home address and opens the first. */}
          <Route path="/connector" element={<Navigate to="/connector/people" replace />} />
          <Route
            path="/connector/people"
            element={
              <RequireRole role="connector">
                <ConnectorPeople />
              </RequireRole>
            }
          />
          <Route
            path="/connector/invitations"
            element={
              <RequireRole role="connector">
                <ConnectorInvitations />
              </RequireRole>
            }
          />
          <Route
            path="/connector/raised"
            element={
              <RequireRole role="connector">
                <ConnectorRaised />
              </RequireRole>
            }
          />
          <Route
            path="/home"
            element={
              <RequireRole role="user">
                <MemberHome />
              </RequireRole>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
