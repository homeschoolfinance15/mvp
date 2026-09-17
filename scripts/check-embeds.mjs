/**
 * PostgREST embeds that are ambiguous, found by reading the source:
 *
 *   node scripts/check-embeds.mjs
 *
 * Why this exists. `public.connectors` has two foreign keys to
 * `public.profiles` — `profile_id`, the connector's own account, and
 * `events_permission_changed_by`, which admin last moved their event
 * permission (ORG-01B, added by 20260916000002). PostgREST will not choose
 * between two paths: it refuses the request with "Could not embed because more
 * than one relationship was found for 'connectors' and 'profiles'".
 *
 * That shipped, and the administration screen's whole Connectors tab came back
 * empty with that sentence printed above it. The member dashboard lost the
 * connector who brought them in at the same time, by the same cause.
 *
 * It is worth being clear about why nothing caught it, because that is the
 * thing this file is trying to change. The query is valid TypeScript. The
 * types are right. `deno check` and `tsc` are both happy. It fails only
 * against a database that actually has both columns, so the only checks that
 * could have found it are the ones that need SB_URL and SB_SERVICE — and
 * those have never been run. A screenshot found it instead.
 *
 * So this asserts the *shape* rather than the three instances that were
 * wrong: no embed of `profiles` through `connectors` anywhere in src/ may go
 * unqualified, whichever file it lives in and whoever writes it next. The
 * admin area is being split into many files as this is written, and queries
 * are moving between them; a rule that named the three call sites would stop
 * applying the moment they moved.
 *
 * Adding a table here: put it in AMBIGUOUS below with the constraint that
 * should be named. Any table with two foreign keys to the same target belongs
 * in it.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * parent -> child embeds that must name their foreign key, and the one they
 * should almost always mean.
 */
const AMBIGUOUS = [
  {
    parent: 'connectors',
    child: 'profiles',
    constraint: 'connectors_profile_id_fkey',
    why: '`connectors.events_permission_changed_by` is a second foreign key to profiles (ORG-01B)',
  },
]

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

const files = sourceFiles('src')
assert.ok(files.length > 0, 'found no source files to check — has src/ moved?')

const offences = []

for (const { parent, child, constraint, why } of AMBIGUOUS) {
  // `connectors(… profiles( …` and `connectors:…(… profiles(`, across newlines,
  // which is how these appear once a select list is long enough to wrap. The
  // qualified form carries a `!` between the name and the bracket, so it is
  // the bare `profiles(` that is the fault.
  const nested = new RegExp(`${parent}\\s*(?::[a-z_]+)?\\s*\\([^)]*?\\b${child}\\s*\\(`, 'gs')

  for (const file of files) {
    const source = readFileSync(file, 'utf8')

    // A direct `.from('connectors').select('*, profiles(*)')`.
    //
    // Scoped to the select that belongs to THIS `.from()`, not to every select
    // in the file. The first version of this check asked "does the file
    // mention .from('connectors')?" and then judged every select in it, which
    // flagged ConnectorDashboard for a perfectly good
    // `.from('connector_user_links').select('… profiles(*) …')` sitting twenty
    // lines below an unrelated `.from('connectors').select('*')`. That embed
    // is unambiguous — connector_user_links has one foreign key to profiles —
    // and a check that cries wolf is worse than no check, because the next
    // person learns to skip the output.
    const from = new RegExp(`\\.from\\(['"]${parent}['"]\\)`, 'g')
    for (const match of source.matchAll(from)) {
      // The chain runs to the next `.from(` or the end of the statement,
      // whichever comes first. The select that matters is the first one in it.
      const rest = source.slice(match.index + match[0].length)
      const chain = rest.slice(0, Math.min(...[rest.search(/\.from\(/), 600].filter((n) => n > 0)))
      const select = chain.match(/\.select\(\s*(['"`])([\s\S]*?)\1/)
      if (select && new RegExp(`(^|[^!\\w])${child}\\s*\\(`).test(select[2])) {
        const line = source.slice(0, match.index).split('\n').length
        offences.push(`${file}:${line}: .from('${parent}') selects a bare \`${child}(\``)
      }
    }

    // A nested embed reached through the parent from some other table.
    for (const hit of source.match(nested) ?? []) {
      if (new RegExp(`(^|[^!\\w])${child}\\s*\\(`).test(hit)) {
        offences.push(`${file}: embeds a bare \`${child}(\` through \`${parent}(\``)
      }
    }
  }

  if (offences.length) {
    console.error(`\nAmbiguous embeds of ${child} through ${parent} — ${why}.`)
    console.error(`Name the constraint: ${child}!${constraint}(…)\n`)
    for (const offence of offences) console.error(`  FAIL  ${offence}`)
    console.error('')
  }
}

assert.equal(
  offences.length,
  0,
  `${offences.length} ambiguous PostgREST embed(s) — each one empties its screen at runtime`,
)

// The guard is only worth having if it can fail, and a regex that matches
// nothing passes quietly forever. This proves it still recognises the shape
// that actually shipped.
const KNOWN_BAD = `supabase.from('connectors').select('*, profiles(*)')`
const KNOWN_GOOD = `supabase.from('connectors').select('*, profiles!connectors_profile_id_fkey(*)')`
const bare = /(^|[^!\w])profiles\s*\(/
assert.ok(
  bare.test(KNOWN_BAD.match(/\.select\(\s*'([^']*)'/)[1]),
  'the check no longer recognises the embed that actually broke production',
)
assert.ok(
  !bare.test(KNOWN_GOOD.match(/\.select\(\s*'([^']*)'/)[1]),
  'the check would now reject the corrected form',
)

console.log(`ok    no ambiguous embeds across ${files.length} source files`)
console.log('ok    the check still recognises the form that broke, and accepts the fix')
console.log('\nEmbeds are unambiguous.')
