// Independent local-only acceptance probes. Never targets the configured production project.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cache = path.join(process.env.LOCALAPPDATA, 'npm-cache/_npx')
const cli = path.join(cache, 'aa8e5c70f9d8d161/node_modules/supabase/dist/supabase.js')
const info = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { encoding: 'utf8' }))
const base = info.API_URL
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(base)) throw Error('Local database required')
const out = 'docs/event-platform/uat-evidence'
mkdirSync(out, { recursive: true })
const results = [], users = [], events = [], questions = []
const tag = `uat-${Date.now()}`, password = `Uat-${Date.now()}-Aa1!`
const questionSlot = Math.floor(Date.now()/1000)
function check(name, pass, detail = '') { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
async function api(route, token = info.SERVICE_ROLE_KEY, method = 'GET', body) {
  const r = await fetch(`${base}${route}`, { method, headers: { apikey: info.ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  return { ok: r.ok, status: r.status, data }
}
const db = (route, token, method, body) => api(`/rest/v1/${route}`, token, method, body)
const rpc = (name, token, body) => db(`rpc/${name}`, token, 'POST', body)
async function user(label, role = 'user') {
  const email = `${tag}-${label}@acceptance.invalid`
  const r = await api('/auth/v1/admin/users', undefined, 'POST', { email, password, email_confirm: true })
  if (!r.ok) throw Error(JSON.stringify(r.data)); users.push(r.data.id)
  const id = r.data.id
  const s = await api('/auth/v1/token?grant_type=password', info.ANON_KEY, 'POST', { email, password })
  const token = s.data.access_token
  if (role === 'user') await rpc('create_event_account', token, { p_full_name: `UAT ${label}` })
  else await db('profiles', undefined, 'POST', { id, email, full_name: `UAT ${label}`, role, profile_status: 'active', current_profession: 'Tester' })
  await db(`profiles?id=eq.${id}`, token, 'PATCH', { current_profession: 'Tester' })
  return { id, email, token }
}
let browser, server, emailServer, currentPage
try {
  // Remove only this script's abandoned local fixtures, identifiable by both title and description.
  const abandoned=(await db('events?description=eq.An%20independent%20acceptance%20test%20dinner.&select=id,slug')).data
  for(const old of Array.isArray(abandoned)?abandoned:[]) if(/^uat-\d{13}$/.test(old.slug)) {
    for(const table of ['event_attendance','event_registrations']) await db(`${table}?event_id=eq.${old.id}`,undefined,'DELETE')
    await db(`events?id=eq.${old.id}`,undefined,'DELETE')
  }
  const oldQuestions=(await db('feedback_questions?slot=eq.99001&wording=eq.UAT%20changed%20meaning&select=id')).data
  for(const q of Array.isArray(oldQuestions)?oldQuestions:[]) await db(`feedback_questions?id=eq.${q.id}`,undefined,'DELETE')
  const admin = await user('admin', 'admin'), guest = await user('guest'), peer = await user('peer')
  emailServer = spawn(path.join(cache, '05b6ef7b13673c57/node_modules/deno/deno.exe'), ['run', '--node-modules-dir=none', '--allow-env', '--allow-net', '--allow-read', 'scripts/serve-event-email-test.ts'], {
    env: { ...process.env, SUPABASE_URL: base, SUPABASE_ANON_KEY: info.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: info.SERVICE_ROLE_KEY, MAILER_SECRET: '' },
    stdio: 'ignore', windowsHide: true,
  })
  for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:5487',{method:'OPTIONS'});break}catch{}await new Promise(r=>setTimeout(r,250))}
  async function email(token, body) {
    const r=await fetch('http://127.0.0.1:5487',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
    return {ok:r.ok,status:r.status,data:await r.json()}
  }
  const evR = await db('events', admin.token, 'POST', { host_id: admin.id, title: `${tag} Dinner`, slug: tag, description: 'An independent acceptance test dinner.', venue_name: 'Test Hall', address: '123 Test Street', starts_at: new Date(Date.now()+86400000).toISOString(), ends_at: new Date(Date.now()+90000000).toISOString(), timezone: 'Europe/London', capacity: 30, feedback_opens_after_minutes: 0 })
  if (!evR.ok) throw Error(JSON.stringify(evR.data)); const ev = evR.data[0]; events.push(ev.id)
  const ttResponse = await db('ticket_types', admin.token, 'POST', { event_id: ev.id, name: 'General admission', price_cents: 0, currency: ev.currency, is_active: true })
  if (!ttResponse.ok) throw Error(`Ticket fixture failed: ${JSON.stringify(ttResponse.data)}`)
  const tt = ttResponse.data[0]
  const published = await db(`events?id=eq.${ev.id}`, admin.token, 'PATCH', { status: 'published' })
  if (!published.ok) throw Error(JSON.stringify(published.data))
  const schedule=()=>db(`event_messages?event_id=eq.${ev.id}&select=id,kind,status,scheduled_for,reminder_id`)
  let messages=(await schedule()).data
  check('EML-01 EML-11 publication automatically schedules feedback',messages.some(m=>m.kind==='feedback_open'&&m.status==='scheduled'))
  await db('event_reminders',admin.token,'POST',{event_id:ev.id,minutes_before:60,enabled:true})
  messages=(await schedule()).data
  check('EML-02 adding reminder creates saved schedule',messages.some(m=>m.kind==='reminder'&&m.status==='scheduled'))
  await db(`event_email_settings?event_id=eq.${ev.id}`,admin.token,'PATCH',{reminders_enabled:false})
  messages=(await schedule()).data
  check('EML-02 disabling reminders cancels unsent reminders',!messages.some(m=>m.kind==='reminder'&&m.status==='scheduled'))
  check('EML-02 disabling reminders preserves feedback request',messages.some(m=>m.kind==='feedback_open'&&m.status==='scheduled'))
  await db(`event_email_settings?event_id=eq.${ev.id}`,admin.token,'PATCH',{reminders_enabled:true})
  messages=(await schedule()).data
  check('EML-02 re-enabling restores future reminders',messages.some(m=>m.kind==='reminder'&&m.status==='scheduled'))
  const changedStart=new Date(Date.now()+172800000).toISOString(),changedEnd=new Date(Date.now()+176400000).toISOString()
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{starts_at:changedStart,ends_at:changedEnd})
  messages=(await schedule()).data
  const reminderIds=(await db(`event_reminders?event_id=eq.${ev.id}&minutes_before=eq.60`)).data.map(r=>r.id)
  check('EML-06 rescheduling moves unsent reminders',messages.some(m=>reminderIds.includes(m.reminder_id)&&m.status==='scheduled'&&Date.parse(m.scheduled_for)===Date.parse(changedStart)-3600000))
  check('FDB-15 rescheduling moves feedback opening email',messages.some(m=>m.kind==='feedback_open'&&m.status==='scheduled'&&Date.parse(m.scheduled_for)===Date.parse(changedEnd)))
  const denied=await db(`event_email_settings?event_id=eq.${ev.id}`,guest.token)
  check('EML-09 non-host cannot read organizer email settings',Array.isArray(denied.data)&&denied.data.length===0)
  const { chromium } = await import(pathToFileURL(path.join(cache, '86170c4cd1c5da32/node_modules/playwright/index.mjs')).href)
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], { env: { ...process.env, VITE_SUPABASE_URL: base, VITE_SUPABASE_PUBLISHABLE_KEY: info.ANON_KEY }, stdio: 'ignore', windowsHide: true })
  for (let i=0;i<60;i++) { try { if ((await fetch('http://127.0.0.1:5187')).ok) break } catch {} await new Promise(r=>setTimeout(r,500)) }
  browser = await chromium.launch({ headless: true, executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1223/chrome-win64/chrome.exe') })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage(); const errors=[]; page.on('pageerror', e=>errors.push(e.message))
  currentPage=page
  const site='http://127.0.0.1:5187'
  await page.goto(`${site}/e/${tag}`); await page.getByRole('heading', { name: ev.title, exact: true }).waitFor()
  check('EVT-01 public event readable without login', await page.getByText('Test Hall', { exact: false }).count()>0)
  check('QLT-01 mobile public page has no horizontal overflow', await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.screenshot({ path: `${out}/public-mobile.png`, fullPage: true })
  const signupContext=await browser.newContext({viewport:{width:390,height:844}})
  const signupPage=await signupContext.newPage()
  currentPage=signupPage
  await signupPage.goto(`${site}/signup?event=${tag}&ticket=${tt.id}`)
  await signupPage.getByLabel('Full name').fill('UAT New Visitor')
  await signupPage.getByLabel('Email address').fill(`${tag}-new@acceptance.invalid`)
  await signupPage.locator('input[type="password"]').fill(password)
  const signupResponse=signupPage.waitForResponse(r=>r.url().includes('/auth/v1/signup')&&r.request().method()==='POST')
  await signupPage.getByRole('button',{name:'Create account',exact:true}).click()
  const signupData=await(await signupResponse).json();if(signupData.user?.id)users.push(signupData.user.id)
  await signupPage.waitForURL('**/onboarding')
  try { await signupPage.getByLabel('Current profession').waitFor({timeout:5000}) } catch {}
  const onboardingShown = await signupPage.getByLabel('Current profession').isVisible()
  check('ACC-07 signup keeps the required onboarding screen open',onboardingShown,`Destination: ${signupPage.url()}`)
  if (!onboardingShown) {
    await signupPage.screenshot({path:`${out}/signup-onboarding-redirect.png`,fullPage:true})
    await signupPage.goto(`${site}/onboarding`)
  }
  await signupPage.getByLabel('Current profession').fill('UAT Event Visitor')
  await signupPage.getByRole('button',{name:'Continue',exact:true}).click()
  await signupPage.waitForURL('**/events/checkout/**')
  check('ACC-01 ACC-07 browser signup and onboarding return to selected checkout',signupPage.url().includes(tag)&&signupPage.url().includes(tt.id))
  const signupProfile=(await db(`profiles?id=eq.${signupData.user.id}&select=network_member`)).data
  check('ACC-02 browser signup creates no network membership',signupProfile[0]?.network_member===false)
  await signupPage.screenshot({path:`${out}/signup-return.png`,fullPage:true});await signupContext.close();currentPage=page
  await page.goto(`${site}/signin?next=${encodeURIComponent(`/events/checkout/${tag}?ticket=${tt.id}`)}`)
  await page.getByLabel('Email address').fill(guest.email); await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL('**/events/checkout/**'); await page.getByRole('button', { name: /confirm|reserve|register/i }).first().waitFor({timeout:15000})
  check('ACC-03 BUY-12 login preserves event checkout destination', page.url().includes(`/events/checkout/${tag}`))
  await page.screenshot({ path: `${out}/checkout-mobile.png`, fullPage: true })
  await page.getByRole('button', { name: /confirm|reserve|register/i }).first().click()
  await page.waitForTimeout(1500)
  const regs = (await db(`event_registrations?event_id=eq.${ev.id}&profile_id=eq.${guest.id}`)).data
  check('BUY-02 browser free registration confirms one place', regs.length===1&&regs[0].status==='confirmed')
  const tickets=(await db(`event_tickets?event_id=eq.${ev.id}&profile_id=eq.${guest.id}`)).data
  await page.goto(`${site}/events/tickets/${tickets[0].id}`); await page.getByText('General admission', { exact: false }).first().waitFor()
  await page.screenshot({ path: `${out}/ticket-mobile.png`, fullPage: true })
  check('BUY-10 browser ticket displays selected option', await page.getByText('General admission', { exact: false }).count()>0)
  await rpc('register_free',peer.token,{p_event:ev.id,p_ticket_type:tt.id})
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{starts_at:new Date(Date.now()-7200000).toISOString(),ends_at:new Date(Date.now()-3600000).toISOString()})
  for (const person of [guest,peer,admin]) await rpc('mark_attended',admin.token,{p_event:ev.id,p_profile:person.id,p_reason:'UAT attendance correction'})
  await page.goto(`${site}/events/feedback/${tag}`)
  await page.getByText('How was the event?', {exact:true}).waitFor()
  check('FDB-08 browser shows both exact event questions', await page.getByText('What did you enjoy the most?', {exact:true}).count()>0)
  check('FDB-14 visibility explanation shown before submission', (await page.locator('body').innerText()).includes('This is not anonymous'))
  const slider=page.getByRole('slider'); await slider.focus(); await page.keyboard.press('ArrowRight')
  check('QLT-04 event slider supports keyboard', await slider.inputValue() !== '5')
  await page.screenshot({path:`${out}/feedback-mobile.png`,fullPage:true})
  const qs=(await db('feedback_questions?scope=eq.event&active=eq.true')).data
  const q=qs.find(q=>q.answer_format==='text')
  if (!q) throw Error(`Missing event text question: ${JSON.stringify(qs)}`)
  const sent=await rpc('submit_event_feedback',guest.token,{p_event:ev.id,p_answers:[{question_id:q.id,answer_text:'UAT confidential original response'}]})
  check('FDB-06 verified guest can submit through actual RPC',sent.ok,`HTTP ${sent.status}`)
  const own=await rpc('my_event_feedback',guest.token,{p_event:ev.id})
  check('FDB-09 FDB-12 non-admin cannot read submitted answers through RPC', !JSON.stringify(own.data).includes('UAT confidential original response'),`HTTP ${own.status}; returned ${Array.isArray(own.data)?own.data.length:'non-array'} answers`)
  await page.reload(); await page.getByText('You have sent your feedback on this event.',{exact:true}).waitFor()
  check('FDB-12 submission offers confirmation, not answer readback',await page.getByRole('button',{name:'Change my feedback',exact:true}).count()===0)
  check('FDB-09 FDB-12 non-admin browser does not redisplay submitted response', !(await page.locator('textarea').evaluateAll(es=>es.map(e=>e.value))).includes('UAT confidential original response'))
  await page.screenshot({path:`${out}/feedback-readback.png`,fullPage:true})
  const other=await rpc('my_event_feedback',peer.token,{p_event:ev.id})
  check('FDB-09 another attendee cannot retrieve author answers with own RPC',Array.isArray(other.data)&&other.data.length===0)
  const exported=await rpc('export_my_data',guest.token,{})
  check('FDB-09 non-admin data export excludes submitted feedback',!JSON.stringify(exported.data).includes('UAT confidential original response'),`HTTP ${exported.status}; own submitted event answer present: ${JSON.stringify(exported.data).includes('UAT confidential original response')}`)
  const peerQuestion=(await db('feedback_questions?scope=eq.peer&slot=eq.1&active=eq.true')).data[0]
  const peerWrite=await rpc('submit_peer_feedback',guest.token,{p_event:ev.id,p_subject:peer.id,p_answers:[{question_id:peerQuestion.id,answer_text:'UAT confidential peer answer'}]})
  const peerExport=await rpc('export_my_data',guest.token,{})
  check('FDB-09 peer feedback also stays out of account exports',peerWrite.ok&&!JSON.stringify(peerExport.data).includes('UAT confidential peer answer'))
  const customQ=await db('feedback_questions',admin.token,'POST',{scope:'event',slot:questionSlot,version:1,wording:'UAT original wording',answer_format:'text',active:true})
  if(customQ.ok) {
    const qid=customQ.data[0].id; questions.push(qid)
    const answer=await rpc('submit_event_feedback',guest.token,{p_event:ev.id,p_answers:[{question_id:qid,answer_text:'Answer to original wording'}]})
    check('FDB-16 original question accepts its original answer',answer.ok,`HTTP ${answer.status}`)
    const changed=await db(`feedback_questions?id=eq.${qid}`,admin.token,'PATCH',{wording:'UAT changed meaning'})
    const historical=await db(`event_feedback?event_id=eq.${ev.id}&question_id=eq.${qid}&select=answer_text,feedback_questions(wording)`,admin.token)
    check('FDB-16 original question meaning remains attached to saved answer',!answer.ok||!changed.ok||historical.data[0]?.feedback_questions?.wording==='UAT original wording',`question PATCH HTTP ${changed.status}; historical wording ${historical.data[0]?.feedback_questions?.wording}`)
    await db(`feedback_questions?id=eq.${qid}`,admin.token,'PATCH',{active:false})
    const inactive=await rpc('submit_event_feedback',peer.token,{p_event:ev.id,p_answers:[{question_id:qid,answer_text:'Must not save'}]})
    check('FDB-16 inactive questions cannot receive new responses',!inactive.ok,`HTTP ${inactive.status}`)
    const next=await db('feedback_questions',admin.token,'POST',{scope:'event',slot:questionSlot,version:2,wording:'UAT new question meaning',answer_format:'text',active:true})
    if(next.ok)questions.push(next.data[0].id)
    check('FDB-16 a new question version can be created',next.ok)
  } else check('FDB-16 independent version probe setup',false,JSON.stringify(customQ.data))
  const adminContext=await browser.newContext({viewport:{width:1440,height:1000}})
  await adminContext.route('**/functions/v1/event-email',async route=>{
    const request=route.request()
    const r=await fetch('http://127.0.0.1:5487',{method:request.method(),headers:request.headers(),body:request.postData()??undefined})
    await route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()})
  })
  const adminPage=await adminContext.newPage()
  currentPage=adminPage
  await adminPage.goto(`${site}/signin?next=${encodeURIComponent(`/admin/events/${ev.id}`)}`)
  await adminPage.getByLabel('Email address').fill(admin.email);await adminPage.getByLabel('Password',{exact:true}).fill(password);await adminPage.getByRole('button',{name:'Sign in',exact:true}).click()
  await adminPage.waitForURL(`**/admin/events/${ev.id}`);await adminPage.getByText('UAT confidential original response',{exact:false}).first().waitFor()
  check('ORG-14 FDB-11 admin-host browser reads submitted event feedback',await adminPage.getByText('UAT confidential original response',{exact:false}).count()>0)
  await adminPage.screenshot({path:`${out}/admin-event.png`,fullPage:true})
  await adminPage.goto(`${site}/manage/events/${ev.id}/emails`);await adminPage.getByRole('heading',{name:/emails|reminders/i}).first().waitFor()
  await adminPage.screenshot({path:`${out}/organizer-emails.png`,fullPage:true})
  check('ORG-16 organizer email controls render',!(await adminPage.locator('body').innerText()).includes('could not load'))
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{venue_name:'Updated Test Hall',address:'456 New Street'})
  await adminPage.getByRole('button',{name:'Send an update to attendees',exact:true}).click()
  await adminPage.getByLabel('What you want to say').fill('UAT: The venue has changed.')
  await adminPage.getByRole('heading',{name:'Email preview',exact:true}).waitFor()
  const updateText=await adminPage.getByRole('dialog').innerText()
  check('EML-03 later send-update flow includes preview and recipient count',/preview/i.test(updateText)&&/\d+ (recipient|attendee|person|people)/i.test(updateText))
  await adminPage.screenshot({path:`${out}/update-dialog.png`,fullPage:true})
  const savedPreview=(await rpc('event_update_preview',admin.token,{p_event:ev.id})).data
  check('EML-03 later preview retains previous and current saved address',savedPreview.changed_details.address?.from==='123 Test Street'&&savedPreview.changed_details.address?.to==='456 New Street')
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{address:'789 Latest Street'})
  await adminPage.getByRole('button',{name:/Send update to \d+ people/}).click()
  await adminPage.getByText('Review a fresh preview before sending. Your explanation has been kept.',{exact:true}).waitFor()
  check('EML-04 stale browser preview refused without losing explanation',await adminPage.getByLabel('What you want to say').inputValue()==='UAT: The venue has changed.')
  await adminPage.getByRole('button',{name:'Refresh preview',exact:true}).click()
  await adminPage.getByText('789 Latest Street',{exact:false}).first().waitFor()
  const freshPreview=(await rpc('event_update_preview',admin.token,{p_event:ev.id})).data
  const blankSubject=await email(admin.token,{kind:'update',event_id:ev.id,subject:null,body:'UAT blank subject validation',changed_details:freshPreview.changed_details,preview_snapshot:freshPreview.snapshot,send_now:false})
  check('EML-03 subject labelled optional is accepted by endpoint',blankSubject.ok,`HTTP ${blankSubject.status}; ${JSON.stringify(blankSubject.data)}`)
  const queued=(await db(`event_messages?id=eq.${blankSubject.data.message_id}&select=subject,changed_details,preview_snapshot`)).data[0]
  check('EML-03 queued subject matches default preview and contains latest changes',queued?.subject===`${ev.title} has changed`&&queued?.changed_details?.address?.to==='789 Latest Street')
  const staleQueue=await db('event_messages',undefined,'POST',{event_id:ev.id,kind:'update',subject:'Old preview',preview_snapshot:savedPreview.snapshot})
  check('EML-04 database rejects stale snapshot at queue insertion',!staleQueue.ok,`HTTP ${staleQueue.status}`)
  await adminPage.goto(`${site}/manage/events/${ev.id}/checkin`);await adminPage.getByRole('button',{name:'Start the camera',exact:true}).waitFor()
  await adminPage.screenshot({path:`${out}/checkin-desktop.png`,fullPage:true})
  check('ATT-01 scanner capability recorded',true,`BarcodeDetector available: ${await adminPage.evaluate(()=>typeof window.BarcodeDetector==='function')}`)
  if (!await adminPage.evaluate(()=>typeof window.BarcodeDetector==='function')) {
    await adminPage.getByRole('button',{name:'Start the camera',exact:true}).click()
    await adminPage.getByText('This browser cannot read QR codes.',{exact:false}).waitFor()
    check('ATT-01 unsupported camera browser explains typed-code fallback',await adminPage.getByLabel(/Ticket code/).isVisible())
    await adminPage.screenshot({path:`${out}/scanner-unsupported.png`,fullPage:true})
  }
  await adminPage.route('**/rest/v1/rpc/check_in',route=>route.abort('internetdisconnected'))
  await adminPage.getByLabel(/Ticket code/).fill(tickets[0].code)
  await adminPage.getByRole('button',{name:'Check this ticket',exact:true}).click()
  await adminPage.getByText('Not sent',{exact:true}).waitFor()
  check('QLT-10 interrupted check-in never shows false success',await adminPage.getByText('We could not reach the server',{exact:false}).count()>0)
  await adminPage.screenshot({path:`${out}/scanner-interrupted.png`,fullPage:true})
  await adminPage.unroute('**/rest/v1/rpc/check_in')
  await adminPage.waitForTimeout(4200)
  await adminPage.getByLabel(/Ticket code/).fill(tickets[0].code)
  await adminPage.getByRole('button',{name:'Check this ticket',exact:true}).click()
  await adminPage.getByText('Already checked in',{exact:true}).waitFor()
  check('ATT-03 QLT-10 restored connection retries without duplicate attendance', (await db(`event_attendance?event_id=eq.${ev.id}&profile_id=eq.${guest.id}`)).data.length===1)
  await adminPage.goto(`${site}/manage/events/${ev.id}/guests`);await adminPage.getByText('UAT guest',{exact:true}).first().waitFor()
  await adminPage.screenshot({path:`${out}/guest-list.png`,fullPage:true})
  check('ORG-07 corrected guest visible in browser guest list',await adminPage.getByText('UAT guest',{exact:true}).count()>0)
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString()})
  await adminPage.goto(`${site}/manage/events/${ev.id}`)
  await adminPage.getByLabel(/^Venue/).fill('Editor changed venue')
  await adminPage.getByRole('button',{name:'Save changes',exact:true}).click()
  await adminPage.getByRole('button',{name:/Save and email \d+ people/}).waitFor()
  const editorReply=adminPage.waitForResponse(r=>r.url().includes('/functions/v1/event-email')&&r.request().method()==='POST')
  await adminPage.getByRole('button',{name:/Save and email \d+ people/}).click()
  const response=await editorReply
  const editorData=await response.json()
  check('ORG-10 editor save-and-notify accepts its complete preview and default subject',response.ok(),`HTTP ${response.status()}; ${JSON.stringify(editorData)}`)
  await adminPage.screenshot({path:`${out}/editor-notify.png`,fullPage:true})
  await adminContext.close()
  check('QLT-02 tested browser journeys have no uncaught JS errors',errors.length===0,errors.join('; '))
} catch(e) {
  if(currentPage&&!currentPage.isClosed()) {
    await currentPage.screenshot({path:`${out}/test-failure.png`,fullPage:true}).catch(()=>{})
    console.log('Failure screen:',(await currentPage.locator('body').innerText()).slice(0,1800))
  }
  check('Independent probe completed',false,e.stack);
}
finally {
  if(browser) await browser.close(); if(server) server.kill(); if(emailServer)emailServer.kill()
  for(const id of events) {
    for(const table of ['event_attendance','event_registrations']) await db(`${table}?event_id=eq.${id}`,undefined,'DELETE')
    const removed=await db(`events?id=eq.${id}`,undefined,'DELETE')
    if(!removed.ok)check('Fixture event cleanup',false,JSON.stringify(removed.data))
  }
  for(const id of questions) await db(`feedback_questions?id=eq.${id}`,undefined,'DELETE')
  for(const id of users) await api(`/auth/v1/admin/users/${id}`,undefined,'DELETE')
  writeFileSync(`${out}/independent-results.json`,JSON.stringify({at:new Date().toISOString(),scope:'local current working tree',results},null,2))
  console.log(`${results.filter(r=>r.pass).length}/${results.length} passed; own fixtures cleaned up`)
  process.exitCode=results.some(r=>!r.pass)?1:0
}
