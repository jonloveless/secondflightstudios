import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('preview registers Turnstile callback before rendering and gates submit on all three conditions', async () => {
  const html = await readFile(new URL('../demo.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../assets/js/demo.js', import.meta.url), 'utf8');
  const demoScript = html.indexOf('<script src="assets/js/demo.js" defer></script>');
  const turnstileScript = html.indexOf('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>');
  assert.ok(demoScript >= 0 && turnstileScript > demoScript);
  assert.match(script, /window\.sfsTurnstileCallback\s*=/);

  const submit = { disabled: true };
  const token = { value: '', addEventListener() {} };
  const form = { valid: false, checkValidity() { return this.valid; }, querySelector() { return submit; }, addEventListener() {} };
  const nodes = { '#intake-form': form, '#demo-success': {}, '#form-error': {}, '#success-summary': {}, '#reset-demo': { addEventListener() {} }, '#intake-test-token': token, '#turnstile-widget': {} };
  const window = {};
  runInNewContext(script, { document: { querySelector: selector => nodes[selector] }, window });
  form.valid = true;
  token.value = 'present';
  window.sfsTurnstileCallback('response');
  assert.equal(submit.disabled, false);
  token.value = '';
  window.sfsTurnstileCallback('response');
  assert.equal(submit.disabled, true);
  token.value = 'present';
  form.valid = false;
  window.sfsTurnstileCallback('response');
  assert.equal(submit.disabled, true);
  form.valid = true;
  window.sfsTurnstileExpired();
  assert.equal(submit.disabled, true);
});

test('public preview sends only the explicit Turnstile token', async () => {
  const script = await readFile(new URL('../assets/js/demo.js', import.meta.url), 'utf8');
  const listeners = {};
  const submit = { disabled: true };
  const token = { value: 'private-test-token', addEventListener() {} };
  const form = { hidden: false, checkValidity: () => true, querySelector: () => submit,
    addEventListener: (name, handler) => { listeners[name] = handler; } };
  const success = { hidden: true, focus() {} };
  const nodes = { '#intake-form': form, '#demo-success': success, '#form-error': { hidden: true },
    '#success-summary': { textContent: '' }, '#reset-demo': { addEventListener() {} },
    '#intake-test-token': token, '#turnstile-widget': {} };
  let sent;
  const window = {};
  runInNewContext(script, {
    document: { querySelector: selector => nodes[selector] }, window,
    FormData: class { constructor() { return new Map([
      ['name', 'Invented Customer'], ['source', 'sfs_hvac_demo'],
      ['intake_test_token', token.value], ['turnstile_token', 'injected-hidden'],
      ['cf-turnstile-response', 'injected-response'],
    ]); } },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    location: { origin: 'https://preview.example' },
    fetch: async (_url, options) => { sent = JSON.parse(options.body); return {
      ok: true, json: async () => ({ ok: true, request_id: '00000000-0000-4000-8000-000000000000' }),
    }; },
  });
  window.sfsTurnstileCallback('callback-response');
  await listeners.submit({ preventDefault() {} });
  assert.equal(sent['cf-turnstile-response'], undefined);
  assert.equal(sent.turnstile_token, 'callback-response');
  assert.equal(sent.intake_test_token, undefined);
});

test('uncertain preview request retries with the same request ID after fresh verification', async () => {
  const script = await readFile(new URL('../assets/js/demo.js', import.meta.url), 'utf8');
  const listeners = {};
  const submit = { disabled: true };
  const token = { value: 'private-test-token', addEventListener() {} };
  const form = { hidden: false, checkValidity: () => true, querySelector: () => submit,
    addEventListener: (name, handler) => { listeners[name] = handler; } };
  const nodes = { '#intake-form': form, '#demo-success': { hidden: true, focus() {} },
    '#form-error': { hidden: true, textContent: '' }, '#success-summary': { textContent: '' },
    '#reset-demo': { addEventListener() {} }, '#intake-test-token': token, '#turnstile-widget': {} };
  let attempts = 0;
  const ids = [];
  const window = { turnstile: { reset() {} } };
  runInNewContext(script, {
    document: { querySelector: selector => nodes[selector] }, window,
    FormData: class { constructor() { return new Map([
      ['name', 'Invented Customer'], ['phone', '8025550147'], ['zip', '05401'],
      ['message', 'Invented furnace issue'], ['cf-turnstile-response', 'browser-token'],
    ]); } },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    location: { origin: 'https://preview.example' },
    fetch: async (_url, options) => {
      ids.push(options.headers['X-SFS-Request-ID']);
      attempts++;
      if (attempts === 1) throw new Error('network uncertainty');
      return { ok: true, json: async () => ({ ok: true, request_id: ids[1] }) };
    },
  });
  window.sfsTurnstileCallback('first-response');
  await listeners.submit({ preventDefault() {} });
  assert.equal(nodes['#form-error'].hidden, false);
  assert.equal(submit.disabled, true);
  window.sfsTurnstileCallback('fresh-response');
  await listeners.submit({ preventDefault() {} });
  assert.equal(attempts, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(nodes['#demo-success'].hidden, false);
});
