/**
 * Requirement IDs that reach the screen, found by reading the source:
 *
 *   node scripts/check-copy.mjs
 *
 * Why this exists. The screens were written against a numbered brief, and the
 * numbers leaked into the copy: "ORG-12. Registering, turning up and
 * cancelling are three different things." as a section caption, "(BUY-13)"
 * after a payee. An organiser has never seen the brief. To them it reads as
 * an error code, or as the product talking to itself.
 *
 * The IDs are useful in comments — they say which rule a line of code is
 * keeping — so this does not ban them from the source. It bans them from the
 * two places a user can read: JSX text, and string literals (captions, labels,
 * notices and messages are all passed as strings). Comments are not nodes in
 * the syntax tree, so reading the tree rather than the text is what keeps
 * them out of it; a hand-rolled scanner cannot tell the apostrophe in
 * "Amazing's" from the start of a string, and gets that wrong both ways.
 *
 * It asserts the *shape* — three capitals, a hyphen, a number — rather than a
 * list of the families in use today, so a new family is caught the day it is
 * first written.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
// Already a devDependency (tsc builds the app); nothing new is installed.
import ts from 'typescript'

// ORG-12, ORG-01A, ORG-08B, ACC-2. UTF-16 has the same shape and is not ours.
const REQUIREMENT_ID = /\b(?!UTF-)[A-Z]{3}-\d{1,2}[A-Z]?\b/

const RENDERABLE = new Set([
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
])

/** Every requirement ID a user could read in `source`, with its line. */
function offencesIn(name, source) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out = []
  const visit = (node) => {
    if (RENDERABLE.has(node.kind)) {
      const hit = node.text.match(REQUIREMENT_ID)
      if (hit) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        out.push(`${name}:${line + 1}: "${hit[0]}" is shown to users`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

// The guard is only worth having if it can fail. These are the forms that
// actually shipped, and the comments that must keep being allowed.
const KNOWN_BAD = [
  `<SectionHeader caption="ORG-12. Registering, turning up and cancelling." />`,
  `<span className="text-dim"> (BUY-13)</span>`,
  `<Explainer>\n  ATT-04. Nobody was checked in.\n</Explainer>`,
  "const note = `ORG-01A: switched on by ${who}`",
]
const KNOWN_GOOD = [
  `{/* ORG-14. Details and status first. */}\n<p>Amazing's own account</p>`,
  `// BUY-14. Whose Stripe account.\nconst a = 'Cohost — takes no share of the money'`,
  `/** QLT-02. The state in words. */\nconst s = "Stored as UTF-16"`,
]
for (const bad of KNOWN_BAD) {
  assert.equal(offencesIn('known-bad.tsx', bad).length, 1, `the check no longer catches: ${bad}`)
}
for (const good of KNOWN_GOOD) {
  assert.deepEqual(offencesIn('known-good.tsx', good), [], `the check now rejects: ${good}`)
}

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (entry.endsWith('.tsx')) {
      out.push(path)
    }
  }
  return out
}

const files = sourceFiles('src')
assert.ok(files.length > 0, 'found no source files to check — has src/ moved?')

const offences = files.flatMap((file) => offencesIn(file, readFileSync(file, 'utf8')))
for (const offence of offences) console.error(`  FAIL  ${offence}`)
assert.equal(
  offences.length,
  0,
  `${offences.length} requirement ID(s) in user-facing text — keep them in comments, reword the copy`,
)

console.log('ok    the check still catches IDs in copy, and ignores them in comments')
console.log(`ok    no requirement IDs in user-facing text across ${files.length} files`)
