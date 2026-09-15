// Operator-only preview tests. Forwarding sends a fixed synthetic sample.
const MAX_BYTES = 8192;
const VERSION = 'sms-v1-2026-09-12';
const limits = { name: 100, phone: 32, email: 254, zip: 10, address: 200,
  message: 2000, preferred_time: 160, company_site: 200, turnstile_token: 2048 };
const allowed = new Set([...Object.keys(limits), 'sms_consent', 'consent_version']);

function reply(status, body) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Allow': 'POST',
  }});
}
const fail = (status, code = 'REQUEST_REJECTED') => reply(status, { ok: false, code, message: 'Request could not be processed.' });

export function normalizePhone(value) {
  if (!/^[+\d\s().-]+$/.test(value)) throw new Error('invalid');
  if ((value.match(/\+/g) ?? []).length > 1 || (value.includes('+') && !value.startsWith('+'))) throw new Error('invalid');
  let digits = value.replace(/\D/g, '');
  if (!value.startsWith('+') && digits.length === 10) digits = '1' + digits;
  // This demo supports NANP numbers only; this checks structure, not ownership.
  if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) throw new Error('invalid');
  return '+' + digits;
}

export function validate(data, origin, now = new Date()) {
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('invalid');
  if (Object.keys(data).some(key => !allowed.has(key))) throw new Error('invalid');
  const clean = {};
  for (const [key, max] of Object.entries(limits)) {
    const value = data[key] ?? '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new Error('invalid');
    clean[key] = value.trim();
  }
  if (!clean.name || !clean.message || clean.company_site) throw new Error('invalid');
  if (!/^\d{5}(-\d{4})?$/.test(clean.zip)) throw new Error('invalid');
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw new Error('invalid');
  if (typeof data.sms_consent !== 'boolean' || data.consent_version !== VERSION) throw new Error('invalid');
  clean.phone = normalizePhone(clean.phone);
  return { name: clean.name, phone: clean.phone, email: clean.email, zip: clean.zip,
    address: clean.address, message: clean.message, preferred_time: clean.preferred_time,
    business_id: 'biz_test_001', source: 'sfs_hvac_controlled_test', record_type: 'Test',
    appointment_confirmed: false,
    consent: { sms: data.sms_consent, disclosure_version: VERSION,
      recorded_at: now.toISOString(), source_page: origin + '/demo',
      capture_context: 'controlled_test_not_live_consent' } };
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

async function sameSecret(actual, expected) {
  const encode = value => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([actual, expected].map(value => crypto.subtle.digest('SHA-256', encode(value))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

// Best-effort, isolate-local test throttle; NOT production/global rate limiting.
const attempts = new Map();
function testThrottle(ip) {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
  if (!attempts.has(ip) && attempts.size >= 1000) return false;
  const entry = attempts.get(ip) ?? { count: 0, expires: now + 60000 };
  attempts.set(ip, entry); return ++entry.count <= 5;
}

// Durable preview capture is intentionally separate from the fixed Make sample.
// The unique key is enforced by SQL, not a read-then-write check in JavaScript.
export async function savePreviewLead(database, requestId, payload) {
  const db = database.withSession ? database.withSession('first-primary') : database;
  const { recorded_at, ...consent } = payload.consent;
  const stable = { ...payload, consent };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable)));
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  const envelope = { schema_version: 'hvac-lead.v1', request_id: requestId,
    received_at: recorded_at, environment: 'test', ...payload };
  const inserted = await db.prepare(`INSERT INTO preview_leads
    (business_id, request_id, payload_hash, received_at, payload_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (business_id, request_id) DO NOTHING
    RETURNING request_id`).bind(payload.business_id, requestId, hash, recorded_at, JSON.stringify(envelope)).first();
  if (inserted) return { status: 'saved', stored: true };
  const existing = await db.prepare('SELECT payload_hash FROM preview_leads WHERE business_id = ? AND request_id = ?')
    .bind(payload.business_id, requestId).first();
  if (!existing) throw new Error('capture unconfirmed');
  return existing.payload_hash === hash ? { status: 'duplicate', stored: true } : { status: 'conflict', stored: false };
}

export async function claimPreviewNotification(database, businessId, requestId, attemptedAt) {
  const db = database.withSession ? database.withSession('first-primary') : database;
  const inserted = await db.prepare(`INSERT INTO preview_notification_state
    (business_id, request_id, status, attempt_count, first_attempt_at, last_attempt_at)
    VALUES (?, ?, 'pending', 1, ?, ?) ON CONFLICT (business_id, request_id) DO NOTHING
    RETURNING status`).bind(businessId, requestId, attemptedAt, attemptedAt).first();
  if (inserted) return { claimed: true, status: 'pending' };
  const existing = await db.prepare(`SELECT status, attempt_count, message_ref, last_error_code
    FROM preview_notification_state WHERE business_id = ? AND request_id = ?`)
    .bind(businessId, requestId).first();
  if (!existing) throw new Error('notification claim unconfirmed');
  return { claimed: false, ...existing };
}

export async function finishPreviewNotification(database, businessId, requestId, status, messageRef = '', errorCode = '') {
  if (!['sent', 'unconfirmed'].includes(status)) throw new Error('invalid notification status');
  const db = database.withSession ? database.withSession('first-primary') : database;
  const updated = await db.prepare(`UPDATE preview_notification_state
    SET status = ?, message_ref = ?, last_error_code = ?
    WHERE business_id = ? AND request_id = ? AND status = 'pending'
    RETURNING status, attempt_count, message_ref, last_error_code`)
    .bind(status, String(messageRef), errorCode, businessId, requestId).first();
  if (updated) return updated;
  const existing = await db.prepare(`SELECT status, attempt_count, message_ref, last_error_code
    FROM preview_notification_state WHERE business_id = ? AND request_id = ?`)
    .bind(businessId, requestId).first();
  if (!existing || existing.status !== status) throw new Error('notification update unconfirmed');
  return existing;
}

export async function listPreviewNotificationReconciliation(database, limit = 25) {
  const db = database.withSession ? database.withSession('first-primary') : database;
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 25, 50));
  const response = await db.prepare(`SELECT n.request_id, n.status, n.attempt_count,
    n.first_attempt_at, n.last_attempt_at, n.last_error_code, l.payload_json
    FROM preview_notification_state n
    JOIN preview_leads l ON l.business_id = n.business_id AND l.request_id = n.request_id
    WHERE n.business_id = ? AND n.status IN ('pending', 'unconfirmed')
    ORDER BY n.first_attempt_at ASC LIMIT ?`).bind('biz_test_001', boundedLimit).all();
  const rows = Array.isArray(response) ? response : response?.results ?? [];
  return rows.map(row => {
    let payload = {};
    try { payload = JSON.parse(row.payload_json); } catch {}
    return { request_id: row.request_id, status: row.status, attempt_count: row.attempt_count,
      first_attempt_at: row.first_attempt_at, last_attempt_at: row.last_attempt_at,
      last_error_code: row.last_error_code,
      lead: { name: String(payload.name ?? ''), zip: String(payload.zip ?? ''), message: String(payload.message ?? '') } };
  });
}

function makeTarget(env) {
  let target;
  try { target = new URL(env.MAKE_TEST_WEBHOOK_URL); } catch { throw new Error('configuration'); }
  if (target.protocol !== 'https:' || target.hostname !== 'hook.us2.make.com' ||
      target.port || target.username || target.password || target.search || target.hash ||
      !/^[/][a-z0-9]{32}$/.test(target.pathname) || !env.MAKE_TEST_API_KEY) throw new Error('configuration');
  return target;
}

export async function handle(request, env, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  let stage = 'start';
  try {
    if (request.method !== 'POST') return fail(405);
    // Never enabled by a client field. Missing or production configuration fails closed.
    if (env.INTAKE_MODE !== 'controlled-dry-run' || !env.INTAKE_TEST_TOKEN || env.INTAKE_TEST_TOKEN.length < 32 || !env.TURNSTILE_SECRET_KEY) return fail(503, 'PREVIEW_CONFIGURATION');
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (!origin || origin !== env.INTAKE_TEST_ORIGIN || origin !== url.origin || url.search) return fail(403);
    const testType = request.headers.get('X-SFS-Test');
    if (![null, 'forward', 'storage', 'capture', 'capture-alert', 'reconcile'].includes(testType)) return fail(400);
    const reconcile = testType === 'reconcile';
    const captureAlert = testType === 'capture-alert';
    const capture = testType === 'capture' || captureAlert;
    const storage = testType === 'storage';
    const forward = storage || request.headers.get('X-SFS-Test') === 'forward';
    const storageId = request.headers.get('X-SFS-Request-ID');
    if ((storage || capture) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(storageId ?? '')) return fail(400);
    if ((forward || capture) && origin !== 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev') return fail(403);
    if ((capture || reconcile) && !env.INTAKE_PREVIEW_DB) return fail(503, 'CAPTURE_CONFIGURATION');
    const auth = request.headers.get('Authorization') ?? '';
    if (auth.length > 512 || !await sameSecret(auth, 'Bearer ' + env.INTAKE_TEST_TOKEN)) return fail(403);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return fail(403);
    if (!(dependencies.throttle ?? testThrottle)(ip)) return fail(429);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415);
    if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return fail(413);
    let data, payload;
    try { data = await boundedJson(request); payload = validate(data, origin); }
    catch { return fail(400); }
    if (!data.turnstile_token) return fail(400);
    stage = 'turnstile-request';
    const verification = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: data.turnstile_token, remoteip: ip }),
    });
    if (!verification.ok) return fail(503, 'TURNSTILE_UNAVAILABLE');
    stage = 'turnstile-response';
    const result = await verification.json();
    if (result.success !== true || result.hostname !== url.hostname || result.action !== 'hvac_intake_test') return fail(403);
    // Validate the intended downstream contract without transmitting or retaining it.
    stage = 'final-check';
    if (!payload.phone || !payload.consent.recorded_at) return fail(400);
    if (reconcile) {
      stage = 'notification-reconciliation';
      try {
        const items = await listPreviewNotificationReconciliation(env.INTAKE_PREVIEW_DB);
        return reply(200, { ok: true, mode: 'notification-reconciliation', count: items.length, items });
      } catch { return reply(503, { ok: false, code: 'RECONCILIATION_UNAVAILABLE' }); }
    }
    if (capture) {
      stage = 'durable-capture';
      payload.source = 'sfs_hvac_capture_test';
      payload.consent.source_page = origin + '/intake-test';
      payload.consent.capture_context = 'synthetic_test';
      // Operator test evidence must never be represented as customer SMS permission.
      if (payload.consent.sms !== false) return fail(400, 'SYNTHETIC_CONSENT_REQUIRED');
      try {
        const saved = await savePreviewLead(env.INTAKE_PREVIEW_DB, storageId, payload);
        if (saved.status === 'conflict') return reply(409, { ok: false, code: 'REQUEST_ID_CONFLICT', request_id: storageId });
        if (!captureAlert) return reply(200, { ok: true, mode: 'capture-test', request_id: storageId,
          stored: true, storage_status: saved.status, notification_status: 'not_requested' });
        let claim;
        try { claim = await claimPreviewNotification(env.INTAKE_PREVIEW_DB, payload.business_id, storageId, payload.consent.recorded_at); }
        catch { return reply(503, { ok: false, code: 'NOTIFICATION_CLAIM_UNCONFIRMED', request_id: storageId }); }
        if (!claim.claimed) {
          if (claim.status === 'sent') return reply(200, { ok: true, mode: 'capture-alert-test', request_id: storageId,
            stored: true, storage_status: saved.status, notification_status: 'sent', notification_repeated: false });
          return reply(202, { ok: false, code: 'NOTIFICATION_RECONCILIATION_REQUIRED', request_id: storageId,
            stored: true, storage_status: saved.status, notification_status: claim.status });
        }
        let target;
        try { target = makeTarget(env); }
        catch { await finishPreviewNotification(env.INTAKE_PREVIEW_DB, payload.business_id, storageId, 'unconfirmed', '', 'MAKE_TEST_CONFIGURATION').catch(() => {});
          return reply(503, { ok: false, code: 'MAKE_TEST_CONFIGURATION', request_id: storageId }); }
        const outbound = { schema_version: 'hvac-lead.v1', request_id: storageId,
          received_at: payload.consent.recorded_at, environment: 'test', ...payload,
          source: 'sfs_hvac_d1_notification_test' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const delivery = await fetcher(target.href, { method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'x-make-apikey': env.MAKE_TEST_API_KEY }, body: JSON.stringify(outbound) });
          if (delivery.status !== 200) throw new Error('MAKE_TEST_REJECTED');
          const ack = await boundedJson(delivery);
          if (ack.status !== 'staff_alert_test_result' || ack.request_id !== storageId || ack.appointment_confirmed !== false ||
              !['sent', 'unconfirmed'].includes(ack.notification_status)) throw new Error('MAKE_TEST_UNCONFIRMED');
          if (ack.notification_status !== 'sent') throw new Error('STAFF_DELIVERY_UNCONFIRMED');
          try { await finishPreviewNotification(env.INTAKE_PREVIEW_DB, payload.business_id, storageId, 'sent', ack.message_ref ?? ''); }
          catch { return reply(503, { ok: false, code: 'NOTIFICATION_LOG_UNCONFIRMED', request_id: storageId }); }
          return reply(200, { ok: true, mode: 'capture-alert-test', request_id: storageId,
            stored: true, storage_status: saved.status, notification_status: 'sent', notification_repeated: false });
        } catch (error) {
          const code = ['MAKE_TEST_REJECTED', 'STAFF_DELIVERY_UNCONFIRMED'].includes(error.message) ? error.message : 'MAKE_TEST_UNCONFIRMED';
          await finishPreviewNotification(env.INTAKE_PREVIEW_DB, payload.business_id, storageId, 'unconfirmed', '', code).catch(() => {});
          return reply(502, { ok: false, code, request_id: storageId, stored: true, notification_status: 'unconfirmed' });
        } finally { clearTimeout(timer); }
      } catch { return reply(503, { ok: false, code: 'CAPTURE_UNCONFIRMED', request_id: storageId }); }
    }
    if (forward) {
      let target;
      try { target = makeTarget(env); } catch { return fail(503, 'MAKE_TEST_CONFIGURATION'); }
      const requestId = storage ? storageId : crypto.randomUUID();
      const now = new Date().toISOString();
      // No caller contact data or tokens are forwarded, even if supplied in a valid request.
      const sample = { schema_version: 'hvac-lead.v1', request_id: requestId, received_at: now,
        environment: 'test', business_id: 'biz_test_001', source: storage ? 'sfs_hvac_storage_test' : 'sfs_hvac_intake', record_type: 'Test',
        name: 'Demo Customer', phone: '+18025550147', zip: '05401', email: '', address: '', preferred_time: '',
        message: 'Test only: heat pump is not warming the house.', appointment_confirmed: false,
        consent: { sms: false, disclosure_version: VERSION, recorded_at: now,
          source_page: origin + '/intake-test', capture_context: 'synthetic_test' } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const delivery = await fetcher(target.href, { method: 'POST', redirect: 'manual',
          signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-make-apikey': env.MAKE_TEST_API_KEY },
          body: JSON.stringify(sample) });
        if (delivery.status !== 200) return reply(502, { ok: false, code: 'MAKE_TEST_REJECTED', request_id: requestId });
        const ack = await boundedJson(delivery);
        if (storage) {
          const validOutcome = ack.storage_status === 'duplicate'
            ? ack.notification_status === 'not_repeated'
            : ack.storage_status === 'stored' && ['sent', 'unconfirmed', 'unconfirmed_log_update_failed', 'sent_log_update_failed'].includes(ack.notification_status);
          if (ack.status !== 'storage_test_result' || ack.request_id !== requestId || ack.appointment_confirmed !== false || !validOutcome) return reply(502, { ok: false, code: 'STORAGE_UNCONFIRMED', request_id: requestId });
          return reply(200, { ok: true, mode: 'storage-test', request_id: requestId, stored: true, storage_status: ack.storage_status, notification_status: ack.notification_status });
        }
        if (ack.status !== 'test_received' || ack.request_id !== requestId || ack.downstream_actions !== false ||
            ack.appointment_confirmed !== false) return reply(502, { ok: false, code: 'MAKE_TEST_UNCONFIRMED', request_id: requestId });
        return reply(200, { ok: true, mode: 'forward-test', forwarded: true, request_id: requestId, downstream_actions: false });
      } catch {
        return reply(502, { ok: false, code: 'MAKE_TEST_UNCONFIRMED', request_id: requestId });
      } finally { clearTimeout(timer); }
    }
    return reply(200, { ok: true, mode: 'dry-run', forwarded: false,
      message: 'Test validated. Nothing was sent. No appointment is confirmed.' });
  } catch { return fail(503, `PREVIEW_RUNTIME_${stage}`); }
}

export const onRequest = ({ request, env }) => handle(request, env);

