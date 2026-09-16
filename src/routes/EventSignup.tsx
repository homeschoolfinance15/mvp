import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, Field, Input, Notice, Spinner } from '../components/ui'
import { errorMessage, supabase } from '../lib/supabase'
import { needsOnboarding, useAuth } from '../context/AuthProvider'
import {
  CAPACITY_WORDS,
  eventLink,
  eventWhen,
  money,
  priceLabel,
  type CapacityState,
  type PublicEvent,
  type TicketType,
} from '../lib/events'
import { rememberSignupResume } from '../lib/signupResume'

/**
 * The second door into AMAZING.
 *
 * The first one, /join, needs an invitation code and puts the new account
 * inside a connector's network. This one needs nothing at all (ACC-01): a
 * person who followed a link to an event can make an account, answer the same
 * required questions everybody answers, and then browse, register, pay, hold a
 * ticket, manage their attendance and give feedback they are eligible for.
 *
 * What it deliberately does NOT do is make them a member of the network
 * (ACC-02). `create_event_account` writes `network_member = false` and no
 * `connector_user_links` row, so `is_member()` stays false and the feed, the
 * circle, the member directory, connector notes and other people's private
 * answers stay exactly as closed as they were (ACC-05, QLT-06). Buying a
 * ticket, turning up, or being invited to an event puts nobody in anybody's
 * network — that only happens by redeeming a code at /join, which flips the
 * flag on this same profile row rather than making a second person (ACC-06).
 *
 * /join is untouched by all of this. This is a second door, not a replacement
 * for the first one.
 */
export default function EventSignup() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { session, profile, loading: authLoading, refreshProfile } = useAuth()

  // EVT-01 sends people here as /signup?event=<slug>, and the event page adds
  // ?ticket=<ticket_type_id> when they had already chosen one. Arriving with
  // neither is fine: this is also just "create an account".
  const slug = (params.get('event') ?? '').trim()
  const ticketId = (params.get('ticket') ?? '').trim() || null

  const [event, setEvent] = useState<PublicEvent | null>(null)
  const [loadingEvent, setLoadingEvent] = useState(Boolean(slug))
  const [eventMissing, setEventMissing] = useState(false)

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // ACC-07. What changed underneath them while they were filling the form in,
  // said in words, with a button rather than a silent redirect.
  const [drift, setDrift] = useState<string[] | null>(null)
  const [next, setNext] = useState<string | null>(null)

  const loadEvent = useCallback(async () => {
    if (!slug) return
    const { data, error: loadError } = await supabase
      .from('event_public')
      .select('*')
      .eq('slug', slug)
      .maybeSingle()

    if (loadError) console.error('[amazing] could not load the event:', loadError)
    setEvent((data as PublicEvent) ?? null)
    setEventMissing(!data)
    setLoadingEvent(false)
  }, [slug])

  useEffect(() => {
    void loadEvent()
  }, [loadEvent])

  const ticket = ticketId
    ? (event?.ticket_types ?? []).find((t) => t.id === ticketId) ?? null
    : null

  /**
   * Where they end up once the account exists and the required questions are
   * answered. A chosen ticket goes back to checkout carrying that choice; no
   * choice goes back to the event page; no event at all goes to browse.
   */
  const resumePath = slug
    ? ticketId
      ? `/events/checkout/${encodeURIComponent(slug)}?ticket=${encodeURIComponent(ticketId)}`
      : eventLink(slug)
    : '/events'

  /**
   * ACC-07. Between opening this page and finishing with it, the event carried
   * on: a price can be edited, the last place can go, an organiser can close
   * registration. Re-read it and say what moved, rather than landing them on a
   * checkout that quietly costs more than the one they clicked.
   *
   * This covers the window this screen owns. Someone creating an account also
   * passes through onboarding and the questionnaire afterwards, which is a
   * longer window still — the snapshot goes into the resume record so checkout
   * can make the same comparison when they finally arrive.
   */
  function driftAgainst(before: PublicEvent, after: PublicEvent | null): string[] {
    if (!after) return []
    const said: string[] = []

    const wasTicket = ticketId ? before.ticket_types?.find((t) => t.id === ticketId) : undefined
    const nowTicket = ticketId ? after.ticket_types?.find((t) => t.id === ticketId) : undefined

    if (wasTicket && !nowTicket) {
      said.push(`The ${wasTicket.name} ticket is no longer on sale.`)
    } else if (wasTicket && nowTicket && wasTicket.price_cents !== nowTicket.price_cents) {
      said.push(
        `The ${nowTicket.name} ticket was ${priceLabel(wasTicket)} when you started and is ` +
          `${priceLabel(nowTicket)} now.`,
      )
    }

    if (before.capacity_state !== after.capacity_state) {
      said.push(
        `${CAPACITY_WORDS[before.capacity_state]} when you started; ` +
          `${CAPACITY_WORDS[after.capacity_state].toLowerCase()} now.`,
      )
    } else if (
      after.remaining !== null &&
      before.remaining !== null &&
      after.remaining < before.remaining
    ) {
      said.push(
        `${before.remaining} ${before.remaining === 1 ? 'place was' : 'places were'} left when ` +
          `you started; ${after.remaining} ${after.remaining === 1 ? 'is' : 'are'} left now.`,
      )
    }

    return said
  }

  /** Writes down where they were, then hands over to the next screen. */
  function handOver(to: string, after: PublicEvent | null) {
    const snapshot = after ?? event
    if (slug && snapshot) {
      rememberSignupResume({
        path: resumePath,
        eventTitle: snapshot.title,
        priceCents: ticket ? ticket.price_cents : null,
        currency: ticket ? ticket.currency : snapshot.currency,
        capacityState: snapshot.capacity_state,
        at: new Date().toISOString(),
      })
    }
    navigate(to, { replace: true })
  }

  /** ACC-03. Already one of us: no second account, no questions asked twice. */
  async function continueAsExisting() {
    setError('')
    setBusy(true)
    const { data } = slug
      ? await supabase.from('event_public').select('*').eq('slug', slug).maybeSingle()
      : { data: null }
    const after = (data as PublicEvent) ?? null
    const moved = event ? driftAgainst(event, after) : []
    setBusy(false)

    if (moved.length > 0) {
      setDrift(moved)
      setNext(profile && needsOnboarding(profile) ? '/onboarding' : resumePath)
      if (after) setEvent(after)
      return
    }
    handOver(profile && needsOnboarding(profile) ? '/onboarding' : resumePath, after)
  }

  async function createAccount(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    // ponytail: signUp is called here rather than through AuthProvider, which
    // owns joinWithCode and createAdminAccount and is not this workstream's
    // file. The right home for this is a createEventAccount alongside them —
    // see the handover note. Until then the shape is deliberately identical.
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { full_name: fullName.trim() } },
    })

    if (signUpError) {
      setBusy(false)
      setError(
        /already registered|already been registered/i.test(signUpError.message)
          ? 'An account already exists for that email address. Sign in instead — ' +
              'you will come straight back here.'
          : errorMessage(signUpError),
      )
      return
    }

    if (!data.session) {
      setBusy(false)
      setError(
        "Your account was created, but we couldn't sign you in automatically. " +
          'Check your inbox for a confirmation link, then sign in.',
      )
      return
    }

    // ACC-01/ACC-02. The profile row, network_member = false, and no connector
    // link. A client-side insert cannot do this: it would have to be allowed to
    // choose its own role and network_member, which is the whole boundary.
    const { error: rpcError } = await supabase.rpc('create_event_account', {
      p_full_name: fullName.trim(),
    })
    if (rpcError) {
      setBusy(false)
      setError(errorMessage(rpcError))
      return
    }

    await refreshProfile()

    const { data: fresh } = slug
      ? await supabase.from('event_public').select('*').eq('slug', slug).maybeSingle()
      : { data: null }
    const after = (fresh as PublicEvent) ?? null
    const moved = event ? driftAgainst(event, after) : []
    setBusy(false)

    // BUY-01. A profile that has just been created has answered nothing, so
    // onboarding and the questionnaire are always next. The resume record is
    // what carries the event across them.
    if (moved.length > 0) {
      setDrift(moved)
      setNext('/onboarding')
      if (after) setEvent(after)
      return
    }
    handOver('/onboarding', after)
  }

  /* ------------------------------------------------------------- loading */
  if (authLoading || loadingEvent) {
    return (
      <AuthLayout eyebrow="Your account" title="One moment" caption="Fetching the details.">
        <div className="flex justify-center py-6 text-dim">
          <Spinner />
        </div>
      </AuthLayout>
    )
  }

  /* --------------------------------------------------------- what changed */
  if (drift && next) {
    return (
      <AuthLayout
        eyebrow="Before you go on"
        title="Something moved while you were signing up"
        caption="Your account is ready. This is what changed in the meantime."
      >
        <ul className="space-y-2.5">
          {drift.map((line) => (
            <li key={line} className="text-sm leading-relaxed text-fg">
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs leading-relaxed text-dim">
          Nothing has been booked and nothing has been charged. You decide on the next
          screen.
        </p>
        <Button variant="primary" className="mt-7 w-full" onClick={() => handOver(next, event)}>
          {next === '/onboarding' ? 'Continue' : 'Back to the event'}
        </Button>
      </AuthLayout>
    )
  }

  /* ---------------------------------------------------------- ACC-03 path */
  if (session && profile) {
    return (
      <AuthLayout
        eyebrow="Already with us"
        title={`Welcome back, ${profile.full_name.split(' ')[0]}`}
        caption={
          needsOnboarding(profile)
            ? 'Your account exists. There are a couple of questions still to finish, and then you go straight back to the event.'
            : 'You already have an account and a finished profile, so there is nothing to fill in again.'
        }
      >
        {event && <EventSummary event={event} ticket={ticket} />}

        {error && (
          <div className="mt-5">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        <Button
          variant="primary"
          loading={busy}
          className="mt-7 w-full"
          onClick={() => void continueAsExisting()}
        >
          {needsOnboarding(profile)
            ? 'Finish your profile'
            : event
              ? 'Continue to the event'
              : 'Continue'}
        </Button>
      </AuthLayout>
    )
  }

  /* --------------------------------------------------------- missing event */
  if (slug && eventMissing) {
    return (
      <AuthLayout
        eyebrow="Your account"
        title="We couldn't find that event"
        caption="The link may be out of date, or the event may not be published yet. You can still create an account and look for it."
        footer={
          <Link to="/signin" className="text-fg underline-offset-4 hover:underline">
            Sign in instead
          </Link>
        }
      >
        <SignupForm
          fullName={fullName}
          email={email}
          password={password}
          busy={busy}
          error={error}
          onFullName={setFullName}
          onEmail={setEmail}
          onPassword={setPassword}
          onSubmit={createAccount}
        />
      </AuthLayout>
    )
  }

  /* ---------------------------------------------------------- new account */
  return (
    <AuthLayout
      eyebrow={event ? 'Attending an event' : 'Your account'}
      title="Create your account"
      caption={
        event
          ? 'No invitation code needed. An account lets you register, pay, hold your ticket and give feedback afterwards.'
          : 'No invitation code needed. An account lets you browse events, register, pay and hold your tickets.'
      }
      footer={
        <>
          Already have an account?{' '}
          <Link to="/signin" className="text-fg underline-offset-4 hover:underline">
            Sign in
          </Link>
          {' · '}
          <Link to="/join" className="text-fg underline-offset-4 hover:underline">
            I have an invitation code
          </Link>
        </>
      }
    >
      {event && <EventSummary event={event} ticket={ticket} />}

      <div className={event ? 'mt-7' : ''}>
        <SignupForm
          fullName={fullName}
          email={email}
          password={password}
          busy={busy}
          error={error}
          onFullName={setFullName}
          onEmail={setEmail}
          onPassword={setPassword}
          onSubmit={createAccount}
        />
      </div>

      {/*
        ACC-02, said out loud rather than left as an implementation detail. An
        event account is an event account: it joins no community, and nobody's
        private network information opens because somebody bought a ticket.
      */}
      <p className="mt-6 text-xs leading-relaxed text-dim">
        This account is for events. It does not join you to anyone&apos;s network, and
        registering, attending or being invited to an event never will. If someone
        sends you an invitation code later, you can use it on this same account.
      </p>
    </AuthLayout>
  )
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/** What they clicked, restated, so signup never feels like a detour. */
function EventSummary({ event, ticket }: { event: PublicEvent; ticket: TicketType | null }) {
  const state: CapacityState = event.capacity_state

  return (
    <div className="rounded-sm border border-gold/25 bg-gold-wash px-4 py-4">
      <p className="eyebrow text-gold-dim">You&apos;re signing up to attend</p>
      <p className="mt-2.5 text-sm font-medium text-fg">{event.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{eventWhen(event)}</p>
      {event.host_names?.length > 0 && (
        <p className="mt-1 text-xs text-dim">Hosted by {event.host_names.join(', ')}</p>
      )}
      <p className="mt-2.5 text-xs text-dim">
        {ticket
          ? `${ticket.name} · ${money(ticket.price_cents, ticket.currency)}`
          : CAPACITY_WORDS[state]}
        {ticket && state !== 'open' ? ` · ${CAPACITY_WORDS[state]}` : ''}
      </p>
    </div>
  )
}

function SignupForm({
  fullName,
  email,
  password,
  busy,
  error,
  onFullName,
  onEmail,
  onPassword,
  onSubmit,
}: {
  fullName: string
  email: string
  password: string
  busy: boolean
  error: string
  onFullName: (v: string) => void
  onEmail: (v: string) => void
  onPassword: (v: string) => void
  onSubmit: (e: FormEvent) => void
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field label="Full name">
        <Input
          required
          value={fullName}
          onChange={(e) => onFullName(e.target.value)}
          placeholder="Jane Okonkwo"
          autoComplete="name"
        />
      </Field>

      <Field label="Email address" hint="Where your ticket and reminders go.">
        <Input
          required
          type="email"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          placeholder="jane@company.com"
          autoComplete="email"
        />
      </Field>

      <Field label="Password" hint="At least 8 characters.">
        <Input
          required
          type="password"
          minLength={8}
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>

      {error && <Notice tone="error">{error}</Notice>}

      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Create account
      </Button>
    </form>
  )
}
