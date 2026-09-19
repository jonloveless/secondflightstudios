# SFS mobile lead inbox: audit, proposal, and implementation plan

Date: 2026-09-19

Status: non-production product prototype

Scope: Second Flight Studios as the single first client

## Executive recommendation

Build the first real vertical slice around one outcome: an SFS website inquiry becomes a normalized SFS lead, receives structured AI assistance, and appears in a protected mobile inbox where Jonathan can approve an email response. Keep the public `/demo` and all SMS infrastructure independent. Do not generalize this into a multi-client platform yet.

## 1. Current repository audit

### Current public contact and intake behavior

- The public site’s primary contact path is the `#contact` section in `index.html`, whose only action is a `mailto:hello@secondflightstudios.com` link. There is no real SFS project inquiry form or SFS lead record.
- “Live Demo” appears in the main navigation and service card. `/demo` is a public demonstration form, not a genuine request for SFS work.
- The public demo requires name, phone, ZIP, and inquiry, with optional email, address, and preferred time. That shape is service-call oriented and is a poor fit for the studio’s actual mix of design, production, and workflow work.
- The demo client creates an idempotency UUID and posts to `/api/intake` after Cloudflare Turnstile verification. Success means the demo record and private test-bot notifications were confirmed; it does not create a production SFS lead.
- “SMS Updates” is prominent in the desktop navigation and footer even though SMS registration is paused. The SMS opt-in, Twilio webhook, consent tables, privacy language, and terms form a separate compliance subsystem.

### Reusable pieces

- The public site’s color palette, typography direction, SFS wordmark treatment, button language, spacing, and responsive breakpoints can inform the inbox visual system.
- The demo offers useful implementation patterns: explicit field limits, server-side normalization, Turnstile, generic error responses, origin checking, rate limiting, request IDs, payload hashes, idempotent inserts, workflow claim/finalization, and a clear “capture confirmed vs. unconfirmed” distinction.
- The form’s accessible labels, live error/success regions, disabled-until-valid submission, honeypot, and reset flow can inform the future SFS inquiry form.
- Existing Cloudflare Pages Functions and D1 conventions can host a narrow SFS vertical slice without introducing a second runtime.

These are patterns to reuse, not a reason to share the demo’s data model or endpoint.

### Demo/HVAC legacy that must not become the SFS lead system

- `functions/api/intake.js` deliberately labels its final outbound payload as `hvac-lead.v1` and changes the source to `sfs_hvac_d1_demo_test` so the old Make arm can be reused.
- The demo hardcodes `business_id: "biz_test_001"`, `record_type: "Test"`, `environment: "demo"`/`"test"`, and `appointment_confirmed: false`.
- ZIP, service address, preferred appointment time, HVAC-style urgency/routing, and appointment semantics are demo/service-business concepts, not canonical SFS lead fields.
- `preview_leads`, `preview_notification_state`, `demo_rate_limits`, the Make webhook acknowledgement, and private test-bot delivery are demonstration infrastructure. They should stay on `/api/intake` and should not be renamed into production concepts.
- SMS opt-in evidence and Twilio STOP/HELP/START handling are legally sensitive, purpose-built records. They must remain separate from leads and are not a contact preference field for this MVP.
- The checkout contains migration `0003_sms_consent.sql` but not the earlier demo-table migrations referenced by the code. Before new production migrations are applied, tomorrow’s work should inventory the deployed D1 schema and restore a complete migration history without editing existing migrations.

### Navigation and contact UX

- On mobile, all standard navigation links are hidden and only the `nav-contact` action remains. This is simple, but it gives no explicit choice between trying the product demo and hiring SFS.
- On desktop, “Live Demo,” “SMS Updates,” and “Get in touch” compete at the same level. The real contact path is visually prominent but functionally only opens an email client.
- The “Intelligent Solutions” card truthfully says the work is in development, but its copy is broad and its action (“Try the service intake demo”) does not yet articulate the lead-response product.

### Cleanup required when SFS becomes client #1

- A real SFS inquiry must get its own page, endpoint, D1 table, source values, and success language.
- The internal inbox must never read the demo preview tables by default.
- Test/demo records must remain clearly labeled and excluded from SFS operational views.
- The owner-facing inbox requires authentication before any real contact data is shown.
- Public copy must differentiate “experience the demo” from “start a project with SFS.”

No production files were changed during this pass.

## 2. Proposed canonical lead object

The machine-readable proposal is [`sfs-lead.schema.json`](./sfs-lead.schema.json). The object intentionally contains no `businessId`, tenant, appointment, SMS-consent, social-channel, or analytics fields.

```json
{
  "leadId": "SFS-1048",
  "source": "Website form",
  "customerName": "Maya Chen",
  "email": "maya@example.com",
  "phone": "+1-802-555-0148",
  "company": "Green Mountain Coffee Club",
  "originalInquiry": "We need 300 custom coffee scoop clips...",
  "aiSummary": "300 branded scoop clips needed by Oct 10; logo is ready.",
  "urgency": "High",
  "missingInformation": ["Target budget", "Final dimensions"],
  "recommendedNextAction": "Confirm feasibility and request dimensions.",
  "preparedResponse": "Hi Maya — thanks for reaching out...",
  "status": "Needs response",
  "assignedPerson": "Jonathan",
  "createdTimestamp": "2026-09-19T12:00:00Z",
  "updatedTimestamp": "2026-09-19T12:00:00Z",
  "firstResponseTimestamp": null
}
```

Decisions:

- Status is exactly one of `New`, `Needs response`, `Waiting on customer`, `In progress`, or `Closed`.
- Urgency is one of `Low`, `Normal`, `High`, or `Urgent`. Urgency should describe time/business consequence, not sentiment.
- `phone`, `company`, `assignedPerson`, and `firstResponseTimestamp` are nullable. Email is required for the first end-to-end slice because the approved reply channel is email.
- Missing information is an array of short human-readable items, not a loosely formatted paragraph.
- Timestamps are UTC ISO 8601 strings. Lead age is derived, never persisted as text.
- `firstResponseTimestamp` is set only after an email provider confirms acceptance, not when AI creates a draft or a human clicks before delivery succeeds.

## 3. Prototype and “10-second response” decisions

The prototype lives at `prototype/lead-inbox/` and uses six realistic in-memory SFS leads. It performs no fetches and does not persist browser state.

The interaction hierarchy is:

1. **Notice:** lead age is the first signal on every card, with a visible “waiting on you” count and a response target.
2. **Understand:** company/name, source, urgency, AI summary, missing-information count, response readiness, ownership, and wait direction are visible without opening the inquiry.
3. **Review:** the detail screen puts the AI brief, missing information, next action, and prepared response above the collapsed original inquiry.
4. **Act:** “Approve & send response” is the dominant action. Edit and copy are adjacent. Call, assign, snooze, and close live in a stable thumb dock.

Additional choices:

- “Waiting on us” and “Waiting on customer” use direction language rather than relying only on status labels.
- Urgent/high/normal/low signals use both text and color; urgency is not conveyed by color alone.
- Approval locally changes the lead to `Waiting on customer` and demonstrates a first-response measurement, but a persistent banner and action note state that nothing is sent.
- Original inquiry is collapsed because it is supporting evidence, not the first thing a jobsite user should parse.
- Assignment is explicit and can return a lead to an unassigned queue.
- A poor-fit lead shows that the prepared response can safely decline work, not merely maximize conversion.
- Filtering is limited to Active, Needs response, and Closed. No dashboard, analytics, pipeline chart, search, or complex sorting is included.

## 4. Public website cleanup recommendations for tomorrow

Do the smallest coherent copy and route cleanup:

1. Change the public navigation label from **Live Demo** to **Try the Demo** and keep it pointing to `/demo`.
2. Change the primary contact action to **Start a project** and point it to a real SFS inquiry page or form section, not `mailto:`.
3. Create a concise SFS project form with name, email, optional phone, optional company, inquiry, and a simple project-type selector only if routing proves necessary. Do not reuse ZIP, service address, or preferred appointment time.
4. Preserve `/demo` and `/api/intake` as the public product demonstration. Keep its “demonstration only” disclosures intact.
5. Remove **SMS Updates** from primary navigation while registration is paused. Keep the consent page, privacy language, terms, endpoints, and footer/legal access intact; do not delete or repurpose the compliance infrastructure.
6. Replace the Intelligent Solutions paragraph with: “AI-assisted lead intake and response workflows that help small teams understand new inquiries, prioritize what matters, and reply faster—with a person in control.”
7. Use careful availability language: **prototype**, **in development**, or **pilot conversations** as appropriate. Do not present SMS, social-media ingestion, voice, a native app, omnichannel intake, or autonomous replies as live capabilities.
8. Give the demo and real inquiry distinct confirmation screens: “Demo complete” versus “Your project inquiry was received.”

These recommendations were documented only and not implemented.

## 5. Narrow implementation sequence for tomorrow

### Step 1 — freeze the boundaries

- Keep `/demo`, `/api/intake`, preview tables, Make delivery, test bots, and SMS files unchanged.
- Choose new SFS-only names such as `/start`, `/api/sfs-leads`, `/inbox`, and D1 table `sfs_leads`.
- Confirm the deployed D1 bindings and full migration history before writing migration `0004` or the next valid sequence number.

### Step 2 — add the minimum D1 schema

Create one single-client `sfs_leads` table with the canonical fields:

- `lead_id TEXT PRIMARY KEY`
- `source TEXT NOT NULL`
- `customer_name TEXT NOT NULL`
- `email TEXT NOT NULL`
- `phone TEXT NULL`
- `company TEXT NULL`
- `original_inquiry TEXT NOT NULL`
- `ai_summary TEXT NOT NULL`
- `urgency TEXT NOT NULL` with the four-value check
- `missing_information_json TEXT NOT NULL DEFAULT '[]'`
- `recommended_next_action TEXT NOT NULL`
- `prepared_response TEXT NOT NULL`
- `status TEXT NOT NULL` with the five-value check
- `assigned_person TEXT NULL`
- `created_timestamp TEXT NOT NULL`
- `updated_timestamp TEXT NOT NULL`
- `first_response_timestamp TEXT NULL`

Add narrow indexes on `(status, created_timestamp DESC)` and `(assigned_person, status, created_timestamp DESC)`. Do not add `business_id`, tenant tables, or generic custom-field machinery.

For reliable sending, add a separate minimal `sfs_email_deliveries` table only when the send path is implemented. It should hold an idempotency key, lead ID, provider message reference, attempt/result timestamps, and delivery state. This keeps provider execution state out of the canonical lead while preventing double sends and false first-response timestamps.

### Step 3 — build the real SFS inquiry capture

- Add a dedicated public form and SFS endpoint with explicit size limits, normalization, honeypot, Turnstile, origin validation, rate limits, request IDs, idempotent capture, and generic public errors.
- Reuse those defensive patterns from `/api/intake`; do not import its business payload, service fields, Make contract, or demo success semantics.
- Store the original inquiry immediately before AI work so an AI outage cannot lose a lead.

### Step 4 — analyze asynchronously or as a recoverable state

- Pass only the stored SFS inquiry to the selected model with a strict structured-output schema matching the AI-owned fields.
- Treat all model output as untrusted: validate enums and lengths, sanitize content for rendering, and keep the original inquiry immutable.
- If analysis fails, keep the lead visible as `New` with a safe “Analysis unavailable” fallback rather than failing intake.
- AI prepares; it does not send or change customer-facing state.

### Step 5 — protect and connect the mobile inbox

- Rebuild the prototype views against authenticated SFS endpoints and D1 data.
- Minimum authentication is one owner identity, secure session handling, server-side authorization on every inbox/read/update/send endpoint, and no public access to lead data. Given the current Cloudflare-shaped stack, Cloudflare Access in front of `/inbox` plus server-side Access token validation is the smallest likely option to evaluate. Do not rely on a hidden URL or client-only gate.
- Keep assignment values to a small allowed list or nullable owner name for the MVP; do not build accounts, roles, invitations, or tenant membership.

### Step 6 — add human-approved email delivery

- The send endpoint must accept lead ID, edited response, and an idempotency key; re-read the lead server-side; require authentication; record the approval attempt; send once; and set `Waiting on customer` plus `firstResponseTimestamp` only after confirmed provider acceptance.
- Likely options to evaluate are: an email API provider with verified SFS sending domain; the API of an existing managed mailbox; or authenticated SMTP for the existing SFS mailbox. Compare domain authentication, reply threading/reply-to behavior, sandbox/testing, delivery logs, cost after trial limits, and Cloudflare runtime compatibility. Do not select or configure a provider until the existing mailbox setup and expected volume are confirmed.
- Keep **Copy response** as a safe fallback if outbound delivery is unavailable.

### Step 7 — verify one complete vertical slice

Test: public SFS inquiry → durable lead → validated AI analysis → protected inbox → edit → approve → provider acceptance → status/first-response update. Include duplicates, model failure, provider timeout, double-click, unsafe HTML, missing optional fields, and unauthorized requests.

## 6. Explicitly deferred

- Native iOS or Android apps
- SMS sending or intake and any changes to SMS consent infrastructure
- Phone and voicemail handling
- Facebook or Instagram integration
- Social mention detection
- Multi-client tenancy, tenant switching, client onboarding, or roles
- Dashboards, analytics, forecasts, SLA reporting, or complex filtering
- Autonomous customer messaging
- Appointment booking
- File uploads and attachment analysis
- Production authentication, email-provider selection/configuration, Cloudflare changes, Make changes, Twilio changes, deployment, and production route changes during this prototype pass

## 7. Assumptions

- The current GitHub `main` branch is the production source of truth and deploys through a Cloudflare Pages-style environment.
- SFS receives a low enough initial volume that a single mobile queue and simple status filters are sufficient.
- Jonathan is the primary owner; Cindy is included only as a realistic mock collaborator, not as a proposed authorization model.
- Email is required on the first real inquiry form because human-approved email is the first outbound channel.
- Prepared responses may be edited before approval and must never be sent autonomously.
- The public demo remains useful and must continue to be clearly labeled as a demonstration.
- The prototype’s “send,” “call,” “snooze,” assignment, and close behaviors are visual evaluation aids only.
