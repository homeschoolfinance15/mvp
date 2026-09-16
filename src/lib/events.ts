/**
 * The event platform's shared vocabulary.
 *
 * Every screen in the event experience — public page, checkout, tickets,
 * organiser dashboard, check-in, feedback — reads the same rows out of
 * Postgres, so the row shapes are declared once, here, rather than being
 * re-typed slightly differently in each route.
 *
 * Mirrors docs/event-platform/CONTRACT.md §3. If a column changes there, it
 * changes here, and TypeScript finds everywhere that cared.
 *
 * Money is integer minor units throughout (`_cents`). Floats and currency do
 * not mix: 0.1 + 0.2 is not 0.3, and a ticket price is not worth debugging.
 */

/* -------------------------------------------------------------------------- */
/* Enums — these mirror Postgres types of the same name                        */
/* -------------------------------------------------------------------------- */

export type EventStatus = 'draft' | 'published' | 'cancelled'

export type RegistrationStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired'

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'cancelled'

export type RefundStatus =
  | 'requested'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'needs_attention'

export type MessageStatus =
  | 'scheduled'
  | 'queued'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/**
 * FDB-05. Four distinguishable states, because "I did not meet them" and "I
 * have not got to them yet" and "I chose not to answer" are three different
 * facts about a respondent, and none of them is an unfavourable review.
 */
export type FeedbackOutcome = 'pending' | 'skipped' | 'did_not_meet' | 'submitted'

/**
 * ORG-03A. Sold out and registration closed are deliberately separate: one is
 * the event filling up, the other is the organiser stopping sales early, and
 * an attendee reads them very differently.
 */
export type CapacityState = 'open' | 'sold_out' | 'closed' | 'cancelled' | 'finished'

/** ATT-02. Every outcome a scan can have, each with its own words on screen. */
export type CheckInResult = 'ok' | 'already' | 'wrong_event' | 'invalid' | 'cancelled'

export type MessageKind =
  | 'confirmation'
  | 'payment'
  | 'reminder'
  | 'invite'
  | 'update'
  | 'cancelled'
  | 'attendee_cancelled'
  | 'refund'
  | 'feedback_open'
  /**
   * "You are hosting this." Not in EML-01's table, which enumerates what the
   * spec requires rather than all a platform may send — this one predates the
   * rebuild and removing it would have quietly deleted a working email
   * (QLT-06). ORG-05 makes cohosting a real grant: they can edit, invite,
   * scan and refund, and being handed that without being told is worse.
   */
  | 'cohost'

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

export interface EventRecord {
  id: string
  host_id: string
  title: string
  description: string | null
  /** Legacy free-text location. venue_name/address are what new events fill. */
  location: string | null
  starts_at: string
  ends_at: string | null
  cover_path: string | null
  created_at: string

  status: EventStatus
  slug: string
  timezone: string
  venue_name: string | null
  address: string | null
  attendee_instructions: string | null
  refund_terms: string | null
  capacity: number | null
  registration_closed: boolean
  currency: string
  payment_connector_id: string | null
  payment_recipient_id: string | null
  published_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  feedback_opens_after_minutes: number
  /**
   * §7.2. Set the moment the first real payment lands, and from then on the
   * event's payment recipient is immutable — revenue for tickets already sold
   * cannot be retargeted. Null means no money has moved yet.
   */
  payment_locked_at: string | null
  /**
   * EML-08. When attendees were last told about a change to the details, or
   * null if there are unannounced changes — which is also the right answer for
   * an event nobody has ever sent an update about.
   *
   * Cleared by a trigger whenever a notifiable field moves (venue, address,
   * location, start, end, timezone, attendee instructions), and stamped when
   * an `update` message is queued. It is a column rather than screen state
   * because the organiser who needs the banner is often the cohost who arrives
   * tomorrow, not the one who made the edit.
   */
  details_notified_at: string | null
}

export interface TicketType {
  id: string
  event_id: string
  name: string
  price_cents: number
  currency: string
  /** Null means "no separate cap" — the event capacity is the only limit. */
  quantity: number | null
  /**
   * ORG-04. Places left on this option, composed by `attachAvailability` from
   * `ticket_type_availability`. Null when the option has no cap, and absent on
   * a ticket type read straight from the table rather than through that
   * helper — the organiser's editor, for one, which wants the cap and not the
   * count. Never read `quantity` to mean "left": it is the cap, it is never
   * decremented, and a check constraint keeps it above zero.
   */
  remaining?: number | null
  position: number
  is_active: boolean
  created_at: string
}

export interface EventRegistration {
  id: string
  event_id: string
  profile_id: string
  ticket_type_id: string | null
  status: RegistrationStatus
  /** BUY-06. A place held during checkout, released when the hold lapses. */
  hold_expires_at: string | null
  confirmed_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  /** BUY-15. The terms as they read when this person agreed to them. */
  terms_snapshot: string | null
  created_at: string
}

export interface EventOrder {
  id: string
  event_id: string
  /**
   * Null once the payer has closed their account.
   *
   * The order itself survives an erasure (`on delete set null`), because the
   * money moved regardless of who has since left, and an organiser opening
   * their event in March to find February's revenue has quietly dropped is
   * the practical harm §9 and ORG-13 are guarding against. The person stops
   * being identifiable; the payment stays reconcilable.
   */
  profile_id: string | null
  registration_id: string | null
  amount_cents: number
  fee_cents: number | null
  currency: string
  status: OrderStatus
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  /** Which Stripe account took the money. BUY-14 — never assume it is ours. */
  stripe_account_id: string | null
  terms_snapshot: string | null
  paid_at: string | null
  created_at: string
}

export interface EventRefund {
  id: string
  order_id: string
  amount_cents: number
  status: RefundStatus
  stripe_refund_id: string | null
  reason: string | null
  requested_by: string | null
  failure_message: string | null
  created_at: string
  updated_at: string
}

export interface EventTicket {
  id: string
  registration_id: string
  event_id: string
  profile_id: string
  /** What the QR encodes. Random, not derived — a guessable code is a free ticket. */
  code: string
  revoked_at: string | null
  replaced_by: string | null
  created_at: string
}

export interface EventAttendance {
  id: string
  event_id: string
  /** Null once that person has closed their account. The arrival still happened. */
  profile_id: string | null
  method: 'scan' | 'manual'
  ticket_id: string | null
  recorded_by: string | null
  recorded_at: string
  /**
   * ATT-06. True when a host corrected a missed check-in after the fact. The
   * correction is preserved as a correction — we do not invent a scan that
   * never happened or an arrival time nobody observed.
   */
  corrected: boolean
  reason: string | null
}

export interface EventInvite {
  id: string
  event_id: string
  profile_id: string
  invited_by: string
  /** ORG-08A. Which community made this person eligible to be invited. */
  via_connector_id: string | null
  message: string | null
  send_status: 'queued' | 'sent' | 'failed'
  /** EML-05A. Set when this row is a deliberate resend of an earlier invite. */
  resend_of: string | null
  sent_at: string | null
  created_at: string
}

export interface FeedbackQuestion {
  id: string
  scope: 'peer' | 'event'
  slot: number
  version: number
  wording: string
  answer_format: 'text' | 'choice' | 'scale'
  active: boolean
  created_at: string
}

export interface EventEmailSettings {
  event_id: string
  reminders_enabled: boolean
  updated_by: string | null
  updated_at: string
}

export interface EventReminder {
  id: string
  event_id: string
  minutes_before: number
  enabled: boolean
  created_at: string
}

export interface EventMessage {
  id: string
  event_id: string
  kind: MessageKind
  reminder_id: string | null
  scheduled_for: string | null
  status: MessageStatus
  subject: string | null
  body: string | null
  /** EML-04. What actually changed, so the email can name it precisely. */
  changed_details: Record<string, { from: unknown; to: unknown }> | null
  audience_count: number | null
  triggered_by: string | null
  sent_at: string | null
  error: string | null
  created_at: string
}

export interface EventMessageRecipient {
  id: string
  message_id: string
  profile_id: string
  email: string
  status: MessageStatus
  error: string | null
  sent_at: string | null
}

/** What `event_capacity_state(uuid)` hands back. */
export interface CapacityInfo {
  capacity: number | null
  confirmed: number
  remaining: number | null
  state: CapacityState
}

/** The anon-readable view: an event plus the host names, and no email addresses. */
export interface PublicEvent extends EventRecord {
  host_names: string[]
  capacity_state: CapacityState
  remaining: number | null
  ticket_types: TicketType[]
}

/* -------------------------------------------------------------------------- */
/* Words for states                                                            */
/* -------------------------------------------------------------------------- */

/**
 * QLT-02 and QLT-04: every state says what it is in plain words, not only in
 * a colour. One definition so the event page, the browse list and the
 * organiser dashboard cannot disagree about what an event is currently doing.
 */
export const CAPACITY_WORDS: Record<CapacityState, string> = {
  open: 'Registration open',
  sold_out: 'Sold out',
  closed: 'Registration closed',
  cancelled: 'Cancelled',
  finished: 'This event has finished',
}

export const REFUND_WORDS: Record<RefundStatus, string> = {
  requested: 'Refund requested',
  processing: 'Refund processing',
  completed: 'Refunded',
  failed: 'Refund failed',
  needs_attention: 'Refund needs attention',
}

/**
 * BUY-08. Attendance and money are two different questions, so they get two
 * different sentences. Never "refunded" until the refund actually completed.
 */
export function attendanceAndMoney(
  registration: RegistrationStatus,
  refund: RefundStatus | null,
): string {
  const place =
    registration === 'cancelled'
      ? 'Your attendance is cancelled'
      : registration === 'confirmed'
        ? 'Your place is confirmed'
        : registration === 'pending'
          ? 'Your place is being held while payment completes'
          : 'Your place has expired'

  return refund ? `${place}; ${REFUND_WORDS[refund].toLowerCase()}` : `${place}.`
}

/* -------------------------------------------------------------------------- */
/* Money and time                                                              */
/* -------------------------------------------------------------------------- */

/** EVT-04. Price and currency together, always — never a bare number. */
export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

export function priceLabel(type: TicketType): string {
  return type.price_cents === 0 ? 'Free' : money(type.price_cents, type.currency)
}

/**
 * EVT-02. An event happens in its own timezone, not the reader's. Someone
 * booking a London dinner from New York needs to see the London time, with
 * the zone named so they can do the arithmetic themselves.
 */
export function eventWhen(event: Pick<EventRecord, 'starts_at' | 'ends_at' | 'timezone'>): string {
  const tz = event.timezone
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: tz,
  })
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  })
  const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short', timeZone: tz })
    .formatToParts(new Date(event.starts_at))
    .find((p) => p.type === 'timeZoneName')?.value

  const start = new Date(event.starts_at)
  const opening = `${date.format(start)}, ${time.format(start)}`
  if (!event.ends_at) return `${opening} (${zone})`

  const end = new Date(event.ends_at)
  return date.format(end) === date.format(start)
    ? `${opening} – ${time.format(end)} (${zone})`
    : `${opening} until ${date.format(end)}, ${time.format(end)} (${zone})`
}

/** Where the event is. New events fill venue/address; old ones only have location. */
export function eventWhere(event: EventRecord): string | null {
  const parts = [event.venue_name, event.address].filter(Boolean)
  return parts.length ? parts.join(', ') : event.location
}

/** EVT-01. The link a host sends to anyone, account or no account. */
export function eventLink(slug: string): string {
  return `/e/${encodeURIComponent(slug)}`
}

/**
 * Whether registration can be attempted right now. The server enforces this
 * too — this is only so the screen does not offer a button that will fail.
 */
export function canRegister(state: CapacityState): boolean {
  return state === 'open'
}
