Date: 10/27/2026
# Optima Solutions — Order → HubSpot

Signed order webhooks create one HubSpot Deal per order and associate it with a Contact. The app provides durable SQLite attempt history, a protected React retry dashboard, and a seven-day Python CSV export. Two independent n8n workflows implement the automation bonus.

# Setup Steps

## 1. Configure the project

Run commands from the repository root. Local development/tests require **Node 24.x**, npm and **Python 3.11+**. Docker deployment requires Docker Desktop or Docker Engine with Compose; host Node/Python are only needed for local tools and tests.

```sh
npm install
# Fresh checkout only; preserve an existing .env:
cp .env.example .env
```

Edit `.env` using [.env.example](.env.example):

| Variable                                        | Configuration                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `HUBSPOT_ACCESS_TOKEN`                          | HubSpot test-portal Service Key; server-only                              |
| `WEBHOOK_SECRET`                                | Random HMAC secret, at least 32 characters                                |
| `DASHBOARD_ADMIN_TOKEN`                         | A different random secret, at least 32 characters                         |
| `HUBSPOT_PIPELINE_ID` / `HUBSPOT_DEAL_STAGE_ID` | Verified portal IDs; defaults `default` / `closedwon`                     |
| `HUBSPOT_PHP_CONFIRMED`                         | Set `true` only after enabling/confirming PHP in the portal               |
| `HOST` / `PORT` / `DATABASE_PATH`               | Local defaults: `127.0.0.1`, `3001`, `./data/orders.sqlite`               |
| `API_HOST_PORT` / `WEB_HOST_PORT`               | Optional Docker host-port overrides: `3001` / `5173`                      |
| `N8N_HOST_PORT`                                 | Optional n8n host port; default `5678`                                    |
| `N8N_DATA_VOLUME` / `N8N_DATA_EXTERNAL`         | Existing-volume adoption only; fresh installs use a project-scoped volume |

Generate each random secret separately with `openssl rand -hex 32`. Never commit `.env`, database files, CSVs or credentials.

In HubSpot, grant `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read` and `crm.objects.deals.write`. Create a Deal property named **`external_order_id`**, single-line text with **unique values required**. Enable PHP and verify the pipeline/stage. Metadata checks may require schema-read permission; no schema-write permission is needed.

## 2. Run the main app

```sh
npm run hubspot:verify   # Read-only property, pipeline/stage and authentication check
npm run db:migrate
npm run dev             # API + worker + Vite dashboard
```

Open the dashboard at <http://localhost:5173> and enter `DASHBOARD_ADMIN_TOKEN`. API: <http://localhost:3001>; health: `/health`. The dashboard shows the latest 50 **attempts**, refreshes automatically, and allows retrying failed orders using their original payloads.

With the app running, send a signed synthetic order, then resend it unchanged:

```sh
npm run mock:send -- REVIEW-ORDER-001
npm run mock:send -- REVIEW-ORDER-001
```

These commands write to the configured test portal. Verify the Contact, Deal and association in HubSpot, confirm one Deal after redelivery, and inspect attempt history in the dashboard. Correct the cause of a failed sync before pressing **Retry**.

The endpoint is `POST /api/webhooks/orders`, with JSON and `X-Order-Signature: sha256=<lowercase hex HMAC-SHA256(WEBHOOK_SECRET, exact raw body)>`. It accepts PHP orders with `items[].quantity`, validates totals in integer minor units, and verifies signatures before parsing. New orders return `202`; identical repeats return `200` with `duplicate:true`; changed content for an existing order ID returns `409`; invalid signatures/payloads return `401`/`400`.

For compiled API startup: `npm run build` then `npm start`. This serves the API only; use `npm run dev` for the local dashboard or Docker below for both built services.

## 3. Run tests and checks

```sh
npm test                # Offline Vitest + Python tests
npm run typecheck
npm run lint
npm run build
npm run format:check
```

Focused suites: `npm run test:unit`, `npm run test:integration`, `npm run test:frontend`, and `npm run test:python`. Use `npm run format` to apply formatting.

Opt-in checks:

```sh
python3 tests/manual/docker-smoke.py       # Isolated app + n8n Docker/persistence test
npm run smoke:live -- LIVE-REVIEW-001       # Running API required; creates test CRM records
```

Use a fresh order ID for the live runner; its payload differs from the mock sender. Automated tests never use real credentials or the runtime database. The last full suite passed **137 Vitest + 10 Python tests**. See [tests/README.md](tests/README.md) for coverage, fault-injection scenarios, the isolated n8n engine-smoke command and verification evidence.

## 4. Run with Docker Compose

Configure `.env` as above. Stop any local app already using ports 3001/5173, or set the host-port overrides.

```sh
docker compose config --quiet
docker compose up --build -d --wait        # API + dashboard
# Include n8n after checking the port/volume notes below:
docker compose --profile automation up --build -d --wait
docker compose ps
docker compose logs -f api web
```

Dashboard: <http://localhost:5173>; API: <http://localhost:3001>; optional n8n: <http://localhost:5678>. All published ports bind to localhost. API startup applies migrations and resumes queued/recoverable work; existing published n8n automations may also resume.

`docker compose stop` stops services; `docker compose down` removes containers while retaining data. Use `up -d --wait` to recreate them. Include `--profile automation` when starting the whole stack with n8n. After environment changes, use `up -d` rather than `restart`. Keep the same Compose project/volume names and never use `down -v` during normal operation. API SQLite data and n8n data/encryption keys use separate persistent volumes. Never print/share resolved `docker compose config`; use `config --quiet`.

## 5. Configure and test n8n

The `automation` profile provides pinned **n8n 2.44.7**, crypto access, an internal task runner, readiness checks and read-only workflow files. To start n8n alone:

```sh
docker compose up -d --no-deps --wait n8n
```


For a fresh instance, create the owner account, then:

1. Import [error-notification.json](n8n/error-notification.json), then [order-to-hubspot.json](n8n/order-to-hubspot.json).
2. In **Compute HMAC**, select a Crypto credential with **Hmac Secret** matching `WEBHOOK_SECRET`; keep output property `expectedSignature`.
3. In **HubSpot Request**, select Header Auth: name `Authorization`, value `Bearer <Service Key>`. Keep the exported response settings and result handler together.
4. In **Verify Signature and Validate Order**, confirm pipeline/stage/PHP and set `phpConfirmed:true`.
5. In **Email Operator**, configure SMTP credentials and sender/recipient. Gmail requires 2-Step Verification and an App Password, `smtp.gmail.com`, port `465`, SSL/TLS on.
6. Publish the error workflow, select it under the main workflow's **Settings → Error workflow**, then publish main. Credentials and workflow IDs must be assigned after import; nothing is auto-published.

Send a signed order from the host after `npm install`:

```sh
node --env-file=.env --import tsx scripts/send-n8n-webhook.ts \
  http://localhost:5678/webhook/optima-orders N8N-REVIEW-001
```

Use your configured host port. Repeat the same command: expect `200`, one Deal and the correct Contact association. The temporary `/webhook-test/optima-orders` URL requires **Listen for test event**; the published `/webhook/optima-orders` URL is required for automatic error-workflow testing. React history covers the main app only; monitor n8n separately.

To test alerts, publish a test copy at a different webhook path with `phpConfirmed:false` and the same error workflow. Send a valid signed request to that path: expect `502` and a notification, without HubSpot writes. Unpublish the test copy afterward. Full import, Gmail setup, recovery and troubleshooting details are in [n8n/README.md](n8n/README.md).

## 6. Export the last seven days of Deals

```sh
python3 scripts/export_recent_deals.py --output deals_last_7_days.csv
# Docker alternative:
mkdir -p exports
EXPORT_UID=$(id -u) EXPORT_GID=$(id -g) docker compose run --rm --no-deps exporter
```

The exporter uses the environment or local `.env`, paginates **all** Deals whose HubSpot `createdate` falls within the last seven rolling UTC days, and writes UTF-8 CSV. It filters Deal creation time, not the order timestamp/close date. No Python packages are required. Docker output is `exports/deals_last_7_days.csv`; keep CRM exports private.

# Architecture, mapping and limits

Express validates and durably queues orders in SQLite; one worker syncs HubSpot and records each attempt. React uses protected history/retry endpoints. Unique local order IDs and the unique remote property prevent duplicate Deals; retries reconcile uncertain creates and repair associations. Network/429/5xx retries are bounded with timeouts, backoff/jitter and capped Retry-After handling. The independent n8n workflow calls HubSpot directly.

| Source                                 | HubSpot mapping                                                 |
| -------------------------------------- | --------------------------------------------------------------- |
| Normalized email; names/provided phone | Find/create Contact, then update provided fields                |
| Order ID and customer name             | `dealname = Order {id} — {first} {last}`                        |
| Total / currency                       | Two-decimal `amount` / confirmed PHP currency                   |
| Order timestamp                        | UTC `closedate`; paid orders assume configured closed-won stage |
| Order ID / item summary                | Unique `external_order_id` / Deal description                   |


With more time, I would prioritize production readiness and operational visibility. I would replace the development admin token with session-based authentication and role-based access, deploy behind HTTPS, and define retention and encryption policies for stored order data and exports. I would also add structured metrics and alerts for failed syncs, processing delays, and repeated retries.

For larger workloads, I would move processing to a durable queue backed by a database suited to multiple workers, while preserving the current idempotency and recovery guarantees. Finally, I would automate CI checks and expand end-to-end verification against the HubSpot test portal, including concurrent deliveries, interrupted requests, and n8n failure notifications.