/**
 * Signed in, every page navigates from the left sidebar and only from there:
 *
 *   node scripts/check-shell.mjs
 *
 * Why this exists. "I want all the roles to have only left sidebar." Admin had
 * one; the connector, member and event pages still carried their links in the
 * top bar, so moving between an admin screen and an event changed where the
 * navigation was — the same complaint the single SiteHeader was built to end.
 * The fix put every signed-in frame through AppShell, which draws the sidebar
 * from navLinks() and wears `<SiteHeader nav={false} />` on top.
 *
 * Nothing in the types keeps it that way. `<SiteHeader />` with its default
 * `nav` compiles on any page, and the next new screen that reaches for it
 * instead of DashboardShell puts a second navigation back in the bar. So this
 * asserts the shape, not the pages that were fixed:
 *
 *   (a) no file renders `<SiteHeader>` with navigation where a signed-in
 *       reader can see it — only AppShell (nav={false}), EventShell's
 *       anonymous branch, and the public pages that only visitors reach;
 *   (b) SiteHeader itself never draws navLinks() — its links are publicLinks()
 *       and only while nobody is signed in;
 *   (c) DashboardShell, AdminLayout and EventShell's signed-in branch still go
 *       through AppShell;
 *   (d) ManagedEventGate's loading, failed and denied states go through
 *       DashboardShell, the door scanner's included — before, all three were
 *       frameless pages with no sidebar;
 *   (e) no route returns a full-page frame of its own (a min-h-screen div, or
 *       <PageLoader />) for a signed-in state — Feedback's spinner was one.
 *       Allowed: auth still loading, the anonymous branch after
 *       `if (signedIn) { return … }`, the public pages, and CheckIn.tsx.
 *   (f) the refusal screens in App.tsx — WrongPlace and RequireMember's
 *       not-a-member branch — draw their <Panel> inside <AppShell>. A signed-in
 *       person who lands somewhere not theirs keeps the sidebar to leave by.
 *       NotProvisioned (no profile, so no sidebar to draw) is exempt.
 *   (g) ManageShell draws no tab bar of its own: no <Link>/<NavLink>/navigate
 *       in it, and it hands the event's pages to the sidebar as `sideContext`.
 *       A row of route-changing tabs above the content is a second navigation.
 *   (h) no tab bar anywhere: DashboardShell takes no `tabs`, and no file keeps
 *       the old tab plumbing (activeTab, onTabChange, setTab, <Tab>/<Tabs>,
 *       role="tablist"). "I need them as different page but not as same
 *       page" — each former tab is its own address in the sidebar.
 *   (i) no two sidebar links share an address, for any role. navLinks(),
 *       homePathFor() and ADMIN_LINKS are lifted out of the source, stripped
 *       of types and run against a synthetic profile of each role, under every
 *       combination of the feature flags.
 *   (j) exactly one sidebar link is lit on every page a reader's sidebar
 *       offers, and on the pages that stand in for one (a ticket, a feedback
 *       form, a hosted event's guests). AppShell's activeLink() and its aliases
 *       are lifted and run against each role's sidebar. The refusal screens —
 *       WrongPlace, RequireMember's refusal and "belongs to somebody else" —
 *       are exempt by name (REFUSALS): they sit at an address that is not the
 *       reader's, so nothing lit is the truth there (decision 23).
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const norm = (p) => p.replace(/\\/g, '/')
const read = (p) => readFileSync(p, 'utf8')
const lineOf = (source, index) => source.slice(0, index).split('\n').length

/**
 * Pages only an anonymous visitor reaches. A signed-in person hitting them is
 * sent home by the route itself, so a public header there is correct.
 */
const PUBLIC = new Set([
  'src/routes/Landing.tsx',
  'src/components/AuthLayout.tsx',
  'src/routes/SignIn.tsx',
  'src/routes/Join.tsx',
  'src/routes/ForgotPassword.tsx',
  'src/routes/ResetPassword.tsx',
])

/**
 * True when `index` sits after an `if (signedIn) { … return … }` block in the
 * same function — the anonymous branch of an early-return shell (EventShell).
 */
function anonymousBranch(source, index) {
  const at = source.slice(0, index).lastIndexOf('if (signedIn) {')
  if (at < 0) return false
  const block = source.slice(at).match(/^if \(signedIn\) \{([\s\S]*?)\n  \}/)
  if (!block || !/\breturn\b/.test(block[1])) return false
  const end = at + block[0].length
  return end <= index && !/\bfunction\s/.test(source.slice(end, index))
}

/**
 * Every `<SiteHeader …>` in a file that would show navigation to a signed-in
 * reader. Allowed: an explicit nav={false}, a render guarded on the same
 * expression by `!signedIn`, or one in the anonymous branch after a signed-in
 * early return (EventShell).
 */
function headerOffences(source) {
  const out = []
  for (const m of source.matchAll(/<SiteHeader\b([^>]*)>/g)) {
    if (/\bnav\s*=\s*\{\s*false\s*\}/.test(m[1])) continue
    const lineStart = source.lastIndexOf('\n', m.index) + 1
    if (/!\s*signedIn\s*&&/.test(source.slice(lineStart, m.index))) continue
    if (anonymousBranch(source, m.index)) continue
    out.push(lineOf(source, m.index))
  }
  return out
}

/** The text of `function name(…) { … }`, to its closing brace at column 0. */
function functionText(source, name) {
  const start = source.search(new RegExp(`function ${name}\\b`))
  if (start < 0) return null
  const end = source.slice(start).search(/\n\}\r?\n/)
  return end < 0 ? null : source.slice(start, start + end + 2)
}

/**
 * Returns in ManagedEventGate that skip the sidebar frame. Allowed: the ready
 * state's children and DashboardShell. 0 = no DashboardShell anywhere in it.
 */
function gateOffences(gate) {
  const out = []
  for (const m of gate.matchAll(/^.*\breturn\b.*$/gm)) {
    const line = m[0]
    if (/return\s*<>\s*\{\s*children\(/.test(line)) continue
    if (/return\s*\(?\s*<DashboardShell\b/.test(line)) continue
    out.push(lineOf(gate, m.index))
  }
  if (!/<DashboardShell\b/.test(gate)) out.push(0)
  return out
}

/**
 * A full-page frame a route draws for itself: a min-h-screen/h-screen div, or
 * <PageLoader /> (which is one). Allowed: `if (loading) return <PageLoader />`
 * while auth settles, and the anonymous branch after a signed-in return.
 */
function frameOffences(source) {
  const out = []
  for (const m of source.matchAll(/<div\b[^>]*\b(?:min-h-(?:screen|dvh|svh)|h-screen)\b[^>]*>|<PageLoader\b/g)) {
    const lineStart = source.lastIndexOf('\n', m.index) + 1
    if (/if\s*\(\s*(?:auth)?[lL]oading\s*\)\s*return\s*$/.test(source.slice(lineStart, m.index))) continue
    if (anonymousBranch(source, m.index)) continue
    out.push(lineOf(source, m.index))
  }
  return out
}

/**
 * Route-changing controls ManageShell draws itself (line numbers in it), plus
 * 0 when it no longer passes its pages to the sidebar as `sideContext`.
 */
function manageShellOffences(shell) {
  const out = []
  for (const m of shell.matchAll(/<(?:Nav)?Link\b|\buseNavigate\b|\bnavigate\s*\(/g)) out.push(lineOf(shell, m.index))
  if (!/\bsideContext\s*=/.test(shell)) out.push(0)
  return out
}

/**
 * <Panel>s in a function that sit outside every <AppShell>…</AppShell> span.
 * 0 = the function draws no Panel at all (the screen moved; update the check).
 */
function refusalOffences(fn) {
  const spans = [...fn.matchAll(/<AppShell\b[\s\S]*?<\/AppShell>/g)].map((m) => [m.index, m.index + m[0].length])
  const panels = [...fn.matchAll(/<Panel\b/g)]
  if (panels.length === 0) return [0]
  return panels.filter((m) => !spans.some(([a, b]) => a < m.index && m.index < b)).map((m) => lineOf(fn, m.index))
}

const files = sourceFiles('src').map(norm)
assert.ok(files.length > 0, 'found no source files to check — has src/ moved?')

const offences = []

// (a)
for (const file of files) {
  if (PUBLIC.has(file)) continue
  for (const line of headerOffences(read(file))) {
    offences.push(`${file}:${line}: <SiteHeader> with navigation where a signed-in reader sees it — use AppShell, or nav={false}`)
  }
}

// (b) The component, from its declaration to the end of the file.
const HEADER = 'src/components/SiteHeader.tsx'
const header = read(HEADER)
const start = header.search(/export function SiteHeader\b/)
assert.ok(start >= 0, `${HEADER} no longer declares SiteHeader — update this check`)
const body = header.slice(start)
const drawn = body.search(/\bnavLinks\s*\(/)
if (drawn >= 0) offences.push(`${HEADER}:${lineOf(header, start + drawn)}: SiteHeader draws navLinks() — that list belongs to AppShell's sidebar`)
if (!/\bpublicNav\s*=\s*nav\s*&&\s*!\s*signedIn\b/.test(body)) {
  offences.push(`${HEADER}: \`publicNav\` is no longer \`nav && !signedIn\` — a signed-in reader could get top-bar links`)
}
if (!/\bentries\s*=\s*publicNav\s*\?\s*publicLinks\(\)\s*:\s*\[\]/.test(body)) {
  offences.push(`${HEADER}: the bar's links are no longer \`publicNav ? publicLinks() : []\``)
}

// (c)
const through = (file, scope = read(file)) => {
  if (!/<AppShell\b/.test(scope)) offences.push(`${file}: no longer renders through <AppShell> — the sidebar is gone from it`)
}
through('src/components/DashboardShell.tsx')
through('src/routes/admin/AdminLayout.tsx')
{
  const file = 'src/routes/events/shared.tsx'
  const source = read(file)
  // The block that `if (signedIn)` opens, up to the anonymous return after it.
  const branch = source.match(/if\s*\(\s*signedIn\s*\)\s*\{([\s\S]*?)\n  \}/)
  if (!branch) offences.push(`${file}: EventShell has no \`if (signedIn) { … }\` branch any more — update this check`)
  else through(file, branch[1])
}

// (d)
{
  const file = 'src/routes/manage/shared.tsx'
  const gate = functionText(read(file), 'ManagedEventGate')
  if (!gate) offences.push(`${file}: ManagedEventGate is gone — update this check`)
  else for (const line of gateOffences(gate)) {
    offences.push(`${file}: ManagedEventGate${line ? ` (line ${line} of it)` : ''} returns a state outside DashboardShell`)
  }
}

// (g)
{
  const file = 'src/routes/manage/shared.tsx'
  const shell = functionText(read(file), 'ManageShell')
  if (!shell) offences.push(`${file}: ManageShell is gone — update this check`)
  else for (const line of manageShellOffences(shell)) {
    offences.push(`${file}: ManageShell ${line ? `(line ${line} of it) draws a route-changing control — its pages belong in the sidebar` : 'no longer passes its pages to the sidebar as sideContext'}`)
  }
}

// (e) Routes only; the gate's own frame is (d)'s business.
const FRAMELESS = new Set([...PUBLIC, 'src/routes/manage/CheckIn.tsx'])
for (const file of files) {
  if (!file.startsWith('src/routes/') || FRAMELESS.has(file)) continue
  let source = read(file)
  const gate = file === 'src/routes/manage/shared.tsx' && functionText(source, 'ManagedEventGate')
  if (gate) source = source.replace(gate, gate.replace(/[^\n]/g, ' '))
  for (const line of frameOffences(source)) {
    offences.push(`${file}:${line}: a full-page frame of its own for a signed-in state — render it inside DashboardShell or EventShell`)
  }
}

// (f)
{
  const file = 'src/App.tsx'
  const app = read(file)
  for (const name of ['WrongPlace', 'RequireMember']) {
    const fn = functionText(app, name)
    if (!fn) { offences.push(`${file}: ${name} is gone — update this check`); continue }
    for (const line of refusalOffences(fn)) {
      offences.push(`${file}: ${name}${line ? ` (line ${line} of it)` : ''} ${line ? 'draws its refusal outside <AppShell>' : 'draws no <Panel> any more — update this check'}`)
    }
  }
}

// (h)
/** Lines that still carry tab plumbing: a tab bar by any of its old names. */
function tabOffences(source) {
  const out = []
  for (const m of source.matchAll(/\b(?:activeTab|onTabChange|setTab)\b|<Tabs?\b|\brole\s*=\s*\{?\s*["'`]tablist["'`]/g)) out.push(lineOf(source, m.index))
  return out
}
for (const file of files) {
  for (const line of tabOffences(read(file))) {
    offences.push(`${file}:${line}: tab plumbing — make each tab its own page with its own sidebar link`)
  }
}
{
  const file = 'src/components/DashboardShell.tsx'
  const shell = functionText(read(file), 'DashboardShell')
  if (!shell) offences.push(`${file}: DashboardShell is gone — update this check`)
  else if (/\btabs\b/.test(shell)) offences.push(`${file}: DashboardShell takes \`tabs\` again — a tab bar is a second navigation`)
}

// (i)
/** Addresses that appear more than once in one sidebar. */
function repeatedAddresses(tos) {
  return [...new Set(tos.filter((to, i) => tos.indexOf(to) !== i))]
}

/**
 * Every address one role's sidebar lists, as AppShell builds it: the admin
 * sections first for an administrator, then navLinks() with the Dashboard leaf
 * skipped for them (roleGroups' skipHome).
 */
function sidebarAddresses(sidebar, profile, features) {
  const { navLinks, ADMIN_LINKS } = sidebar(features)
  const admin = profile.role === 'admin'
  const tos = admin ? ADMIN_LINKS.map((l) => l.to) : []
  for (const entry of navLinks(profile)) {
    if ('items' in entry) tos.push(...entry.items.map((l) => l.to))
    else if (!(admin && entry.label === 'Dashboard')) tos.push(entry.to)
  }
  return tos
}

/** navLinks(), what it calls and AppShell's activeLink(), lifted from the source and run as plain JS. */
function loadSidebar() {
  const auth = read('src/context/AuthProvider.tsx')
  const shell = read('src/components/AppShell.tsx')
  const list = (source, name) => source.match(new RegExp(`const ${name}\\b[\\s\\S]*?\\r?\\n\\]\\r?\\n`))?.[0]
  const parts = [
    ...['needsOnboarding', 'needsQuestionnaire', 'isNetworkMember', 'homePathFor'].map((n) => [n, functionText(auth, n)]),
    ['questionnaireDone', functionText(read('src/lib/questionnaire.ts'), 'questionnaireDone')],
    ['navLinks', functionText(header, 'navLinks')],
    ['ADMIN_LINKS', list(read('src/lib/adminNav.ts'), 'ADMIN_LINKS')],
    ['ALIASES', list(shell, 'ALIASES')],
    ['ADMIN_ALIASES', shell.match(/const ADMIN_ALIASES\b.*\r?\n/)?.[0]],
    ['activeLink', functionText(shell, 'activeLink')],
  ]
  for (const [name, text] of parts) assert.ok(text, `could not find ${name} in the source — update this check`)
  const js = ts.transpileModule(parts.map(([, text]) => text.replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return (features) => new Function('FEATURES', `${js}\nreturn { navLinks, ADMIN_LINKS, activeLink }`)(features)
}

const ANSWERED = { completed_at: '2026-01-01' }
const PROFILES = {
  admin: { role: 'admin', network_member: true, current_profession: null },
  connector: { role: 'connector', network_member: true, current_profession: 'Founder' },
  member: { role: 'user', network_member: true, current_profession: 'Founder', profile_answers: ANSWERED },
  'member still answering the questionnaire': { role: 'user', network_member: true, current_profession: 'Founder', profile_answers: null },
  'event-only account': { role: 'user', network_member: false, current_profession: 'Founder' },
  'member still onboarding': { role: 'user', network_member: true, current_profession: null },
  'event-only account still onboarding': { role: 'user', network_member: false, current_profession: null },
}
const sidebar = loadSidebar()
let sidebarsChecked = 0
for (const feed of [false, true]) {
  for (const events of [false, true]) {
    for (const [who, profile] of Object.entries(PROFILES)) {
      sidebarsChecked++
      const twice = repeatedAddresses(sidebarAddresses(sidebar, profile, { feed, events }))
      if (twice.length) offences.push(`src/components/SiteHeader.tsx: navLinks() gives the ${who} (feed ${feed}, events ${events}) ${twice.join(', ')} twice in the sidebar`)
    }
  }
}
assert.ok(
  sidebarAddresses(sidebar, PROFILES.connector, { feed: false, events: true }).includes('/connector/invitations'),
  'the lifted navLinks() no longer lists a connector\'s Invitations — is the check reading the right function?',
)
// An event-only account's sidebar is the same before and after onboarding.
assert.deepEqual(
  sidebarAddresses(sidebar, PROFILES['event-only account still onboarding'], { feed: true, events: true }),
  sidebarAddresses(sidebar, PROFILES['event-only account'], { feed: true, events: true }),
  'an event-only account still onboarding gets a different sidebar from one that has finished',
)

// Decision 1. Still answering, a member keeps their events as well.
{
  const tos = sidebarAddresses(sidebar, PROFILES['member still answering the questionnaire'], { feed: true, events: true })
  for (const to of ['/questions', '/events', '/events/mine', '/events/mine/past', '/events/mine/cancelled', '/profile']) {
    if (!tos.includes(to)) offences.push(`src/components/SiteHeader.tsx: navLinks() no longer gives a member still answering the questionnaire ${to}`)
  }
  if (tos.includes('/home')) offences.push('src/components/SiteHeader.tsx: navLinks() offers /home to a member RequireRole holds at /questions')
}

// (j)
const EVERYONE = ['admin', 'connector', 'member', 'event-only account', 'member still answering the questionnaire']
/** Pages with no link of their own, and who reaches them. Each lights one of that reader's links. */
const STAND_INS = [
  ['/events/tickets/1', EVERYONE],
  ['/events/feedback/dinner', EVERYONE],
  ['/e/dinner', EVERYONE],
  ['/manage/events/42/guests', ['admin', 'connector']],
  ['/admin/events/42', ['admin']],
  ['/connector/stripe/return', ['connector']],
]
/**
 * Decision 23. Refusal screens, exempt by name from "one link lit": the reader
 * is somewhere that is not theirs, and the sidebar is only the way out.
 */
const REFUSALS = [
  ['connector', '/admin/waitlist', 'WrongPlace'],
  ['member', '/manage/events', 'WrongPlace'],
  ['event-only account', '/circle', "RequireMember's refusal"],
  ['member', '/manage/events/42', 'belongs to somebody else'],
]
/** Pages in `pages` ([address, expected link?]) where the sidebar lights nothing, or the wrong link. */
function unlit(activeLink, tos, admin, pages) {
  const groups = [{ links: tos.map((to) => ({ to })) }]
  return pages
    .filter(([page, expect]) => {
      const lit = activeLink(page, groups, admin)
      return lit === null || (expect !== undefined && lit !== expect)
    })
    .map(([page]) => page)
}
let pagesLit = 0
{
  const features = { feed: true, events: true }
  const { activeLink } = sidebar(features)
  for (const [who, profile] of Object.entries(PROFILES)) {
    const tos = sidebarAddresses(sidebar, profile, features)
    const refused = REFUSALS.filter(([r]) => r === who).map(([, page]) => page)
    for (const page of refused) {
      if (tos.includes(page)) offences.push(`scripts/check-shell.mjs: ${page} is exempt as a refusal for the ${who}, but it is in their sidebar — drop the exemption`)
    }
    const pages = [
      ...tos.map((to) => [to, to]),
      ...STAND_INS.filter(([, whom]) => whom.includes(who)).map(([page]) => [page]),
    ].filter(([page]) => !refused.includes(page))
    pagesLit += pages.length
    for (const page of unlit(activeLink, tos, profile.role === 'admin', pages)) {
      offences.push(`src/components/AppShell.tsx: the ${who} on ${page} does not see exactly its own link lit`)
    }
  }
}

for (const offence of offences) console.error(`  FAIL  ${offence}`)
assert.equal(offences.length, 0, `${offences.length} place(s) where a signed-in reader would navigate from the top bar`)

// The guard is only worth having if it can fail. Known bad, then known good.
assert.deepEqual(headerOffences(`return <>\n  <SiteHeader />\n</>`), [2], 'the check no longer sees a bare <SiteHeader />')
assert.deepEqual(headerOffences(`<SiteHeader nav />`), [1], 'the check no longer sees <SiteHeader nav />')
assert.deepEqual(headerOffences(`<SiteHeader\n  nav={true}\n/>`), [1], 'the check no longer sees a wrapped nav={true}')
assert.deepEqual(headerOffences(`<SiteHeader nav={false} />`), [], 'the check rejects nav={false}')
assert.deepEqual(headerOffences(`<SiteHeader\n  nav={ false }\n/>`), [], 'the check rejects a wrapped nav={false}')
assert.deepEqual(headerOffences(`{!signedIn && !loading && <SiteHeader />}`), [], 'the check rejects the anonymous branch')
assert.deepEqual(
  headerOffences(`function Shell() {\n  if (signedIn) {\n    return <AppShell />\n  }\n  return <SiteHeader />\n}`),
  [],
  'the check rejects the anonymous branch after a signed-in return',
)
assert.deepEqual(
  headerOffences(`function A() {\n  if (signedIn) {\n    return <AppShell />\n  }\n}\nfunction B() {\n  return <SiteHeader />\n}`),
  [7],
  'a signed-in return in another function excuses a header',
)
assert.deepEqual(
  gateOffences(`function ManagedEventGate() {\n  if (result.state === 'loading') return <PageLoader />\n  return <DashboardShell>{body}</DashboardShell>\n}`),
  [2],
  'the check no longer sees a gate state returned without DashboardShell',
)
assert.deepEqual(
  gateOffences(`function ManagedEventGate() {\n  if (result.state === 'ready') return <>{children(result.data)}</>\n  return <DashboardShell title="Event">{body}</DashboardShell>\n}`),
  [],
  'the check rejects the gate as fixed',
)
assert.deepEqual(
  gateOffences(`function ManagedEventGate() {\n  if (bare) return <div>{body}</div>\n  return <DashboardShell title="Event">{body}</DashboardShell>\n}`),
  [2],
  'the check no longer sees a bare opt-out from the gate frame',
)
assert.deepEqual(
  manageShellOffences(`function ManageShell() {\n  return <DashboardShell>\n    <nav>{TABS.map((t) => <NavLink to={t.path} />)}</nav>\n  </DashboardShell>\n}`),
  [3, 0],
  'the check no longer sees a tab bar in ManageShell',
)
assert.deepEqual(
  manageShellOffences(`function ManageShell() {\n  return <DashboardShell sideContext={{ label, links }}>{children}</DashboardShell>\n}`),
  [],
  'the check rejects ManageShell handing its pages to the sidebar',
)
assert.deepEqual(
  frameOffences(`return (\n  <div className="flex min-h-screen items-center justify-center text-dim">\n    <Spinner />`),
  [2],
  'the check no longer sees a bare full-page spinner',
)
assert.deepEqual(frameOffences(`if (result.state === 'loading') return <PageLoader />`), [1], 'the check no longer sees a bare <PageLoader /> for data')
assert.deepEqual(frameOffences(`if (loading) return <PageLoader />`), [], 'the check rejects the auth-loading loader')
assert.deepEqual(frameOffences(`<Shell>\n  <div className="flex justify-center py-24 text-dim">`), [], 'the check rejects a spinner inside a shell')
assert.deepEqual(
  refusalOffences(`function WrongPlace() {
  return (
    <div className="ambient">
      <Panel>no</Panel>
    </div>
  )
}`),
  [4],
  'the check no longer sees a refusal drawn without AppShell',
)
assert.deepEqual(
  refusalOffences(`function RequireMember() {
  return ok ? <>{children}</> : (
    <AppShell>
      <main><Panel>no</Panel></main>
    </AppShell>
  )
}`),
  [],
  'the check rejects a refusal inside AppShell',
)
assert.deepEqual(
  refusalOffences(`function X() {
  return <>
    <AppShell><main /></AppShell>
    <Panel>no</Panel>
  </>
}`),
  [4],
  'a Panel after a closed AppShell passes as inside it',
)

assert.deepEqual(tabOffences(`const [activeTab, setActiveTab] = useState('a')`), [1], 'the check no longer sees activeTab')
assert.deepEqual(tabOffences(`<DashboardShell\n  onTabChange={setTab}\n/>`), [2, 2], 'the check no longer sees onTabChange/setTab')
assert.deepEqual(tabOffences(`<div role="tablist">\n  <Tab to="a" />`), [1, 2], 'the check no longer sees role="tablist" or <Tab>')
assert.deepEqual(tabOffences(`const table = <Table />\n// a tabular list\nsetTable(x)`), [], 'the check mistakes Table/setTable for tabs')
assert.deepEqual(repeatedAddresses(['/a', '/b', '/a', '/a']), ['/a'], 'the check no longer sees a repeated address')
assert.deepEqual(repeatedAddresses(['/admin/raised', '/connector/raised']), [], 'the check treats different addresses as one')
{
  const fake = () => ({
    ADMIN_LINKS: [{ to: '/admin/events' }],
    navLinks: () => [{ to: '/admin', label: 'Dashboard' }, { label: 'Events', items: [{ to: '/admin/events' }] }],
  })
  assert.deepEqual(repeatedAddresses(sidebarAddresses(fake, { role: 'admin' }, {})), ['/admin/events'], 'the check no longer sees a group repeating an admin section')
  assert.deepEqual(sidebarAddresses(fake, { role: 'member' }, {}), ['/admin', '/admin/events'], "the check no longer counts a member's Dashboard leaf")
}

{
  const { activeLink } = sidebar({ feed: true, events: true })
  assert.deepEqual(unlit(activeLink, ['/events'], false, [['/questions', '/questions']]), ['/questions'], 'the check no longer sees a page that lights nothing')
  assert.deepEqual(unlit(activeLink, ['/events', '/events/mine'], false, [['/events/mine', '/events/mine']]), [], 'the check rejects the longest match')
  assert.deepEqual(unlit(activeLink, ['/admin/events', '/admin/events/past'], true, [['/admin/events/past', '/admin/events/past']]), [], "the check lights Upcoming on the admin's Past")
  assert.deepEqual(unlit(activeLink, ['/events', '/events/mine'], false, [['/events/mine', '/events']]), ['/events/mine'], 'the check no longer sees the wrong link lit')
}

console.log(`ok    exactly one sidebar link lit on ${pagesLit} pages; ${REFUSALS.length} refusal screens exempt by name`)
console.log(`ok    no signed-in top-bar navigation across ${files.length} source files`)
console.log('ok    SiteHeader offers publicLinks() to visitors only, never navLinks()')
console.log('ok    DashboardShell, AdminLayout and signed-in EventShell go through AppShell')
console.log("ok    ManagedEventGate's states go through DashboardShell, the door scanner's included")
console.log("ok    ManageShell draws no tab bar; its pages are the sidebar's first section")
console.log('ok    no route draws a full-page frame of its own for a signed-in state')
console.log('ok    WrongPlace and RequireMember refuse inside AppShell')
console.log('ok    no tab bar: DashboardShell takes no tabs, and no file keeps activeTab, onTabChange, setTab, <Tab> or role="tablist"')
console.log(`ok    no sidebar repeats an address — ${sidebarsChecked} sidebars (${Object.keys(PROFILES).length} roles x 4 flag settings)`)
console.log('ok    the check still recognises a bare <SiteHeader />, a bare gate state, a ManageShell tab bar, a bare spinner, a bare refusal, tab plumbing and a repeated sidebar address')
console.log('\nSigned in, the sidebar is the only navigation.')
