// Local database integration tests for gaps left by the first acceptance audit.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const cache = path.join(process.env.LOCALAPPDATA, 'npm-cache/_npx')
const cli = path.join(cache, 'aa8e5c70f9d8d161/node_modules/supabase/dist/supabase.js')
const info = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { encoding: 'utf8' }))
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(info.API_URL)) throw Error('Local only')
const users = [], events = [], connectors = [], waitlist = [], results = []
const tag = `uat-remaining-${Date.now()}`, password = `Test-${Date.now()}-Aa1!`
const check = (name, pass, detail = '') => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`) }
async function api(route, token = info.SERVICE_ROLE_KEY, method = 'GET', body, prefer = 'return=representation') {
  const r = await fetch(info.API_URL + route, { method, headers: { apikey: info.ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  return { ok: r.ok, status: r.status, data }
}
const db = (route, t, m, b, p) => api('/rest/v1/' + route, t, m, b, p)
const rpc = (name, t, b) => db('rpc/' + name, t, 'POST', b)
const must = (r) => { if (!r.ok) throw Error(JSON.stringify(r.data)); return r.data }
async function user(n, role = 'user') {
  const email = `${tag}-${n}@acceptance.invalid`
  const u = must(await api('/auth/v1/admin/users', undefined, 'POST', { email, password, email_confirm: true })); users.push(u.id)
  const token = must(await api('/auth/v1/token?grant_type=password', info.ANON_KEY, 'POST', { email, password })).access_token
  if (role === 'user') must(await rpc('create_event_account', token, { p_full_name: `UAT ${n}` }))
  else must(await db('profiles', undefined, 'POST', { id: u.id, email, role, full_name: `UAT ${n}`, profile_status: 'active', current_profession: 'Tester' }))
  must(await db(`profiles?id=eq.${u.id}`, token, 'PATCH', { current_profession: 'Tester' }))
  return { id: u.id, token, email }
}
let mailer
try {
  const admin = await user('admin', 'admin'), replacement = await user('replacement', 'admin'), cohost = await user('cohost', 'connector'), guest = await user('guest'), peer = await user('peer')
  const conn = must(await db('connectors', undefined, 'POST', { profile_id: cohost.id, invite_status: 'active', invite_capacity: 200, can_create_events: true }))[0]; connectors.push(conn.id)
  const ev = must(await db('events', admin.token, 'POST', { host_id: admin.id, title: tag, slug: tag, capacity: 100, currency: 'gbp', starts_at: new Date(Date.now() + 86400000).toISOString(), ends_at: new Date(Date.now() + 90000000).toISOString(), timezone: 'UTC', feedback_opens_after_minutes: 0 }))[0]; events.push(ev.id)
  const tt = must(await db('ticket_types', admin.token, 'POST', { event_id: ev.id, name: 'General', price_cents: 0, currency: 'gbp' }))[0]
  must(await db(`events?id=eq.${ev.id}`, admin.token, 'PATCH', { status: 'published' }))
  for (const p of [guest, peer]) must(await rpc('register_free', p.token, { p_event: ev.id, p_ticket_type: tt.id }))
  const before = must(await db(`event_tickets?event_id=eq.${ev.id}&profile_id=eq.${guest.id}`))[0]
  must(await db('profile_answers', guest.token, 'POST', { profile_id: guest.id, background: 'UAT original profile answer' }))
  // Keep the event in the past only while producing attendance and feedback.
  must(await db(`events?id=eq.${ev.id}`, admin.token, 'PATCH', { starts_at: new Date(Date.now() - 7200000).toISOString(), ends_at: new Date(Date.now() - 3600000).toISOString() }))
  for (const p of [guest, peer]) must(await rpc('mark_attended', admin.token, { p_event: ev.id, p_profile: p.id, p_reason: 'Verified UAT attendance' }))
  const q = must(await db('feedback_questions?scope=eq.event&active=eq.true&answer_format=eq.text'))[0]
  must(await rpc('submit_event_feedback', guest.token, { p_event: ev.id, p_answers: [{ question_id: q.id, answer_text: 'UAT retained event response' }] }))
  const code = must(await rpc('create_invite_code', cohost.token, { p_max_uses: 2 })).code
  must(await rpc('redeem_code', guest.token, { p_code: code, p_full_name: '' }))
  const profile = must(await db(`profiles?id=eq.${guest.id}`, guest.token))[0]
  const after = must(await db(`event_tickets?event_id=eq.${ev.id}&profile_id=eq.${guest.id}`, guest.token))[0]
  check('ACC-06 joining network preserves account, onboarding and current ticket', profile.network_member === true && profile.current_profession === 'Tester' && after.id === before.id && after.code === before.code)
  const answers = must(await db(`profile_answers?profile_id=eq.${guest.id}`, guest.token))
  check('ACC-06 joining network preserves original profile answers', answers[0]?.background === 'UAT original profile answer')
  const feedback = must(await db(`event_feedback?event_id=eq.${ev.id}`, replacement.token))
  check('ACC-06 ORG-15 new admin sees feedback still attached to same person', feedback.some(r => r.author_id === guest.id && r.answer_text === 'UAT retained event response'))
  check('FDB-09 joining a network does not unlock submitted feedback', must(await db(`event_feedback?event_id=eq.${ev.id}`, guest.token)).length === 0)
  // Admin roles are deliberately pinned through REST. Emulate operator replacement
  // for this owned fixture using the database's internal role-change guard.
  execFileSync('docker', ['exec', '-i', 'supabase_db_amazing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `begin; select set_config('amazing.claiming_connector','on',true); update profiles set role='user' where id='${admin.id}'; commit;`, stdio: ['pipe', 'ignore', 'pipe'] })
  check('ORG-15 replacing administrator preserves event and guest records', must(await db(`events?id=eq.${ev.id}`, replacement.token)).length === 1 && must(await db(`event_registrations?event_id=eq.${ev.id}`, replacement.token)).length === 2)
  check('FDB-09 former administrator loses review-reading access', must(await db(`event_feedback?event_id=eq.${ev.id}`, admin.token)).length === 0)
  const replacementEdit = await db(`events?id=eq.${ev.id}`, replacement.token, 'PATCH', { venue_name: 'Replacement admin venue' })
  check('ORG-14 ORG-15 replacement admin can edit existing event after creator demotion', replacementEdit.ok && replacementEdit.data?.length === 1, { status: replacementEdit.status, error: replacementEdit.data?.message })
  execFileSync('docker', ['exec', '-i', 'supabase_db_amazing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `begin; select set_config('amazing.claiming_connector','on',true); update profiles set role='admin' where id='${admin.id}'; commit;`, stdio: ['pipe', 'ignore', 'pipe'] })
  // Verify named hosts and assigned event managers through authenticated APIs.
  must(await db('event_hosts', replacement.token, 'POST', { event_id: ev.id, profile_id: cohost.id }))
  const edit = await db(`events?id=eq.${ev.id}`, cohost.token, 'PATCH', { venue_name: 'Cohost changed venue' })
  const settings = await db(`event_email_settings?event_id=eq.${ev.id}`, cohost.token)
  check('ORG-05 named host can be separated from event-management permissions', !(edit.ok && edit.data?.length) && !settings.data?.length)
  check('ORG-05 named host cannot grant themselves management', !(await rpc('set_event_host_management', cohost.token, { p_event: ev.id, p_profile: cohost.id, p_can_manage: true })).ok)
  must(await rpc('set_event_host_management', replacement.token, { p_event: ev.id, p_profile: cohost.id, p_can_manage: true }))
  check('ORG-05 explicitly assigned manager can edit and read communications', must(await db(`events?id=eq.${ev.id}`, cohost.token, 'PATCH', { venue_name: 'Assigned manager venue' })).length === 1 && must(await db(`event_email_settings?event_id=eq.${ev.id}`, cohost.token)).length === 1)
  must(await db(`connectors?id=eq.${conn.id}`, replacement.token, 'PATCH', { can_create_events: false }))
  check('ORG-01C creation permission removal preserves assigned management', must(await rpc('hosts_event', cohost.token, { p_event: ev.id })) === true)
  must(await rpc('set_event_host_management', replacement.token, { p_event: ev.id, p_profile: cohost.id, p_can_manage: false }))
  check('ORG-05 revoking management preserves named host but removes access', must(await rpc('hosts_event', cohost.token, { p_event: ev.id })) === false && must(await db(`event_hosts?event_id=eq.${ev.id}&profile_id=eq.${cohost.id}`, replacement.token)).length === 1)
  check('ORG-05 cohost still cannot read confidential feedback', must(await db(`event_feedback?event_id=eq.${ev.id}`, cohost.token)).length === 0)
  // Public network waitlist remains separate from event registration.
  const wEmail = `${tag}-waitlist@acceptance.invalid`
  const w = await db('waitlist_entries', info.ANON_KEY, 'POST', { email: wEmail, full_name: 'UAT Waitlist', phone: '+12025550123', background: 'UAT waitlist background' }, 'return=minimal')
  must(w)
  const entry = must(await db(`waitlist_entries?email=eq.${wEmail}`, replacement.token))[0]; waitlist.push(entry.id)
  check('Network waitlist public submission is not publicly readable', must(await db(`waitlist_entries?email=eq.${wEmail}`, info.ANON_KEY)).length === 0)
  const assigned = must(await rpc('assign_waitlist_entry', replacement.token, { p_entry_id: entry.id, p_connector_id: conn.id }))
  const waitUser = await user('waitlist')
  must(await rpc('redeem_code', waitUser.token, { p_code: assigned.code, p_full_name: 'UAT Waitlist' }))
  must(await rpc('claim_waitlist_answers', waitUser.token, { p_email: wEmail }))
  check('Network waitlist assignment and redemption preserve questionnaire', must(await db(`profile_answers?profile_id=eq.${waitUser.id}`, waitUser.token))[0]?.background === 'UAT waitlist background')
  check('Network waitlist does not create an event booking', must(await db(`event_registrations?profile_id=eq.${waitUser.id}`)).length === 0)
  const legacy = must(await db('events', replacement.token, 'POST', { host_id: replacement.id, title: `${tag} Legacy`, starts_at: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC', status: 'published' }))[0]; events.push(legacy.id)
  const backfill = readFileSync('supabase/migrations/20260916000009_backfill_legacy_events.sql', 'utf8')
  const legacySql = `begin;
    insert into event_invitations(event_id,profile_id,status,created_at,responded_at) values ('${legacy.id}','${guest.id}','going','2026-01-01T12:00:00Z','2026-01-02T12:00:00Z');
    ${backfill}
    select json_build_object('registrations',(select count(*) from event_registrations where event_id='${legacy.id}'), 'tickets',(select count(*) from event_tickets where event_id='${legacy.id}'), 'orders',(select count(*) from event_orders where event_id='${legacy.id}'), 'attendance',(select count(*) from event_attendance where event_id='${legacy.id}'), 'original_rsvp',(select count(*) from event_invitations where event_id='${legacy.id}'), 'timestamp_preserved',(select confirmed_at='2026-01-02T12:00:00Z'::timestamptz from event_registrations where event_id='${legacy.id}'));
    rollback;`
  const legacyOut = execFileSync('docker', ['exec', '-i', 'supabase_db_amazing', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: legacySql, encoding: 'utf8' })
  const legacyResult = JSON.parse(legacyOut.split('\n').find(l => l.startsWith('{')))
  check('QLT-07 legacy RSVP backfill preserves ticket and timestamp without inventing payment or attendance', legacyResult.registrations === 1 && legacyResult.tickets === 1 && legacyResult.orders === 0 && legacyResult.attendance === 0 && legacyResult.original_rsvp === 1 && legacyResult.timestamp_preserved, legacyResult)
  // Local provider adapter runs the real dispatcher; no UI and no external email.
  mailer = spawn(path.join(cache, '05b6ef7b13673c57/node_modules/deno/deno.exe'), ['run', '--node-modules-dir=none', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', 'scripts/serve-uat-mailer.ts'], { env: { ...process.env, SUPABASE_URL: info.API_URL, SUPABASE_ANON_KEY: info.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: info.SERVICE_ROLE_KEY, MAILER_SECRET: 'uat-local-only', RESEND_API_KEY: 'uat-fake-only' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let mailerLog = ''; mailer.stderr.on('data', d => { mailerLog += d.toString() })
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:5488/_test'); break } catch {} if (mailer.exitCode !== null) throw Error(mailerLog); await new Promise(r => setTimeout(r, 250)) }
  const control = async fail => fetch('http://127.0.0.1:5488/_test', { method: 'POST', body: JSON.stringify({ fail }) }).then(r => r.json())
  const dispatch = async id => { const r = await fetch('http://127.0.0.1:5488', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mailer-secret': 'uat-local-only' }, body: JSON.stringify({ message_id: id }) }); const body = await r.json(); if (!r.ok) throw Error(JSON.stringify(body)); return body }
  const feedbackMessage = must(await db(`event_messages?event_id=eq.${ev.id}&kind=eq.feedback_open`))[0]
  await control(true)
  const failed = await dispatch(feedbackMessage.id)
  check('EML-08 provider failure is recorded without erasing tickets', failed.failed === 2 && must(await db(`event_tickets?id=eq.${before.id}`)).length === 1, failed)
  await control(false)
  const retried = await dispatch(feedbackMessage.id)
  const repeated = await dispatch(feedbackMessage.id)
  check('EML-08 retry recovers failed recipients and never resends successes', retried.sent === 2 && repeated.sent === 0, { retried, repeated })
  const captured = (await fetch('http://127.0.0.1:5488/_test').then(r => r.json())).batches
  check('EML-09 feedback requests do not contain submitted answers', captured.length > 0 && !JSON.stringify(captured).includes('UAT retained event response'))
  check('EML-05 recipient addresses are separate', captured.every(b => b.payload.every(m => typeof m.to === 'string' || m.to.length === 1)))
  must(await rpc('mark_attended', replacement.token, { p_event: ev.id, p_profile: cohost.id, p_reason: 'Present cohost added after initial sends' }))
  await control(true)
  const lateFailure = await dispatch(feedbackMessage.id)
  await control(false)
  const lateRetry = await dispatch(feedbackMessage.id)
  const mixedRows = must(await db(`event_message_recipients?message_id=eq.${feedbackMessage.id}`))
  check('EML-08 FDB-06 mixed successful and failed recipient history retries only the new failure', lateFailure.failed === 1 && lateRetry.sent === 1 && mixedRows.filter(r => r.status === 'sent').length === 3, { lateFailure, lateRetry })
  // Back to upcoming, and exercise the actual reminder dispatcher with no dashboard.
  must(await db(`events?id=eq.${ev.id}`, replacement.token, 'PATCH', { starts_at: new Date(Date.now() + 7200000).toISOString(), ends_at: new Date(Date.now() + 10800000).toISOString(), address: 'Latest UAT Address' }))
  const reminderSetting = must(await db('event_reminders', replacement.token, 'POST', { event_id: ev.id, minutes_before: 61, enabled: true }))[0]
  const reminder = must(await db(`event_messages?event_id=eq.${ev.id}&reminder_id=eq.${reminderSetting.id}`))[0]
  must(await db(`event_messages?id=eq.${reminder.id}`, undefined, 'PATCH', { scheduled_for: new Date(Date.now() - 1000).toISOString() }))
  const peerReg = must(await db(`event_registrations?event_id=eq.${ev.id}&profile_id=eq.${peer.id}`))[0]
  must(await rpc('cancel_registration', peer.token, { p_registration: peerReg.id }))
  const sent = await dispatch(reminder.id)
  const last = (await fetch('http://127.0.0.1:5488/_test').then(r => r.json())).batches.at(-1)
  check('EML-05 EML-07 reminder rechecks cancellation and uses current address', sent.sent === 1 && JSON.stringify(last).includes('Latest UAT Address') && !JSON.stringify(last).includes(peer.email), sent)
  const unauthorized = await fetch('http://127.0.0.1:5488', { method: 'POST', body: '{}' })
  check('EML-09 anonymous caller cannot dispatch email', unauthorized.status === 401)
  // Proposed local correctness target: 100 attendees and 50 simultaneous scanners.
  const loadGuests = []
  for (let i = 0; i < 100; i += 5) loadGuests.push(...await Promise.all(Array.from({ length: 5 }, (_, n) => user(`load-${i + n}`))))
  const start = performance.now()
  const registrations = await Promise.all(loadGuests.map(p => rpc('register_free', p.token, { p_event: ev.id, p_ticket_type: tt.id })))
  const durationMs = Math.round(performance.now() - start)
  check('QLT-10 100 simultaneous free claims cannot exceed 100 total places', registrations.filter(r => r.ok).length === 99, { success: registrations.filter(r => r.ok).length, durationMs, existingPlaces: 1 })
  const tickets = must(await db(`event_tickets?event_id=eq.${ev.id}&revoked_at=is.null`))
  const scanStart = performance.now()
  const scans = await Promise.all(tickets.slice(0, 50).map(t => rpc('check_in', replacement.token, { p_event: ev.id, p_ticket_code: t.code })))
  check('QLT-10 50 concurrent distinct-ticket check-ins return known outcomes', scans.every(r => r.ok && ['ok', 'already'].includes(r.data)), { durationMs: Math.round(performance.now() - scanStart), count: scans.length, failures: scans.filter(r => !r.ok || !['ok', 'already'].includes(r.data)) })
} catch (e) { check('Remaining suite completed', false, e.stack) }
finally {
  mailer?.kill()
  for (const id of events) { for (const table of ['event_attendance', 'event_registrations']) await db(`${table}?event_id=eq.${id}`, undefined, 'DELETE'); await db(`events?id=eq.${id}`, undefined, 'DELETE') }
  for (const id of waitlist) await db(`waitlist_entries?id=eq.${id}`, undefined, 'DELETE')
  for (const id of connectors) await db(`connectors?id=eq.${id}`, undefined, 'DELETE')
  for (const id of users) await api(`/auth/v1/admin/users/${id}`, undefined, 'DELETE')
  writeFileSync('docs/event-platform/uat-evidence/remaining-results.json', JSON.stringify({ at: new Date().toISOString(), scope: 'Local real database and dispatcher; captured provider requests, no real delivery or Stripe', results }, null, 2))
  process.exitCode = results.some(r => !r.pass) ? 1 : 0
}
