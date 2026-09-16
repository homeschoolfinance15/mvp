/**
 * Things that are built but not switched on yet.
 *
 * Feed and Events are finished and shipped; the client wants to hold them back
 * until they have signed off on what those two should do. Rather than delete
 * working code and rebuild it later, each is one boolean here.
 *
 * A flag turned off hides the nav link AND blocks the route. Hiding only the
 * link leaves the page reachable by typing the address, by an old bookmark,
 * or by a notification that points at it — which is not "switched off", it is
 * "harder to find".
 *
 * To switch either back on: set it to true, and that is the whole change.
 */
export const FEATURES = {
  feed: false,
  /**
   * The event platform: public event pages, ticketing, check-in, feedback and
   * the organiser and administrator surfaces around them.
   *
   * On, because it replaces the basic event experience rather than sitting
   * beside it — the old members-only RSVP page is gone and this is what
   * `/events` now means. The flag stays as the kill switch: one boolean hides
   * every address in §4 of the contract and sends anyone following an old
   * link home, which is a safer thing to own than a half-reverted deploy.
   *
   * Switching it off does not touch data. Events, registrations, orders,
   * tickets, attendance and feedback all remain exactly where they are, and
   * turning it back on finds them (QLT-08).
   */
  events: true,
  /**
   * The post thread on an event page. Off on its own so events can be
   * switched on without the feed coming with them. Existing threads are
   * hidden, not deleted — and note they are ordinary feed posts, so they
   * reappear in the network feed when `feed` is switched on.
   */
  eventPosts: false,
} as const

export type FeatureName = keyof typeof FEATURES
