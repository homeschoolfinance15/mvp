import { useCallback, useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { Button, CopyCode, LoadFailed, Notice, Panel, Spinner } from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import {
  eventLink,
  type EventRecord,
  type EventTicket,
  type RegistrationStatus,
} from '../../lib/events'
import { loadFailed, supabase } from '../../lib/supabase'
import { EventShell, NeedsSignIn, WhenWhere, useLoader } from './shared'

/**
 * The thing you hold at the door. BUY-10, BUY-11, BUY-12.
 *
 * Designed for the twenty seconds it is actually used in: a phone held up in
 * a doorway, probably in the dark, by somebody who has not looked at this
 * screen since they booked. So the code is the largest thing on it, the name
 * and the event sit directly under it so a host can read both without
 * scrolling, and everything else waits below the fold.
 *
 * BUY-11 is the rule that matters most here. A revoked or cancelled ticket
 * shows **no scannable code at all** — not a greyed-out one, not one behind a
 * warning. A code on a screen is an invitation to try it, and a door in a
 * queue is the worst possible place to discover that it does not work.
 *
 * QLT-05. The id in the address says which ticket, never whose. The query
 * asks for this person's own row and nobody else's, so changing a digit
 * returns nothing rather than returning somebody else's evening.
 */

interface TicketRow extends EventTicket {
  events: EventRecord | null
  event_registrations: {
    status: RegistrationStatus
    ticket_types: { name: string } | null
  } | null
}

async function loadTicket(id: string, profileId: string): Promise<TicketRow | null> {
  const { data, error } = await supabase
    .from('event_tickets')
    .select('*, events(*), event_registrations(status, ticket_types(name))')
    .eq('id', id)
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) throw error
  return (data as TicketRow | null) ?? null
}

export default function Ticket() {
  const { id = '' } = useParams()
  const { session, profile, loading: authLoading } = useAuth()
  const profileId = profile?.id ?? null

  const load = useCallback(
    () => (profileId ? loadTicket(id, profileId) : Promise.resolve(null)),
    [id, profileId],
  )
  const { data: ticket, loading, failed, reload } = useLoader<TicketRow | null>(load, [
    id,
    profileId,
  ])

  if (authLoading || loading) {
    return (
      <EventShell>
        <div className="flex justify-center py-24 text-dim">
          <Spinner />
        </div>
      </EventShell>
    )
  }

  // BUY-12. The usual way somebody arrives here is a link in an email they
  // have since lost, followed on a device that was never signed in.
  if (!session || !profile) {
    return (
      <EventShell>
        <div className="py-12">
          <NeedsSignIn what="your ticket" to={`/events/tickets/${id}`} />
        </div>
      </EventShell>
    )
  }

  if (failed) {
    return (
      <EventShell back={{ to: '/events/mine', label: 'My events' }}>
        <div className="py-12">
          <LoadFailed what="your ticket" onRetry={() => void reload()} />
        </div>
      </EventShell>
    )
  }

  /*
   * No row. Either there is no such ticket or it is not this person's, and
   * those two are deliberately told apart by nothing at all — confirming that
   * a ticket exists but belongs to somebody else is itself a leak.
   */
  if (!ticket || !ticket.events) {
    return (
      <EventShell back={{ to: '/events/mine', label: 'My events' }}>
        <div className="mx-auto max-w-md py-20 text-center">
          <h1 className="display text-3xl">We can&rsquo;t find that ticket</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            The link may have been cut short, or this ticket may belong to a different account. Any
            ticket of your own will be listed under my events.
          </p>
          <Link to="/events/mine" className="mt-8 inline-block">
            <Button variant="primary">My events</Button>
          </Link>
        </div>
      </EventShell>
    )
  }

  const event = ticket.events
  const registration = ticket.event_registrations
  const optionName = registration?.ticket_types?.name ?? null

  // BUY-11. Three ways a ticket stops being a way in, and all three end with
  // no code on the screen.
  const revoked = !!ticket.revoked_at
  const cancelledPlace = registration?.status === 'cancelled' || registration?.status === 'expired'
  const cancelledEvent = event.status === 'cancelled'
  const usable = !revoked && !cancelledPlace && !cancelledEvent

  return (
    <EventShell back={{ to: '/events/mine', label: 'My events' }}>
      <div className="mx-auto max-w-md space-y-6">
        {!usable && (
          <Notice tone="error">
            <strong>
              {cancelledEvent
                ? 'This event has been cancelled.'
                : cancelledPlace
                  ? 'Your place at this event was cancelled.'
                  : ticket.replaced_by
                    ? 'This ticket has been replaced.'
                    : 'This ticket has been cancelled.'}
            </strong>{' '}
            {cancelledEvent
              ? 'It is not going ahead, so there is nothing to scan. Anything owed back to you shows under my events.'
              : cancelledPlace
                ? 'It will not get you in. If that is not what you meant to happen, the host can put you back on the list.'
                : ticket.replaced_by
                  ? 'A newer ticket was issued in its place — that is the one to bring. It is listed under my events.'
                  : 'It will not get you in. Speak to the host if you were expecting to come.'}
          </Notice>
        )}

        <Panel className="px-6 py-8 text-center sm:px-8">
          {usable ? (
            <>
              {/* BUY-10. What the door scans. The code itself is random and
                  unguessable, which is the only reason showing it is safe. */}
              <QrCode code={ticket.code} />
              <p className="mt-5 text-xs text-dim">Show this at the door.</p>
              <div className="mt-3 flex justify-center">
                {/* If a scanner will not co-operate, a host can type it. */}
                <CopyCode code={ticket.code} size="sm" />
              </div>
            </>
          ) : (
            <div className="rounded-[6px] border border-dashed border-line-strong px-6 py-14 text-sm text-dim">
              There is no code to show for this ticket.
            </div>
          )}

          <div className="mt-8 border-t border-line pt-6 text-left">
            {/* BUY-10. Whose ticket, which event, which option — the three
                things a host on the door is checking against a list. */}
            <h1 className="text-lg leading-snug font-medium text-fg">{profile.full_name}</h1>
            <p className="mt-1 text-sm text-muted">
              <Link to={eventLink(event.slug)} className="hover:underline hover:underline-offset-4">
                {event.title}
              </Link>
            </p>
            {optionName && <p className="mt-1 text-xs text-dim">{optionName}</p>}

            <div className="mt-6 border-t border-line pt-6">
              <WhenWhere event={event} />
            </div>

            {/* BUY-10 and EVT-06. Entry instructions belong on the ticket,
                because this is the screen that is open when they arrive. */}
            {event.attendee_instructions && (
              <div className="mt-6 border-t border-line pt-6">
                <h2 className="eyebrow">Getting in</h2>
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                  {event.attendee_instructions}
                </p>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </EventShell>
  )
}

/* -------------------------------------------------------------------------- */
/* The code itself                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A QR of the ticket code, drawn to a canvas.
 *
 * The one thing on these five screens with no native browser equivalent, so
 * it is the one npm dependency: `qrcode`. Error correction is left at the
 * library's medium default — a phone screen does not get smudged, and a
 * higher level only makes the modules smaller and harder to scan in a dim
 * doorway.
 *
 * Drawn deliberately large and at a fixed pixel size rather than scaled by
 * CSS: a resampled QR is a QR that takes three attempts to read.
 */
function QrCode({ code }: { code: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const target = canvas.current
    if (!target) return
    QRCode.toCanvas(target, code, {
      width: 260,
      margin: 1,
      // Pure black on white. A tinted QR looks better and scans worse.
      color: { dark: '#000000', light: '#ffffff' },
    }).catch((e) => loadFailed(e, 'the code on your ticket'))
  }, [code])

  return (
    <canvas
      ref={canvas}
      // The code is not readable by a screen reader in any useful sense, so
      // the label says what the thing is and CopyCode below carries the text.
      role="img"
      aria-label="The QR code for your ticket"
      className="mx-auto h-[260px] w-[260px] max-w-full rounded-[4px] border border-line bg-white"
    />
  )
}
