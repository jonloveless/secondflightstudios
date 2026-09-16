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
  const update = () => {
    submit.disabled = !(turnstileToken && token.value.trim() && form.checkValidity());
    console.info('[SFS preview gate] ' + JSON.stringify({ valid: form.checkValidity(), invalidFields: [...form.querySelectorAll(':invalid')].map(field => field.id || field.name), privateTokenPresent: !!token.value.trim(), turnstileTokenPresent: !!turnstileToken, submitDisabled: submit.disabled }));
  };
  window.sfsTurnstileCallback = value => { console.info('[SFS preview callback] ' + JSON.stringify({ receivedResponse: !!value })); turnstileToken = value || ''; update(); };
  window.sfsTurnstileExpired = () => { turnstileToken = ''; update(); };
  token.addEventListener('input', update);
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.hidden = true; update();
    if (!form.checkValidity() || !token.value.trim() || !turnstileToken) { error.hidden = false; return; }
    submit.disabled = true;
    const requestId = crypto.randomUUID();
    const data = Object.fromEntries(new FormData(form));
    delete data.source;
    delete data.intake_test_token;
    delete data.consent_timestamp;
    delete data.turnstile_token;
    data.sms_consent = data.sms_consent === 'yes';
    data.consent_version = 'sms-v1-2026-09-12';
    data.turnstile_token = turnstileToken;
    try {
      const response = await fetch('/api/intake', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Origin': location.origin,
        'Authorization': `Bearer ${token.value.trim()}`, 'X-SFS-Test': 'public-preview',
        'X-SFS-Request-ID': requestId,
      }, body: JSON.stringify(data) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error('preview failed');
      summary.textContent = `Saved to the controlled preview database. Request ID: ${result.request_id}`;
      form.hidden = true; success.hidden = false; success.focus();
    } catch { error.textContent = 'The preview could not save this test request. Check the private token and try again.'; error.hidden = false; }
    finally { turnstileToken = ''; if (window.turnstile?.reset) window.turnstile.reset(challenge); update(); }
  });
  reset?.addEventListener('click', () => { form.reset(); success.hidden = true; form.hidden = false; error.hidden = true; turnstileToken = ''; if (window.turnstile?.reset) window.turnstile.reset(challenge); update(); form.querySelector('#name')?.focus(); });
  update();
})();

