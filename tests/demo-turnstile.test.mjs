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

