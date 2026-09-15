(() => {
  'use strict';
  const expectedOrigin = 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev';
  const button = document.querySelector('#run-test');
  const forwardButton = document.querySelector('#forward-test');
  const storageButton = document.querySelector('#storage-test');
  const repeatButton = document.querySelector('#repeat-storage-test');
  let storageId = '';
  const input = document.querySelector('#test-token');
  const result = document.querySelector('#test-result');
  let challengeToken = '', widgetId, busy = false, hasResult = false;
  const refresh = () => { button.disabled = busy || !challengeToken || input.value.length < 32; forwardButton.disabled = button.disabled; if (storageButton) storageButton.disabled = button.disabled; if (repeatButton) repeatButton.disabled = button.disabled || !storageId; };
  if (location.origin !== expectedOrigin) {
    input.disabled = true;
    result.textContent = 'This test is available only on the approved secure-intake branch preview.';
    return;
  }
  input.addEventListener('input', refresh);
  window.addEventListener('pagehide', () => { input.value = ''; challengeToken = ''; });
  window.sfsTurnstileReady = () => {
    widgetId = window.turnstile.render('#turnstile-container', {
      sitekey: '0x4AAAAAAEx2JqLT8A6b7dNC', action: 'hvac_intake_test',
      callback: token => { challengeToken = token; if (!hasResult) result.textContent = 'Verification complete. Enter your private test token to continue.'; refresh(); },
      'expired-callback': () => { challengeToken = ''; if (!hasResult) result.textContent = 'Verification expired. Complete it again.'; refresh(); },
      'error-callback': () => { challengeToken = ''; if (!hasResult) result.textContent = 'Verification could not load. Refresh this page and try again.'; refresh(); },
    });
  };
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=sfsTurnstileReady&render=explicit';
  script.async = true;
  script.onerror = () => { result.textContent = 'Verification could not load. Refresh this page and try again.'; };
  document.head.append(script);
  const run = async (forward = false, storage = false, repeat = false) => {
    if (button.disabled || (repeat && !storageId)) return;
    if (storage && !repeat) storageId = crypto.randomUUID();
    busy = true; hasResult = false; refresh();
    const authorization = 'Bearer ' + input.value;
    input.value = '';
    result.textContent = 'Checking the synthetic request…';
    try {
      const response = await fetch('/api/intake', {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(25000),
        headers: { 'Content-Type': 'application/json', Authorization: authorization, ...(storage ? { 'X-SFS-Test': 'storage', 'X-SFS-Request-ID': storageId } : forward ? { 'X-SFS-Test': 'forward' } : {}) },
        body: JSON.stringify({ name: 'Demo Customer', phone: '(802) 555-0147', zip: '05401',
          message: 'Test only: heat pump is not warming the house.', sms_consent: false,
          consent_version: 'sms-v1-2026-09-12', turnstile_token: challengeToken }),
      });
      const body = await response.json();
      if (storage && response.ok && body.ok === true && body.mode === 'storage-test' && body.stored === true) {
        const notification = { sent: 'Staff test alert sent.', not_repeated: 'No repeat alert was attempted.', unconfirmed: 'Staff alert delivery could not be confirmed. Check Make before sending another alert.', unconfirmed_log_update_failed: 'Staff alert and its log update could not be confirmed. Check Make.', sent_log_update_failed: 'Staff alert sent, but its log update failed. Check Make.' };
        result.textContent = (body.storage_status === 'duplicate' ? 'Already stored. ' : 'Synthetic lead saved. ') + notification[body.notification_status] + ' Request ID: ' + body.request_id;
      } else if (forward && response.ok && body.ok === true && body.mode === 'forward-test' && body.downstream_actions === false) {
        result.textContent = 'Forwarding test passed. Make acknowledged the synthetic sample. No downstream actions. Request ID: ' + body.request_id;
      } else if (!storage && !forward && response.ok && body.ok === true && body.mode === 'dry-run' && body.forwarded === false) {
        result.textContent = 'Test passed. The request was validated. No lead or notification was sent, and no appointment was confirmed.';
      } else {
        const guidance = { 502: 'Make delivery was rejected or could not be confirmed. Check Make before retrying. Request ID: ' + (body.request_id ?? 'unavailable'), 400: 'Sample or verification token was rejected.', 403: 'Check the private test token, preview origin, and Turnstile configuration.', 429: 'Wait one minute before trying again.', 503: 'Preview configuration is incomplete or verification is unavailable. Confirm the saved secrets and redeployment.' };
        const code = typeof body.code === 'string' ? ` Code: ${body.code}.` : '';
        result.textContent = `Test not completed (HTTP ${response.status}).${code} ${guidance[response.status] ?? 'Check the preview deployment.'}`;
      }
    } catch {
      result.textContent = 'The outcome could not be confirmed. Check Make before retrying. For storage tests, use Repeat same storage request to preserve the request ID.';
    } finally {
      hasResult = true;
      challengeToken = ''; busy = false;
      if (widgetId !== undefined) window.turnstile.reset(widgetId);
      refresh();
    }
  };
  button.addEventListener('click', () => run(false));
  storageButton?.addEventListener('click', () => run(true, true));
  repeatButton?.addEventListener('click', () => run(true, true, true));
  forwardButton.addEventListener('click', () => run(true));
})();
