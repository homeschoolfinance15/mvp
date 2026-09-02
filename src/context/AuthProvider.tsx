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

const RATE_LIMITED =
  'Too many accounts have been created in the last hour. Please try again ' +
  'shortly, or ask the person who invited you to let us know.'

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
        'email" is enabled — each signup sends a message and the built-in mailer ' +
        'is capped at a few per hour. Disable it under Authentication → Sign In / ' +
        'Providers → Email, or configure custom SMTP.',
      error,
    )
    return new Error(RATE_LIMITED)
  }

  if (/already registered|already been registered/i.test(raw)) {
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

  const fetchProfile = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      console.error('Failed to load profile', error)
      setProfile(null)
    } else {
      setProfile((data as Profile) ?? null)
    }
    setSettledFor(id)
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
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      })
      if (error) throw humanSignupError(error)
      if (!data.session) throw new Error(NO_SESSION_AFTER_SIGNUP)

      const { data: redeemed, error: redeemError } = await supabase.rpc('redeem_code', {
        p_code: code.trim(),
        p_full_name: fullName.trim(),
      })
      if (redeemError) throw redeemError

      await fetchProfile(data.session.user.id)
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
      await fetchProfile(data.session.user.id)
    },
    [fetchProfile],
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

// eslint-disable-next-line react-refresh/only-export-components
export function homePathFor(profile: Profile | null): string {
  if (!profile) return '/signin'
  if (needsOnboarding(profile)) return '/onboarding'
  if (profile.role === 'admin') return '/admin'
  if (profile.role === 'connector') return '/connector'
  return '/home'
}
