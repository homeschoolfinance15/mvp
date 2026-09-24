import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
const cache = path.join(process.env.LOCALAPPDATA, 'npm-cache/_npx')
const cli = path.join(cache, 'aa8e5c70f9d8d161/node_modules/supabase/dist/supabase.js')
const info = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { encoding: 'utf8' }))
if (info.API_URL !== 'http://127.0.0.1:54321') throw Error('Local only')
const out = 'scripts/stripe-sim/out'
mkdirSync(out, { recursive: true })
const env = { ...process.env, UAT_PAYMENT_URL: 'http://127.0.0.1:5489', SUPABASE_URL: info.API_URL, SUPABASE_ANON_KEY: info.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: info.SERVICE_ROLE_KEY, STRIPE_SECRET_KEY: 'sk_test_sim', STRIPE_WEBHOOK_SECRET: 'whsec_local_sim', STRIPE_CONNECT_CLIENT_ID: 'ca_sim', STRIPE_API_BASE: 'http://127.0.0.1:12111', SITE_URL: 'http://localhost:5173', PLATFORM_FEE_BPS: '0', MAILER_SECRET: '', RESEND_API_KEY: '', WEBHOOK_URL: 'http://127.0.0.1:5489/functions/v1/stripe-webhook' }
const children = []
env.PORT = '12112'
env.UAT_SIM_URL = 'http://localhost:12112'
env.STRIPE_API_BASE = 'http://127.0.0.1:12112'
env.SIM_PUBLIC_BASE = 'http://localhost:12111'
env.SIM_LOG = env.UAT_SIM_LOG = path.resolve(out, 'uat-stripe-requests.jsonl')
const executed = []
function start(command, args, label) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { log += d.toString() })
  child.on('close', () => writeFileSync(`${out}/uat-${label}.log`, log))
  return child
}
async function ready(url, child) { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return } catch {} if (child.exitCode !== null) throw Error(`Server exited ${child.exitCode}`); await new Promise(r => setTimeout(r, 250)) } throw Error(`Not ready: ${url}`) }
async function run(name) {
  executed.push(name)
  const child = start(process.execPath, [`scripts/stripe-sim/scenarios/${name}.mjs`], name)
  const code = await new Promise(r => child.on('close', r))
  const log = readFileSync(`${out}/uat-${name}.log`, 'utf8')
  console.log(`${name}: exit ${code}, ${log.match(/^PASS/gm)?.length ?? 0} passed, ${log.match(/^FAIL/gm)?.length ?? 0} failed`)
  if (code !== 0) { console.log(log.slice(-2500)); throw Error(`${name} failed to complete`) }
}
const control = body => fetch('http://127.0.0.1:5489/_test', { method: 'POST', body: JSON.stringify(body) })
let failure
try {
  const sim = start(process.execPath, ['scripts/stripe-sim/server.mjs'], 'sim')
  const gateway = start(path.join(cache, '05b6ef7b13673c57/node_modules/deno/deno.exe'), ['run', '--node-modules-dir=none', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', 'scripts/serve-uat-payments.ts'], 'gateway')
  await ready('http://127.0.0.1:12112/_sim/state', sim)
  await ready('http://127.0.0.1:5489/_test', gateway)
  await run('fixtures')
  for (const name of ['scen1', 'scen2', 'scen3a']) await run(name)
  await control({ offline: true }); await run('scen3b')
  await control({ offline: false, fee: 500 }); await run('scen3c')
  await control({ offline: false, fee: 0 })
  for (const name of ['scen4', 'scen5', 'scen6', 'ledger']) await run(name)
} catch (e) { failure = e.message; console.error(failure) }
finally {
  for (const child of children) if (child.exitCode === null) child.kill()
  const results = executed.filter(n => n.startsWith('scen')).flatMap(n => { try { return readFileSync(`${out}/uat-${n}.log`, 'utf8').split('\n').filter(l => /^(PASS|FAIL)/.test(l)).map(l => ({ batch: n, pass: l.startsWith('PASS'), detail: l })) } catch { return [] } })
  writeFileSync('docs/event-platform/uat-evidence/payment-integration-results.json', JSON.stringify({ at: new Date().toISOString(), scope: 'Real application handlers and local database with simulated Stripe; no real Stripe evidence', failure, results }, null, 2))
  process.exitCode = failure || results.some(r => !r.pass) ? 1 : 0
}
