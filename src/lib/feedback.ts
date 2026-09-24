import type { EventRecord } from './events'

export type FeedbackEvent = Pick<
  EventRecord,
  'id' | 'slug' | 'status' | 'starts_at' | 'ends_at' | 'timezone' | 'feedback_opens_after_minutes'
>

export function feedbackOpensAt(event: FeedbackEvent): number {
  return Date.parse(event.ends_at ?? event.starts_at) + event.feedback_opens_after_minutes * 60_000
}

/** Attendance, not account role or registration, grants access. The RPC enforces this too. */
export function feedbackAvailability(event: FeedbackEvent, attended: boolean, now: number) {
  if (event.status === 'cancelled') return 'cancelled'
  if (now < feedbackOpensAt(event)) return 'waiting'
  return attended ? 'open' : 'attendance_required'
}
