// Controlled dry-run only. There is deliberately no Make delivery path.
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

export async function handle(request, env, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  try {
    if (request.method !== 'POST') return fail(405);
    // Never enabled by a client field. Missing or production configuration fails closed.
    if (env.INTAKE_MODE !== 'controlled-dry-run' || !env.INTAKE_TEST_TOKEN || env.INTAKE_TEST_TOKEN.length < 32 || !env.TURNSTILE_SECRET_KEY) return fail(503, 'PREVIEW_CONFIGURATION');
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (!origin || origin !== env.INTAKE_TEST_ORIGIN || origin !== url.origin || url.search) return fail(403);
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
    const verification = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: data.turnstile_token, remoteip: ip }),
    });
    if (!verification.ok) return fail(503, 'TURNSTILE_UNAVAILABLE');
    const result = await verification.json();
    if (result.success !== true || result.hostname !== url.hostname || result.action !== 'hvac_intake_test') return fail(403);
    // Validate the intended downstream contract without transmitting or retaining it.
    if (!payload.phone || !payload.consent.recorded_at) return fail(400);
    return reply(200, { ok: true, mode: 'dry-run', forwarded: false,
      message: 'Test validated. Nothing was sent. No appointment is confirmed.' });
  } catch { return fail(503, 'PREVIEW_RUNTIME'); }
}

export const onRequest = ({ request, env }) => handle(request, env);
