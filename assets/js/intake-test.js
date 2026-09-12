(() => {
  'use strict';
  const expectedOrigin = 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev';
  const button = document.querySelector('#run-test');
  const input = document.querySelector('#test-token');
  const result = document.querySelector('#test-result');
  let challengeToken = '', widgetId, busy = false;
  const refresh = () => { button.disabled = busy || !challengeToken || input.value.length < 32; };
  if (location.origin !== expectedOrigin) {
    input.disabled = true;
    result.textContent = 'This test is available only on the approved secure-intake branch preview.';
    return;
  }
  input.addEventListener('input', refresh);
  window.addEventListener('pagehide', () => { input.value = ''; challengeToken = ''; });
  window.sfsTurnstileReady = () => {
    widgetId = window.turnstile.render('#turnstile', {
      sitekey: '0x4AAAAAAEx2JqLT8A6b7dNC', action: 'hvac_intake_test',
      callback: token => { challengeToken = token; result.textContent = 'Verification complete. Enter your private test token to continue.'; refresh(); },
      'expired-callback': () => { challengeToken = ''; result.textContent = 'Verification expired. Complete it again.'; refresh(); },
      'error-callback': () => { challengeToken = ''; result.textContent = 'Verification could not load. Refresh this page and try again.'; refresh(); },
    });
  };
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=sfsTurnstileReady&render=explicit';
  script.async = true;
  script.onerror = () => { result.textContent = 'Verification could not load. Refresh this page and try again.'; };
  document.head.append(script);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    busy = true; refresh();
    const authorization = 'Bearer ' + input.value;
    input.value = '';
    result.textContent = 'Checking the synthetic request…';
    try {
      const response = await fetch('/api/intake', {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ name: 'Demo Customer', phone: '(802) 555-0147', zip: '05401',
          message: 'Test only: heat pump is not warming the house.', sms_consent: false,
          consent_version: 'sms-v1-2026-09-12', turnstile_token: challengeToken }),
      });
      const body = await response.json();
      if (response.ok && body.ok === true && body.mode === 'dry-run' && body.forwarded === false) {
        result.textContent = 'Test passed. The request was validated. No lead or notification was sent, and no appointment was confirmed.';
      } else {
        const guidance = { 400: 'Sample or verification token was rejected.', 403: 'Check the private test token, preview origin, and Turnstile configuration.', 429: 'Wait one minute before trying again.', 503: 'Preview configuration is incomplete or verification is unavailable. Confirm the saved secrets and redeployment.' };
        result.textContent = `Test not completed (HTTP ${response.status}). ${guidance[response.status] ?? 'Check the preview deployment.'}`;
      }
    } catch {
      result.textContent = 'The test could not be completed. Check your connection and the preview deployment.';
    } finally {
      challengeToken = ''; busy = false;
      if (widgetId !== undefined) window.turnstile.reset(widgetId);
      refresh();
    }
  });
})();
