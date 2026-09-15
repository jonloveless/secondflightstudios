# Controlled preview intake

The operator page /intake-test supports three authenticated synthetic tests:

1. Dry-run validates on Cloudflare and sends nothing to Make.
2. Forwarding sends a fixed sample to the isolated receiver and checks test_received, matching request ID, and downstream_actions: false.
3. Storage explicitly sends source: sfs_hvac_storage_test. Make stores a fixed synthetic row and attempts an authorized staff Telegram alert. Cloudflare checks storage_test_result, matching request ID, and separate storage/notification outcomes. It never reports no downstream actions for this operation.

The public demo is not connected to this endpoint. PR #2 requires owner review before merging or production activation.

## Preview configuration

- INTAKE_MODE: controlled-dry-run
- INTAKE_TEST_ORIGIN: https://feature-hvac-secure-intake.secondflightstudios.pages.dev
- Secrets: INTAKE_TEST_TOKEN (random, at least 32 characters), TURNSTILE_SECRET_KEY, MAKE_TEST_WEBHOOK_URL, MAKE_TEST_API_KEY.

Secrets stay in Cloudflare and Make. The page clears the operator token after each request and does not use browser storage. Each test requires fresh Turnstile verification with the expected hostname and hvac_intake_test action.

The endpoint requires same-origin JSON requests, operator authentication, bounded fields/body, valid consent-version and phone structure, and a blank honeypot. Only a fixed synthetic sample is forwarded, regardless of submitted contact data. Make destination is restricted to the configured HTTPS us2 webhook, with redirects rejected and a ten-second timeout. No automatic delivery retries occur.

## Storage and retry behavior

The page creates a lowercase UUID for a new storage test and keeps it in memory. **Repeat same storage request** reuses that UUID. Keep the page open after an uncertain result; reloading loses the repeat ID. Re-enter the private token before repeating.

Make scenario 6262425 routes explicit storage tests to on-demand scenario 6269105. The latter uses sequential processing and a separate Test Leads Sheet. It checks the first 999 request IDs and stops accepting new rows at capacity. It stores fixed synthetic data with Make-generated timestamps, then alerts the authorized staff-test chat. This is not a production consent ledger or full incoming-lead persistence.

stored/sent confirms both operations. duplicate/not_repeated confirms a previously stored ID without a repeat alert; it does not establish the original alert's delivery status. Notification failures preserve the stored row and return uncertainty. Check Make and the Sheet before manually retrying an alert. A storage-unconfirmed result does not prove no row was written.

## Durable submitted-details preview

The separate capture operation (X-SFS-Test: capture) saves validated operator-entered synthetic details to D1 via INTAKE_PREVIEW_DB. Apply migrations/0001_preview_leads.sql to the isolated preview database. Its SQL primary key on business_id/request_id prevents duplicate rows; a hash of normalized content rejects reuse of the same ID with changed details. Server-generated timestamps from the original record are preserved on repeats. SMS consent must be false; no Make call or staff notification occurs in this operation.

The D1-gated alert operation (`X-SFS-Test: capture-alert`) uses a separate request ID. It first saves the normalized lead, then atomically claims one notification attempt in `preview_notification_state` from migration `0002_preview_notification_state.sql`. Only the request that creates that claim may call the isolated Make receiver. Make scenario 6286358 sends the authorized Telegram staff-test alert and returns an exact acknowledgement. Cloudflare records `sent` or `unconfirmed` in D1. A duplicate returns the stored outcome without another alert; pending or unconfirmed outcomes require Make inspection and are never resent automatically.

The operator reconciliation view sends `X-SFS-Test: reconcile` through the same origin, private-token, Turnstile, and preview-database gates. It lists at most 25 oldest `pending` or `unconfirmed` alerts and exposes only request ID, state, timestamps, error code, and the synthetic name/ZIP/issue needed for investigation. Loading the queue cannot call Make or Telegram and cannot change D1. Operators must inspect the matching request in Make before any later resolution action is designed.

The database binding is Preview-only. The page keeps capture and alert request IDs in memory, so keep it open through save, repeat, and conflict tests. The SQLite adapter tests exercise the schema, atomic claim, and uncertainty hold locally; deployed D1 behavior still requires a live authenticated alert test.

## Verification and remaining work

Run node --test tests/*.test.mjs. External services are mocked in local tests. Tests cover dry-run gates, synthetic forwarding, strict acknowledgements, storage results, stable browser retry IDs, durable D1 capture, atomic alert claims, and no automatic resend after uncertainty. Live browser alert verification is a separate checkpoint.

Before production: a controlled resolution workflow for reconciled alerts, distributed rate limiting, complete lead/consent mapping, production destination configuration, and end-to-end acceptance tests are required. The current isolate-local throttle and older bounded Sheet lookup are only suitable for controlled tests. Siteverify currently has no explicit timeout. No appointment or customer message is authorized by these tests.

