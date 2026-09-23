/**
 * Which database functions a browser can call, against a live database:
 *
 *   SB_URL=<url> SB_PUB=<publishable-key> SB_JWT_SECRET=<jwt-secret> \
 *     node scripts/check-function-grants.mjs
 *
 * Functions in public are closed to anon and authenticated unless a migration
 * grants them by name (20260923000901). This holds both halves of that:
 *
 *   - nothing is executable by anon unless it is on ALLOW_ANON below. A new
 *     function that forgot to revoke, or a grant to anon that nobody meant,
 *     fails here.
 *   - every supabase.rpc('<name>') in src, and every asCaller.rpc('<name>') in
 *     the edge functions (those run with the caller's token), is executable by
 *     authenticated. A new call whose migration forgot the grant fails here.
 *
 * It asks PostgREST rather than the catalogue: PostgREST's schema document
 * lists an /rpc/<name> path only for functions the requesting role may
 * execute, so it is the view the browser actually gets. The authenticated
 * token is minted with the project's JWT secret (no sign-in, so no rate limit,
 * and no user is needed: grants are per role). Local projects only; the
 * secret is printed by `npx supabase status -o env`.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Signed-out screens need lookup_code (/join, the landing page code box).
// The rest are read by the events_select and ticket_types_select policies,
// the public event views, and the check constraints on waitlist_entries,
// which call them as the reader.
const ALLOW_ANON = new Set([
  'lookup_code',
  'is_admin',
  'hosts_event',
  'has_event_booking',
  'event_visible',
  'event_host_ids',
  'event_capacity_state',
  'ranked_distinct',
  'tag_answer_ok',
  'tag_answer_count',
])

// .rpc('name'), .rpc<T>('name'), and the name on the line after .rpc(
const RPC_CALL = /(\w+)\.rpc(?:<[^>]*>)?\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g

/** Names called through `<receiver>.rpc(...)`, optionally only for one receiver. */
export function rpcNames(source, receiver) {
  const names = new Set()
  for (const [, who, name] of source.matchAll(RPC_CALL)) {
    if (!receiver || who === receiver) names.add(name)
  }
  return names
}

/** The /rpc/<name> paths in a PostgREST schema document. */
export function executable(openapi) {
  return new Set(
    Object.keys(openapi.paths ?? {})
      .filter((p) => p.startsWith('/rpc/'))
      .map((p) => p.slice('/rpc/'.length)),
  )
}

function selfTest() {
  const src = `
    await supabase.rpc('delete_my_account', { p_scope })
    const { data } = await supabase.rpc(
      'event_sale_readiness',
      { p_event: id },
    )
    supabase.rpc<Row[]>("my_circle_id")
    asCaller.rpc('is_admin'); db.rpc('event_host_ids', {})
    // supabase.from('rpc') is not a call
  `
  assert.deepEqual(
    [...rpcNames(src)].sort(),
    ['delete_my_account', 'event_host_ids', 'event_sale_readiness', 'is_admin', 'my_circle_id'],
  )
  assert.deepEqual([...rpcNames(src, 'asCaller')], ['is_admin'])
  assert.deepEqual(
    [...executable({ paths: { '/': {}, '/events': {}, '/rpc/lookup_code': {} } })],
    ['lookup_code'],
  )
}

function files(dir, ext) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && ext.test(d.name))
    .map((d) => join(d.parentPath, d.name))
}

function jwt(secret, payload) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

async function schemaAs(url, pub, token) {
  const r = await fetch(`${url}/rest/v1/`, {
    headers: {
      apikey: pub,
      Accept: 'application/openapi+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!r.ok) throw new Error(`schema document: ${r.status} ${await r.text()}`)
  return executable(await r.json())
}

selfTest()
console.log('PASS  self-test')

const URL = process.env.SB_URL
const PUB = process.env.SB_PUB
const SECRET = process.env.SB_JWT_SECRET
if (!URL || !PUB || !SECRET) {
  console.error('Set SB_URL, SB_PUB and SB_JWT_SECRET.')
  process.exit(1)
}

const called = new Set()
for (const f of files('src', /\.tsx?$/)) for (const n of rpcNames(readFileSync(f, 'utf8'))) called.add(n)
for (const f of files('supabase/functions', /\.ts$/)) {
  for (const n of rpcNames(readFileSync(f, 'utf8'), 'asCaller')) called.add(n)
}

const now = Math.floor(Date.now() / 1000)
const anon = await schemaAs(URL, PUB)
const authenticated = await schemaAs(
  URL,
  PUB,
  jwt(SECRET, { role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 300 }),
)

let failed = 0
function check(name, pass, detail) {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Guards against a vacuous pass: an empty or unreadable schema would satisfy
// "nothing extra is open to anon".
check('anon can call lookup_code at all', anon.has('lookup_code'))

const extra = [...anon].filter((n) => !ALLOW_ANON.has(n)).sort()
check('nothing outside ALLOW_ANON is executable by anon', extra.length === 0, extra.join(', '))

const missing = [...called].filter((n) => !authenticated.has(n)).sort()
check(
  `every rpc the client calls (${called.size}) is executable by authenticated`,
  called.size > 0 && missing.length === 0,
  missing.join(', '),
)

process.exitCode = failed ? 1 : 0
