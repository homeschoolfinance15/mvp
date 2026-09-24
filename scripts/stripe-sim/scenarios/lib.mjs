// Test harness helpers. LOCAL ONLY: 127.0.0.1:54321 (Supabase) and localhost:12111 (stripe-sim).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// Results, state and the simulator's request log land here (git-ignored).
export const DIR = fileURLToPath(new globalThis.URL('../out', import.meta.url))
fs.mkdirSync(DIR, { recursive: true })
export const URL = 'http://127.0.0.1:54321'
export const SIM = 'http://localhost:12111'
export const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
export const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
export const PW = 'QaTest-2026!'
export const LOG = `${DIR}/stripe-requests.jsonl`

const H = (t) => ({ apikey: ANON, Authorization: `Bearer ${t ?? ANON}`, 'Content-Type': 'application/json' })
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }

async function out(r) {
  const text = await r.text()
  let body = text
  try { body = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, body }
}

export const rest = (token, method, path, body, extra = {}) =>
  fetch(`${URL}/rest/v1/${path}`, { method, headers: { ...H(token), Prefer: 'return=representation', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }).then(out)
export const svc = (method, path, body) =>
  fetch(`${URL}/rest/v1/${path}`, { method, headers: SH, body: body === undefined ? undefined : JSON.stringify(body) }).then(out)
export const rpc = (token, fn, args = {}) =>
  fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H(token), body: JSON.stringify(args) }).then(out)
export const fn = (token, name, body, headers = {}) =>
  fetch(`${URL}/functions/v1/${name}`, { method: 'POST', headers: { ...H(token), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(out)
export const sim = (method, path, body) =>
  fetch(`${SIM}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }).then(out)

export async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) }).then(out)
  if (!r.body?.access_token) throw new Error(`sign in ${email}: ${JSON.stringify(r.body)}`)
  return r.body.access_token
}

export async function createAuthUser(email, fullName) {
  const r = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: SH, body: JSON.stringify({ email, password: PW, email_confirm: true, user_metadata: { full_name: fullName } }) }).then(out)
  if (!r.body?.id) throw new Error(`create ${email}: ${JSON.stringify(r.body)}`)
  return r.body.id
}

export function psql(sql) {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_amazing', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim()
}
export function psqlJson(sql) {
  const s = psql(`select coalesce(json_agg(t), '[]') from (${sql}) t`)
  return JSON.parse(s)
}

export function logLines() {
  if (!fs.existsSync(LOG)) return []
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
export const mark = () => logLines().length
export const since = (m) => logLines().slice(m)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const soon = (days, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString()

export const results = []
export function check(scenario, name, pass, detail) {
  results.push({ scenario, name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
export function saveResults(file) {
  fs.writeFileSync(`${DIR}/${file}`, JSON.stringify(results, null, 2))
}
export const fx = () => JSON.parse(fs.readFileSync(`${DIR}/fixtures.json`, 'utf8'))
