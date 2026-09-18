import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { handleWebOptIn, handleTwilioWebhook, canSendSms } from '../lib/sms-consent.mjs';

const origin = 'https://secondflightstudios.com';
const schema = await readFile(new URL('../migrations/0003_sms_consent.sql', import.meta.url), 'utf8');
const phone = '+18025550147';
function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
  const db = { prepare: sql => ({ bind: (...values) => ({
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    run: async () => sqlite.prepare(sql).run(...values),
  }) }) };
  const env = { SMS_CONSENT_DB: db, DEMO_TURNSTILE_SECRET_KEY: 'test',
    DEMO_RATE_LIMIT_SECRET: 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'auth-token-test',
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'b'.repeat(32) };
  return { sqlite, db, env };
}
const body = { phone: '(802) 555-0147', consent: true, turnstile_token: 'token',
  company_site: '', source_page: '/sms-consent' };
const webRequest = data => new Request(origin + '/api/sms-consent', { method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.2' },
  body: JSON.stringify(data) });
const opts = { rateLimit: async () => true, fetch: async () => Response.json({
  success: true, hostname: 'secondflightstudios.com', action: 'sfs_sms_consent',
}) };
function twilioRequest(env, action, sid, overrideSignature = false) {
  const url = origin + '/api/sms-twilio';
  const params = new URLSearchParams({ AccountSid: env.TWILIO_ACCOUNT_SID,
    MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, From: phone,
    MessageSid: 'SM' + sid.repeat(32), OptOutType: action });
  const signed = url + [...params.keys()].sort().map(key => key + params.get(key)).join('');
  const signature = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(signed).digest('base64');
  return new Request(url, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Twilio-Signature': overrideSignature ? 'invalid' : signature,
  }, body: params.toString() });
}

test('explicit opt-in only; duplicate consent is auditable and no arbitrary fields are stored', async () => {
  const { sqlite, db, env } = fixture();
  assert.equal(await canSendSms(db, phone), false);
  assert.equal((await handleWebOptIn(webRequest({ ...body, consent: false }), env, opts)).status, 400);
  assert.equal((await handleWebOptIn(webRequest(body), env, opts)).status, 200);
  assert.equal((await handleWebOptIn(webRequest(body), env, opts)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sms_consent_events').get().n, 2);
  const row = sqlite.prepare('SELECT * FROM sms_consent_events LIMIT 1').get();
  assert.equal(row.phone, phone); assert.equal(row.consent_status, 'opted_in');
  assert.equal(row.capture_context, 'sfs_web_sms_optin');
  assert.equal(row.source_page, origin + '/sms-consent');
  assert.ok(row.recorded_at); assert.ok(row.consent_version);
  assert.equal(await canSendSms(db, phone), true);
});

test('Turnstile, exact origin and body validation fail closed', async () => {
  const { sqlite, env } = fixture();
  assert.equal((await handleWebOptIn(webRequest({ ...body, unexpected: 'x' }), env, opts)).status, 400);
  assert.equal((await handleWebOptIn(webRequest(body), env, { ...opts,
    fetch: async () => Response.json({ success: false }) })).status, 403);
  const wrong = new Request(origin + '/api/sms-consent', { method: 'POST',
    headers: { Origin: 'https://www.secondflightstudios.com',
      'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.2' },
    body: JSON.stringify(body) });
  assert.equal((await handleWebOptIn(wrong, env, opts)).status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sms_consent_events').get().n, 0);
});

test('signed STOP, START and HELP preserve current consent; invalid signatures are rejected', async () => {
  const { sqlite, db, env } = fixture();
  await handleWebOptIn(webRequest(body), env, opts);
  assert.equal((await handleTwilioWebhook(twilioRequest(env, 'STOP', 'a', true), env)).status, 403);
  assert.equal(await canSendSms(db, phone), true);
  assert.equal((await handleTwilioWebhook(twilioRequest(env, 'STOP', 'b'), env)).status, 200);
  assert.equal(await canSendSms(db, phone), false);
  assert.equal((await handleTwilioWebhook(twilioRequest(env, 'HELP', 'c'), env)).status, 200);
  assert.equal(await canSendSms(db, phone), false);
  assert.equal((await handleTwilioWebhook(twilioRequest(env, 'START', 'd'), env)).status, 200);
  assert.equal(await canSendSms(db, phone), true);
  assert.equal((await handleTwilioWebhook(twilioRequest(env, 'STOP', 'b'), env)).status, 200);
  assert.equal(await canSendSms(db, phone), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sms_consent_events').get().n, 4);
  assert.equal(await canSendSms(db, '+18025550148'), false);
  const other = fixture();
  assert.equal((await handleTwilioWebhook(twilioRequest(other.env, 'START', 'e'), other.env)).status, 200);
  assert.equal(await canSendSms(other.db, phone), false);
});
