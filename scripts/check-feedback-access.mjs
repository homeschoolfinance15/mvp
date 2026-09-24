import assert from 'node:assert/strict'
import { feedbackAvailability, feedbackOpensAt } from '../src/lib/feedback.ts'

const event = {
  id: 'event', slug: 'community-dinner', status: 'published',
  starts_at: '2026-09-24T18:00:00Z', ends_at: '2026-09-24T20:00:00Z',
  timezone: 'America/New_York', feedback_opens_after_minutes: 120,
}
const opens = Date.parse('2026-09-24T22:00:00Z')
assert.equal(feedbackOpensAt(event), opens)
assert.equal(feedbackAvailability(event, true, opens - 1), 'waiting', 'no early access')
assert.equal(feedbackAvailability(event, true, opens), 'open', 'opens at the exact boundary')
assert.equal(feedbackAvailability(event, false, opens), 'attendance_required', 'registration or a privileged role cannot replace attendance')
assert.equal(feedbackAvailability({ ...event, status: 'cancelled' }, true, opens), 'cancelled', 'cancelled events never offer feedback')
assert.equal(feedbackAvailability({ ...event, status: 'cancelled' }, false, opens - 1), 'cancelled')
assert.equal(feedbackAvailability({ ...event, feedback_opens_after_minutes: 0 }, true, Date.parse(event.ends_at)), 'open', 'zero-delay event')
assert.equal(feedbackAvailability({ ...event, feedback_opens_after_minutes: 180 }, true, opens), 'waiting', 'custom delay is respected')
assert.equal(feedbackOpensAt({ ...event, ends_at: null }), Date.parse('2026-09-24T20:00:00Z'), 'open-ended event falls back to start')
assert.equal(feedbackOpensAt({ ...event, ends_at: '2026-09-24T16:00:00-04:00' }), opens, 'timezone offsets describe the same instant')
console.log('PASS feedback access: attendance, opening boundaries, cancellation, custom delay, and timezone handling')
