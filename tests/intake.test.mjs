import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../functions/api/intake.js', import.meta.url), 'utf8');
const { handle, validate, normalizePhone } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const origin = 'https://preview.example.com';
const env = { INTAKE_MODE: 'controlled-dry-run', INTAKE_TEST_TOKEN: 'test-only-placeholder-token-32-characters', INTAKE_TEST_ORIGIN: origin, TURNSTILE_SECRET_KEY: 'mock-only' };
const data = { name: 'Demo Customer', phone: '(802) 555-0147', zip: '05401', message: 'Heat pump test', sms_consent: false, consent_version: 'sms-v1-2026-09-12', turnstile_token: 'mock-token' };
function request(body = data, headers = {}, method = 'POST') {
  return new Request(origin + '/api/intake', { method, headers: { Origin: origin, Authorization: 'Bearer ' + env.INTAKE_TEST_TOKEN, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
const deps = { throttle: () => true, fetch: async (url) => {
  assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  return Response.json({ success: true, hostname: 'preview.example.com', action: 'hvac_intake_test' });
}};
test('NANP normalization and invalid numbers', () => {
  for (const phone of ['8025550147', '+18025550147', '1 (802) 555-0147']) assert.equal(normalizePhone(phone), '+18025550147');
  for (const phone of ['++18025550147', '+8025550147', '123', '802CALLNOW', '8025550147 ext 2', '+442079460123']) assert.throws(() => normalizePhone(phone));
});
test('server-owned consent evidence and normalized contract', () => {
  const result = validate(data, origin, new Date('2026-09-12T00:00:00Z'));
  assert.equal(result.phone, '+18025550147'); assert.equal(result.appointment_confirmed, false);
  assert.equal(result.consent.sms, false); assert.equal(result.consent.recorded_at, '2026-09-12T00:00:00.000Z');
  assert.equal(result.consent.capture_context, 'controlled_test_not_live_consent');
});
test('strict fields, lengths, consent, ZIP, email, honeypot', () => {
  for (const patch of [{ name: '' }, { message: 'x'.repeat(2001) }, { sms_consent: 'true' }, { consent_version: 'old' }, { zip: '123' }, { email: 'bad' }, { company_site: 'spam' }, { business_id: 'attacker' }, { consent_timestamp: 'forged' }, { name: 4 }]) assert.throws(() => validate({ ...data, ...patch }, origin));
});
test('disabled by default, including a production mode value', async () => {
  for (const config of [{}, { ...env, INTAKE_MODE: 'production' }, { ...env, TURNSTILE_SECRET_KEY: '' }]) assert.equal((await handle(request(), config, deps)).status, 503);
});
test('method, origin, authentication, content type and throttle gates', async () => {
  assert.equal((await handle(request(data, {}, 'GET'), env, deps)).status, 405);
  for (const headers of [{ Origin: 'https://evil.example' }, { Authorization: '' }, { 'CF-Connecting-IP': '' }]) assert.equal((await handle(request(data, headers), env, deps)).status, 403);
  assert.equal((await handle(request(data, { 'Content-Type': 'text/plain' }), env, deps)).status, 415);
  assert.equal((await handle(request(), env, { ...deps, throttle: () => false })).status, 429);
});
test('bounded body and malformed JSON rejected', async () => {
  for (const body of ['{', 'x'.repeat(9000), 'null', '[]']) assert.equal((await handle(request(body), env, deps)).status, 400);
  assert.equal((await handle(request(data, { 'Content-Length': '9000' }), env, deps)).status, 413);
});
test('Turnstile failures fail closed and never leak upstream details', async () => {
  for (const result of [{ success: false }, { success: true, hostname: 'evil.example', action: 'hvac_intake_test' }, { success: true, hostname: 'preview.example.com', action: 'other' }]) {
    assert.equal((await handle(request(), env, { ...deps, fetch: async () => Response.json(result) })).status, 403);
  }
  const response = await handle(request(), env, { ...deps, fetch: async () => { throw new Error('SECRET'); } });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('SECRET'));
});
test('successful dry-run makes only verification request and returns no personal data', async () => {
  let calls = 0;
  const response = await handle(request(), env, { ...deps, fetch: async (...args) => { calls++; return deps.fetch(...args); } });
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const body = await response.json(); assert.equal(body.forwarded, false);
  assert.ok(!JSON.stringify(body).includes('Demo Customer')); assert.ok(!JSON.stringify(body).includes('18025550147'));
});
