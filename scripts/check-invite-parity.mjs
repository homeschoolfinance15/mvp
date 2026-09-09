/**
 * The two rules that decide whether an invited member is asked what a
 * waitlist applicant was asked. Both are pure, so this needs no database:
 *
 *   node scripts/check-invite-parity.mjs
 *
 * Node strips the TypeScript types on import.
 */
import assert from 'node:assert/strict'
import {
  TRAVEL_DEFAULT_INDEX,
  TRAVEL_OPTIONS,
  questionnaireDone,
} from '../src/lib/questionnaire.ts'

/* The gate. Wrong in one direction it lets invited members past unasked;
   wrong in the other it locks everybody on /questions forever. */
assert.equal(questionnaireDone(null), false, 'no answers row yet')
assert.equal(questionnaireDone(undefined), false, 'embed missing')
assert.equal(questionnaireDone([]), false, 'empty array embed')
assert.equal(questionnaireDone({ completed_at: null }), false, 'row, never finished')
assert.equal(questionnaireDone([{ completed_at: null }]), false, 'array, never finished')
assert.equal(questionnaireDone({ completed_at: '2026-09-09T00:00:00Z' }), true, 'object embed')
assert.equal(questionnaireDone([{ completed_at: '2026-09-09T00:00:00Z' }]), true, 'array embed')

/* The slider. Every answer already in the database must be reachable, or
   editing a profile would silently move somebody's answer. */
for (const [i, option] of TRAVEL_OPTIONS.entries()) {
  assert.equal(
    TRAVEL_OPTIONS.findIndex((o) => o.id === option.id),
    i,
    `${option.id} maps to one slider position`,
  )
}
assert.ok(
  TRAVEL_OPTIONS[TRAVEL_DEFAULT_INDEX],
  'the default slider position is a real option',
)

console.log(`PASS  invite parity: gate and travel slider (${TRAVEL_OPTIONS.length} options)`)
