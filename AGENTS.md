# AGENTS.md — Optima Solutions Order → HubSpot Sync

## Mission
Build a secure, testable, reviewer-friendly take-home application for Optima Solutions Stage 2. A signed `order.created` webhook must produce **one HubSpot Deal per order**, attached to the appropriate Contact, with durable attempt history, operational retry UI, and a Python export of HubSpot deals created during the last seven days.

The assessment rubric is the source of truth. Do not sacrifice a required item to implement bonuses. Implement the smallest design that is demonstrably reliable. Never claim an integration or test works unless it has actually been executed.

## Verified assessment environment — 2026-10-27
This section is an evidence-backed handoff from the candidate's HubSpot setup session. Treat **verified** items as completed setup; do not confuse a working read-only request with full end-to-end integration success.

### Confirmed from candidate's HubSpot UI and terminal
- **HubSpot developer test account:** Created and accessible; account labeled `Optima Solutions Assessment Test Account` in the UI.
- **API authentication:** Service Key named `optima-order-sync-dev` has been created; secret must never be copied into this repository or chat. Use a locally stored `HUBSPOT_ACCESS_TOKEN` environment variable.
- **Assigned Service Key scopes, confirmed in UI:** `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`. *Assigned* does not mean every API operation has been tested.
- **Selected HubSpot Deal pipeline ID:** `default` (candidate confirmed from pipeline settings).
- **Selected Deal stage ID:** `closedwon` (candidate confirmed from pipeline settings). Our documented assumption is that an already-placed order is a closed-won Deal; validate against the account's pipeline when performing Deal creation.
- **Contacts API smoke test PASSED:** On 2026-10-27, an authenticated `GET https://api.hubapi.com/crm/v3/objects/contacts?limit=1` returned a JSON `results` array containing a Contact, plus a `paging` object. This confirms the Service Key was accepted and **Contacts read access works**. Do not record the returned person's email/name, contact ID, account ID, or the full response in source files.
- **External order ID property:** Candidate selected **Require unique values for this property** in the new Deal property form (screenshot verified). The screenshot does **not** prove the property was saved, or that its internal name is exactly `external_order_id`; check both before relying on it.

### Setup work not yet verified
- [ ] Verify Deal property `external_order_id` actually exists on **Deals**, is **single-line text**, and is configured with **unique values**.
- [ ] Verify PHP (`PHP`) is enabled as a Deal/company currency before sending PHP amounts.
- [ ] Validate HubSpot Deals read/write, Contacts write, Deal–Contact associations, and uniqueness through real end-to-end tests once code exists. Do not mark these as passing based on the Contacts read test alone.

### Next milestone: initialize the repository (Phase 1)
- [ ] Create a clean Git repository and npm workspaces for `apps/api` and `apps/web`, plus `scripts/`.
- [ ] Place this `AGENTS.md` in the repository root and add `.gitignore`/`.env.example` before adding any credentials.
- [ ] Use `HUBSPOT_PIPELINE_ID=default` and `HUBSPOT_DEAL_STAGE_ID=closedwon` in `.env.example` as non-secret defaults; use placeholders for `HUBSPOT_ACCESS_TOKEN` and `WEBHOOK_SECRET`.
- [ ] Add strict TypeScript, Express API, Vite/React frontend, environment validation, SQLite migrations, and a `GET /health` route.
- [ ] Confirm a fresh `npm install` and documented dev command start both apps; only then proceed to the signed webhook implementation.

**Security note:** The successful terminal output is evidence of authentication, not something to paste into committed fixtures; do not embed API credentials or CRM customer data in tests, logs, examples, or screenshots.

## Working agreement for coding agents
1. Read this file, the assessment, `README.md` - not created yet Oct 27, relevant source code, and tests before making changes.
2. State the immediate task and its acceptance criteria; make focused changes rather than broad rewrites.
3. Before adding a dependency, justify it and prefer an existing library already used in the repo.
4. Preserve TypeScript strict mode, existing conventions, public API contracts, database constraints, and test coverage.
5. Do not bypass signature verification, idempotency checks, authentication, or error handling to make a demo pass.
6. Never fabricate HubSpot IDs, real API responses, screenshots, test results, or sample output.
7. Run relevant tests, lint, and type checking after changes; report what ran and any failures accurately.
8. Do not commit or display secrets; do not leak full webhook bodies, email addresses, phone numbers, or bearer tokens into application logs.
9. When an external API detail is uncertain, consult current official HubSpot docs and verify behavior against a developer test portal before hard-coding it.
10. At the end of each task, report files modified, behavioral change, commands/tests run, remaining risks, and the next rubric item.

## Scope and acceptance gates (all mandatory)
- R22: POST webhook accepts only supported events, validates schema, and verifies a constant-time HMAC-SHA256 signature computed on **raw request bytes**.
- R23: Search Contact by normalized email; create if absent; update if present; create an amount/name/close-date/pipeline/stage Deal; associate with Contact; store HubSpot IDs.
- R24: Redelivery of an identical `order_id` must not create another Deal, including after restarts/retries.
- R25: Retry HubSpot HTTP 429 and 5xx with bounded exponential backoff, jitter, timeouts, and `Retry-After` support when present. Persist terminal failure details.
- R26: SQLite tables persist each order's current state **and every sync attempt** with order ID, status, relevant HubSpot IDs, timestamp, and sanitized error.
- R27: Frontend shows the newest 50 **attempts**, status/timestamps/errors, and a working retry action only on failed orders.
- R28: Python script exports **all HubSpot deals whose HubSpot `createdate` is within the last 7 rolling days** to a UTF-8 CSV with pagination.
- R29: README has quick start, env variables, architecture, data mapping, authentication, assumptions, tests, sample webhook command, export command, limitations, and future improvements.
- Bonus only after R22–R29: mapping/idempotency tests first; Docker Compose second; n8n export/error notification last.

## Chosen stack
- Backend: Node.js LTS, TypeScript (strict), Express, Zod, native fetch or an existing HTTP client.
- Frontend: React, TypeScript, Vite, basic CSS (no unnecessary component library).
- Storage: SQLite (via Drizzle ORM + SQLite driver); committed migrations, WAL mode, foreign keys enabled.
- Tests: Vitest, Supertest, stubbed HubSpot HTTP transport, temporary isolated SQLite DB.
- Language B: Python 3 with `requests` (or standard-library HTTP) and `csv`.
- Package manager: npm workspaces; commit lockfile; choose a single runtime/node version and document it.

## Proposed project layout
```
.
├── AGENTS.md
├── README.md
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.ts               # Express app and middleware
│   │   │   ├── server.ts            # startup / graceful shutdown
│   │   │   ├── config.ts            # env validation
│   │   │   ├── routes/{webhooks,syncs}.ts
│   │   │   ├── domain/{order-schema,mapping}.ts
│   │   │   ├── services/{hubspot,sync-processor,retry}.ts
│   │   │   ├── db/{schema,client,repository}.ts
│   │   │   └── middleware/{signature,error-handler}.ts
│   │   └── tests/
│   └── web/
│       └── src/{App.tsx,api.ts,components/}
├── scripts/
│   ├── mock-webhook.ts
│   ├── export_recent_deals.py
│   └── requirements.txt
└── docs/
    └── architecture.md              # optional; README is mandatory
```
The braces represent suggested modules; choose normal platform-specific file names. Do not create empty architectural layers just for appearance.

## External contracts
### Inbound webhook
- `POST /api/webhooks/orders` with `Content-Type: application/json` and `X-Order-Signature: sha256=<lowercase-hex-HMAC>`.
- The shared secret is `WEBHOOK_SECRET` and the signature equals `HMAC-SHA256(secret, raw_body)`; this is a **candidate-defined contract** because the assessment does not specify a header name/encoding. Mock sender and README must use exactly the same scheme. No signature bypass for demo mode.
- Apply a reasonably small body limit (e.g. 256 KiB). Compare fixed-length digests using `crypto.timingSafeEqual`, rejecting missing/invalid signatures with `401` before JSON parsing.
- Parse JSON and validate Zod schema after verification: `event === "order.created"`, nonempty `order_id`, valid ISO 8601 `created_at`, valid customer email/name, positive integer quantities, finite nonnegative item prices and total, and three-letter currency. Require at least one item. Check `total` against `sum(qty * price)` in integer minor units (for the assessment's PHP currency). Log only safe IDs and error codes.
- Successful durable enqueue: `202` with `{orderId, status: "queued"}`. Identical repeat: `200` or `202` with current status and `duplicate: true`; never enqueue an extra live job. Reused order ID with a different canonical payload hash: `409 Conflict` (do not silently rewrite the original).
- Invalid authenticated payload: `400` with safe validation details. Unexpected DB failure: `500` so the sender may retry.

### Frontend API
- `GET /api/sync-attempts?limit=50`: return newest 50 attempts, ordered by attempt creation time descending, with order ID, attempt number, status, HubSpot IDs, timestamp, safe error, and current order state. The server caps limit at 50.
- `POST /api/orders/:orderId/retry`: allow only the current state `failed`; atomically mark the order `queued` and return `202`. A duplicate retry request while queued/processing must not start a second processor; return `409` or the already-queued state consistently.
- Dashboard/retry routes are admin-only: use a simple documented development-only admin token (`DASHBOARD_ADMIN_TOKEN`, sent by an appropriate mechanism) or proper session auth. Do not ship public unauthenticated retry access. Handle CORS carefully.
- Optional `GET /health`: liveness only; does not expose configuration or tokens.

## Database and state machine
Use two tables, not a single row overwritten on every attempt.

`orders`:
- `order_id TEXT PRIMARY KEY`
- `payload_json TEXT NOT NULL` (internal only; do not expose in list API)
- `payload_sha256 TEXT NOT NULL`
- `status TEXT NOT NULL` in `queued | processing | succeeded | failed`
- `hubspot_contact_id TEXT NULL`
- `hubspot_deal_id TEXT NULL`
- `last_error TEXT NULL` (sanitized)
- `next_run_at DATETIME NULL`
- `lease_expires_at DATETIME NULL`
- `created_at DATETIME NOT NULL`, `updated_at DATETIME NOT NULL`

`sync_attempts`:
- `id INTEGER PRIMARY KEY`
- `order_id TEXT NOT NULL REFERENCES orders(order_id)`
- `attempt_number INTEGER NOT NULL`
- `status TEXT NOT NULL` in `processing | succeeded | failed`
- `hubspot_contact_id TEXT NULL`, `hubspot_deal_id TEXT NULL`
- `error_code TEXT NULL`, `error_message TEXT NULL`
- `started_at DATETIME NOT NULL`, `finished_at DATETIME NULL`
- unique `(order_id, attempt_number)`; index `started_at DESC`.

Enforce atomic insert-or-select by order ID and atomic worker claim/transition. A polling worker in the API process is sufficient for the take-home, if queued work resumes on restart and expired `processing` leases are reclaimed. Limit concurrency to 1 initially for SQLite and HubSpot API simplicity. Worker must not hold a database transaction open across network requests.

State transitions: new → `queued` → `processing` → `succeeded` or `failed`; explicit manual retry: `failed` → `queued` → `processing`. A transient 429/5xx may be retried internally within the current attempt; record a final outcome and relevant IDs, optionally with a future scheduled attempt for exhaustion if clearly documented. Do not lose a recoverable order after a crash.

## HubSpot integration behavior
- Authenticate the outbound **server-to-HubSpot** connection with `HUBSPOT_ACCESS_TOKEN` (Service Key where available; an existing supported token also works). This is unrelated to the inbound HMAC secret. Never send the HubSpot token to React.
- Required scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`, plus property/schema permissions only if managing a custom property programmatically. Confirm scopes in the actual test portal.
- Target documented **date-based** endpoints, ideally `2026-09`. Keep endpoint roots in one module; copy exact paths from the official versioned API docs rather than assuming old `/crm/v3/` paths map mechanically.
- Normalize contact email (`trim().toLowerCase()`) for matching. Search by exact email. Reuse existing contact ID and patch known provided fields; otherwise create contact. Handle duplicate-contact conflicts by re-reading contact. Do not intentionally overwrite good CRM data with missing/blank fields.
- Configure `HUBSPOT_PIPELINE_ID` and `HUBSPOT_DEAL_STAGE_ID` from the actual test portal. Never invent numeric stage IDs. For paid orders, closed-won is a reasonable documented assumption; verify pipeline/stage pairing.
- Suggested Deal mapping: `dealname = Order {order_id} — {first_name} {last_name}`; `amount = total` as decimal string; `closedate = order.created_at` converted to a HubSpot-accepted UTC instant; `pipeline`, `dealstage` from env; `deal_currency_code = currency` **only after enabling/confirming that currency in the test portal**; custom `external_order_id = order_id`.
- The given payload's `items` can be represented in a short Deal description for traceability. Creating HubSpot line-item objects is **not** required; avoid unless core rubric is complete.
- Create a **custom unique Deal property** named `external_order_id` (text, uniqueness enabled), and document one-time setup. Uniqueness is a second line of defense against lost create responses, crashes, and racing workers. Check for an existing remote Deal by this key *before* create. If creation returns a duplicate/unique-conflict error, retrieve the existing record instead of creating another. If existing, verify/repair its Contact association. Confirm property support in the portal during setup.
- Prefer creating the Deal with its Contact association in one request if supported by the chosen API contract; otherwise associate immediately after creating it. Re-try must repair a missing association without creating a second Deal. If the API response is lost after Deal creation, reconcile via the unique remote order property before any additional create attempt.
- Keep HubSpot calls behind `HubSpotClient` abstraction. Parse API error status, safe message, and correlation ID; redact headers/tokens. Use bounded request timeouts.
- For HTTP `429` and `5xx`, retry up to e.g. 4 total requests with exponential delays of ~1/2/4 seconds plus jitter, honoring valid `Retry-After` when longer and capping wait. For other `4xx`, fail fast (except recoverable duplicate/conflict reconciliation); don't repeatedly retry invalid stage/currency or unauthorized token. For any retried create, reconcile before resending to avoid duplicates.
- Document that CRM Search can be eventually consistent. Never rely on Search alone for global uniqueness when the HubSpot unique property is available.

## Python CSV export
- Entrypoint: `python scripts/export_recent_deals.py --output deals_last_7_days.csv`.
- Use the same server-side HubSpot access token via environment variable; never embed a credential.
- Compute the cutoff in UTC at runtime: `now(UTC) - timedelta(days=7)`.
- Search HubSpot Deals using `createdate >= cutoff`; follow pagination `paging.next.after` until exhausted; include all matching Deals, not just those from this integration. If upstream sorts/results are unpredictable, filter returned `createdate` again in Python and de-duplicate by HubSpot Deal ID.
- Suggested CSV columns: `deal_id, deal_name, amount, currency, created_at_utc, close_date, pipeline, stage, external_order_id`.
- Use Python's `csv.DictWriter` with explicit header order and `utf-8-sig` optional Excel-friendly encoding. Handle missing properties; escape formula-like cells (`=`, `+`, `-`, `@`) for spreadsheet safety when exporting textual values. Do not accidentally strip the leading minus sign from numeric amounts.
- Retry rate limits/5xx if practical, exit nonzero on unrecoverable failures, print output path and row count. Test pagination and 7-day boundary with a mocked HTTP client.
- **Important:** The sample order has `created_at` September 20, 2026, but the export filters when the **HubSpot Deal itself was created**, not the order timestamp. A Deal created today from that sample belongs in today's 7-day export.

## Dashboard UX requirements
- Minimal, responsive operations UI with page title, current success/failure counts (optional), table of most recent 50 attempts, colored but accessible status text, order ID, attempt time, Contact ID, Deal ID, sanitized error, and a Retry action on failed orders only.
- After retry, show queued/processing state, disabled button, and new attempt when started; refresh/poll every few seconds, or add an explicit Refresh button. Show loading, empty and API-error states.
- Design is secondary to working behavior. Never create fictitious sync rows in production mode. Seed/demo data must be clearly labeled and isolated.

## Test matrix (required before calling the project done)
1. Correct signed order → accepted → Contact found/created → one associated Deal → success attempt recorded.
2. Same signed payload twice (sequential) → one HubSpot Deal and no extra active job.
3. Same signed payload submitted concurrently → one local order and one HubSpot Deal.
4. Same `order_id`, different content → `409`, original order untouched.
5. Missing/incorrect signature → `401`, no order and no HubSpot calls.
6. Schema-invalid payload / mismatched total → `400`, no HubSpot calls.
7. Existing contact → contact updated, not duplicated.
8. HubSpot `429` then success → honors retry policy and records success.
9. HubSpot `500` then success → retries; persistent `503` → records failure and safe error.
10. Non-retryable `400` or `401` from HubSpot → fails promptly with actionable log.
11. Simulate Contact success / Deal fail → retry reuses Contact and creates only one Deal.
12. Simulate Deal created / network response lost → reconciliation finds original Deal by unique order key; no duplicate.
13. Simulate Deal created / association failed → retry repairs association rather than creating Deal.
14. Retry button on failed order → new attempt row and correct terminal result; attempts remain immutable audit history.
15. Worker restarts while queued/processing → tasks recovered; no duplicate Deal.
16. Dashboard returns newest 50 **attempt rows**, not only 50 unique orders.
17. Python export: correct UTC boundary, pagination, CSV header/order, empty result and network failure.

Mock HubSpot for deterministic tests. Run at least one **real test-portal smoke test** and verify a Contact, Deal, association, and custom unique order property in HubSpot UI. Keep any genuine IDs out of committed fixtures.

## Milestone order and stop conditions
1. Bootstrap workspace, `.env.example`, scripts, types, database migrations, health route. Stop when a fresh clone boots.
2. Implement canonical payload validation and raw-body HMAC + mock sender. Stop when positive/negative signature tests pass.
3. Add atomic order reservation, state machine, attempts log, worker. Stop when duplicates/concurrency tests pass without HubSpot.
4. Implement HubSpot client, actual portal credentials, pipeline/stage, unique Deal property, and mapping. Stop when real smoke test creates associated record.
5. Add retries, timeout, crash/lost-response recovery and logs. Stop when fault injection tests pass.
6. Implement last-50 attempts API, protected retry endpoint and responsive React dashboard. Stop when retry changes persistent state.
7. Implement Python CSV export with pagination and UTC cutoff. Stop when it generates a valid CSV against test HubSpot.
8. Write/review README, screenshot actual UI, complete test suite. Stop when another developer can reproduce from clean clone.
9. Bonus tests, Docker Compose, n8n only if all mandatory acceptance criteria are demonstrated.

## Expected package scripts and project handoff
Prefer working root commands:
- `npm install`
- `npm run dev` — API, worker, and Vite frontend
- `npm run db:migrate`
- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run mock:send`
- `python scripts/export_recent_deals.py --output deals_last_7_days.csv`

At final delivery, `README.md` must state actual ports and commands rather than aspirational ones. Show a short manual demo: send signed payload, see Contact and Deal in HubSpot, resend same order without duplication, simulate a failure then recover through UI, run Python export. GitHub repository URL is the required submission; include an exported n8n JSON only if implemented.

## Security and quality guardrails
- Never accept unauthenticated inbound order webhooks or expose the Service Key in browser bundles.
- Limit request size and enforce server-side validation; never trust frontend-only checks.
- No secrets, actual user PII, SQLite DB file, local CSV output, `.env`, or runtime logs committed to Git.
- Use parameterized SQL through ORM and structured, redacted error logging.
- Prevent arbitrary replays or edits through retry endpoint; retry persisted immutable original payload only.
- Gracefully stop worker on shutdown; document single-instance constraints of SQLite and in-process jobs.
- Track exact choices and assumptions in README (signature protocol, date/close date, accepted currencies, stage selection, seven-day export semantics, and limitations).
- Prefer a complete, comprehensible repository over speculative features, microservices, Kubernetes, Redis, or queues not requested.

## Current HubSpot reference notes (verify at implementation time)
- Service Keys replacing legacy private app creation: https://developers.hubspot.com/changelog/legacy-private-app-creation-sunset
- Service Keys limitations: https://developers.hubspot.com/changelog/service-keys
- Date-based API versioning guidance: https://developers.hubspot.com/blog/date-based-api-versioning-migration-playbook
- 2026-09 update and validation behavior: https://developers.hubspot.com/changelog/fall-2026-spotlight
- New CRM write validation: https://developers.hubspot.com/changelog/crm-api-write-validation-enforcement
- HubSpot unique value properties: https://knowledge.hubspot.com/records/deduplication-of-records
- Deal currency validation: https://developers.hubspot.com/changelog/deal-currenct-code-validation

## Testing conventions

- Store all automated test files under root `tests/` (unit, integration, frontend and Python); opt-in live checks belong in `tests/manual` and must be excluded from automated discovery. The earlier proposed `apps/api/tests` layout is superseded.
- Each feature and confirmed defect must include appropriate behavioral tests. Reuse shared helpers and synthetic fixtures under `tests/helpers` and `tests/fixtures`.
- Automated tests must never access the real HubSpot account, read `.env`, use actual credentials/CRM PII, or open the application's runtime database. Inject mocked HTTP and use isolated SQLite; close/remove temporary databases after tests.
- Use deterministic clocks/injected delays instead of real backoff waits. Distinguish internal HTTP retries from persistent application sync attempts.
- Keep `tests/README.md`, its Assessment Requirements-to-Tests Coverage Matrix, commands and execution counts synchronized with test/code changes. Mark live/manual, skipped, failed and unexecuted verification honestly.
- Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` after relevant changes. Live smoke checks require explicit invocation against an authorized test portal and are not part of `npm test`.


## Docker maintenance conventions
- Root `compose.yaml` uses repository-root build contexts and the single npm lockfile. Keep Node 24 aligned with `.nvmrc`; `build:api` is shared by the root build and API Dockerfile.
- API is non-root UID 1000; persist the whole `/data` directory through `app-data`, including SQLite WAL. Startup applies existing repeat-safe initialization. Never reset data, scale workers, or use `down -v` during normal verification.
- Preserve localhost-only published ports 3001/5173 and same-origin Nginx `/api` forwarding without stripping the prefix. Local HOST defaults to loopback; Compose overrides it to all interfaces internally.
- Secrets are runtime interpolation only. Never print resolved Compose config; use `docker compose config --quiet`. Do not add secrets as build args or frontend env. `.dockerignore` must exclude local credentials and data.
- Run normal regressions plus explicitly invoked `python3 tests/manual/docker-smoke.py` when Docker is available. This now checks API/web and the automation profile on isolated ports 33001/35173/35678, using project-scoped app/n8n volumes; scrub inherited N8N variables and keep external-volume reuse disabled. This isolated synthetic project must keep PHP confirmation false to avoid all HubSpot requests. It is excluded from automatic tests and retains its volume.
- Adopting legacy n8n data requires `N8N_DATA_EXTERNAL=true` and the exact `N8N_DATA_VOLUME` after stopping its previous writer. Preserve the stored encryption key and never mount a single n8n database into two running processes. Default fresh volumes are project-scoped; do not hardcode a shared container name.
- Exporter is an opt-in one-shot profile using the existing script; never start it or send sample webhooks automatically. Keep real portal mutations explicitly authorized. Document actual Docker evidence and any unverified browser/live behavior in tests/README.md.


## n8n automation maintenance conventions
- Keep the independent bonus in `n8n/order-to-hubspot.json` and `n8n/error-notification.json`, with synthetic `N8N-` fixtures. Never route its synchronization through the application API or SQLite.
- Target verified n8n 2.44.7 node versions, especially credential-backed Crypto v2. Use binary raw-body HMAC and fixed-size `crypto.timingSafeEqual`; document the narrow crypto builtin allowlist for the actual runner deployment.
- Secrets belong in Crypto, Header Auth and SMTP credentials, never workflow parameters, Code, pinned data or exports. Keep exports inactive, restore explicit credential/error-workflow placeholders, remove local instance metadata/history and real email addresses before committing. Assign installation-specific references after import.
- Root Compose includes n8n 2.44.7 under opt-in `automation`, localhost-only 5678 (overridable), non-root UID 1000, internal task runner and crypto-only builtin access. Keep HubSpot/HMAC/SMTP credentials in n8n, mount exports read-only and never auto-import/publish workflows or send samples at startup. Preserve the separate installed n8n container, encryption key, credentials, workflows and volumes. Inspect for same-named workflows before importing; do not overwrite existing work. Do not publish a conflicting webhook path.
- Keep validation, PHP minor-unit arithmetic, Contact updates, Deal naming/date/description and date-based endpoints aligned with `apps/api/src/order.ts` and `hubspot.ts`. Test changes against the actual exported Code strings. Document deliberate contract differences, especially synchronous replies and lack of SQLite payload-conflict enforcement.
- Keep remote unique `external_order_id` as the final concurrency safeguard. Reconcile uncertain/conflicting creates by direct unique-key read before another create; always repair association before success. Keep retry loops bounded and ordinary permanent errors fail-fast.
- Return expected validation errors normally. Route transport errors only through explicit bounded handling; terminal operational failures must raise an execution error after a safe HTTP response so the Error Trigger runs. n8n 2.44.7 requires the referenced error workflow to have a published version; test this in actual production-mode execution. Allowlist notification details and avoid arbitrary upstream strings/customer data.
- Default tests belong under root `tests/` and must not read credentials or call n8n/HubSpot. Explicit engine smoke belongs in `tests/manual/n8n-smoke.mjs`, runs only in a disposable network-isolated n8n container with fake CRM/SMTP, and must never run inside the installed instance. Real portal/notification checks remain explicit opt-in work.
- Update `n8n/README.md` and `tests/README.md` evidence/matrices with each workflow change. Distinguish mocked logic, actual n8n engine import/execution, live CRM records, automatic Error Trigger invocation and real recipient delivery. Never infer one from another.
