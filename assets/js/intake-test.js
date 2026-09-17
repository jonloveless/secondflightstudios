(() => {
  'use strict';
  const expectedOrigin = 'https://feature-hvac-secure-intake.secondflightstudios.pages.dev';
  const button = document.querySelector('#run-test');
  const forwardButton = document.querySelector('#forward-test');
  const storageButton = document.querySelector('#storage-test');
  const repeatButton = document.querySelector('#repeat-storage-test');
  let storageId = '';
  const captureButton = document.querySelector('#capture-test');
  const repeatCaptureButton = document.querySelector('#repeat-capture-test');
  let captureId = '';
  const captureAlertButton = document.querySelector('#capture-alert-test');
  const repeatCaptureAlertButton = document.querySelector('#repeat-capture-alert-test');
  const reviewAlertsButton = document.querySelector('#review-alerts');
  const reconciliationList = document.querySelector('#reconciliation-list');
  let captureAlertId = '';
  const input = document.querySelector('#test-token');
  const result = document.querySelector('#test-result');
  let challengeToken = '', widgetId, busy = false, hasResult = false;
  const refresh = () => { button.disabled = busy || !challengeToken || input.value.length < 32; forwardButton.disabled = button.disabled; if (storageButton) storageButton.disabled = button.disabled; if (repeatButton) repeatButton.disabled = button.disabled || !storageId; if (captureButton) captureButton.disabled = button.disabled; if (repeatCaptureButton) repeatCaptureButton.disabled = button.disabled || !captureId; if (captureAlertButton) captureAlertButton.disabled = button.disabled; if (repeatCaptureAlertButton) repeatCaptureAlertButton.disabled = button.disabled || !captureAlertId; if (reviewAlertsButton) reviewAlertsButton.disabled = button.disabled; };
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
  const renderReconciliation = items => {
    if (!reconciliationList) return;
    reconciliationList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p'); empty.className = 'reconciliation-empty';
      empty.textContent = 'No pending or unconfirmed staff alerts.'; reconciliationList.append(empty); return;
    }
    for (const item of items) {
      const card = document.createElement('article'); card.className = 'reconciliation-item';
      const title = document.createElement('h3'); title.textContent = item.status === 'pending' ? 'Pending staff alert' : 'Unconfirmed staff alert'; card.append(title);
      for (const [label, value] of [['Request ID', item.request_id], ['Test lead', item.lead.name], ['ZIP', item.lead.zip], ['Issue', item.lead.message], ['First attempt', item.first_attempt_at], ['Error code', item.last_error_code || 'None recorded']]) {
        const line = document.createElement('p'); line.textContent = label + ': ' + value; card.append(line);
      }
      reconciliationList.append(card);
    }
  };
  const run = async (forward = false, storage = false, repeat = false, capture = false, captureAlert = false, reconcile = false) => {
    if (button.disabled || (repeat && !(captureAlert ? captureAlertId : capture ? captureId : storageId))) return;
    if (storage && !repeat) storageId = crypto.randomUUID();
    if (capture && !repeat) captureId = crypto.randomUUID();
    if (captureAlert && !repeat) captureAlertId = crypto.randomUUID();
    busy = true; hasResult = false; refresh();
    const authorization = 'Bearer ' + input.value;
    input.value = '';
    result.textContent = 'Checking the synthetic request…';
    try {
      const response = await fetch('/api/intake', {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(25000),
        headers: { 'Content-Type': 'application/json', Authorization: authorization, ...(reconcile ? { 'X-SFS-Test': 'reconcile' } : captureAlert ? { 'X-SFS-Test': 'capture-alert', 'X-SFS-Request-ID': captureAlertId } : capture ? { 'X-SFS-Test': 'capture', 'X-SFS-Request-ID': captureId } : storage ? { 'X-SFS-Test': 'storage', 'X-SFS-Request-ID': storageId } : forward ? { 'X-SFS-Test': 'forward' } : {}) },
        body: JSON.stringify({ name: 'Demo Customer', phone: '(802) 555-0147', zip: '05401',
          message: 'Test only: heat pump is not warming the house.', sms_consent: false,
          consent_version: 'sms-v1-2026-09-12', turnstile_token: challengeToken,
          ...((capture || captureAlert) ? Object.fromEntries(['name','phone','email','zip','address','message','preferred_time'].map(key => [key, document.querySelector('#capture-' + key).value])) : {}) }),
      });
      const body = await response.json();
      if (reconcile && response.ok && body.ok === true && body.mode === 'notification-reconciliation' && Array.isArray(body.items)) {
        renderReconciliation(body.items);
        result.textContent = body.count ? body.count + ' unresolved staff alert' + (body.count === 1 ? '' : 's') + ' loaded. Inspect the matching request in Make before taking action.' : 'Reconciliation queue is clear.';
      } else if (captureAlert && response.ok && body.ok === true && body.mode === 'capture-alert-test' && body.stored === true && body.notification_status === 'sent') {
        result.textContent = (body.storage_status === 'duplicate' ? 'Already stored. The staff test alert was not repeated. ' : 'New preview lead saved in D1 and the staff test alert was sent. ') + 'Request ID: ' + body.request_id;
      } else if (capture && response.ok && body.ok === true && body.mode === 'capture-test' && body.stored === true) {
        result.textContent = (body.storage_status === 'duplicate' ? 'This request is already saved. ' : 'Submitted test details saved in the preview database. ') + 'No staff alert was requested. Request ID: ' + body.request_id;
      } else if (storage && response.ok && body.ok === true && body.mode === 'storage-test' && body.stored === true) {
        const notification = { sent: 'Staff test alert sent.', not_repeated: 'No repeat alert was attempted.', unconfirmed: 'Staff alert delivery could not be confirmed. Check Make before sending another alert.', unconfirmed_log_update_failed: 'Staff alert and its log update could not be confirmed. Check Make.', sent_log_update_failed: 'Staff alert sent, but its log update failed. Check Make.' };
        result.textContent = (body.storage_status === 'duplicate' ? 'Already stored. ' : 'Synthetic lead saved. ') + notification[body.notification_status] + ' Request ID: ' + body.request_id;
      } else if (forward && response.ok && body.ok === true && body.mode === 'forward-test' && body.downstream_actions === false) {
        result.textContent = 'Forwarding test passed. Make acknowledged the synthetic sample. No downstream actions. Request ID: ' + body.request_id;
      } else if (!capture && !storage && !forward && response.ok && body.ok === true && body.mode === 'dry-run' && body.forwarded === false) {
        result.textContent = 'Test passed. The request was validated. No lead or notification was sent, and no appointment was confirmed.';
      } else {
        const guidance = { 502: 'Make delivery was rejected or could not be confirmed. Check Make before retrying. Request ID: ' + (body.request_id ?? 'unavailable'), 400: 'Sample or verification token was rejected.', 403: 'Check the private test token, preview origin, and Turnstile configuration.', 429: 'Wait one minute before trying again.', 503: 'Preview configuration is incomplete or verification is unavailable. Confirm the saved secrets and redeployment.' };
        if (capture || captureAlert) {
          guidance[409] = 'This request ID already belongs to different details. The original record was preserved.';
          guidance[503] = 'Database or notification-state update could not be confirmed. Keep this page open and use the matching repeat button. Request ID: ' + (captureAlert ? captureAlertId : captureId);
          guidance[202] = 'The lead is stored, but the alert outcome requires inspection in Make. Do not send it again automatically. Request ID: ' + captureAlertId;
          guidance[502] = 'The lead is stored, but staff alert delivery could not be confirmed. Check Make before any manual retry. Request ID: ' + captureAlertId;
        }
        if (reconcile) guidance[503] = 'The reconciliation queue could not be loaded. No alert was sent or retried.';
        const code = typeof body.code === 'string' ? ` Code: ${body.code}.` : '';
        result.textContent = `Test not completed (HTTP ${response.status}).${code} ${guidance[response.status] ?? 'Check the preview deployment.'}`;
      }
    } catch {
      result.textContent = reconcile ? 'The reconciliation queue could not be loaded. No alert was sent or retried.' : captureAlert ? 'The lead or alert outcome could not be confirmed. Keep this page open and check Make before retrying. Request ID: ' + captureAlertId : capture ? 'Database save could not be confirmed. Keep the page open and repeat the same database request. Request ID: ' + captureId : 'The outcome could not be confirmed. Check Make before retrying. For storage tests, use Repeat same storage request to preserve the request ID.';
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
  captureButton?.addEventListener('click', () => run(false, false, false, true));
  repeatCaptureButton?.addEventListener('click', () => run(false, false, true, true));
  captureAlertButton?.addEventListener('click', () => run(false, false, false, false, true));
  repeatCaptureAlertButton?.addEventListener('click', () => run(false, false, true, false, true));
  reviewAlertsButton?.addEventListener('click', () => run(false, false, false, false, false, true));
})();

