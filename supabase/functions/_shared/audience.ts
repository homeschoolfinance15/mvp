// ============================================================================
// audience — who hears an event message
//
// One resolver, imported by both halves of the email engine:
//
//   event-email   resolves at enqueue time, when a person or a UI asks for a
//                 message to go out.
//   event-mailer  resolves at send time, for a message that arrived in the
//                 queue with no recipients — which is every reminder and
//                 every feedback_open, because schedule_event_messages()
//                 writes the event_messages row in SQL and nothing in SQL
//                 has ever written event_message_recipients.
//
// It lives here rather than in either function because two audience resolvers
// that can disagree is how a message goes to the wrong people, or to nobody,
// and reads as though it went to everybody. There is one definition of who
// hears a thing and both callers use it.
//
// Resolving is always a *starting point*, never the final word. EML-07 says
// the list is re-checked at send time whenever it was built, which is why
// computing the audience early — in SQL, at schedule time, days ahead — would
// have been wrong even if it had been written.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

/**
 * The service-role client's type, taken from an actual call rather than from
 * `ReturnType<typeof createClient>`. With no generated `Database` type,
 * `createClient`'s schema generics fall back to their *constraints* when read
 * off the bare signature, which resolves to `never` and makes every real
 * client unassignable to it. Same shape as stripe-webhook, which hit it first.
 */
const clientOfOurs = (url: string, key: string) => createClient(url, key)
export type Db = ReturnType<typeof clientOfOurs>

/**
 * `cohost` is not in EML-01's table. It is here because it already existed and
 * worked: the original event-email sent it, and dropping it in the move to a
 * queue would have deleted a working email nobody decided to remove — the
 * regression QLT-06 exists to prevent. EML-01 enumerates what the spec
 * requires and does not forbid more, and §13 excludes nothing relevant.
 *
 * On the merits too: ORG-05 supports more than one named host, and a cohost
 * can edit the event, invite people, scan tickets and issue refunds. Being
 * handed that without being told is worse than being told.
 */
export type MessageKind =
  | 'confirmation'
  | 'payment'
  | 'reminder'
  | 'invite'
  | 'cohost'
  | 'update'
  | 'cancelled'
  | 'attendee_cancelled'
  | 'refund'
  | 'feedback_open'

export const KINDS: MessageKind[] = [
  'confirmation',
  'payment',
  'reminder',
  'invite',
  'cohost',
  'update',
  'cancelled',
  'attendee_cancelled',
  'refund',
  'feedback_open',
]

/** These are about one named person, so they carry a profile_id. */
export const PERSONAL: MessageKind[] = [
  'confirmation',
  'payment',
  'refund',
  'attendee_cancelled',
  'cohost',
]

/**
 * Money is only ever queued by the function that moved it. A browser asking
 * for a payment or refund email would be asserting something it cannot know.
 */
export const SERVICE_ONLY: MessageKind[] = ['confirmation', 'payment', 'refund']

/**
 * The kinds whose audience is a property of the *event*, so the dispatcher can
 * work it out from the event_messages row alone.
 *
 * The rest are about one named person whose id lives only on the recipient
 * row, so a message of those kinds that arrives with no recipients cannot be
 * resolved by anybody — see planFor().
 */
export const RESOLVABLE: MessageKind[] = [
  'reminder',
  'invite',
  'update',
  'cancelled',
  'feedback_open',
]

export interface Person {
  profile_id: string
  email: string
}

/**
 * What to do with a claimed message, given how many recipient rows it has.
 *
 * This exists as its own function because getting it wrong is silent. The
 * dispatcher used to treat "no recipients" as "everybody has had it" and mark
 * the message `sent` — so every scheduled reminder and every feedback request
 * was recorded as delivered without a single email being sent, which is worse
 * than failing, because the organiser's history said it went.
 *
 *   send          there are recipients; dispatch to the ones still pending
 *   resolve       no recipients and we can work out who they are
 *   unresolvable  no recipients and nobody can work out who they were
 *
 * `unresolvable` is never `sent`. "Resolved, and nobody qualified" and "never
 * resolved" are different facts and the queue has to be able to tell them
 * apart.
 */
export type Plan = 'send' | 'resolve' | 'unresolvable'

export function planFor(kind: MessageKind, recipientsOnFile: number): Plan {
  if (recipientsOnFile > 0) return 'send'
  return RESOLVABLE.includes(kind) ? 'resolve' : 'unresolvable'
}

/**
 * EML-05. "Currently registered" means a confirmed registration — free and
 * paid alike, because a free place and a paid place are the same commitment
 * to be somewhere. A cancelled registration is out, and so is a purchase that
 * never completed: a registration still sitting at 'pending' is a place being
 * held during checkout, not a person who is coming.
 *
 * A cancellation is wider than that and feedback is narrower — see
 * unresolved() and the feedback_open branch. A cancellation has to be queued
 * before the registrations are cancelled, or there is nobody left to tell.
 */
export async function resolveAudience(
  db: Db,
  kind: MessageKind,
  eventId: string,
  profileId: string,
): Promise<Person[]> {
  if (PERSONAL.includes(kind)) {
    // Without a named person there is nothing to resolve. Returning empty
    // here is not "nobody qualified" — planFor() keeps the two apart.
    return profileId ? addressesFor(db, [profileId]) : []
  }

  if (kind === 'invite') {
    // One named person, or everybody still waiting to be invited — which is
    // how a freshly published event mails its whole list in one call rather
    // than one invocation per guest.
    const query = db
      .from('event_invites')
      .select('profile_id')
      .eq('event_id', eventId)
      .eq('send_status', 'queued')
    const { data } = profileId ? await query.eq('profile_id', profileId) : await query
    const ids = ((data ?? []) as { profile_id: string }[]).map((r) => r.profile_id)

    // A host is not a guest of their own event. Somebody who is both on the
    // invite list and hosting hears the `cohost` message and not this one —
    // otherwise being made a cohost would arrive twice, once as "you are
    // hosting this" and once as "you are invited to this", which contradict
    // each other. The original filtered hosts out here for the same reason.
    const { data: hosts } = await db.rpc('event_host_ids', { p_event: eventId })
    const hostIds = ((hosts ?? []) as { profile_id: string }[]).map((h) => h.profile_id)

    // Only people actually on the list, so this can never be used to mail
    // somebody who was never invited.
    return addressesFor(db, withoutHosts(ids, hostIds))
  }

  if (kind === 'feedback_open') {
    // FDB-06. Verified attendance, not a ticket: "Buying a ticket, receiving
    // an invitation, or RSVPing alone is insufficient." Mailing a no-show a
    // link to a form that will refuse them is exactly the dead end QLT-02
    // exists to prevent.
    const query = db.from('event_attendance').select('profile_id').eq('event_id', eventId)
    const { data } = profileId ? await query.eq('profile_id', profileId) : await query
    const ids = [...new Set(((data ?? []) as { profile_id: string }[]).map((r) => r.profile_id))]
    return addressesFor(db, ids)
  }

  if (kind === 'cancelled') return addressesFor(db, await unresolved(db, eventId))

  const { data } = await db
    .from('event_registrations')
    .select('profile_id')
    .eq('event_id', eventId)
    .eq('status', 'confirmed')
  const ids = [...new Set(((data ?? []) as { profile_id: string }[]).map((r) => r.profile_id))]
  return addressesFor(db, ids)
}

/**
 * EML-01's cancellation row is deliberately wider than "who is registered":
 * "Affected attendees **and anyone with an unresolved booking/payment
 * obligation**."
 *
 * Three separate populations, because none of them implies the others:
 *
 *   - a registration at 'confirmed' or 'pending' — 'pending' is somebody
 *     mid-checkout, who is precisely the person most in need of the email;
 *   - an order still at 'pending' or 'paid' — money that has moved, or is
 *     moving, and now has nothing to buy;
 *   - an open refund, which survives its order going to 'refunded' or
 *     'cancelled' and so is missed by any query that looks at orders alone.
 *
 * Deduped by profile: one person hears once (EML-06).
 */
async function unresolved(db: Db, eventId: string): Promise<string[]> {
  const [{ data: regs }, { data: orders }] = await Promise.all([
    db
      .from('event_registrations')
      .select('profile_id')
      .eq('event_id', eventId)
      .in('status', ['confirmed', 'pending']),
    db.from('event_orders').select('id, profile_id, status').eq('event_id', eventId),
  ])

  const orderRows = (orders ?? []) as { id: string; profile_id: string; status: string }[]
  let refundOrderIds: string[] = []
  if (orderRows.length > 0) {
    const { data: refunds } = await db
      .from('event_refunds')
      .select('order_id')
      .in('order_id', orderRows.map((o) => o.id))
      .in('status', ['requested', 'processing', 'needs_attention'])
    refundOrderIds = ((refunds ?? []) as { order_id: string }[]).map((r) => r.order_id)
  }

  return unresolvedProfiles((regs ?? []) as { profile_id: string }[], orderRows, refundOrderIds)
}

/** The union itself, with the reading already done. Pure — self-checked. */
export function unresolvedProfiles(
  registrations: { profile_id: string }[],
  orders: { id: string; profile_id: string; status: string }[],
  openRefundOrderIds: string[],
): string[] {
  const ids = new Set(registrations.map((r) => r.profile_id))
  const byOrder = new Map(orders.map((o) => [o.id, o.profile_id]))
  for (const o of orders) {
    if (o.status === 'pending' || o.status === 'paid') ids.add(o.profile_id)
  }
  for (const orderId of openRefundOrderIds) {
    const profileId = byOrder.get(orderId)
    if (profileId) ids.add(profileId)
  }
  return [...ids]
}

/** Guests who are not also hosts. Pure — self-checked. */
export function withoutHosts(ids: string[], hostIds: string[]): string[] {
  return ids.filter((id) => !hostIds.includes(id))
}

/** Addresses live on profiles, which is why this runs with the service role. */
export async function addressesFor(db: Db, ids: string[]): Promise<Person[]> {
  if (ids.length === 0) return []
  const { data } = await db
    .from('profiles')
    .select('id, email')
    .in('id', ids)
    // Somebody suspended or removed is not written to. The dispatcher asks
    // again at send time — this only keeps the queue honest to begin with.
    .eq('profile_status', 'active')
  return ((data ?? []) as { id: string; email: string | null }[])
    .filter((p): p is { id: string; email: string } => Boolean(p.email))
    .map((p) => ({ profile_id: p.id, email: p.email }))
}
