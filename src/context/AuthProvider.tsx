import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { questionnaireDone } from '../lib/questionnaire'
import { supabase } from '../lib/supabase'
import type { Profile, RedeemResult } from '../lib/types'

interface AuthValue {
  session: Session | null
  profile: Profile | null
  /** True until we know both the session and (if signed in) the profile. */
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Sign up and redeem an invitation or claim code in one step. */
  joinWithCode: (args: {
    code: string
    fullName: string
    email: string
    password: string
  }) => Promise<RedeemResult>
  /** Signup path for an email on the admin allowlist; the DB trigger assigns the role. */
  createAdminAccount: (args: {
    fullName: string
    email: string
    password: string
  }) => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

const NO_SESSION_AFTER_SIGNUP =
  "Your account was created, but we couldn't sign you in automatically. " +
  'Check your inbox for a confirmation link, then sign in.'

const EXISTING_ACCOUNT_WRONG_PASSWORD =
  'An account already exists for that email address, and that password does not ' +
  "match it. Enter that account's password to use your code with it."

const NOT_AN_ADMIN_EMAIL =
  "This email isn't approved for administrator access. Ask an existing " +
  'administrator to add it.'

const RATE_LIMITED =
  'Too many accounts have been created in the last hour. Please try again ' +
  'shortly, or ask the person who invited you to let us know.'

function isAlreadyRegistered(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error)
  return /already registered|already been registered/i.test(raw)
}

/**
 * Supabase surfaces provisioning problems as raw strings like "email rate limit
 * exceeded", which are meaningless to the person signing up and cannot be acted
 * on by them. Translate to something honest and human, and log the operator
 * detail to the console where whoever runs the project will find it.
 *
 * The rate limit is a symptom of email confirmation being enabled: every signup
 * sends a message, and the built-in mailer allows only a handful per hour.
 * Turning off "Confirm email" removes the email step, and the limit with it.
 */
function humanSignupError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)

  if (/rate limit/i.test(raw)) {
    console.error(
      'Signup hit the Supabase email rate limit. This happens because "Confirm ' +
        'email" is enabled. Each signup sends a message and the built-in mailer ' +
        'is capped at a few per hour. Disable it under Authentication → Sign In / ' +
        'Providers → Email, or configure custom SMTP.',
      error,
    )
    return new Error(RATE_LIMITED)
  }

  if (isAlreadyRegistered(raw)) {
    return new Error('An account already exists for that email address. Try signing in instead.')
  }

  return error instanceof Error ? error : new Error(raw)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  // Which user id we have a settled profile answer for. Prevents a flash of
  // "account not provisioned" in the gap between session and profile loading.
  const [settledFor, setSettledFor] = useState<string | null>(null)

  const userId = session?.user.id ?? null

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setSessionLoaded(true)
    })

    // Do not await Supabase calls inside this callback — it runs while the
    // auth client holds its lock and awaiting here can deadlock. Just record
    // the session; the effect below fetches the profile.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return
      setSession(next)
      setSessionLoaded(true)
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const fetchProfile = useCallback(async (id: string): Promise<Profile | null> => {
    const { data, error } = await supabase
      .from('profiles')
      // The questionnaire stamp rides along: RequireRole needs it on every
      // page load to know whether this member still owes their answers.
      .select('*, profile_answers(completed_at)')
      .eq('id', id)
      .maybeSingle()

    const next = error ? null : ((data as Profile) ?? null)
    if (error) console.error('Failed to load profile', error)
    setProfile(next)
    setSettledFor(id)
    return next
  }, [])

  useEffect(() => {
    if (!userId) {
      setProfile(null)
      setSettledFor(null)
      return
    }
    if (settledFor === userId) return
    void fetchProfile(userId)
  }, [userId, settledFor, fetchProfile])

  const refreshProfile = useCallback(async () => {
    if (userId) await fetchProfile(userId)
  }, [userId, fetchProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error) throw error
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setSettledFor(null)
  }, [])

  const joinWithCode = useCallback<AuthValue['joinWithCode']>(
    async ({ code, fullName, email, password }) => {
      // ACC-2, ACC-06. The account may already exist: somebody whose earlier
      // redemption failed after signUp, or an event-only account now joining a
      // network. Signing up again would be refused forever, so reuse the
      // session that is there, or sign in with the password they just typed.
      let user = (await supabase.auth.getSession()).data.session?.user ?? null
      if (!user) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() } },
        })
        if (error && (error.code === 'user_already_exists' || isAlreadyRegistered(error))) {
          const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
          })
          if (signInError) throw new Error(EXISTING_ACCOUNT_WRONG_PASSWORD)
          user = signedIn.user
        } else {
          if (error) throw humanSignupError(error)
          if (!data.session) throw new Error(NO_SESSION_AFTER_SIGNUP)
          user = data.session.user
        }
      }

      const { data: redeemed, error: redeemError } = await supabase.rpc('redeem_code', {
        p_code: code.trim(),
        p_full_name: fullName.trim(),
      })
      if (redeemError) throw redeemError

      // Somebody who answered the questionnaire at the waitlist door should
      // not be asked the same thirty questions again. Best effort: failing to
      // copy old answers must not fail the join.
      const { error: claimError } = await supabase.rpc('claim_waitlist_answers', {
        p_email: user.email ?? email.trim(),
      })
      if (claimError) console.error('[amazing] waitlist answers:', claimError)

      await fetchProfile(user.id)
      return redeemed as RedeemResult
    },
    [fetchProfile],
  )

  const createAdminAccount = useCallback<AuthValue['createAdminAccount']>(
    async ({ fullName, email, password }) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      })
      if (error) throw humanSignupError(error)
      if (!data.session) throw new Error(NO_SESSION_AFTER_SIGNUP)
      // ACC-9. handle_new_user only provisions an allowlisted email. Anyone
      // else is left holding a session with no profile, so sign them straight
      // back out and say why. If the email is allowlisted later,
      // provision_allowlisted_admin() gives this same account its profile.
      if (!(await fetchProfile(data.session.user.id))) {
        await signOut()
        throw new Error(NOT_AN_ADMIN_EMAIL)
      }
    },
    [fetchProfile, signOut],
  )

  const loading = !sessionLoaded || (userId !== null && settledFor !== userId)

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      loading,
      signIn,
      signOut,
      joinWithCode,
      createAdminAccount,
      refreshProfile,
    }),
    [session, profile, loading, signIn, signOut, joinWithCode, createAdminAccount, refreshProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/**
 * Members and connectors describe themselves during onboarding; admins never do.
 * A missing profession is what marks onboarding as outstanding.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function needsOnboarding(profile: Profile | null): boolean {
  if (!profile) return false
  if (profile.role === 'admin') return false
  return !profile.current_profession
}

/**
 * True while a member has not finished the questionnaire's first stage.
 *
 * Waitlist applicants answer at the door and their answers are copied across
 * on redemption, so this is really about invited members: without a gate they
 * land on the dashboard from /onboarding and are never asked, which leaves
 * them unmatchable. Only members: admins and connectors run the network
 * rather than being curated into it.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function needsQuestionnaire(profile: Profile | null): boolean {
  if (!profile || profile.role !== 'user') return false
  // Somebody who holds an account only to attend events is not being curated
  // into the network, so the questionnaire that does the curating is not owed
  // (ACC-01, ACC-02). ACC-01's "required signup/profile questions" is
  // onboarding — enough to put a name and a face on a guest list. Asking
  // whoever bought one dinner ticket how often they travel would be asking
  // them to join something they did not ask to join, and RequireRole would
  // hold them at /questions until they did.
  //
  // They keep the same profile if they later redeem an invitation code, and
  // redemption flips network_member true, at which point this turns true with
  // it and they are asked then — once, at the moment it starts to mean
  // something (ACC-06).
  if (!profile.network_member) return false
  if (needsOnboarding(profile)) return false
  return !questionnaireDone(profile.profile_answers)
}

// eslint-disable-next-line react-refresh/only-export-components
export function homePathFor(profile: Profile | null): string {
  if (!profile) return '/signin'
  if (needsOnboarding(profile)) return '/onboarding'
  if (profile.role === 'admin') return '/admin'
  if (profile.role === 'connector') return '/connector'
  // Somebody who holds an account only so they can attend events has no
  // network to go home to (ACC-01, ACC-02). /home is the member dashboard —
  // the directory, the circle, the people their connector introduced them to
  // — and none of it is theirs. Their events are.
  if (!profile.network_member) return '/events/mine'
  return '/home'
}

/**
 * True for an account that belongs to the network rather than only to the
 * event platform.
 *
 * The mirror of `is_member()` in Postgres, and it must stay the mirror: row
 * level security is what actually protects the feed, the circle and the
 * member directory, and this only decides whether to offer a door that would
 * open. A profile from before the event platform has `network_member` true,
 * so this is true for every existing member (QLT-06).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isNetworkMember(profile: Profile | null): boolean {
  return Boolean(profile && profile.network_member)
}
