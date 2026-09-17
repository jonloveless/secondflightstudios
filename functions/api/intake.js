// Public Second Flight Studios demo intake. Only the /demo workflow is exposed.
const ORIGIN = 'https://secondflightstudios.com';
const MAX_BYTES = 8192;
const limits = { name: 100, phone: 32, email: 254, zip: 10, address: 200,
  message: 2000, preferred_time: 160, company_site: 200, turnstile_token: 2048 };
const allowed = new Set(Object.keys(limits));
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const reply = (status, body) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Allow': 'POST',
} });
const fail = (status, code = 'REQUEST_REJECTED') => reply(status, {
  ok: false, code, message: 'Request could not be processed.',
});

function normalizePhone(value) {
  if (!/^[+\d\s().-]+$/.test(value)) throw new Error('invalid');
  if ((value.match(/\+/g) ?? []).length > 1 || (value.includes('+') && !value.startsWith('+'))) throw new Error('invalid');
  let digits = value.replace(/\D/g, '');
  if (!value.startsWith('+') && digits.length === 10) digits = '1' + digits;
  if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) throw new Error('invalid');
  return '+' + digits;
}

function validate(data, now = new Date()) {
  if (!data || Array.isArray(data) || typeof data !== 'object' ||
      Object.keys(data).some(key => !allowed.has(key))) throw new Error('invalid');
  const clean = {};
  for (const [key, max] of Object.entries(limits)) {
    const value = data[key] ?? '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new Error('invalid');
    clean[key] = value.trim();
  }
  if (!clean.name || !clean.message || clean.company_site || !clean.turnstile_token) throw new Error('invalid');
  if (!/^\d{5}(-\d{4})?$/.test(clean.zip)) throw new Error('invalid');
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw new Error('invalid');
  return { name: clean.name, phone: normalizePhone(clean.phone), email: clean.email,
    zip: clean.zip, address: clean.address, message: clean.message,
    preferred_time: clean.preferred_time, business_id: 'biz_test_001',
    source: 'sfs_public_demo', record_type: 'Test', appointment_confirmed: false,
    consent: { sms: false, disclosure_version: 'sfs-demo-2026-09-17',
      recorded_at: now.toISOString(), source_page: ORIGIN + '/demo',
      capture_context: 'sfs_public_demo' } };
}

async function boundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function rateLimit(database, ip, secret, now = Date.now()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)));
  const fingerprint = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
  const window = Math.floor(now / 60000);
  const db = database.withSession ? database.withSession('first-primary') : database;
  for (const [bucket, maximum] of [[`ip:${fingerprint}`, 5], ['all', 60]]) {
    const row = await db.prepare(`INSERT INTO demo_rate_limits (bucket, window_start, count, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN demo_rate_limits.window_start = excluded.window_start
        THEN demo_rate_limits.count + 1 ELSE 1 END,
      window_start = excluded.window_start, updated_at = excluded.updated_at
      RETURNING count`).bind(bucket, window, now).first();
    if (!row || row.count > maximum) return false;
  }
  return true;
}

async function saveLead(database, requestId, payload) {
  const db = database.withSession ? database.withSession('first-primary') : database;
  const { recorded_at, ...consent } = payload.consent;
  const stable = { ...payload, consent };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable)));
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  const envelope = { schema_version: 'service-lead.v1', request_id: requestId,
    received_at: recorded_at, environment: 'demo', ...payload };
  const inserted = await db.prepare(`INSERT INTO preview_leads
    (business_id, request_id, payload_hash, received_at, payload_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (business_id, request_id) DO NOTHING
    RETURNING request_id`).bind(payload.business_id, requestId, hash, recorded_at, JSON.stringify(envelope)).first();
  if (inserted) return 'saved';
  const existing = await db.prepare('SELECT payload_hash FROM preview_leads WHERE business_id = ? AND request_id = ?')
    .bind(payload.business_id, requestId).first();
  if (!existing) throw new Error('capture unconfirmed');
  return existing.payload_hash === hash ? 'duplicate' : 'conflict';
}

async function claimWorkflow(database, businessId, requestId, at) {
  const db = database.withSession ? database.withSession('first-primary') : database;
  const inserted = await db.prepare(`INSERT INTO preview_notification_state
    (business_id, request_id, status, attempt_count, first_attempt_at, last_attempt_at)
    VALUES (?, ?, 'pending', 1, ?, ?) ON CONFLICT (business_id, request_id) DO NOTHING
    RETURNING status`).bind(businessId, requestId, at, at).first();
  if (inserted) return { claimed: true, status: 'pending' };
  const existing = await db.prepare(`SELECT status FROM preview_notification_state
    WHERE business_id = ? AND request_id = ?`).bind(businessId, requestId).first();
  if (!existing) throw new Error('claim unconfirmed');
  return { claimed: false, status: existing.status };
}

async function finishWorkflow(database, businessId, requestId, status, ref = '', errorCode = '') {
  const db = database.withSession ? database.withSession('first-primary') : database;
  const updated = await db.prepare(`UPDATE preview_notification_state
    SET status = ?, message_ref = ?, last_error_code = ?
    WHERE business_id = ? AND request_id = ? AND status = 'pending'
    RETURNING status`).bind(status, String(ref), errorCode, businessId, requestId).first();
  if (!updated) throw new Error('workflow update unconfirmed');
}

function makeTarget(env) {
  let target;
  try { target = new URL(env.DEMO_MAKE_WEBHOOK_URL); } catch { throw new Error('configuration'); }
  if (target.protocol !== 'https:' || target.hostname !== 'hook.us2.make.com' ||
      target.port || target.username || target.password || target.search || target.hash ||
      !/^[/][a-z0-9]{32}$/.test(target.pathname) || !env.DEMO_MAKE_API_KEY) throw new Error('configuration');
  return target;
}

export async function handle(request, env, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  if (request.method !== 'POST') return fail(405);
  if (!env.DEMO_DB || !env.DEMO_TURNSTILE_SECRET_KEY ||
      !env.DEMO_MAKE_WEBHOOK_URL || !env.DEMO_MAKE_API_KEY ||
      !env.DEMO_RATE_LIMIT_SECRET || env.DEMO_RATE_LIMIT_SECRET.length < 32) return fail(503, 'DEMO_CONFIGURATION');
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.search || request.headers.get('Origin') !== ORIGIN) return fail(403);
  const requestId = request.headers.get('X-SFS-Request-ID');
  if (!requestIdPattern.test(requestId ?? '')) return fail(400);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return fail(403);
  try { if (!await (dependencies.rateLimit ?? rateLimit)(env.DEMO_DB, ip, env.DEMO_RATE_LIMIT_SECRET)) return fail(429); }
  catch { return fail(503, 'RATE_LIMIT_UNAVAILABLE'); }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415);
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return fail(413);
  let data, payload;
  try { data = await boundedJson(request); payload = validate(data); }
  catch { return fail(400); }
  let verification;
  try {
    verification = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ secret: env.DEMO_TURNSTILE_SECRET_KEY,
        response: data.turnstile_token, remoteip: ip }),
    });
    if (!verification.ok) return fail(503, 'TURNSTILE_UNAVAILABLE');
    const result = await verification.json();
    if (result.success !== true || result.hostname !== url.hostname ||
        result.action !== 'sfs_public_demo') return fail(403);
  } catch { return fail(503, 'TURNSTILE_UNAVAILABLE'); }

  let stored;
  try { stored = await saveLead(env.DEMO_DB, requestId, payload); }
  catch { return reply(503, { ok: false, code: 'CAPTURE_UNCONFIRMED', request_id: requestId }); }
  if (stored === 'conflict') return reply(409, { ok: false, code: 'REQUEST_ID_CONFLICT', request_id: requestId });
  let claim;
  try { claim = await claimWorkflow(env.DEMO_DB, payload.business_id, requestId, payload.consent.recorded_at); }
  catch { return reply(503, { ok: false, code: 'WORKFLOW_CLAIM_UNCONFIRMED', request_id: requestId, stored: true }); }
  if (!claim.claimed) {
    if (claim.status === 'sent') return reply(200, { ok: true, request_id: requestId,
      stored: true, storage_status: stored, workflow_status: 'sent', workflow_repeated: false });
    return reply(202, { ok: false, code: 'WORKFLOW_RECONCILIATION_REQUIRED',
      request_id: requestId, stored: true, workflow_status: claim.status });
  }
  let target;
  try { target = makeTarget(env); }
  catch {
    await finishWorkflow(env.DEMO_DB, payload.business_id, requestId, 'unconfirmed', '', 'MAKE_CONFIGURATION').catch(() => {});
    return reply(503, { ok: false, code: 'MAKE_CONFIGURATION', request_id: requestId, stored: true });
  }
  // The legacy internal routing label is retained so the verified Make demo arm can be reused unchanged.
  const outbound = { schema_version: 'hvac-lead.v1', request_id: requestId,
    received_at: payload.consent.recorded_at, environment: 'test', ...payload,
    source: 'sfs_hvac_d1_demo_test' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const delivery = await fetcher(target.href, { method: 'POST', redirect: 'manual',
      signal: controller.signal, headers: { 'Content-Type': 'application/json',
        'x-make-apikey': env.DEMO_MAKE_API_KEY }, body: JSON.stringify(outbound) });
    if (delivery.status !== 200) throw new Error('MAKE_REJECTED');
    const ack = await boundedJson(delivery);
    if (ack.status !== 'demo_workflow_result' || ack.request_id !== requestId ||
        !['stored', 'updated'].includes(ack.sheet_status) ||
        ack.customer_status !== 'sent' || ack.staff_status !== 'sent' ||
        !ack.customer_message_ref || !ack.staff_message_ref ||
        ack.appointment_confirmed !== false) throw new Error('WORKFLOW_UNCONFIRMED');
    await finishWorkflow(env.DEMO_DB, payload.business_id, requestId, 'sent', ack.staff_message_ref);
    return reply(200, { ok: true, request_id: requestId, stored: true,
      storage_status: stored, workflow_status: 'sent', sheet_status: ack.sheet_status,
      customer_status: ack.customer_status, staff_status: ack.staff_status });
  } catch (error) {
    await finishWorkflow(env.DEMO_DB, payload.business_id, requestId, 'unconfirmed', '',
      error.message === 'MAKE_REJECTED' ? 'MAKE_REJECTED' : 'WORKFLOW_UNCONFIRMED').catch(() => {});
    return reply(502, { ok: false, code: 'WORKFLOW_UNCONFIRMED',
      request_id: requestId, stored: true, workflow_status: 'unconfirmed' });
  } finally { clearTimeout(timer); }
}

export async function onRequestPost({ request, env }) { return handle(request, env); }

