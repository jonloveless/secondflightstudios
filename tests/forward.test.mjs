import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../functions/api/intake.js',import.meta.url),'utf8');
const {handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const origin='https://feature-hvac-secure-intake.secondflightstudios.pages.dev';
const env={INTAKE_MODE:'controlled-dry-run',INTAKE_TEST_ORIGIN:origin,INTAKE_TEST_TOKEN:'x'.repeat(32),TURNSTILE_SECRET_KEY:'secret',MAKE_TEST_WEBHOOK_URL:'https://hook.us2.make.com/'+'a'.repeat(32),MAKE_TEST_API_KEY:'receiver-secret'};
function req(){return new Request(origin+'/api/intake',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+env.INTAKE_TEST_TOKEN,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1','X-SFS-Test':'forward'},body:JSON.stringify({name:'Private person',phone:'8025550147',zip:'05401',message:'private text',sms_consent:true,consent_version:'sms-v1-2026-09-12',turnstile_token:'private-token'})});}
test('fixed synthetic payload and exact acknowledgement, no caller data or secrets',async()=>{
 let calls=0;
 const res=await handle(req(),env,{throttle:()=>true,fetch:async(url,opts)=>{
 calls++;
 if(calls===1)return Response.json({success:true,hostname:new URL(origin).hostname,action:'hvac_intake_test'});
 assert.equal(url,env.MAKE_TEST_WEBHOOK_URL);assert.equal(opts.redirect,'manual');assert.equal(opts.headers['x-make-apikey'],env.MAKE_TEST_API_KEY);
 const sample=JSON.parse(opts.body);assert.equal(sample.name,'Demo Customer');assert.equal(sample.consent.sms,false);assert.equal(sample.environment,'test');assert.ok(!opts.body.includes('private'));assert.ok(!opts.body.includes('secret'));
 return Response.json({status:'test_received',request_id:sample.request_id,downstream_actions:false,appointment_confirmed:false});
 }});assert.equal(res.status,200);assert.equal(calls,2);assert.equal((await res.json()).mode,'forward-test');
});
test('reject generic, mismatched, redirect and failed acknowledgements without retry',async()=>{
 for(const outcome of [()=>new Response('Accepted'),()=>Response.json({status:'test_received',request_id:'wrong',downstream_actions:false}),()=>new Response('',{status:302}),()=>new Response('',{status:401}),()=>{throw Error('secret');}]){
 let calls=0;const res=await handle(req(),env,{throttle:()=>true,fetch:async()=>{calls++;if(calls===1)return Response.json({success:true,hostname:new URL(origin).hostname,action:'hvac_intake_test'});return outcome();}});
 assert.equal(res.status,502);assert.equal(calls,2);assert.ok(!(await res.text()).includes('secret'));
 }
});
test('wrong destination never receives credentials',async()=>{let calls=0;const res=await handle(req(),{...env,MAKE_TEST_WEBHOOK_URL:'https://evil.example/'},{throttle:()=>true,fetch:async()=>{calls++;return Response.json({success:true,hostname:new URL(origin).hostname,action:'hvac_intake_test'});}});assert.equal(res.status,503);assert.equal(calls,1);});

