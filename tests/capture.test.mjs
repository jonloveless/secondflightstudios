import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../functions/api/intake.js', import.meta.url), 'utf8');
const { savePreviewLead, claimPreviewNotification, validate, handle } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const sql = (await Promise.all([
 readFile(new URL('../migrations/0001_preview_leads.sql', import.meta.url), 'utf8'),
 readFile(new URL('../migrations/0002_preview_notification_state.sql', import.meta.url), 'utf8')
])).join('\n');
const origin = 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev';
const id = 'a40dd3bb-2ed8-4b64-9117-1ace05c821a3';
const data = {name:'Test Second Customer',phone:'8025550147',email:'demo@example.com',zip:'05401',address:'Invented test address',message:'Test: fan rattles',preferred_time:'Friday',sms_consent:false,consent_version:'sms-v1-2026-09-12',turnstile_token:'verify'};
function database() {
 const sqlite = new DatabaseSync(':memory:'); sqlite.exec(sql);
 return {sqlite, prepare: statement => ({bind: (...values) => ({first: async () => sqlite.prepare(statement).get(...values) ?? null})})};
}
test('SQL unique key keeps one record for concurrent same-ID attempts and preserves original details', async()=>{
 const db=database(); const payload=validate(data,origin,new Date('2026-09-15T00:00:00Z'));
 const results=await Promise.all(Array.from({length:20},()=>savePreviewLead(db,id,payload)));
 assert.equal(results.filter(r=>r.status==='saved').length,1);
 assert.equal(results.filter(r=>r.status==='duplicate').length,19);
 const later=validate(data,origin,new Date('2026-09-16T00:00:00Z'));
 assert.equal((await savePreviewLead(db,id,later)).status,'duplicate');
 assert.equal((await savePreviewLead(db,id,{...later,message:'Different issue'})).status,'conflict');
 const rows=db.sqlite.prepare('SELECT * FROM preview_leads').all();assert.equal(rows.length,1);
 const record=JSON.parse(rows[0].payload_json);
 assert.equal(record.name,data.name);assert.equal(record.message,data.message);assert.equal(record.phone,'+18025550147');
 assert.equal(record.email,data.email);assert.equal(record.address,data.address);assert.equal(record.preferred_time,data.preferred_time);
 assert.equal(record.consent.recorded_at,'2026-09-15T00:00:00.000Z');
 assert.equal(record.turnstile_token,undefined);assert.equal(rows[0].notification_status,'not_requested');db.sqlite.close();
});
test('capture endpoint saves validated fields, never forwards, and reports DB uncertainty',async()=>{
 const db=database();const env={INTAKE_MODE:'controlled-dry-run',INTAKE_TEST_ORIGIN:origin,INTAKE_TEST_TOKEN:'x'.repeat(32),TURNSTILE_SECRET_KEY:'secret',INTAKE_PREVIEW_DB:db};
 const req=(body=data)=>new Request(origin+'/api/intake',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+env.INTAKE_TEST_TOKEN,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1','X-SFS-Test':'capture','X-SFS-Request-ID':id},body:JSON.stringify(body)});
 let calls=0;const deps={throttle:()=>true,fetch:async url=>{calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');return Response.json({success:true,hostname:new URL(origin).hostname,action:'hvac_intake_test'});}};
 const first=await handle(req(),env,deps);assert.equal(first.status,200);assert.equal((await first.json()).storage_status,'saved');assert.equal(calls,1);
 assert.equal((await (await handle(req(),env,deps)).json()).storage_status,'duplicate');
 assert.equal((await handle(req({...data,message:'Changed'}),env,deps)).status,409);
 assert.equal((await handle(req({...data,sms_consent:true}),env,deps)).status,400);
 assert.equal((await handle(req(),{...env,INTAKE_PREVIEW_DB:undefined},deps)).status,503);
 const broken={prepare(){throw Error('PRIVATE DATABASE DETAIL');}};
 const failure=await handle(req(),{...env,INTAKE_PREVIEW_DB:broken},deps);assert.equal(failure.status,503);assert.ok(!(await failure.text()).includes('PRIVATE'));
 db.sqlite.close();
});
test('notification claim is atomic for a stored lead',async()=>{
 const db=database();const payload=validate(data,origin,new Date('2026-09-15T00:00:00Z'));
 await savePreviewLead(db,id,payload);
 const claims=await Promise.all(Array.from({length:20},()=>claimPreviewNotification(db,'biz_test_001',id,'2026-09-15T00:00:01Z')));
 assert.equal(claims.filter(item=>item.claimed).length,1);
 assert.equal(claims.filter(item=>!item.claimed&&item.status==='pending').length,19);
 const row=db.sqlite.prepare('SELECT * FROM preview_notification_state').get();
 assert.equal(row.attempt_count,1);assert.equal(row.status,'pending');db.sqlite.close();
});
test('D1-gated alert sends once, records delivery, and never auto-repeats uncertainty',async()=>{
 const db=database();const env={INTAKE_MODE:'controlled-dry-run',INTAKE_TEST_ORIGIN:origin,INTAKE_TEST_TOKEN:'x'.repeat(32),TURNSTILE_SECRET_KEY:'secret',INTAKE_PREVIEW_DB:db,MAKE_TEST_WEBHOOK_URL:'https://hook.us2.make.com/'+('a'.repeat(32)),MAKE_TEST_API_KEY:'make-secret'};
 const request=(requestId,body=data)=>new Request(origin+'/api/intake',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+env.INTAKE_TEST_TOKEN,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.2','X-SFS-Test':'capture-alert','X-SFS-Request-ID':requestId},body:JSON.stringify(body)});
 let makeCalls=0;const sent={throttle:()=>true,fetch:async(url,options)=>{
  if(url.includes('siteverify'))return Response.json({success:true,hostname:new URL(origin).hostname,action:'hvac_intake_test'});
  makeCalls++;const forwarded=JSON.parse(options.body);assert.equal(forwarded.request_id,id);assert.equal(forwarded.source,'sfs_hvac_d1_notification_test');assert.equal(forwarded.name,data.name);assert.equal(options.headers['x-make-apikey'],'make-secret');
  return Response.json({status:'staff_alert_test_result',request_id:id,notification_status:'sent',message_ref:'17',appointment_confirmed:false});
 }};
 const first=await handle(request(id),env,sent);const firstBody=await first.json();assert.equal(first.status,200);assert.equal(firstBody.notification_status,'sent');assert.equal(makeCalls,1);
 const repeat=await handle(request(id),env,sent);const repeatBody=await repeat.json();assert.equal(repeat.status,200);assert.equal(repeatBody.storage_status,'duplicate');assert.equal(repeatBody.notification_repeated,false);assert.equal(makeCalls,1);
 assert.equal((await handle(request(id,{...data,message:'Changed'}),env,sent)).status,409);assert.equal(makeCalls,1);
 const recorded=db.sqlite.prepare('SELECT * FROM preview_notification_state WHERE request_id=?').get(id);assert.equal(recorded.status,'sent');assert.equal(recorded.message_ref,'17');assert.equal(recorded.attempt_count,1);
 const uncertainId='b40dd3bb-2ed8-4b64-9117-1ace05c821a3';let uncertainCalls=0;const uncertain={throttle:()=>true,fetch:async(url)=>{
  if(url.includes('siteverify'))return Response.json({success:true,hostname:new URL(origin).hostname,action:'hvac_intake_test'});
  uncertainCalls++;return Response.json({status:'staff_alert_test_result',request_id:uncertainId,notification_status:'unconfirmed',message_ref:'',appointment_confirmed:false});
 }};
 const failed=await handle(request(uncertainId),env,uncertain);assert.equal(failed.status,502);assert.equal(uncertainCalls,1);
 const held=await handle(request(uncertainId),env,uncertain);assert.equal(held.status,202);assert.equal(uncertainCalls,1);
 assert.equal(db.sqlite.prepare('SELECT status FROM preview_notification_state WHERE request_id=?').get(uncertainId).status,'unconfirmed');db.sqlite.close();
});

