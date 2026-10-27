# Testing the Order → HubSpot integration

## Strategy and original audit

Automated tests verify behavior at the HTTP, SQLite, outbound HTTP, React component, and CSV boundaries. They never use the real HubSpot account or load `.env`. Synthetic IDs and the assessment's Maria Santos example are fixtures, not recorded customer data. A successful mock test establishes application behavior against the mocked contract, not HubSpot's acceptance of that contract.

The original suite had 24 Vitest tests and 7 Python tests by source inspection. It already exercised raw-byte HMAC, basic duplicates, lease recovery, association repair, and export pagination. Gaps included frontend interactions, exact assessment mapping/date assertions, several retry statuses, backoff timing, remote Deal uniqueness conflicts, local persistence failures, and deterministic latest-50 ordering. Tests lived in `apps/api/tests` and `scripts`. The expanded suite reproduces a confirmed dashboard defect: a late response could restore history after Disconnect. Session/request guards now discard stale responses; a regression test verifies this.

The production architecture remains intact: HTTP validation durably reserves an immutable order; a single worker claims it and creates a sync attempt; HubSpot HTTP retries happen inside that attempt; failed orders require an explicit retry, while interrupted leases are reclaimed. Pure validation/retry tests complement integration tests with real SQLite and mocked HubSpot HTTP. React runs in jsdom, not a real browser.

## Frameworks and structure

Node 24.x and Python 3.11+ are required. Existing Vitest, Supertest, better-sqlite3, and Python `unittest` are reused. jsdom and its TypeScript definitions were added for DOM component tests; React's own `act` and ReactDOM render/interactions avoid an additional component testing library. No Python packages are required.

```text
tests/
  unit/
    config.test.ts
    order-validation.test.ts
    retry-backoff.test.ts
    smoke-live.test.ts
  integration/
    webhook.test.ts
    webhook-validation.test.ts
    hubspot-sync.test.ts
    failure-recovery.test.ts
    order-recovery.test.ts
  frontend/dashboard.test.tsx
  python/test_export_deals.py
  fixtures/                 # assessment JSON and synthetic ingress fixture
  helpers/                  # signing, temp database, HTTP stub, offline guard
  manual/smoke-live.ts       # opt-in real-portal check, NEVER auto-discovered
  tsconfig.json             # strict no-emit checking of Node tests/helpers
```

All executable test sources and shared test utilities live here. `vitest.config.ts` discovers `tests/**/*.test.{ts,tsx}`. Python discovery selects `test_*.py` inside `tests/python`. There was no CI workflow to update; CI should use the same root scripts below. `npm run build` compiles production API/scripts only, while `npm run typecheck` also checks the relocated tests and frontend tests.

## Running tests

From the repository root:

```sh
npm ci
npm test                         # all Node/React tests, then Python; fail fast
npm run test:node                 # all Vitest tests
npm run test:unit
npm run test:integration
npm run test:frontend
npm run test:python
npm run typecheck
npm run lint
npm run build
npm run format:check
```

Individual files and named scenarios:

```sh
npm run test:node -- tests/integration/webhook-validation.test.ts
npm run test:node -- tests/integration/order-recovery.test.ts -t 'concurrent'
npm run test:node -- tests/frontend/dashboard.test.tsx
python3 -m unittest discover -s tests/python -p test_export_deals.py -v
python3 -m unittest discover -s tests/python -p test_export_deals.py -k test_empty -v
```

Vitest exits nonzero and prints the failing scenario, expected/received values and source location. Python prints a traceback and assertion difference; `-v` prints every test name. Run the failing file or named scenario above after a fix, then the full suite. Supertest opens ephemeral local sockets; an environment that forbids `listen` must permit local sockets for integration tests. No running application server is needed.

## Fixtures, mocks and database lifecycle

`fixtures/sample-order.json` is the assessment example: ORD-10482, Maria Santos, maria.santos@example.com, PHP 900.00. Its `+08:00` timestamp deliberately verifies UTC conversion to `2026-09-20T12:00:00.000Z`. `fixtures/order.ts` preserves the smaller synthetic ingress fixture. Tests construct invalid variants rather than maintaining many almost-identical JSON files.

`helpers/mock-hubspot.ts` supplies stateful mocked HTTP, captures paths/methods/JSON and supports existing Contacts/Deals, lost create responses, unique conflicts, and association failure. Tests assert outgoing payloads and call counts. Tests needing distinct per-order remote state provide a small local transport override. `helpers/offline.ts` replaces global fetch with a throwing stub before every Vitest test; clients receive injected HTTP transports. Python patches `urlopen` to reject real networking, then replaces it with explicit mock responses where needed. Neither suite imports server config or reads credentials. Restore mocks after each test.

`helpers/test-database.ts` creates a unique OS temporary directory and real SQLite file using the production Store/migration; cleanup closes the database and removes only that directory, including WAL/SHM files. Existing ingress tests also use isolated in-memory SQLite. Reopen tests exercise persisted queued/processing jobs; two connections to one temporary file verify reservation/claim exclusivity. The 65-attempt test freezes `Date.now` to force equal timestamps, then asserts exactly attempts 65 through 16, descending by ID. Multiple attempts for the same order remain visible. It also checks safe errors, IDs, input limits, and exclusion of payload PII. Tests never open the application's database or modify migrations.

## Webhook signing and expected outcomes

`helpers/webhook-signer.ts` computes `sha256=` plus lowercase hex `HMAC-SHA256(secret, exact raw body)` with a synthetic test secret. Endpoint tests transmit the exact signed string with `Content-Type: application/json` and `X-Order-Signature`. Production uses `express.raw`, validates fixed-length lowercase hex and compares digests using `crypto.timingSafeEqual` before parsing JSON. Timing resistance is established by code inspection; wall-clock timing assertions would be unreliable.

Expected results: valid signed orders return 202, identical normalized repeats return 200 with `duplicate:true`, conflicting reuse returns 409 without changing the original, missing/wrong/tampered signatures return 401, signed invalid JSON/schema/totals return 400, oversized bodies return 413, compressed bodies return 415, and reservation failures return safe 500. Invalid authenticated orders never call reservation. PHP is the only accepted currency; amounts use at most two decimal places and positive integer quantities. Zero-valued orders/items are valid when totals agree.

One application sync attempt may contain up to four HTTP requests **per operation**. Those internal retries do not create extra `sync_attempts` rows. Backoff tests inject delays and fixed jitter, asserting 1/2/4-second exponential bases, rate-limit seconds/HTTP dates, 30-second cap, network exhaustion, timeout recovery, transient 429/500/502/503/504 recovery, and prompt 400/401/403 failure. Integration tests verify persistent terminal failure and sanitized log/history content. A fake timeout signal tests abort handling without ten seconds of real waiting; it does not test an operating system TCP timeout.

## Assessment Requirements-to-Tests Coverage Matrix

Paths below are relative to `tests/`. **Passed** means the named automated assertions executed successfully in this audit. **Partial** distinguishes mock evidence from unexecuted external/manual gates. Each change to tests or behavior must update this matrix and evidence counts.

| Req.           | Feature                                    | Test File                                                                                                        | Scenario / expected assertion                                                                                                                                                                                                                                                    | Verification Status                                                                 |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 22             | Raw HMAC                                   | `integration/webhook.test.ts`                                                                                    | Exact formatted UTF-8 bytes accepted; altered bytes, missing/malformed/incorrect signature rejected before parsing; compression/size rejected                                                                                                                                    | Passed automated; constant-time primitive manually inspected                        |
| 22             | Validation                                 | `integration/webhook-validation.test.ts`, `unit/order-validation.test.ts`                                        | Wrong secret, missing fields/email/date/event/currency, nonfinite/negative/precision money, invalid quantities, empty items and mismatched totals rejected; zero and exact minor units accepted                                                                                  | Passed automated                                                                    |
| 22             | Durable acceptance                         | `integration/webhook-validation.test.ts`                                                                         | DB reservation exception returns sanitized 500 for sender retry                                                                                                                                                                                                                  | Passed automated                                                                    |
| 23             | Contact and Deal mapping                   | `integration/order-recovery.test.ts`, `integration/hubspot-sync.test.ts`                                         | Exact normalized email search/create/update; missing phone omitted; Maria order maps name, 900.00, PHP, UTC, pipeline/stage, external ID and association type; IDs saved                                                                                                         | Passed automated; live contract partial                                             |
| 23             | Setup/conflicts/repair                     | `integration/hubspot-sync.test.ts`, `integration/failure-recovery.test.ts`, `integration/order-recovery.test.ts` | Contact 409 reread; existing Contact creates missing Deal; currency/unique-property guards; existing Deal repairs association                                                                                                                                                    | Passed automated; actual portal permissions/currency not rechecked                  |
| 24             | Sequential duplicates                      | `integration/order-recovery.test.ts`, `integration/webhook.test.ts`                                              | Redelivery after success produces no extra attempt or Deal; different content returns 409 and original timestamp remains                                                                                                                                                         | Passed automated                                                                    |
| 24             | Concurrent duplicates                      | `integration/order-recovery.test.ts`                                                                             | Ten simultaneous HTTP submissions give one reservation; overlapping processOne calls claim once; one attempt/Deal; two SQLite connections cannot double-claim                                                                                                                    | Passed automated; single-process architecture only                                  |
| 24             | Same customer, distinct orders             | `integration/order-recovery.test.ts`                                                                             | Two orders reuse existing Contact and persist two distinct remote Deal IDs                                                                                                                                                                                                       | Passed automated                                                                    |
| 24             | Remote uniqueness                          | `integration/order-recovery.test.ts`, `integration/hubspot-sync.test.ts`                                         | Direct external_order_id reconciliation; remote 409 and lost create response reuse one Deal, repair association, never resend successful create                                                                                                                                  | Passed automated; HubSpot uniqueness enforcement not retested live                  |
| 25             | HTTP retry policy                          | `unit/retry-backoff.test.ts`, `integration/hubspot-sync.test.ts`                                                 | 429/500/502/503/504 recover; 400/401/403 fail promptly; max four requests; exponential jitter; numeric/date Retry-After and cap                                                                                                                                                  | Passed automated                                                                    |
| 25             | Network/timeout/security                   | `unit/retry-backoff.test.ts`, `integration/webhook.test.ts`, `integration/webhook-validation.test.ts`            | Network exhaustion and timeout recovery; arbitrary upstream messages/token/email excluded from errors; safe log on DB failure                                                                                                                                                    | Passed automated; real TCP behavior not executed                                    |
| 25             | Persistent exhaustion                      | `integration/failure-recovery.test.ts`                                                                           | Contact saved, Deal 503 exhausts current attempt; manual retry succeeds, creates one Deal and preserves failed history                                                                                                                                                           | Passed automated                                                                    |
| 26             | Attempt lifecycle                          | `integration/webhook.test.ts`, `integration/order-recovery.test.ts`                                              | Manual retry adds row; terminal row preserved independently of current state; IDs/errors/timestamps stored; remote success/local write failures reconcile                                                                                                                        | Passed automated                                                                    |
| 26             | Restart recovery                           | `integration/failure-recovery.test.ts`, `integration/order-recovery.test.ts`                                     | Real database reopen retains queued/interrupted job; lease expiry closes interrupted attempt; terminal DB outage reconciles one remote Deal                                                                                                                                      | Passed automated; process kill/power loss not executed                              |
| 27             | Latest 50 API                              | `integration/order-recovery.test.ts`                                                                             | 65 equal-time attempts return exact newest 50 in deterministic order, older rows excluded; repeats/errors/IDs included; payload excluded                                                                                                                                         | Passed automated                                                                    |
| 27             | Protected manual retry                     | `integration/webhook.test.ts`, `integration/order-recovery.test.ts`                                              | Unauthorized retry blocked; concurrent retry gives 202/409; queued/processing/succeeded retries rejected; supplied replacement payload ignored                                                                                                                                   | Passed automated                                                                    |
| 27             | Dashboard                                  | `frontend/dashboard.test.tsx`                                                                                    | Loading/disconnected/empty/API/network errors; repeated rows/IDs/errors; Retry eligibility; correct authenticated endpoint; busy/queued disabled; 409/500 failure; polling sees new attempt; Disconnect rejects stale response; older polling response cannot replace newer data | Passed automated; real browser/responsiveness/accessibility review partial          |
| 28             | Export selection/CSV                       | `python/test_export_deals.py`                                                                                    | UTC rolling cutoff inclusive; 1 ms older/future excluded; offset/millisecond dates; pagination/dedup/all columns/missing fields; empty headers; formulas escaped, negative numbers preserved                                                                                     | Passed automated                                                                    |
| 28             | Export reliability                         | `python/test_export_deals.py`                                                                                    | Rate limit/backoff; transient 503; fail-fast 4xx and bounded 5xx/network; repeated cursor; result-cap window splitting; failed export preserves output                                                                                                                           | Passed automated; live export not executed this audit                               |
| 29             | Documentation                              | Manual review of root `README.md`, `tests/README.md`, package scripts                                            | Setup/env/architecture/mapping/auth/assumptions/export/demo/limitations described; commands linked to scripts; matrix evidence recorded                                                                                                                                          | Reviewed in this audit; fresh-clone and external reviewer reproduction not executed |
| Bonus          | Mapping/idempotency tests                  | `integration/order-recovery.test.ts`, `integration/hubspot-sync.test.ts`                                         | Exact mapping, concurrent duplicates, remote conflicts and lost-response recovery                                                                                                                                                                                                | Passed automated                                                                    |
| Bonus          | Docker Compose                             | `manual/docker-smoke.py`                                                                                         | Isolated containers: HMAC, proxy/auth, duplicate, failed attempt persistence across down/up, retry history                                                                                                                                                                       | Docker smoke passed; browser/live CRM checks separate                               |
| 23, 24, 25, 29 | Live runner reporting (offline regression) | `unit/smoke-live.test.ts`                                                                                        | Webhook HTTP/status/duplicate; persisted failure code; successful sync separated from mapping/association/Search failure; bounded indexing wait; missing IDs; history auth and timeout; raw exception redaction                                                                  | Passed automated with mocked transport; live runner not executed in this follow-up  |

| Bonus | Container binding config | `unit/config.test.ts` | Defaults to loopback, accepts container HOST, rejects empty HOST | Passed automated |

## Testing Evidence Summary

Executed on 2026-10-27 in this checkout, with mocked HubSpot and temporary SQLite:

- Total automated tests discovered: **100** (90 Vitest, 10 Python unittest methods; Python status subtests do not add to this count).
- Passed: **100**. Failed: **0**. Skipped: **0**.
- Test files executed: **11** (10 `.test.ts`/`.test.tsx` files listed above, plus `python/test_export_deals.py`). Manual smoke script excluded from discovery; its exported runner is exercised by offline unit tests.
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`: passed. Formatting checked separately with `npm run format:check`.
- Initial full run: 69/70 Node/React tests passed; stale-response regression failed before the production fix. Later tests expanded the final Node count to 89. Docker configuration follow-up adds one HOST validation test (90 Node tests).
- Smoke-runner follow-up: 13 new offline regression tests passed; runner now reports stage, sync state and safe error codes, and tolerates bounded CRM Search indexing lag. No live portal request was made in this follow-up.
- No coverage instrumentation configured; no coverage percentage is claimed.
- External/manual portions of R23–R29 remain unverified in this audit: live writes/scopes/unique enforcement/association, real export, browser layout and retry demo, UI screenshots, and clean-clone reproduction. R22's timing primitive was inspected, not statistically measured. Historical live evidence in the root README was not rerun and is not counted here.

## How to Verify the Assessment Requirements

1. Run `npm ci` on Node 24; Python's standard library supplies its test dependencies.
2. Run `npm test`, followed by `npm run typecheck`, `npm run lint`, and `npm run build`.
3. Choose the actual file(s) in the matrix and run `npm run test:node -- <file>` or the Python discovery command. For R24's concurrency gate, use the named `concurrent` command above. For R27's component gates, run `npm run test:frontend`.
4. Read assertion output for any failure and rerun the scenario. Do not update a matrix entry to Passed until the assertions execute successfully.
5. Compare the matrix's expected assertions and partial/manual caveats with the run output; file existence alone is not evidence.
6. Complete the manual steps below only against an authorized developer test portal. Automated tests require no credentials and perform no CRM writes.

## Manual QA checklist and known limitations

- Configure a private local `.env` following the root README; confirm PHP currency and unique `external_order_id` in the test portal UI. `npm run hubspot:verify` is read-only and does not prove writes.
- Run migrations and `npm run dev`; verify `/health` and dashboard at the documented ports. Connect using the development admin token, never the HubSpot key.
- The runner reports webhook acceptance separately from order completion: HTTP 202 means durable enqueue, not CRM success. A failed existing order prints its stored `error_code` and requires manual retry; resending is only a duplicate. Verification errors include `stage=deal|contact|uniqueness` and retain `sync=succeeded` when appropriate. `SEARCH_NOT_VISIBLE` means direct record checks passed but Search did not index the Deal within five checks (1/2/4/8-second waits). `DUPLICATE_REMOTE_DEALS`, `DEAL_AMOUNT_MISMATCH`, and `CONTACT_ASSOCIATION_MISSING` identify specific failed checks. Non-JSON webhook errors retain their HTTP status. Exit 0 means every smoke check passed; exit 1 means a named check/request failed. No raw customer data or credentials are printed.
- Explicit live check (writes test records): `npm run smoke:live -- YOUR-UNIQUE-TEST-ORDER-ID`. Review Contact, Deal, amount/currency/stage and association in the HubSpot UI. Never include real IDs or portal screenshots containing PII in committed evidence.
- Resend `npm run mock:send -- YOUR-UNIQUE-TEST-ORDER-ID` twice using the same sender payload (use a different ID from the smoke runner, which has its own fixed payload). Confirm a single Deal and no extra attempt. An ID reused between differing sender payloads correctly returns 409.
- For a genuinely failed local order, correct its operational cause, press Retry in the dashboard, observe queued/processing/success and preserved failed history. Do not alter its persisted payload or bypass security to manufacture failure. Deterministic outage injection is available in automated tests instead.
- Resize the real dashboard to mobile/desktop; inspect table scrolling, readable statuses, keyboard operation and an actual retry. Capture a redacted screenshot if required for submission.
- Run `python3 scripts/export_recent_deals.py --output deals_last_7_days.csv` explicitly; inspect CSV privately and verify inclusion follows HubSpot creation time, not the September order/close date. Do not commit CSVs.
- Reproduce documented setup from a clean clone and provide the required GitHub URL separately.

Mocks cannot prove date-based endpoints, uniqueness indexing visibility, rate limits or account permissions. jsdom cannot prove visual layout, browser compatibility or assistive-technology behavior. SQLite tests cover two connections and HTTP concurrency, not multiple deployed workers or power-loss durability. Production intentionally supports a single API/worker instance. Search export is not an atomic snapshot. Testing does not add deployment auth, encryption/retention or n8n. Docker verification is recorded below.

## Adding tests

Place new files under the appropriate root `tests/` category; use `.test.ts`/`.test.tsx` for Vitest and `test_*.py` for Python. Reuse fixtures, signer, HTTP stub and temporary DB helper. Assert observable status, persisted records, payloads and side-effect counts rather than private implementation details. Use injected delays or fake timers; restore spies/timers and close/remove test databases in cleanup. Add a failing regression before fixing a defect. Never read `.env`, use real credentials, call the live portal, or open the application's database in automated tests. Keep opt-in live checks under `tests/manual` and outside discovery. Update this guide, the matrix and executed evidence counts after changes; record failures/skips/unexecuted scenarios honestly.

## Docker follow-up (2026-10-27)

The existing suite remains independent of Docker. One unit test in `unit/config.test.ts` validates default loopback/explicit container HOST and rejects an empty value; the live-runner fixture adds HOST to match the validated configuration type. Total: 90 Vitest + 10 Python = 100 passed, zero skipped/failed in the completed unrestricted run. Typecheck, lint and build passed. The first sandbox run could not open Supertest sockets (EPERM); rerunning with local socket permission passed.

`docker compose config --quiet`, image builds, `up -d --wait`, `ps`, health checks and `down` were executed. The first isolated startup found host port 3001 occupied; optional host-port overrides permit verification on 33001/35173 without interrupting the local app. `python3 tests/manual/docker-smoke.py` passed proxy routing, SPA refresh fallback, authenticated history, signature rejection/acceptance, duplicate delivery, failed attempt history, normal down/up persistence and retry adding a second attempt while retaining the first. It uses synthetic credentials and false PHP confirmation, causing `PHP_CURRENCY_NOT_CONFIRMED` before any HubSpot request. Containers stopped cleanly; its separate `optima-docker-smoke_app-data` volume is retained. The expected missing-.env informational line is harmless because Compose supplies runtime environment variables.

This opt-in script lives under `tests/manual` and is excluded from `npm test` and Python automated discovery. Run it explicitly with Docker running; it uses alternate ports and never loads the local secret file. Real portal writes/export, browser rendering and UI-click retry were not executed in this Docker follow-up. Existing mocked tests cover saved CRM IDs and queued/interrupted lease recovery; Docker persistence was demonstrated with failed synthetic attempts, not a real HubSpot sync.

Additional container checks: the optional exporter image loaded `--help` successfully without API calls. The API runtime check asserts non-root UID, SQLite WAL mode and absence of TypeScript/Vite packages. An intermediate check caught Vite retained by npm's workspace-filtered installation; the Dockerfile now uses a root-only production install.
