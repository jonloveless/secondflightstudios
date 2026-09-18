const ORIGIN = 'https://secondflightstudios.com';
const WEB_PATH = '/api/sms-consent';
const TWILIO_PATH = '/api/sms-twilio';
const DISCLOSURE_VERSION = 'sfs-sms-v1-2026-09-18';
const MAX_WEB_BYTES = 4096;
const MAX_TWILIO_BYTES = 16384;

const dbSession = database => database.withSession ? database.withSession('first-primary') : database;
const json = (status, body) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Allow': 'POST',
} });
const reject = (status, code = 'REQUEST_REJECTED') =>
  json(status, { ok: false, code, message: 'Request could not be processed.' });

function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^[+\d\s().-]+$/.test(value) ||
      (value.match(/\+/g) ?? []).length > 1 ||
      (value.includes('+') && !value.startsWith('+'))) throw new Error('invalid phone');
  let digits = value.replace(/\D/g, '');
  if (!value.startsWith('+') && digits.length === 10) digits = '1' + digits;
  if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) throw new Error('invalid phone');
  return '+' + digits;
}

async function boundedText(request, maximum) {
  if (Number(request.headers.get('Content-Length')) > maximum) throw new Error('too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function rateLimit(database, ip, secret, now = Date.now()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)));
  const fingerprint = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
  const window = Math.floor(now / 60000);
  const db = dbSession(database);
  for (const [bucket, maximum] of [[`ip:${fingerprint}`, 3], ['all', 30]]) {
    const row = await db.prepare(`INSERT INTO sms_consent_rate_limits (bucket, window_start, count, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN sms_consent_rate_limits.window_start = excluded.window_start
        THEN sms_consent_rate_limits.count + 1 ELSE 1 END,
      window_start = excluded.window_start, updated_at = excluded.updated_at
      RETURNING count`).bind(bucket, window, now).first();
    if (!row || row.count > maximum) return false;
  }
  return true;
}

function webFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !['phone', 'consent', 'turnstile_token', 'company_site', 'source_page'].includes(key)) ||
      data.consent !== true || typeof data.turnstile_token !== 'string' ||
      !data.turnstile_token || data.turnstile_token.length > 2048 ||
      data.company_site !== '' ||
      !['/sms-consent', '/sms-consent.html'].includes(data.source_page)) throw new Error('invalid');
  return { phone: normalizePhone(data.phone), source_page: ORIGIN + data.source_page };
}

export async function handleWebOptIn(request, env, dependencies = {}) {
  if (request.method !== 'POST') return reject(405);
  if (!env.SMS_CONSENT_DB || !env.DEMO_TURNSTILE_SECRET_KEY ||
      !env.DEMO_RATE_LIMIT_SECRET || env.DEMO_RATE_LIMIT_SECRET.length < 32)
    return reject(503, 'SMS_CONFIGURATION');
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.pathname !== WEB_PATH || url.search ||
      request.headers.get('Origin') !== ORIGIN) return reject(403);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return reject(403);
  try {
    if (!await (dependencies.rateLimit ?? rateLimit)(env.SMS_CONSENT_DB, ip, env.DEMO_RATE_LIMIT_SECRET))
      return reject(429);
  } catch { return reject(503, 'RATE_LIMIT_UNAVAILABLE'); }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return reject(415);
  let data, fields;
  try {
    data = JSON.parse(await boundedText(request, MAX_WEB_BYTES));
    fields = webFields(data);
  } catch { return reject(400); }
  try {
    const verification = await (dependencies.fetch ?? fetch)(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({ secret: env.DEMO_TURNSTILE_SECRET_KEY,
          response: data.turnstile_token, remoteip: ip }),
      });
    if (!verification.ok) return reject(503, 'TURNSTILE_UNAVAILABLE');
    const result = await verification.json();
    if (result.success !== true || result.hostname !== url.hostname ||
        result.action !== 'sfs_sms_consent') return reject(403);
  } catch { return reject(503, 'TURNSTILE_UNAVAILABLE'); }
  try {
    const at = (dependencies.now ?? (() => new Date()))().toISOString();
    await dbSession(env.SMS_CONSENT_DB).prepare(`INSERT INTO sms_consent_events
      (phone, consent_status, consent_version, source_page, capture_context, recorded_at)
      VALUES (?, 'opted_in', ?, ?, 'sfs_web_sms_optin', ?)`)
      .bind(fields.phone, DISCLOSURE_VERSION, fields.source_page, at).run();
    return json(200, { ok: true, status: 'consent_recorded' });
  } catch { return reject(503, 'CONSENT_STORAGE_UNAVAILABLE'); }
}

function decodedSignature(value) {
  if (!/^[A-Za-z0-9+/]{27}=$/.test(value ?? '')) return null;
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
  catch { return null; }
}

// Twilio's documented form webhook signature: exact URL followed by sorted form name/value pairs.
export async function validTwilioSignature(url, params, header, authToken) {
  const received = decodedSignature(header);
  if (!received || !authToken) return false;
  const names = [...params.keys()].sort();
  const signed = url + names.map(name => name + params.get(name)).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)));
  if (expected.length !== received.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ received[i];
  return mismatch === 0;
}

const emptyTwiml = () => new Response('<Response/>', { status: 200, headers: {
  'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store',
} });

export async function handleTwilioWebhook(request, env, dependencies = {}) {
  if (request.method !== 'POST') return reject(405);
  if (!env.SMS_CONSENT_DB || !env.TWILIO_AUTH_TOKEN ||
      !env.TWILIO_ACCOUNT_SID || !env.TWILIO_MESSAGING_SERVICE_SID)
    return reject(503, 'SMS_CONFIGURATION');
  if (request.url !== ORIGIN + TWILIO_PATH) return reject(403);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
      'application/x-www-form-urlencoded') return reject(415);
  let params;
  try {
    params = new URLSearchParams(await boundedText(request, MAX_TWILIO_BYTES));
    if ([...params.keys()].length !== new Set(params.keys()).size) return reject(400);
    if (!await validTwilioSignature(ORIGIN + TWILIO_PATH, params,
      request.headers.get('X-Twilio-Signature'), env.TWILIO_AUTH_TOKEN)) return reject(403);
  } catch { return reject(403); }
  if (params.get('AccountSid') !== env.TWILIO_ACCOUNT_SID ||
      params.get('MessagingServiceSid') !== env.TWILIO_MESSAGING_SERVICE_SID) return reject(403);
  const action = params.get('OptOutType');
  if (!['STOP', 'START', 'HELP'].includes(action)) return emptyTwiml();
  const sid = params.get('MessageSid');
  if (!/^SM[a-fA-F0-9]{32}$/.test(sid ?? '')) return reject(400);
  let phone;
  try { phone = normalizePhone(params.get('From')); }
  catch { return reject(400); }
  try {
    const at = (dependencies.now ?? (() => new Date()))().toISOString();
    await dbSession(env.SMS_CONSENT_DB).prepare(`INSERT INTO sms_consent_events
      (phone, consent_status, consent_version, source_page, capture_context, recorded_at, twilio_message_sid)
      VALUES (?, ?, 'twilio-advanced-opt-out-v1', ?, 'twilio_keyword', ?, ?)
      ON CONFLICT (twilio_message_sid) DO NOTHING`)
      .bind(phone, { STOP: 'opted_out', START: 'opted_in', HELP: 'help' }[action],
        ORIGIN + TWILIO_PATH, at, sid).run();
    // Advanced Opt-Out already sends its own keyword confirmation.
    return emptyTwiml();
  } catch { return reject(503, 'CONSENT_STORAGE_UNAVAILABLE'); }
}

// A future SFS sender must call this immediately before every attempted SMS.
// A Twilio START restores only a number that previously opted in on the SFS site.
export async function canSendSms(database, value) {
  let phone;
  try { phone = normalizePhone(value); }
  catch { return false; }
  try {
    const state = await dbSession(database).prepare(`SELECT
      EXISTS(SELECT 1 FROM sms_consent_events
        WHERE phone = ? AND capture_context = 'sfs_web_sms_optin'
          AND consent_status = 'opted_in') AS has_sfs_consent,
      (SELECT consent_status FROM sms_consent_events
        WHERE phone = ? AND capture_context = 'twilio_keyword'
          AND consent_status IN ('opted_in', 'opted_out')
        ORDER BY id DESC LIMIT 1) AS provider_status`)
      .bind(phone, phone).first();
    return state?.has_sfs_consent === 1 && state.provider_status !== 'opted_out';
  } catch { return false; }
}
