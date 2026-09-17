(() => {
  const form = document.querySelector('#intake-form');
  const success = document.querySelector('#demo-success');
  const error = document.querySelector('#form-error');
  const summary = document.querySelector('#success-summary');
  const reset = document.querySelector('#reset-demo');
  const token = document.querySelector('#intake-test-token');
  const challenge = document.querySelector('#turnstile-widget');
  const submit = form?.querySelector('[type="submit"]');
  if (!form || !success || !token || !challenge || !submit) return;

  let turnstileToken = '';
  let pendingRequestId = '';
  let pendingPayload = '';
  const update = () => { submit.disabled = !(turnstileToken && token.value.trim() && form.checkValidity()); };
  window.sfsTurnstileCallback = value => { turnstileToken = value || ''; update(); };
  window.sfsTurnstileExpired = () => { turnstileToken = ''; update(); };
  token.addEventListener('input', update);
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.hidden = true; update();
    if (!form.checkValidity() || !token.value.trim() || !turnstileToken) { error.hidden = false; return; }
    submit.disabled = true;
    const data = Object.fromEntries(new FormData(form));
    delete data.source;
    delete data.intake_test_token;
    delete data.consent_timestamp;
    delete data.turnstile_token;
    delete data['cf-turnstile-response'];
    data.sms_consent = data.sms_consent === 'yes';
    data.consent_version = 'sms-v1-2026-09-12';
    const payload = JSON.stringify(data);
    const requestId = pendingRequestId && pendingPayload === payload ? pendingRequestId : crypto.randomUUID();
    pendingRequestId = requestId;
    pendingPayload = payload;
    data.turnstile_token = turnstileToken;
    try {
      const response = await fetch('/api/intake', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Origin': location.origin,
        'Authorization': `Bearer ${token.value.trim()}`, 'X-SFS-Test': 'public-preview',
        'X-SFS-Request-ID': requestId,
      }, body: JSON.stringify(data) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error('preview failed');
      summary.textContent = `Saved to the controlled preview database; both test bots were notified. Request ID: ${result.request_id}`;
      pendingRequestId = '';
      pendingPayload = '';
      form.hidden = true; success.hidden = false; success.focus();
    } catch { error.textContent = `The outcome needs checking before any new request. Request ID: ${requestId}. Complete a fresh verification before retrying this same request.`; error.hidden = false; }
    finally { turnstileToken = ''; if (window.turnstile?.reset) window.turnstile.reset(challenge); update(); }
  });
  reset?.addEventListener('click', () => { form.reset(); success.hidden = true; form.hidden = false; error.hidden = true; turnstileToken = ''; pendingRequestId = ''; pendingPayload = ''; if (window.turnstile?.reset) window.turnstile.reset(challenge); update(); form.querySelector('#name')?.focus(); });
  update();
})();
