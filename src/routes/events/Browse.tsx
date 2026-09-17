import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, LoadFailed, Panel, Spinner } from '../../components/ui'
import { useLive } from '../../lib/live'
import {
  eventLink,
  eventWhen,
  eventWhere,
  priceLabel,
  type PublicEvent,
  type TicketType,
} from '../../lib/events'
import { EventShell, StateBadge, loadUpcomingEvents, remainingWords, useCovers, useLoader } from './shared'

/**
 * EVT-05. What is coming up, publicly.
 *
 * Deliberately a list and not a search. At this scale a member can read the
 * whole of what is on in a few seconds, and filters, categories and a search
 * box would all be machinery for a problem nobody has yet.
 * `ponytail: no filtering. Add a month picker when the list runs past a screen or two.`
 *
 * Every card carries the same four facts as the event page — when, where, how
 * much, and whether you can still come — so that following a link never
 * produces a surprise.
 */
export default function Browse() {
  const load = useCallback(() => loadUpcomingEvents(), [])
  const { data: events, loading, failed, reload } = useLoader<PublicEvent[]>(load, [])

  /*
   * ORG-03A. "Two places left" on a card somebody has had open for ten minutes
   * is the card telling them something that is no longer true, and they find
   * out at checkout. Watching registrations as well as the events themselves
   * is what makes that number move — capacity is counted from them, so an
   * event goes from open to sold out without its own row ever changing.
   *
   * Reloaded quietly: there is nothing here to lose, but swapping a read list
   * for a spinner because somebody elsewhere bought a ticket is its own kind
   * of rudeness.
   */
  useLive(['events', 'ticket_types', 'event_registrations'], () => void reload(true))

  const covers = useCovers((events ?? []).map((e) => e.cover_path))

  return (
    <EventShell>
      <header className="max-w-2xl border-b border-line pt-2 pb-8">
        <p className="brand-kicker text-[#1f5c56]">Where the network meets</p>
        <h1 className="display mt-4 text-4xl">What&rsquo;s coming up</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          Dinners, gatherings and rooms worth being in. Anyone can come to these &mdash; you do not
          need to be a member to take a place.
        </p>
      </header>

      {loading ? (
        <div className="flex justify-center py-24 text-dim">
          <Spinner />
        </div>
      ) : failed ? (
        <div className="pt-10">
          <LoadFailed what="what&rsquo;s coming up" onRetry={() => void reload()} />
        </div>
      ) : (events?.length ?? 0) === 0 ? (
        <div className="pt-10">
          <EmptyState>
            Nothing is on the calendar just now. New gatherings are added often &mdash; it is worth
            looking again in a week.
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-6 pt-10 sm:grid-cols-2 lg:grid-cols-3">
          {(events ?? []).map((event) => (
            <li key={event.id}>
              <EventCard
                event={event}
                coverUrl={event.cover_path ? covers[event.cover_path] : undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </EventShell>
  )
}

/**
 * The cheapest way in, which is what somebody scanning a list wants to know.
 * A free event says Free rather than nothing, because the absence of a price
 * is ambiguous and "free" is not.
 */
function fromPrice(types: TicketType[]): string {
  if (types.length === 0) return 'Free'
  const cheapest = types.reduce((low, t) => (t.price_cents < low.price_cents ? t : low))
  if (types.length === 1 || types.every((t) => t.price_cents === cheapest.price_cents)) {
    return priceLabel(cheapest)
  }
  return cheapest.price_cents === 0 ? 'From free' : `From ${priceLabel(cheapest)}`
}

function EventCard({ event, coverUrl }: { event: PublicEvent; coverUrl?: string }) {
  const where = eventWhere(event)
  const left = remainingWords(event)

  return (
    // The whole card is the link. A card with a separate "view" button inside
    // it is two targets for one intention, and on a phone the wrong one is
    // always under your thumb.
    <Link
      to={eventLink(event.slug)}
      className="group block h-full focus:outline-none"
      aria-label={`${event.title}, ${eventWhen(event)}`}
    >
      <Panel className="flex h-full flex-col overflow-hidden transition-colors group-hover:border-line-strong group-focus-visible:border-fg">
        {coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" className="h-40 w-full object-cover" />
        ) : (
          // Not every event has a photograph and an empty grey box looks
          // broken. A tinted band keeps the cards the same height instead.
          <div aria-hidden className="h-40 w-full bg-raised" />
        )}

        <div className="flex flex-1 flex-col px-5 py-5">
          {event.capacity_state !== 'open' && (
            <div className="mb-3">
              <StateBadge state={event.capacity_state} />
            </div>
          )}

          <h2 className="text-base leading-snug font-medium text-fg">{event.title}</h2>

          <p className="mt-2 text-xs leading-relaxed text-muted">{eventWhen(event)}</p>
          {where && <p className="mt-1 truncate text-xs text-dim">{where}</p>}

          <div className="mt-auto flex items-end justify-between gap-3 pt-5">
            <span className="text-sm font-medium tabular-nums text-fg">
              {fromPrice(event.ticket_types)}
            </span>
            {left && <span className="text-xs text-[#8a4b00]">{left}</span>}
          </div>
        </div>
      </Panel>
    </Link>
  )
}
