/**
 * The organiser dashboard's rules, with the JSX left out.
 *
 * Everything here decides something a person will act on — whether an email
 * goes out, what a blank check-in means, what a night actually took after
 * fees. None of it needs React, a database or a browser, so it lives apart
 * from the screens and `scripts/check-organiser.mjs` asserts it directly.
 *
 * Mirrors docs/event-platform/CONTRACT.md §3 and §6.
 */

import type { PayoutState } from '../connector/payouts'
import type {
  EventOrder,
  EventRecord,
  EventRefund,
  MessageKind,
  MessageStatus,
  RegistrationStatus,
} from '../../lib/events'

/* -------------------------------------------------------------------------- */
/* ORG-10 / EML-03 — what an attendee has to be told about                     */
/* -------------------------------------------------------------------------- */

/**
 * The six fields somebody would turn up to the wrong place or the wrong hour
 * for. Editing a description or a cover image changes nobody's evening, so it
 * does not interrupt the organiser with a notification question.
 *
 * Keyed by column name because the same keys go into
 * `event_messages.changed_details`, which the mailer reads back out.
 */
export const NOTIFIABLE_FIELDS = {
  starts_at: 'Start time',
  ends_at: 'End time',
  timezone: 'Timezone',
  venue_name: 'Venue',
  address: 'Address',
  attendee_instructions: 'Instructions for attendees',
} as const

export type NotifiableField = keyof typeof NOTIFIABLE_FIELDS

export type ChangedDetails = Record<string, { from: unknown; to: unknown }>

/** An empty box and a box that was never filled are the same thing to a reader. */
function normalise(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/**
 * What changed between the event as stored and the event as edited, limited to
 * the fields an attendee needs. Returns an empty object when nothing an
 * attendee cares about moved — which is how the editor knows not to ask.
 */
export function changedDetails(
  before: Partial<EventRecord>,
  after: Partial<EventRecord>,
): ChangedDetails {
  const out: ChangedDetails = {}
  for (const field of Object.keys(NOTIFIABLE_FIELDS) as NotifiableField[]) {
    const from = normalise(before[field])
    const to = normalise(after[field])
    if (from !== to) out[field] = { from: before[field] ?? null, to: after[field] ?? null }
  }
  return out
}

/**
 * EML-04. A preview is only honest about the draft it was built from. This is
 * that draft's identity: if it no longer matches, the organiser is looking at
 * an email describing details they have since changed again, and has to take
 * a fresh preview before anything is sent.
 */
export function previewFingerprint(draft: Partial<EventRecord>): string {
  return (Object.keys(NOTIFIABLE_FIELDS) as NotifiableField[])
    .map((field) => `${field}=${normalise(draft[field])}`)
    .join('|')
}

/* -------------------------------------------------------------------------- */
/* EML-01 / EML-02 — the nine automatic emails                                 */
/* -------------------------------------------------------------------------- */

/**
 * The table in REQUIREMENTS.md §8, EML-01, as the organiser needs to read it.
 *
 * It is keyed by *situation* rather than by message kind, because that is the
 * question an organiser actually has — "what will the people coming to my
 * event receive?" — and because one situation does not map to one kind. A paid
 * purchase is one email, not two: the payment message already states the
 * amount, that the place is confirmed and where the ticket is, which is the
 * combined email EML-01 permits, so the mailer suppresses the separate
 * registration confirmation when a paid order exists.
 *
 * Four columns, the same four the requirement has: the situation, what sets it
 * off, who receives it, and what it has to make clear. No longer shown as a
 * table; the sent list names a message by its situation. Only the reminder row
 * is the organiser's to switch (EML-02).
 */
export const AUTOMATIC_MESSAGES: Array<{
  /** The kinds in `event_messages` this row covers. */
  kinds: MessageKind[]
  situation: string
  trigger: string
  recipient: string
  makesClear: string
  organiserControlled: boolean
}> = [
  {
    kinds: ['confirmation'],
    situation: 'Free RSVP confirmed',
    trigger: 'Automatically, once the place is confirmed',
    recipient: 'The attendee',
    makesClear: 'That their place is confirmed, the event details, and how to reach their ticket.',
    organiserControlled: false,
  },
  {
    kinds: ['payment'],
    situation: 'Paid ticket confirmed',
    trigger: 'Automatically, once Stripe confirms the payment',
    recipient: 'The purchaser',
    makesClear:
      'The amount and currency, the payment status, how to reach the ticket, and the event details. ' +
      'This is one email, not two — it confirms the payment and the place together.',
    organiserControlled: false,
  },
  {
    kinds: ['reminder'],
    situation: 'The event is coming up',
    trigger: 'Automatically, at each reminder time set below',
    recipient: 'Everyone with a confirmed place at that moment',
    makesClear: 'The current time and location, and how to reach their ticket.',
    organiserControlled: true,
  },
  {
    kinds: ['invite'],
    situation: 'You invite somebody from your community',
    trigger: 'Automatically, once you select them and send',
    recipient: 'The person invited',
    makesClear:
      'Which event this is and who is hosting, your message if you wrote one, and a link to ' +
      'view, register or buy while places remain.',
    organiserControlled: false,
  },
  {
    kinds: ['update'],
    situation: 'The address, date, time or instructions change',
    trigger: 'Only when you choose to send it from the change flow',
    recipient: 'Everyone currently registered who is affected',
    makesClear: 'What changed, the replacement details, and a link to the current event page.',
    organiserControlled: false,
  },
  {
    kinds: ['attendee_cancelled'],
    situation: 'An attendee cancels their own place',
    trigger: 'Automatically, as the cancellation is recorded',
    recipient: 'The attendee who cancelled',
    makesClear: 'That their place is cancelled, and — separately — where their money stands.',
    organiserControlled: false,
  },
  {
    kinds: ['refund'],
    situation: 'A refund moves',
    trigger: 'Automatically, whenever the refund status changes',
    recipient: 'The purchaser',
    makesClear:
      'Requested, processing, completed or needs attention — whichever it actually is, never ' +
      'a guess ahead of the money.',
    organiserControlled: false,
  },
  {
    kinds: ['cancelled'],
    situation: 'You cancel the event',
    trigger: 'Automatically, as the cancellation is confirmed',
    recipient: 'Everyone affected, including anybody with an unresolved booking or payment',
    makesClear: 'That the event will not happen, and what becomes of their booking and their money.',
    organiserControlled: false,
  },
  {
    kinds: ['feedback_open'],
    situation: 'Feedback opens',
    trigger: 'Automatically, at the feedback-opening time set on the event',
    recipient: 'Everyone eligible to give feedback',
    makesClear:
      'How to give feedback inside Amazing. Submitted answers are never carried in an email, ' +
      'to anybody, ever.',
    organiserControlled: false,
  },
]

/* -------------------------------------------------------------------------- */
/* ORG-16 / EML-06 — reminder times                                            */
/* -------------------------------------------------------------------------- */

/** Offsets worth offering. Minutes, because that is what the column holds. */
export const REMINDER_CHOICES = [60, 180, 1440, 2880, 10080] as const

/** "1 day before", not "1440". */
export function reminderLabel(minutes: number): string {
  const units: Array<[number, string]> = [
    [10080, 'week'],
    [1440, 'day'],
    [60, 'hour'],
    [1, 'minute'],
  ]
  for (const [size, word] of units) {
    if (minutes % size === 0 && minutes >= size) {
      const n = minutes / size
      return `${n} ${word}${n === 1 ? '' : 's'} before`
    }
  }
  return `${minutes} minutes before`
}

export function reminderAt(startsAt: string, minutesBefore: number): Date {
  return new Date(new Date(startsAt).getTime() - minutesBefore * 60_000)
}

/**
 * EML-06. A reminder whose moment has already gone is not sent late — it is
 * skipped. The organiser is told that on screen rather than discovering it
 * from attendees who never got a reminder.
 */
export function reminderWillSkip(startsAt: string, minutesBefore: number, now = new Date()): boolean {
  return reminderAt(startsAt, minutesBefore).getTime() <= now.getTime()
}

/* -------------------------------------------------------------------------- */
/* ORG-12 / ORG-13 — what a past event actually took                           */
/* -------------------------------------------------------------------------- */

export interface Receipts {
  /** Money charged, before anything is taken off. Never "profit" (ORG-13). */
  grossCents: number
  feesCents: number
  /** Gross, less fees, less money already returned. Still not profit. */
  netCents: number
  refundedCents: number
  paidOrders: number
  refundedOrders: number
  currency: string
}

/**
 * ORG-13. Read off the payment records, never off the ticket prices: a price
 * edited after somebody bought does not change what they paid, and a refunded
 * order is not revenue. Gross, fees and net are three separate lines because
 * an organiser reading one number always reads the flattering one.
 */
export function receipts(
  orders: EventOrder[],
  refunds: EventRefund[],
  fallbackCurrency: string,
): Receipts {
  const counted = orders.filter(
    (o) => o.status === 'paid' || o.status === 'refunded' || o.status === 'partially_refunded',
  )
  const grossCents = counted.reduce((sum, o) => sum + o.amount_cents, 0)
  const feesCents = counted.reduce((sum, o) => sum + (o.fee_cents ?? 0), 0)

  // Only money that actually went back. A requested refund is a promise, and
  // showing it as returned would understate what is still owed.
  const returned = refunds.filter((r) => r.status === 'completed')
  const refundedCents = returned.reduce((sum, r) => sum + r.amount_cents, 0)

  return {
    grossCents,
    feesCents,
    netCents: grossCents - feesCents - refundedCents,
    refundedCents,
    paidOrders: counted.length,
    refundedOrders: new Set(returned.map((r) => r.order_id)).size,
    currency: counted[0]?.currency ?? fallbackCurrency,
  }
}

/* -------------------------------------------------------------------------- */
/* BUY-08 / BUY-09 / ORG-09 — a cancelled place with money still on it         */
/* -------------------------------------------------------------------------- */

/**
 * Where a cancelled attendee's money stands.
 *
 * This is the one thing on the organiser dashboard nobody is told about by
 * email. `event-refund` is host and admin only, deliberately — an attendee
 * cannot return their own money, because the terms they agreed to are the
 * host's to apply. And EML-01 sends the cancellation email to the attendee
 * alone; no host notification is specified. So the guest list is the only
 * place a host ever finds out that somebody cancelled a paid ticket and is
 * waiting on a decision. It has to be findable by somebody opening the page
 * cold a week later, not buried among five other payment values.
 *
 * `none` is the state that needs a person. The other three are already in
 * hand.
 */
export type MoneyState = 'not_paid' | 'none' | 'processing' | 'completed' | 'needs_attention'

export const MONEY_STATE_WORDS: Record<MoneyState, string> = {
  not_paid: 'Nothing was charged',
  none: 'Paid, and no refund has been raised',
  processing: 'Refund on its way',
  completed: 'Refunded',
  needs_attention: 'Refund needs attention',
}

/**
 * Read from the order and whatever refunds exist against it. A `requested`
 * refund counts as in hand — the money has been asked for and the same order
 * cannot be refunded twice while it sits there (BUY-09) — but it is reported
 * as on its way rather than returned, because it has not arrived.
 */
export function moneyState(order: EventOrder | null, refunds: EventRefund[]): MoneyState {
  if (!order || order.amount_cents === 0) return 'not_paid'
  if (order.status !== 'paid' && order.status !== 'refunded' && order.status !== 'partially_refunded') {
    return 'not_paid'
  }

  const mine = refunds.filter((r) => r.order_id === order.id)
  if (mine.some((r) => r.status === 'completed')) return 'completed'
  if (mine.some((r) => r.status === 'requested' || r.status === 'processing')) return 'processing'
  if (mine.some((r) => r.status === 'needs_attention' || r.status === 'failed')) {
    return 'needs_attention'
  }
  return 'none'
}

/**
 * ORG-09. Whether this row is a job waiting for the host: the place is gone,
 * the money is not, and nobody has decided anything about it yet.
 */
export function awaitsRefundDecision(
  registration: RegistrationStatus,
  money: MoneyState,
): boolean {
  return (registration === 'cancelled' || registration === 'expired') && money === 'none'
}

/* -------------------------------------------------------------------------- */
/* ATT-04 / ATT-06 — attendance, honestly                                      */
/* -------------------------------------------------------------------------- */

/**
 * ATT-04. A blank is only a no-show if somebody was actually checking people
 * in. If nothing was ever scanned or marked for this event, the door was not
 * run, and every guest's blank says so instead of accusing them of not coming.
 */
export function attendanceLabel(attended: boolean, checkInRan: boolean): string {
  if (attended) return 'Attended'
  return checkInRan ? 'Not checked in' : 'No check-in recorded'
}

/**
 * ATT-06, as corrected in CONTRACT.md §3 on 16 September.
 *
 * The rule is that a **guest** cannot mark themselves attended — not that
 * nobody can name themselves. A present host is a participant under FDB-06 and
 * their attendance has to be recorded even though they bought no ticket, and a
 * host running an event on their own has nobody else to record it. So "is this
 * person running the event" is the whole question, and `mark_attended()`
 * refuses anybody else whoever they name, which is stricter than a
 * not-yourself test: that one would still have let a guest write a row for a
 * friend.
 *
 * On the organiser dashboard the answer is always yes — `ManagedEventGate`
 * has already turned away anybody who does not host this event. It is a
 * function rather than a constant so the screen states the reason rather than
 * relying on the gate two files away.
 */
export function mayMarkAttended(actorHostsEvent: boolean): boolean {
  return actorHostsEvent
}

/* -------------------------------------------------------------------------- */
/* ACC-04 / ORG-01A — why the create button is not there                       */
/* -------------------------------------------------------------------------- */

/**
 * ORG-01A. A button that fails when pressed is worse than no button, and a
 * missing button with no explanation is nearly as bad. Returns the sentence to
 * show in the create button's place, or null when they may create.
 */
export function whyNoCreate(role: string | undefined, canCreateEvents: boolean): string | null {
  if (role === 'admin') return null
  if (role !== 'connector') {
    return 'Ask an administrator if you would like to host one.'
  }
  if (canCreateEvents) return null
  return 'Your account is not set up to create events yet. An administrator can switch this on for you. Events you already host are unaffected.'
}

/* -------------------------------------------------------------------------- */
/* BUY-13 / BUY-14 / §7.0, §7.2, §7.3 — whose money this is                    */
/* -------------------------------------------------------------------------- */

/**
 * The account an event's ticket money lands in, as far as a screen needs to
 * know it. `connectorId` null means Amazing's own Stripe (BUY-13): the
 * platform is either configured or it is not, which is a deployment question
 * rather than a row anybody here can read.
 */
export interface PaymentAccount {
  connectorId: string | null
  /** Whose community it is, for the sentence on screen. */
  name: string
  /** Whose account it is. A cohost reading about it is not the person who can fix it. */
  ownerId: string | null
}

/**
 * §7.0. Whoever created the event owns its money — resolved from `host_id`,
 * never from whoever happens to be editing. This is the sentence that says so
 * out loud, because BUY-14 asks for the responsible account to be clear
 * *before* sales open rather than discovered afterwards.
 */
export function paymentRecipientSentence(account: PaymentAccount, overridden: boolean): string {
  if (account.connectorId === null) {
    return overridden
      ? 'Ticket money for this event goes to Amazing, which an administrator chose deliberately.'
      : 'Ticket money for this event goes to Amazing’s own Stripe account.'
  }
  return overridden
    ? `Ticket money for this event goes to ${account.name}’s own Stripe account, which an administrator named deliberately.`
    : `Ticket money for this event goes to ${account.name}’s own Stripe account. They receive it, they pay Stripe’s fees, and refunds come out of their balance.`
}

/** ORG-05. Said next to the recipient every time, because it is the assumption people make. */
export const COHOST_MONEY_NOTE = 'Adding a cohost does not split the money.'

/** §7.2. Why the recipient cannot be changed any more, rather than a control that will fail. */
export function lockedSentence(lockedAt: string): string {
  return (
    `Somebody has already paid for a ticket (${new Date(lockedAt).toLocaleDateString()}), so the ` +
    'account that receives this event’s money is now fixed. Revenue for tickets already sold ' +
    'cannot be pointed somewhere else. Refunds go back through the account that took each payment.'
  )
}

/**
 * BUY-14. Where a payment problem gets fixed, and by whom.
 *
 * `event_sale_readiness()` answers whether this event can take money, and that
 * is all this screen takes from it — its `reason` and `fix_action` are state
 * codes, not sentences. The words belong to `payoutState()` in
 * src/routes/connector/payouts.ts, which already owns this vocabulary for the
 * connector's own payment screen and the administrator's view of that
 * connector. One set of words for the same restricted account, wherever it is
 * described.
 *
 * This map holds destinations and nothing else. No prose of its own: every
 * `outstanding` sentence already says what to do — "Continue on Stripe and
 * answer what it still asks for", "Stripe says what it needs ... in the
 * account dashboard" — so a second paragraph would restate what the organiser
 * has just read, on the one screen where the message already runs to three
 * sentences. The link is the part the sentence cannot carry.
 *
 * Keyed on the whole of `PayoutState['fix']`, so a fourth repair verb added
 * there is a missing key here and fails the build. A new verb almost certainly
 * wants a destination of its own, and a catch-all would quietly send it to the
 * connector's setup page — the wrong button, drawn confidently.
 */
const FIX_ACTIONS: Record<
  Exclude<PayoutState['fix'], null>,
  { href: string; label: string }
> = {
  connect: { href: '/connector/payments', label: 'Open payment setup' },
  continue: { href: '/connector/payments', label: 'Continue on Stripe' },
  stripe: { href: 'https://dashboard.stripe.com/', label: 'Finish this on Stripe' },
}

/** The repair verbs this screen knows. Asserted by scripts/check-organiser. */
export const FIX_VERBS = Object.keys(FIX_ACTIONS)

/**
 * The remedy to offer this reader, if any.
 *
 * The one judgement that belongs to an event screen rather than to
 * `payouts.ts`: *who is reading*. That module writes for the account holder on
 * their own payment page. An event dashboard is opened by cohosts and
 * administrators too, and only the account holder can connect, continue or
 * answer Stripe. `fix: 'stripe'` points at Stripe's own dashboard, which a
 * cohost has no login for at all — offering it to them is the wrong button
 * rather than a helpful one, so they are told who can act instead.
 */
export function remedyFor(
  fix: PayoutState['fix'],
  account: PaymentAccount | null,
  readerId: string | null,
): { href?: string; label: string } {
  // BUY-13. An Amazing-hosted event sells on the platform key; whether that is
  // configured is a deployment fact rather than a row, and nothing an
  // organiser can act on from here.
  if (!fix || !account?.connectorId) return { label: '' }

  return readerId === account.ownerId
    ? FIX_ACTIONS[fix]
    : { label: `Only ${account.name} can sort this out, on their own payment setup.` }
}

/* -------------------------------------------------------------------------- */
/* ORG-01 — a draft that is not ready to be seen                               */
/* -------------------------------------------------------------------------- */

/** Field-keyed so the editor can put each message under the box it belongs to. */
export function validateEvent(draft: Partial<EventRecord>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!normalise(draft.title)) errors.title = 'Give the event a title.'
  else if (normalise(draft.title).length > 200) errors.title = 'Keep the title to 200 characters or fewer.'
  if (!normalise(draft.starts_at)) errors.starts_at = 'Say when it starts.'
  if (
    draft.starts_at &&
    draft.ends_at &&
    new Date(draft.ends_at).getTime() < new Date(draft.starts_at).getTime()
  ) {
    errors.ends_at = 'The end time is before the start time.'
  }
  if (
    draft.capacity !== null &&
    draft.capacity !== undefined &&
    (!Number.isInteger(draft.capacity) || draft.capacity < 1)
  ) {
    errors.capacity = 'A limit has to be a whole number of places, at least one, or leave it empty for no limit.'
  }
  return errors
}

/** EVT-01. A readable, stable link. Uniqueness is the database's job. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'event'
  )
}

/* -------------------------------------------------------------------------- */
/* EML-08 — saved, queued, sent, and none of them is "delivered"               */
/* -------------------------------------------------------------------------- */

/**
 * Every state a queued message can be in, in words.
 *
 * "Sent" is the strongest one here on purpose. Resend tells us it accepted a
 * message, not that a mail server took it, not that a person opened it, and
 * the dashboard must not quietly upgrade one to the other (EML-08).
 */
export const MESSAGE_STATUS_WORDS: Record<MessageStatus, string> = {
  scheduled: 'Scheduled — waiting for its time',
  queued: 'Being sent now',
  sent: 'Sent to the mail provider',
  failed: 'Failed',
  cancelled: 'Cancelled before it went',
  skipped: 'Not sent — its moment had already passed',
}

/**
 * EML-06. `skipped` is the one status here that is neither a success nor a
 * problem, and it must not read as one.
 *
 * It happens for two reasons, and an organiser meets the first on the day they
 * create an event at short notice: a reminder set for further ahead than the
 * event itself is away. The second is a reschedule that moves the event
 * earlier, past a reminder that had not yet fired. Same state, different
 * cause, and neither is a fault — in both the reminder had simply stopped
 * meaning anything by the time its turn came, and firing it late would have
 * been the actual mistake.
 *
 * `tone` is what stops it sitting in red beside `failed`.
 */
export const MESSAGE_STATUS_TONE: Record<MessageStatus, 'good' | 'waiting' | 'bad' | 'inert'> = {
  scheduled: 'waiting',
  queued: 'waiting',
  sent: 'good',
  failed: 'bad',
  cancelled: 'inert',
  skipped: 'inert',
}

/** The explanation that goes under a skipped reminder, in the organiser's terms. */
export function skippedSentence(kind: MessageKind, error: string | null): string {
  if (kind !== 'reminder') {
    return (
      error ??
      'This was no longer the right thing to send by the time its turn came, so it was not sent.'
    )
  }
  return (
    'Nothing went wrong. This reminder was set for further ahead than the event was away, so its ' +
    'moment had already passed — either the event was created at short notice, or it was moved ' +
    'earlier. Sending it late would have told people about an event that had already started.'
  )
}

/**
 * Who a message of each kind went to, for the history's audience column.
 *
 * Partial on purpose. `event_messages.kind` is a database enum and the mailer
 * may carry a kind — `cohost` is the current one — before `src/lib/events.ts`
 * lists it. A history row for an unknown kind should read a little vaguely,
 * not crash the page an organiser opened to find out what went wrong.
 */
export const MESSAGE_AUDIENCE: Partial<Record<MessageKind, string>> & {
  [kind: string]: string | undefined
} = {
  confirmation: 'The person who registered',
  payment: 'The person who paid',
  reminder: 'Everyone with a confirmed place',
  invite: 'The people you invited',
  update: 'Everyone with a confirmed place',
  cancelled: 'Everyone holding or confirmed on a place',
  attendee_cancelled: 'The person who cancelled',
  refund: 'The person being refunded',
  feedback_open: 'Everyone who attended',
  // QLT-06. Existing behaviour: somebody handed the ability to edit an event,
  // invite to it, scan its door and refund its orders is told they have it.
  cohost: 'The person you added as a cohost',
}

/* -------------------------------------------------------------------------- */
/* ORG-7 — who can be marked as having been there                              */
/* -------------------------------------------------------------------------- */

/**
 * ORG-7. `mark_attended()` refuses anybody without a confirmed place or an
 * invitation to this event, so the button is not offered for them either — a
 * cancelled or expired registration is a person the host already let go.
 */
export function mayBeMarkedAttended(status: RegistrationStatus, invited: boolean): boolean {
  return status === 'confirmed' || invited
}

/* -------------------------------------------------------------------------- */
/* ORG-25 — the boxes speak the event's timezone                               */
/* -------------------------------------------------------------------------- */

/**
 * What `<input type="datetime-local">` should hold for `iso`, read on the
 * event's clock rather than the reader's. A London dinner edited from New York
 * shows 19:00, not 14:00.
 */
export function toZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/**
 * The inverse: a wall-clock time typed in `timeZone`, as an instant.
 *
 * Guess the instant as if the zone were UTC, measure how far the zone's clock
 * is from UTC at that guess, and correct; a second pass settles the guesses
 * that straddle a clock change. A time that does not exist (inside the spring
 * gap) lands an hour later, which is what calendar apps do too.
 */
export function fromZonedInput(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  const offsetAt = (t: number) => {
    const shown = toZonedInput(new Date(t).toISOString(), timeZone)
    return Date.parse(`${shown}:00Z`) - t
  }
  let t = wall - offsetAt(wall)
  t = wall - offsetAt(t)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** The reader's own zone: what a box with no event zone yet was typed in. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London'
}
