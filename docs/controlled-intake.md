# Controlled intake checkpoint

This change adds POST /api/intake as a Cloudflare Pages Function. The public demo is unchanged and is not wired to it. The function has no Make forwarding code. No customer data is stored, returned, or logged by the function. Only the Turnstile token and client IP go to Cloudflare verification when a controlled test is enabled.

## Disabled by default

Do not configure production. A missing setting or any mode except `controlled-dry-run` returns 503. The existing homepage and demo stay static via _routes.json.

Future operator-only preview configuration (not configured by this PR):

- INTAKE_MODE: controlled-dry-run
- INTAKE_TEST_ORIGIN: exact HTTPS origin of the selected preview; no wildcards, trailing slash, or production origin
- INTAKE_TEST_TOKEN: randomly generated secret of at least 32 characters; store only as a Cloudflare secret
- TURNSTILE_SECRET_KEY: preview widget secret, stored only as a Cloudflare secret

Requests require JSON, exact same-origin Origin, Authorization: Bearer with the private test token, and a fresh Turnstile token with action `hvac_intake_test` and the exact preview hostname. Do not embed the private token in a website, URL, repository, screenshot, or browser storage. There is no browser test console in this phase. A trusted operator harness and preview Turnstile widget must be configured before remote successful-path tests.

## Contract

Required fields: name, phone, zip, message, sms_consent (boolean), consent_version (`sms-v1-2026-09-12`), turnstile_token.
Optional strings: email, address, preferred_time, company_site (honeypot; must be blank).
All other keys are rejected. Body is capped at 8 KiB. Phone supports US/Canada NANP structure only, normalizing ten digits to +1; it does not verify country allocation or ownership. No appointment is confirmed.

Consent evidence is prepared server-side, tagged as controlled test evidence, and discarded. It is NOT yet durably recorded in Sheets or a consent ledger. The server owns business_id, source, record type, timestamp, and source-page metadata; client overrides are rejected. These are a proposed downstream contract, not a claim that Make already maps them.

## Testing

Run `node --test tests/intake.test.mjs`. Tests mock Turnstile and perform no network calls. They cover disabled mode, auth, origin, method, size, fields, phone, consent, honeypot, verification failures, and non-forwarding. The built-in five-per-minute throttle is isolate-local and best-effort, only suitable as an extra safeguard for authenticated tests. It is not distributed rate limiting.

## Before any real forwarding or public activation

1. Add durable/edge-enforced rate limiting and replay/idempotency protection; inspect Cloudflare account capabilities first.
2. Configure a private preview test harness and Turnstile; verify platform deployment behavior, including no secret or personal-data logging.
3. Reinspect Make and Sheets before changes. At the checkpoint, both reply and staff alert target the same fixed Telegram chat; leads use biz_test_001 and Test. These must not be represented as customer delivery.
4. Agree on consent evidence storage/mapping, source/business identifiers, safe spreadsheet text handling, customer routing, and delivery status semantics.
5. Add the Make URL only as a Cloudflare secret, with allowlisted HTTPS destination, timeout, redirect rejection, generic errors and no automatic duplicate-producing retries. It must never appear in client files or source control.
6. Run explicitly authorized synthetic new-customer, same-issue follow-up, and different-issue tests; inspect Customer/Lead/Interaction IDs and notification results.
7. Review a separate PR before merging or enabling real submissions. This PR does not activate them.

References: https://developers.cloudflare.com/pages/functions/ and https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
