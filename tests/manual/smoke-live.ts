import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { config } from '../../apps/api/src/config.js';
import { HubSpotClient, HubSpotError } from '../../apps/api/src/hubspot.js';
class SmokeFailure extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function check(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new SmokeFailure(code, message);
}
const safeCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : 'UNKNOWN_ERROR';
type Attempt = {
  order_id: string;
  status: string;
  current_order_state: string;
  attempt_number: number;
  hubspot_contact_id: string | null;
  hubspot_deal_id: string | null;
  error_code: string | null;
};
export async function runSmoke(
  env: ReturnType<typeof config>,
  orderId: string,
  {
    transport = fetch,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log = console.log,
    error: reportError = console.error,
  } = {},
) {
  let stage = 'webhook';
  let syncState = 'unknown';
  try {
    check(
      /^[A-Za-z0-9_-]{1,200}$/.test(orderId),
      'INVALID_ORDER_ID',
      'Use letters, numbers, hyphens or underscores for the order ID.',
    );
    const payload = {
      event: 'order.created',
      order_id: orderId,
      created_at: '2026-09-20T12:00:00Z',
      customer: {
        email: 'optima-assessment@example.com',
        first_name: 'Assessment',
        last_name: 'Test',
      },
      items: [{ name: 'Assessment item', quantity: 2, price: 125.5 }],
      total: 251,
      currency: 'PHP',
    };
    const body = JSON.stringify(payload),
      base = `http://127.0.0.1:${env.PORT}`;
    const send = () =>
      transport(base + '/api/webhooks/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Order-Signature':
            'sha256=' +
            createHmac('sha256', env.WEBHOOK_SECRET).update(body).digest('hex'),
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
    const first = await send();
    const accepted = (await first.json().catch(() => ({}))) as {
      status?: string;
      duplicate?: boolean;
      error?: string;
    };
    check(
      [200, 202].includes(first.status),
      accepted.error
        ? safeCode(accepted.error)
        : `WEBHOOK_HTTP_${first.status}`,
      `Webhook rejected: HTTP ${first.status}.`,
    );
    syncState = accepted.status ?? 'unknown';
    log(
      `Webhook: HTTP ${first.status}; status=${syncState}; duplicate=${accepted.duplicate === true}. Acceptance is not sync completion.`,
    );
    stage = 'sync';
    let attempt: Attempt | undefined;
    for (let i = 0; i < 120; i++) {
      const r = await transport(base + '/api/sync-attempts?limit=50', {
        headers: { Authorization: 'Bearer ' + env.DASHBOARD_ADMIN_TOKEN },
        signal: AbortSignal.timeout(10000),
      });
      check(
        r.status === 200,
        `HISTORY_HTTP_${r.status}`,
        `Cannot read sync history: HTTP ${r.status}; check API availability and dashboard admin token.`,
      );
      const rows = (await r.json()) as Attempt[];
      // Current state wins over a historical successful attempt during an active retry.
      attempt = rows.find((a) => a.order_id === orderId);
      syncState = attempt?.current_order_state ?? syncState;
      if (syncState === 'failed') {
        throw new SmokeFailure(
          safeCode(attempt?.error_code),
          'Order sync failed. Correct the cause and retry the persisted order through the dashboard; redelivery does not retry failed orders.',
        );
      }
      if (syncState === 'succeeded' && attempt?.status === 'succeeded') break;
      if (i < 119) await sleep(1000);
    }
    check(
      attempt?.status === 'succeeded' && syncState === 'succeeded',
      'SYNC_TIMEOUT',
      'No successful attempt found within 120 history checks. The order may still be running or outside the newest 50 attempts.',
    );
    log(
      `Sync: status=succeeded; attempt=${attempt.attempt_number}; error_code=none.`,
    );
    check(
      attempt.hubspot_contact_id && attempt.hubspot_deal_id,
      'MISSING_SAVED_IDS',
      'Successful attempt is missing saved HubSpot IDs.',
    );
    stage = 'redelivery';
    const duplicate = await send();
    const repeated = (await duplicate.json()) as {
      duplicate?: boolean;
      status?: string;
      error?: string;
    };
    check(
      duplicate.status === 200 && repeated.duplicate === true,
      'REDELIVERY_NOT_DUPLICATE',
      `Redelivery check failed: HTTP ${duplicate.status}; response_code=${safeCode(repeated.error)}.`,
    );
    log(
      `Redelivery: HTTP ${duplicate.status}; duplicate=true; status=${repeated.status ?? 'unknown'}.`,
    );
    stage = 'deal';
    const client = new HubSpotClient(
      {
        token: env.HUBSPOT_ACCESS_TOKEN,
        pipeline: env.HUBSPOT_PIPELINE_ID,
        stage: env.HUBSPOT_DEAL_STAGE_ID,
        phpConfirmed: env.HUBSPOT_PHP_CONFIRMED === 'true',
      },
      transport,
      sleep,
    );
    const deal = await client.request<{
      id: string;
      properties: Record<string, string>;
      associations: { contacts: { results: { id: string }[] } };
    }>(
      `/crm/objects/2026-09/deals/${encodeURIComponent(orderId)}?idProperty=external_order_id&properties=external_order_id,amount,deal_currency_code,pipeline,dealstage,closedate&associations=contacts`,
    );
    check(
      deal.id === attempt.hubspot_deal_id,
      'DEAL_ID_MISMATCH',
      'Remote Deal differs from the successful attempt.',
    );
    const expected = {
      external_order_id: orderId,
      deal_currency_code: 'PHP',
      pipeline: env.HUBSPOT_PIPELINE_ID,
      dealstage: env.HUBSPOT_DEAL_STAGE_ID,
    };
    for (const [field, value] of Object.entries(expected)) {
      check(
        deal.properties[field] === value,
        'DEAL_MAPPING_MISMATCH',
        `Deal field ${field} does not match the smoke order/configuration.`,
      );
    }
    check(
      Number(deal.properties.amount) === payload.total,
      'DEAL_AMOUNT_MISMATCH',
      'Deal amount does not match the smoke order.',
    );
    check(
      new Date(deal.properties.closedate).getTime() ===
        new Date(payload.created_at).getTime(),
      'DEAL_CLOSEDATE_MISMATCH',
      'Deal close date does not match the source timestamp.',
    );
    check(
      deal.associations?.contacts?.results.some(
        (c) => c.id === attempt.hubspot_contact_id,
      ),
      'CONTACT_ASSOCIATION_MISSING',
      'Deal is not associated with the saved Contact.',
    );
    stage = 'contact';
    const contact = await client.request<{
      id: string;
      properties: { email: string };
    }>(
      `/crm/objects/2026-09/contacts/${encodeURIComponent(attempt.hubspot_contact_id)}?properties=email`,
    );
    check(
      contact.id === attempt.hubspot_contact_id &&
        contact.properties.email === payload.customer.email,
      'CONTACT_MAPPING_MISMATCH',
      'Remote Contact does not match the saved Contact and smoke customer.',
    );
    stage = 'uniqueness';
    for (let i = 0; i < 5; i++) {
      const search = await client.request<{ results: { id: string }[] }>(
        `/crm/objects/2026-09/deals/search`,
        'POST',
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'external_order_id',
                  operator: 'EQ',
                  value: orderId,
                },
              ],
            },
          ],
          limit: 100,
        },
      );
      check(
        search.results.length <= 1,
        'DUPLICATE_REMOTE_DEALS',
        'More than one Deal was returned for external_order_id.',
      );
      if (search.results.length === 1) {
        check(
          search.results[0].id === deal.id,
          'SEARCH_DEAL_MISMATCH',
          'Search returned a different Deal from the direct unique-key lookup.',
        );
        break;
      }
      check(
        i < 4,
        'SEARCH_NOT_VISIBLE',
        'Sync succeeded and direct record checks passed, but CRM Search has not indexed the Deal after five checks. Rerun this smoke check; this does not mean the order sync failed.',
      );
      await sleep(1000 * 2 ** i);
    }
    log(
      'Smoke: PASSED; sync=succeeded; Contact, Deal mapping, association and searchable uniqueness verified. Genuine IDs withheld.',
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof SmokeFailure
        ? error.code
        : error instanceof HubSpotError
          ? error.code
          : 'SMOKE_REQUEST_FAILED';
    const message =
      error instanceof SmokeFailure || error instanceof HubSpotError
        ? error.message
        : 'Request or response could not be processed; check API/network availability. Raw errors withheld.';
    reportError(
      `Smoke: FAILED; stage=${stage}; sync=${syncState}; error_code=${code}. ${message}`,
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runSmoke(
      config(),
      process.argv[2] ?? 'OPTIMA-SMOKE-20261027-PHP',
    );
  } catch {
    console.error(
      'Smoke: FAILED; stage=config; error_code=INVALID_CONFIG. Check required environment variables; values withheld.',
    );
    process.exitCode = 1;
  }
}
