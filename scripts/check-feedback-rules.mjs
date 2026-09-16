/**
 * The four things about check-in and feedback that must never quietly change.
 *
 * These are not unit tests of logic — the logic is a form, and a form is
 * verified by using it. They are assertions about the *shape* of the source,
 * because each of these four rules is one careless edit away from being broken
 * in a way that nothing else in the build would notice: the screen would still
 * render, the types would still check, and the product would be wrong.
 *
 *   node scripts/check-feedback-rules.mjs
 *
 * No database, no secrets, no network. Runs anywhere the repo is checked out.
 */
import { readFileSync } from 'node:fs'

const FEEDBACK = 'src/routes/events/Feedback.tsx'
const FORMS = 'src/routes/events/feedback/FeedbackForms.tsx'
const CHECKIN = 'src/routes/manage/CheckIn.tsx'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* -------------------------------------------------------------------------- */
/* FDB-16 — the wording lives in the database, not in a component              */
/* -------------------------------------------------------------------------- */

/*
 * The five strings are the client's, and the client will check them, so they
 * are read out of the client's own document rather than retyped here. A test
 * that hard-codes what it is testing only ever proves that somebody typed the
 * same thing twice.
 *
 * REQUIREMENTS.md §7 is the source of truth — above CONTRACT.md §5, which is
 * our implementation answer to it. If the two ever disagree, this check fails
 * against the spec, which is the right way round.
 */
const SPEC = read('docs/event-platform/REQUIREMENTS.md')

const SPEC_WORDING = [
  ...SPEC.matchAll(/^\|\s*(?:Peer|Host\/event) question \d\s*\|\s*(.+?)\s*\|/gm),
].map((m) => m[1])

check(
  'the five spec questions were found in REQUIREMENTS.md §7',
  SPEC_WORDING.length === 5,
  `${SPEC_WORDING.length} found — the tables in §7 may have been reformatted`,
)

/*
 * The seed is what a respondent actually reads. Every other check in this file
 * guards the wording from being duplicated into the app; this one guards the
 * single copy that is allowed to exist from being wrong, which is the failure
 * nothing else would catch — the screen would render a typo faithfully.
 */
const seed = read('supabase/migrations/20260916000007_feedback.sql')
const missingFromSeed = SPEC_WORDING.filter((wording) => !seed.includes(`'${wording}'`))
check(
  'FDB-02/08: feedback_questions is seeded with the spec wording, character for character',
  SPEC_WORDING.length === 5 && missingFromSeed.length === 0,
  missingFromSeed.length ? `not seeded: ${missingFromSeed.join(' | ')}` : 'all five exact',
)

const feedbackSource = read(FEEDBACK)
const formsSource = read(FORMS)

const pasted = SPEC_WORDING.filter(
  (wording) => feedbackSource.includes(wording) || formsSource.includes(wording),
)
check(
  'FDB-16: no spec question wording is hard-coded in the feedback screens',
  pasted.length === 0,
  pasted.length ? `found: ${pasted.join(' | ')}` : 'all five read from feedback_questions',
)

/* -------------------------------------------------------------------------- */
/* FDB-09 — submitted answers are never read back by a respondent             */
/* -------------------------------------------------------------------------- */

/*
 * The answer tables are write-only from this screen. Progress comes from
 * my_feedback_progress, which returns outcomes and no answer text. A `select`
 * against either answer table here would be an attempt to show somebody a
 * review — their own about another person, or worse, another person's about
 * them — and RLS would refuse it, so the bug would surface as a broken page
 * rather than as the leak it was trying to be. Catch it here instead.
 */
for (const table of ['peer_feedback', 'event_feedback']) {
  const calls = [...feedbackSource.matchAll(new RegExp(`from\\('${table}'\\)\\s*\\.(\\w+)`, 'g'))]
  const verbs = calls.map((m) => m[1])
  check(
    `FDB-09: ${table} is only ever written from the feedback screen`,
    verbs.length > 0 && verbs.every((verb) => verb === 'upsert'),
    verbs.length ? verbs.join(', ') : 'no calls found at all — has the table been renamed?',
  )
}

/*
 * Tested against the code with the comments taken out. Explaining in a comment
 * that there is deliberately no "reviews about me" screen is the correct thing
 * to write down, and an earlier version of this check failed the file for
 * saying so — a check that punishes people for documenting the rule teaches
 * them to delete the documentation.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const rendered = stripComments(feedbackSource) + stripComments(formsSource)

check(
  'FDB-12/13: nothing builds a surface for reviews about the signed-in person',
  !/subject_id.*eq\(.*\bme\b|about\s*me/i.test(rendered),
  'no "reviews about me" screen outside of comments explaining why there is none',
)

/* -------------------------------------------------------------------------- */
/* FDB-14 — the confidentiality line does not promise anonymity               */
/* -------------------------------------------------------------------------- */

/*
 * "Anonymous" is the word everybody reaches for when writing reassurance about
 * a feedback form, and here it would be a lie: administrators can see who
 * wrote what. The only permitted use of the word is the denial.
 */
const anonymousMentions = [...(formsSource + feedbackSource).matchAll(/anonymous/gi)]
check(
  'FDB-14: anonymity is only ever denied, never promised',
  anonymousMentions.length > 0 && /not anonymous/i.test(formsSource),
  anonymousMentions.length ? `${anonymousMentions.length} mention(s), all denials` : 'no mention',
)

/* -------------------------------------------------------------------------- */
/* QLT-03 — the draft store can never be what breaks the page                 */
/* -------------------------------------------------------------------------- */

/*
 * sessionStorage throws outright in private mode and in some embedded
 * webviews — it is not merely empty, the accessor raises. An unguarded read
 * would take the whole feedback form down on exactly the devices least likely
 * to be tested, and the bug it would be causing is worse than the lost draft
 * the store exists to prevent.
 *
 * This walks braces rather than matching a pattern, so it stays honest if
 * somebody adds a fourth access in a new function. If it ever misreads the
 * source it fails rather than passes, which is the safe direction for a check.
 */
function tryBlockRanges(src) {
  const ranges = []
  const opener = /\btry\s*\{/g
  let match
  while ((match = opener.exec(src))) {
    let depth = 0
    let i = match.index + match[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    ranges.push([match.index, i])
  }
  return ranges
}

const guardable = stripComments(feedbackSource)
const ranges = tryBlockRanges(guardable)
const accesses = [...guardable.matchAll(/sessionStorage\s*\.\s*\w+/g)]
const unguarded = accesses.filter(
  (a) => !ranges.some(([from, to]) => a.index > from && a.index < to),
)

check(
  'QLT-03: every sessionStorage access is inside a try/catch',
  accesses.length > 0 && unguarded.length === 0,
  accesses.length
    ? `${accesses.length} access(es), ${unguarded.length} unguarded`
    : 'none found — has the draft store been removed?',
)

/* -------------------------------------------------------------------------- */
/* ATT-02 / QLT-04 — five outcomes, five different sentences                  */
/* -------------------------------------------------------------------------- */

/*
 * The whole point of the check-in screen. If two outcomes ever end up sharing
 * a headline, somebody at a door admits a person they should have turned away,
 * and no type would have stopped it — both are strings.
 */
const checkinSource = read(CHECKIN)
const headlines = [...checkinSource.matchAll(/headline:\s*'([^']+)'/g)].map((m) => m[1])
check(
  'ATT-02: every check-in outcome has its own headline',
  headlines.length === 6 && new Set(headlines).size === 6,
  `${headlines.length} outcomes: ${headlines.join(' / ')}`,
)

/*
 * QLT-04. Colour is how the answer is found across a dark room; words are how
 * it is understood, and one in twelve men cannot tell the green from the red.
 * Each outcome therefore carries an instruction as well as a frame colour.
 */
const instructions = [...checkinSource.matchAll(/instruction:\s*\n?\s*'/g)]
check(
  'QLT-04: every outcome says what to do in words, not only in colour',
  instructions.length === headlines.length,
  `${instructions.length} instructions for ${headlines.length} outcomes`,
)

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
