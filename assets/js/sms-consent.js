(() => {
  const form = document.getElementById('sms-opt-in');
  const phone = document.getElementById('phone');
  const checkbox = document.getElementById('sms-consent');
  const submit = document.getElementById('sms-submit');
  const result = document.getElementById('sms-result');
  let challenge = '';
  let busy = false;
  const refresh = () => { submit.disabled = busy || !challenge || !checkbox.checked || !phone.value.trim() || !phone.checkValidity(); };
  window.sfsSmsTurnstileCallback = value => { challenge = value || ''; refresh(); };
  window.sfsSmsTurnstileExpired = () => { challenge = ''; refresh(); };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !challenge || !checkbox.checked || !phone.checkValidity()) return;
    busy = true; refresh(); result.textContent = 'Saving your SMS consent…';
    try {
      const response = await fetch('/api/sms-consent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.value.trim(), consent: true,
          turnstile_token: challenge, company_site: form.elements.company_site.value,
          source_page: location.pathname }),
      });
      if (!response.ok) throw new Error('save failed');
      const body = await response.json();
      if (body.ok !== true || body.status !== 'consent_recorded') throw new Error('save failed');
      result.textContent = 'Your consent was recorded. No message was sent by this form.';
      checkbox.checked = false;
    } catch {
      result.textContent = 'We could not record your consent. Please try again later.';
    } finally {
      challenge = '';
      if (window.turnstile) window.turnstile.reset();
      busy = false; refresh();
    }
  });
  refresh();
})();
