import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../assets/js/intake-test.js', import.meta.url), 'utf8');
test('storage repeat preserves ID after an uncertain response and clears credentials', async () => {
  const elements = new Map();
  for (const id of ['run-test','forward-test','storage-test','repeat-storage-test','test-token','test-result']) {
    elements.set('#' + id, { disabled: true, value: '', textContent: '', handlers: {}, addEventListener(name, callback) { this.handlers[name] = callback; } });
  }
  let callbacks;
  const requests = [];
  const window = { addEventListener() {}, turnstile: { render(selector, options) { callbacks = options; return 0; }, reset() {} } };
  vm.runInNewContext(source, { window, location: { origin: 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev' }, document: { querySelector: id => elements.get(id), createElement: () => ({}), head: { append() {} } }, crypto: { randomUUID: () => '160e7347-8841-44af-b318-cf2014745701' }, AbortSignal, fetch: async (url, options) => { requests.push(options); if (requests.length === 1) throw Error('network'); return Response.json({ ok: true, mode: 'storage-test', stored: true, storage_status: 'duplicate', notification_status: 'not_repeated', request_id: options.headers['X-SFS-Request-ID'] }); } });
  window.sfsTurnstileReady();
  const unlock = () => { elements.get('#test-token').value = 'x'.repeat(32); callbacks.callback('fresh-verification'); };
  unlock();
  assert.equal(elements.get('#repeat-storage-test').disabled, true);
  await elements.get('#storage-test').handlers.click();
  assert.equal(elements.get('#test-token').value, '');
  assert.match(elements.get('#test-result').textContent, /could not be confirmed/);
  unlock();
  assert.equal(elements.get('#repeat-storage-test').disabled, false);
  await elements.get('#repeat-storage-test').handlers.click();
  assert.equal(requests[0].headers['X-SFS-Request-ID'], requests[1].headers['X-SFS-Request-ID']);
  assert.match(elements.get('#test-result').textContent, /No repeat alert/);
  assert.equal(elements.get('#test-token').value, '');
});
test('operator can load an unresolved-alert queue without a resend control', async () => {
  const makeElement = () => ({ disabled: true, value: '', textContent: '', className: '', children: [], handlers: {}, addEventListener(name, callback) { this.handlers[name] = callback; }, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const elements = new Map();
  for (const id of ['run-test','forward-test','storage-test','repeat-storage-test','capture-test','repeat-capture-test','capture-alert-test','repeat-capture-alert-test','review-alerts','reconciliation-list','test-token','test-result']) elements.set('#' + id, makeElement());
  let callbacks; let request;
  const window = { addEventListener() {}, turnstile: { render(selector, options) { callbacks = options; return 0; }, reset() {} } };
  vm.runInNewContext(source, { window, location: { origin: 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev' }, document: { querySelector: id => elements.get(id), createElement: () => makeElement(), head: { append() {} } }, crypto: { randomUUID: () => '160e7347-8841-44af-b318-cf2014745701' }, AbortSignal, fetch: async (url, options) => { request = options; return Response.json({ ok:true, mode:'notification-reconciliation', count:1, items:[{request_id:'c40dd3bb-2ed8-4b64-9117-1ace05c821a3',status:'unconfirmed',attempt_count:1,first_attempt_at:'2026-09-15T00:00:01Z',last_attempt_at:'2026-09-15T00:00:01Z',last_error_code:'MAKE_TEST_UNCONFIRMED',lead:{name:'Demo Customer',zip:'05401',message:'Synthetic issue'}}] }); } });
  window.sfsTurnstileReady(); elements.get('#test-token').value = 'x'.repeat(32); callbacks.callback('fresh-verification');
  await elements.get('#review-alerts').handlers.click();
  assert.equal(request.headers['X-SFS-Test'],'reconcile');assert.equal(request.headers['X-SFS-Request-ID'],undefined);
  assert.match(elements.get('#test-result').textContent,/1 unresolved staff alert loaded/);
  const list=elements.get('#reconciliation-list');assert.equal(list.children.length,1);assert.match(list.children[0].children.map(item=>item.textContent).join(' '),/MAKE_TEST_UNCONFIRMED/);
  assert.doesNotMatch(source,/retry unresolved|resend alert/i);
});

