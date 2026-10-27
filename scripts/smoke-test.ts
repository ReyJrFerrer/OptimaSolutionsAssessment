import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { config } from '../apps/api/src/config.js';
import { HubSpotClient, HubSpotError } from '../apps/api/src/hubspot.js';
const env = config();
const orderId = process.argv[2] ?? 'OPTIMA-SMOKE-20261027-PHP';
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
  fetch(base + '/api/webhooks/orders', {
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
try {
  const first = await send();
  assert.ok([200, 202].includes(first.status), 'Signed order was not accepted');
  console.log('Signed test order accepted');
  let attempt:
    | {
        status: string;
        current_order_state: string;
        hubspot_contact_id: string;
        hubspot_deal_id: string;
      }
    | undefined;
  for (let i = 0; i < 120; i++) {
    const r = await fetch(base + '/api/sync-attempts?limit=50', {
      headers: { Authorization: 'Bearer ' + env.DASHBOARD_ADMIN_TOKEN },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(r.status, 200, 'Dashboard authentication failed');
    const rows = (await r.json()) as {
      order_id: string;
      status: string;
      current_order_state: string;
      hubspot_contact_id: string;
      hubspot_deal_id: string;
    }[];
    attempt = rows.find((a) => a.order_id === orderId);
    if (attempt?.status === 'succeeded') break;
    if (attempt?.current_order_state === 'failed')
      throw Error('Sync failed; inspect safe dashboard error');
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(
    attempt?.status,
    'succeeded',
    'Sync did not finish within smoke-test deadline',
  );
  const duplicate = await send();
  assert.equal(duplicate.status, 200);
  assert.equal(
    ((await duplicate.json()) as { duplicate: boolean }).duplicate,
    true,
  );
  console.log('Redelivery recognized without another attempt');
  const client = new HubSpotClient({
    token: env.HUBSPOT_ACCESS_TOKEN,
    pipeline: env.HUBSPOT_PIPELINE_ID,
    stage: env.HUBSPOT_DEAL_STAGE_ID,
    phpConfirmed: true,
  });
  const deal = await client.request<{
    id: string;
    properties: Record<string, string>;
    associations: { contacts: { results: { id: string }[] } };
  }>(
    `/crm/objects/2026-09/deals/${encodeURIComponent(orderId)}?idProperty=external_order_id&properties=external_order_id,amount,deal_currency_code,pipeline,dealstage,closedate&associations=contacts`,
  );
  assert.equal(deal.id, attempt!.hubspot_deal_id);
  assert.equal(deal.properties.external_order_id, orderId);
  assert.equal(Number(deal.properties.amount), 251);
  assert.equal(deal.properties.deal_currency_code, 'PHP');
  assert.equal(deal.properties.pipeline, env.HUBSPOT_PIPELINE_ID);
  assert.equal(deal.properties.dealstage, env.HUBSPOT_DEAL_STAGE_ID);
  assert.ok(
    deal.associations.contacts.results.some(
      (c) => c.id === attempt!.hubspot_contact_id,
    ),
  );
  const contact = await client.request<{
    id: string;
    properties: { email: string };
  }>(
    `/crm/objects/2026-09/contacts/${encodeURIComponent(attempt!.hubspot_contact_id)}?properties=email`,
  );
  assert.equal(contact.properties.email, payload.customer.email);
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
  assert.equal(
    search.results.length,
    1,
    'Expected exactly one remotely searchable Deal',
  );
  console.log(
    'Verified Contact, unique Deal, amount, PHP currency, pipeline/stage and Contact association via real API; genuine IDs withheld',
  );
} catch (error) {
  console.error(
    error instanceof HubSpotError
      ? error.message
      : 'Smoke verification failed; inspect safe dashboard state (CRM responses withheld)',
  );
  process.exitCode = 1;
}
