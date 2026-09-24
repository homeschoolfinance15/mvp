import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const cli=path.join(process.env.LOCALAPPDATA,'npm-cache/_npx/aa8e5c70f9d8d161/node_modules/supabase/dist/supabase.js')
const info=JSON.parse(execFileSync(process.execPath,[cli,'status','-o','json'],{encoding:'utf8'}))
if(!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(info.API_URL))throw Error('Local only')
const users=[],events=[],results=[],tag=`uat-load-${Date.now()}`,password=`Test-${Date.now()}-Aa1!`
const check=(name,pass,detail)=>{results.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name} ${JSON.stringify(detail??'')}`)}
async function api(route,token=info.SERVICE_ROLE_KEY,method='GET',body) {
  const r=await fetch(info.API_URL+route,{method,headers:{apikey:info.ANON_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body)})
  const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}return{ok:r.ok,status:r.status,data}
}
const db=(route,t,m,b)=>api('/rest/v1/'+route,t,m,b)
const rpc=(name,t,b)=>db('rpc/'+name,t,'POST',b)
async function user(n,role='user') {
  const email=`${tag}-${n}@acceptance.invalid`
  const r=await api('/auth/v1/admin/users',undefined,'POST',{email,password,email_confirm:true});if(!r.ok)throw Error(JSON.stringify(r.data));const id=r.data.id;users.push(id)
  const auth=await api('/auth/v1/token?grant_type=password',info.ANON_KEY,'POST',{email,password});const token=auth.data.access_token
  if(role==='admin')await db('profiles',undefined,'POST',{id,email,role,full_name:'UAT Load Admin',profile_status:'active',current_profession:'Tester'})
  else{await rpc('create_event_account',token,{p_full_name:`UAT Load ${n}`});await db(`profiles?id=eq.${id}`,token,'PATCH',{current_profession:'Tester'})}return{id,token}
}
try {
  const admin=await user('admin','admin'),guests=[]
  for(let i=0;i<31;i++)guests.push(await user(i))
  const er=await db('events',admin.token,'POST',{host_id:admin.id,title:tag,slug:tag,capacity:30,starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString(),timezone:'UTC'})
  if(!er.ok)throw Error(JSON.stringify(er.data));const ev=er.data[0];events.push(ev.id)
  const types=(await db('ticket_types',admin.token,'POST',[{event_id:ev.id,name:'A',price_cents:0,currency:ev.currency},{event_id:ev.id,name:'B',price_cents:0,currency:ev.currency}])).data
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{status:'published'})
  const start=performance.now()
  const registrations=await Promise.all(guests.map((g,i)=>rpc('register_free',g.token,{p_event:ev.id,p_ticket_type:types[i%2].id})))
  const elapsedMs=Math.round(performance.now()-start),wins=registrations.filter(r=>r.ok).length
  check('ORG-03 ORG-03A BUY-05 31 concurrent registrations across two categories issue 30 places',wins===30,{wins,elapsedMs,rejections:registrations.filter(r=>!r.ok).map(r=>r.data.message)})
  const availability=(await db(`event_availability?event_id=eq.${ev.id}`)).data[0]
  check('ORG-03A capacity30 is sold out with zero remaining',availability.state==='sold_out'&&availability.remaining===0,availability)
  const tickets=(await db(`event_tickets?event_id=eq.${ev.id}`)).data
  check('BUY-10 exactly 30 tickets issued',tickets.length===30,{tickets:tickets.length})
  const scans=await Promise.all(Array.from({length:20},()=>rpc('check_in',admin.token,{p_event:ev.id,p_ticket_code:tickets[0].code})))
  const states=scans.map(r=>typeof r.data==='string'?r.data:r.data?.result??r.data)
  check('ATT-03 20 concurrent scans record exactly one arrival',states.filter(s=>s==='ok').length===1&&states.filter(s=>s==='already').length===19,states)
  const attendance=(await db(`event_attendance?event_id=eq.${ev.id}&profile_id=eq.${tickets[0].profile_id}`)).data
  check('ATT-05 one attendance row after scan race',attendance.length===1,{rows:attendance.length})
  const cancel=await rpc('cancel_registration',admin.token,{p_registration:tickets[0].registration_id})
  const open=(await db(`event_availability?event_id=eq.${ev.id}`)).data[0]
  check('ORG-03A cancellation reopens one place',cancel.ok&&open.remaining===1&&open.state==='open',{remaining:open.remaining,state:open.state})
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{starts_at:new Date(Date.now()-7200000).toISOString(),ends_at:new Date(Date.now()-3600000).toISOString(),feedback_opens_after_minutes:0})
  await rpc('mark_attended',admin.token,{p_event:ev.id,p_profile:tickets[1].profile_id,p_reason:'Verified attendance after rescheduling to an earlier time'})
  const feedbackMessages=(await db(`event_messages?event_id=eq.${ev.id}&kind=eq.feedback_open&select=id,status,sent_at,scheduled_for`)).data
  check('FDB-06 FDB-15 earlier reschedule and corrected attendance retain initial feedback request',feedbackMessages.some(m=>['scheduled','queued','sent'].includes(m.status)),feedbackMessages)
  const messageId=feedbackMessages.find(m=>m.status==='scheduled')?.id
  if(!messageId)throw Error('No initial request to verify')
  await db(`event_message_recipients?message_id=eq.${messageId}`,undefined,'PATCH',{status:'sent',sent_at:new Date().toISOString()})
  await db(`event_messages?id=eq.${messageId}`,undefined,'PATCH',{status:'sent',sent_at:new Date().toISOString()})
  await rpc('mark_attended',admin.token,{p_event:ev.id,p_profile:tickets[2].profile_id,p_reason:'Late verified arrival'})
  await rpc('mark_attended',admin.token,{p_event:ev.id,p_profile:tickets[2].profile_id,p_reason:'Repeated correction'})
  const lateRows=(await db(`event_message_recipients?message_id=eq.${messageId}&select=profile_id,status`)).data
  check('FDB-06 late correction queues one initial request without resending prior recipients',
    lateRows.filter(r=>r.profile_id===tickets[2].profile_id&&r.status==='scheduled').length===1&&lateRows.filter(r=>r.status==='sent').length===2,lateRows)
  const messageCount=(await db(`event_messages?event_id=eq.${ev.id}&kind=eq.feedback_open`)).data
  check('FDB-15 repeat corrections reuse one feedback message',messageCount.length===1,{messages:messageCount.length})
  await db(`events?id=eq.${ev.id}`,admin.token,'PATCH',{feedback_opens_after_minutes:120})
  const delayed=(await db(`event_messages?id=eq.${messageId}&select=scheduled_for,status`)).data[0]
  check('FDB-15 changed feedback delay preserves the future opening time',delayed.status==='scheduled'&&Date.parse(delayed.scheduled_for)>Date.now(),delayed)
  // Simulate a correction during the dispatcher's claim; no provider is called.
  await db(`event_messages?id=eq.${messageId}`,undefined,'PATCH',{status:'queued'})
  await rpc('mark_attended',admin.token,{p_event:ev.id,p_profile:tickets[3].profile_id,p_reason:'Correction during dispatch'})
  await db(`event_messages?id=eq.${messageId}`,undefined,'PATCH',{status:'sent'})
  const raced=(await db(`event_messages?id=eq.${messageId}&select=status`)).data[0]
  check('FDB-06 correction during dispatch remains scheduled for the next sweep',raced.status==='scheduled',raced)
}catch(e){check('Concurrency run completed',false,e.message)}finally{
  for(const id of events){for(const t of ['event_attendance','event_registrations'])await db(`${t}?event_id=eq.${id}`,undefined,'DELETE');await db(`events?id=eq.${id}`,undefined,'DELETE')}
  for(const id of users)await api(`/auth/v1/admin/users/${id}`,undefined,'DELETE')
  writeFileSync('docs/event-platform/uat-evidence/concurrency-results.json',JSON.stringify({at:new Date().toISOString(),scope:'Local free registration only; not a production performance certification',results},null,2))
  process.exitCode=results.some(r=>!r.pass)?1:0
}
