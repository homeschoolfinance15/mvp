import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Button,
  LoadFailed,
  Notice,
  Panel,
  Spinner,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import {
  canRegister,
  eventLink,
  money,
  priceLabel,
  type PublicEvent as PublicEventRow,
  type RegistrationStatus,
  type TicketType,
} from '../../lib/events'
import { rememberSignupResume } from '../../lib/signupResume'
import { loadFailed, supabase } from '../../lib/supabase'
import {
  EventShell,
  NeedsSignIn,
  StateBadge,
  WhenWhere,
  loadPublicEvent,
  rememberChoice,
  remainingWords,
  takeChoice,
  useCovers,
  useLoader,
} from './shared'

/**
 * The public face of an event. EVT-01 … EVT-06, BUY-01, ORG-03A.
 *
 * This is the only screen in the product a complete stranger is expected to
 * arrive at — a link forwarded in a message, with no account and no context.
 * So it reads top to bottom as an answer to "what is this, and do I want to
 * go", and asks for nothing until it has answered that. Registration is the
 * last thing on the page, not the first.
 *
 * Everything here comes out of the anon-readable views, so the page renders
 * identically signed out and signed in. What changes when somebody is signed
 * in is only what we can additionally tell them about themselves: whether they
 * already have a place.
 */

/** What we know about the reader's own relationship to this event. */
interface MyPlace {
  id: string
  status: RegistrationStatus
  ticket_id: string | null
}

export default function PublicEvent() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const { session, profile, loading: authLoading } = useAuth()

  const load = useCallback(() => loadPublicEvent(slug), [slug])
  const { data: event, loading, failed, reload } = useLoader<PublicEventRow | null>(load, [slug])

  const [chosen, setChosen] = useState<string | null>(null)
  /** ACC-07. Set when something moved while they were away making an account. */
  const [changedWhileAway, setChangedWhileAway] = useState('')
  const [mine, setMine] = useState<MyPlace | null>(null)

  const covers = useCovers([event?.cover_path])
  const coverUrl = event?.cover_path ? covers[event.cover_path] : undefined

  /*
   * ACC-07. They picked a ticket, were sent away to make an account, and came
   * back. Put the selection back, and if the price or the availability moved
   * in the meantime, say so here rather than letting them find out at the card
   * screen. The remembered choice is consumed once — a second visit is a fresh
   * decision, not a resumed one.
   */
  useEffect(() => {
    if (!event) return
    const remembered = takeChoice(event.slug)
    if (!remembered) return

    setChosen(remembered.ticketTypeId)

    const stillThere = event.ticket_types.find((t) => t.id === remembered.ticketTypeId)
    if (remembered.ticketTypeId && !stillThere) {
      setChangedWhileAway(
        'The ticket you chose is no longer on sale. Please have another look at the options below.',
      )
      setChosen(null)
      return
    }
    if (stillThere && remembered.priceCents !== null && stillThere.price_cents !== remembered.priceCents) {
      setChangedWhileAway(
        `The price changed while you were signing up: ${money(remembered.priceCents, stillThere.currency)} ` +
          `when you chose it, ${priceLabel(stillThere)} now.`,
      )
      return
    }
    if (remembered.state !== event.capacity_state) {
      setChangedWhileAway(
        event.capacity_state === 'sold_out'
          ? 'This event sold out while you were signing up. Nothing has been charged.'
          : event.capacity_state === 'closed'
            ? 'The organiser closed registration while you were signing up.'
            : event.capacity_state === 'cancelled'
              ? 'This event was cancelled while you were signing up.'
              : 'Something about this event changed while you were signing up. Please check the details below.',
      )
    }
  }, [event])

  /*
   * Whether this reader already has a place. Only asked once we know who they
   * are, and scoped to their own profile — a host reading their own event page
   * would otherwise pull back the whole guest list through the host clause in
   * the RLS policy and we would show them somebody else's registration.
   */
  useEffect(() => {
    if (!event || !profile) {
      setMine(null)
      return
    }
    let active = true
    void supabase
      .from('event_registrations')
      .select('id, status, event_tickets(id)')
      .eq('event_id', event.id)
      .eq('profile_id', profile.id)
      .in('status', ['pending', 'confirmed'])
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          // Not knowing is survivable: the page still describes the event, and
          // the database refuses a second registration regardless.
          loadFailed(error, 'your place at this event')
          return
        }
        const row = data as
          | { id: string; status: RegistrationStatus; event_tickets: { id: string }[] | null }
          | null
        setMine(
          row ? { id: row.id, status: row.status, ticket_id: row.event_tickets?.[0]?.id ?? null } : null,
        )
      })
    return () => {
      active = false
    }
  }, [event, profile])

  if (loading || authLoading) {
    return (
      <EventShell>
        <div className="flex justify-center py-24 text-dim">
          <Spinner />
        </div>
      </EventShell>
    )
  }

  if (failed) {
    return (
      <EventShell>
        <div className="py-12">
          <LoadFailed what="this event" onRetry={() => void reload()} />
        </div>
      </EventShell>
    )
  }

  /*
   * No such event. Distinct from a failure, and phrased as a link problem
   * rather than an accusation — the usual cause is a link that got truncated
   * on its way through three messaging apps.
   */
  if (!event) {
    return (
      <EventShell>
        <div className="mx-auto max-w-md py-20 text-center">
          <h1 className="display text-3xl">We can&rsquo;t find that event</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            The link may have been mistyped or cut short, or the event may never have been
            published. Whoever sent it to you can send it again.
          </p>
          <Link to="/events" className="mt-8 inline-block">
            <Button variant="primary">See what else is on</Button>
          </Link>
        </div>
      </EventShell>
    )
  }

  const state = event.capacity_state
  const open = canRegister(state)
  const types = event.ticket_types
  const selected = types.find((t) => t.id === chosen) ?? (types.length === 1 ? types[0] : null)
  // ORG-04. A lone ticket option is auto-selected, and the Register button only
  // ever tested "more than one option and none chosen" — so an event whose
  // single option had sold out still offered an enabled "Register — £45" for
  // the very ticket its own radio was disabling. Pressing it opened a checkout
  // for something unbuyable, and the refusal arrived from the capacity trigger
  // at the end instead of from the page at the start.
  const selectedGone =
    Boolean(selected) && selected!.remaining !== null && selected!.remaining !== undefined
      ? selected!.remaining <= 0
      : false
  const left = remainingWords(event)

  /**
   * BUY-01. One button, two destinations.
   *
   * Signed out, the ticket choice goes into session storage and they are sent
   * to signup with the slug, so the account they make is tied to the thing
   * they were trying to do. Signed in, they go straight to checkout — which is
   * where both free and paid registration actually happen, so there is exactly
   * one place in the product that creates a registration.
   */
  function register() {
    if (!event) return
    const ticketId = selected?.id ?? null
    if (!session || !profile) {
      rememberChoice(event.slug, {
        ticketTypeId: ticketId,
        priceCents: selected?.price_cents ?? null,
        state: event.capacity_state,
      })
      // ACC-07. Two records, because two different screens read them at two
      // different moments: the resume tells the last step of onboarding where
      // to send somebody who has just been through three forms, and the
      // choice above is what this page puts back when they land on it. Each
      // clears as it is read, so neither can consume the other's answer.
      rememberSignupResume({
        path: eventLink(event.slug),
        eventTitle: event.title,
        priceCents: selected?.price_cents ?? null,
        currency: selected?.currency ?? event.currency,
        capacityState: event.capacity_state,
        at: new Date().toISOString(),
      })
      navigate(`/signup?event=${encodeURIComponent(event.slug)}`)
      return
    }
    navigate(
      `/events/checkout/${encodeURIComponent(event.slug)}${ticketId ? `?ticket=${ticketId}` : ''}`,
    )
  }

  return (
    <EventShell>
      <article className="mx-auto max-w-3xl pt-2">
        {/*
          EVT-03 and ORG-03A. The state is the first thing on the page when it
          is anything other than open, because somebody reading about a
          cancelled dinner should not get as far as the menu before finding
          out.
        */}
        {state === 'cancelled' && (
          <div className="mb-6">
            <Notice tone="error">
              <strong>This event has been cancelled.</strong> It is not going ahead, and nobody
              can register. If you had a place, any refund due to you is shown under{' '}
              <Link to="/events/mine" className="underline underline-offset-2">
                my events
              </Link>
              .
            </Notice>
          </div>
        )}

        {changedWhileAway && (
          <div className="mb-6">
            <Notice tone="error">{changedWhileAway}</Notice>
          </div>
        )}

        <Panel className="overflow-hidden">
          {coverUrl && (
            <img
              src={coverUrl}
              alt=""
              className="h-52 w-full object-cover sm:h-72"
            />
          )}

          <div className="px-6 py-7 sm:px-9 sm:py-9">
            <div className="flex flex-wrap items-center gap-3">
              <StateBadge state={state} />
              {left && <span className="text-xs font-medium text-muted">{left}</span>}
            </div>

            <h1 className="display mt-5 text-3xl sm:text-4xl">{event.title}</h1>

            {/* EVT-02. Who is putting this on, by name, with no email addresses:
                the view is anon-readable and a host's inbox is not public. */}
            {event.host_names.length > 0 && (
              <p className="mt-3 text-sm text-muted">Hosted by {event.host_names.join(', ')}</p>
            )}

            <div className="mt-7 border-t border-line pt-7">
              <WhenWhere event={event} />
            </div>

            {event.description && (
              <div className="mt-7 border-t border-line pt-7">
                <h2 className="eyebrow">About</h2>
                <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                  {event.description}
                </p>
              </div>
            )}

            {/* EVT-06. What to do when you get there. Shown on the public page
                because a host writes it for the people coming, and the link is
                the invitation — anything genuinely secret belongs in the
                confirmation email, not here. */}
            {event.attendee_instructions && (
              <div className="mt-7 border-t border-line pt-7">
                <h2 className="eyebrow">Before you come</h2>
                <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                  {event.attendee_instructions}
                </p>
              </div>
            )}
          </div>
        </Panel>

        {/* ------------------------------------------------------------------ */}
        {/* Taking part                                                        */}
        {/* ------------------------------------------------------------------ */}

        <section className="mt-8" aria-labelledby="register-heading">
          <Panel className="px-6 py-7 sm:px-9">
            <h2 id="register-heading" className="eyebrow">
              {open ? 'Tickets' : 'Registration'}
            </h2>

            {/*
              Already in. Said before anything is offered, so nobody buys a
              second place at the same dinner — and the database's partial
              unique index would refuse them anyway, which is a worse way to
              find out.
            */}
            {mine ? (
              <div className="mt-4">
                <p className="text-sm text-fg">
                  {mine.status === 'confirmed'
                    ? 'You have a place at this event.'
                    : 'Your place is being held while your payment completes.'}
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  {mine.ticket_id && (
                    <Link to={`/events/tickets/${mine.ticket_id}`}>
                      <Button variant="primary">See your ticket</Button>
                    </Link>
                  )}
                  <Link to="/events/mine">
                    <Button>Manage your booking</Button>
                  </Link>
                </div>
              </div>
            ) : !open ? (
              /*
                ORG-03A. Four different reasons you cannot register, four
                different sentences. "Sold out" and "registration closed" in
                particular must never be collapsed into each other: one is the
                event filling up and the other is a decision somebody made.
              */
              <p className="mt-4 text-sm leading-relaxed text-muted">
                {state === 'sold_out'
                  ? 'Every place at this event has been taken. If somebody cancels, places can reopen — it is worth checking back.'
                  : state === 'closed'
                    ? 'The organisers have closed registration for this event. It is still going ahead, but no new places are being taken.'
                    : state === 'finished'
                      ? 'This event has already happened.'
                      : 'This event has been cancelled and is not going ahead.'}
              </p>
            ) : (
              <>
                {types.length > 0 ? (
                  <TicketOptions types={types} chosen={selected?.id ?? null} onChoose={setChosen} />
                ) : (
                  /* ORG-04 allows an event with no separate options. It is
                     free entry, and saying so is clearer than an empty list. */
                  <p className="mt-4 text-sm text-muted">Free to attend.</p>
                )}

                <div className="mt-7 flex flex-wrap items-center gap-4">
                  <Button
                    variant="primary"
                    onClick={register}
                    disabled={(types.length > 1 && !chosen) || selectedGone}
                  >
                    {selected && selected.price_cents > 0
                      ? `Register — ${priceLabel(selected)}`
                      : 'Register'}
                  </Button>
                  {types.length > 1 && !chosen && (
                    <span className="text-xs text-dim">Choose a ticket to continue.</span>
                  )}
                  {selectedGone && (
                    <span className="text-xs text-[#8a4b00]">
                      {types.length > 1
                        ? 'That ticket has sold out — choose another.'
                        : 'This ticket has sold out.'}
                    </span>
                  )}
                  {!session && (
                    <span className="text-xs text-dim">
                      You&rsquo;ll be asked to make an account — it takes a moment.
                    </span>
                  )}
                </div>
              </>
            )}

            {/* EVT-04 and BUY-15. What happens if they cannot come, said
                before they commit rather than discovered afterwards. */}
            <div className="mt-8 border-t border-line pt-6">
              <h3 className="eyebrow">If you can&rsquo;t make it</h3>
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                {event.refund_terms ??
                  'The host has not set out cancellation terms for this event. You can cancel your ' +
                    'place at any time from your events; anything owed back to you is handled by the host.'}
              </p>
            </div>
          </Panel>
        </section>

        {session && !profile && (
          <div className="mt-8">
            <NeedsSignIn what="your booking" to={`/e/${slug}`} />
          </div>
        )}
      </article>
    </EventShell>
  )
}

/* -------------------------------------------------------------------------- */
/* Ticket options                                                              */
/* -------------------------------------------------------------------------- */

/**
 * ORG-04 and EVT-04. Every option with its price and currency spelled out, and
 * its own availability where it has one.
 *
 * Radio inputs rather than styled buttons, because a radio group is what this
 * is: arrow keys move between the options, the label is clickable, and a
 * screen reader announces "2 of 3" without any of it being reimplemented.
 */
function TicketOptions({
  types,
  chosen,
  onChoose,
}: {
  types: TicketType[]
  chosen: string | null
  onChoose: (id: string) => void
}) {
  return (
    <fieldset className="mt-4">
      <legend className="sr-only">Choose a ticket</legend>
      <div className="space-y-3">
        {types.map((type) => {
          // ORG-04. `remaining`, not `quantity`. `quantity` is the cap the
          // organiser typed; a check constraint keeps it above zero and
          // nothing ever decrements it, so this test read `20 <= 0` forever
          // and the branch below it was unreachable — the option stayed
          // selectable and advertised "20 left" while the last place went.
          // `remaining` is counted the way enforce_event_capacity counts, so
          // the page now refuses the option at the same moment the database
          // would.
          const gone = type.remaining !== null && type.remaining !== undefined && type.remaining <= 0
          const left = type.remaining ?? null
          return (
            <label
              key={type.id}
              className={`flex cursor-pointer items-start gap-3 rounded-[6px] border px-4 py-3.5 transition-colors ${
                chosen === type.id ? 'border-fg bg-raised' : 'border-line hover:border-line-strong'
              } ${gone ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="ticket-type"
                value={type.id}
                checked={chosen === type.id}
                disabled={gone}
                onChange={() => onChoose(type.id)}
                className="mt-1 accent-[#1f5c56]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-sm font-medium text-fg">{type.name}</span>
                  <span className="text-sm tabular-nums text-fg">{priceLabel(type)}</span>
                </span>
                {gone ? (
                  <span className="mt-1 block text-xs text-[#8a4b00]">
                    This ticket has sold out
                  </span>
                ) : left !== null && left <= 10 ? (
                  <span className="mt-1 block text-xs text-muted">
                    {left === 1 ? 'One left' : `${left} left`}
                  </span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
