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
  events: false,
  /**
   * The post thread on an event page. Off on its own so events can be
   * switched on without the feed coming with them. Existing threads are
   * hidden, not deleted — and note they are ordinary feed posts, so they
   * reappear in the network feed when `feed` is switched on.
   */
  eventPosts: false,
} as const

export type FeatureName = keyof typeof FEATURES
