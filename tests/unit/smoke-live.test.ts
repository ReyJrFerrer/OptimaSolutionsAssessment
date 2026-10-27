import { it, expect, vi } from 'vitest';
import { runSmoke } from '../manual/smoke-live.js';
const env = {
  HUBSPOT_ACCESS_TOKEN: 'fake-private-token',
  HUBSPOT_PIPELINE_ID: 'default',
  HUBSPOT_DEAL_STAGE_ID: 'closedwon',
  WEBHOOK_SECRET: 's'.repeat(32),
  DASHBOARD_ADMIN_TOKEN: 'a'.repeat(32),
  HUBSPOT_PHP_CONFIRMED: 'true' as const,
  PORT: 3001,
  HOST: '127.0.0.1',
  DATABASE_PATH: ':memory:',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup(
  options: {
    missingIds?: boolean;
    failed?: boolean;
    rejected?: boolean;
    historyStatus?: number;
    pending?: boolean;
    mapping?: boolean;
    searchLag?: number;
    searchDuplicate?: boolean;
    missingAssociation?: boolean;
    rawError?: boolean;
    duplicate?: boolean;
  } = {},
) {
  let sends = 0,
    searches = 0;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (options.rawError)
      throw Error('fake-private-token customer@example.com');
    if (path.endsWith('/api/webhooks/orders')) {
      sends++;
      if (options.rejected) return json({ error: 'ORDER_CONFLICT' }, 409);
      return json(
        {
          status: options.failed
            ? 'failed'
            : options.pending
              ? 'queued'
              : 'succeeded',
          duplicate: sends > 1 || options.duplicate,
        },
        sends > 1 || options.duplicate ? 200 : 202,
      );
    }
    if (path.endsWith('/api/sync-attempts?limit=50'))
      return json(
        options.pending
          ? []
          : [
              {
                order_id: 'ORD-TEST',
                status: options.failed ? 'failed' : 'succeeded',
                current_order_state: options.failed ? 'failed' : 'succeeded',
                attempt_number: 2,
                hubspot_contact_id: options.missingIds
                  ? null
                  : 'private-contact',
                hubspot_deal_id: 'private-deal',
                error_code: options.failed ? 'HUBSPOT_HTTP_503' : null,
                error_message: 'fake-private-token customer@example.com',
              },
            ],
        options.historyStatus ?? 200,
      );
    if (path.includes('/deals/ORD-TEST?'))
      return json({
        id: 'private-deal',
        properties: {
          external_order_id: 'ORD-TEST',
          amount: options.mapping ? '999' : '251',
          deal_currency_code: 'PHP',
          pipeline: 'default',
          dealstage: 'closedwon',
          closedate: '2026-09-20T12:00:00Z',
        },
        associations: {
          contacts: {
            results: options.missingAssociation
              ? []
              : [{ id: 'private-contact' }],
          },
        },
      });
    if (path.includes('/contacts/private-contact?'))
      return json({
        id: 'private-contact',
        properties: { email: 'optima-assessment@example.com' },
      });
    if (path.endsWith('/deals/search') && init?.method === 'POST') {
      searches++;
      return json({
        results: options.searchDuplicate
          ? [{ id: 'private-deal' }, { id: 'other' }]
          : searches <= (options.searchLag ?? 0)
            ? []
            : [{ id: 'private-deal' }],
      });
    }
    throw Error('Unexpected request');
  });
  const log = vi.fn(),
    error = vi.fn(),
    sleep = vi.fn(async (_ms: number) => {});
  return {
    transport,
    log,
    error,
    sleep,
    run: () => runSmoke(env, 'ORD-TEST', { transport, log, error, sleep }),
  };
}
it('reports webhook HTTP state, successful sync and verification separately', async () => {
  const t = setup();
  expect(await t.run()).toBe(0);
  const output = t.log.mock.calls.flat().join('\n');
  expect(output).toContain(
    'Webhook: HTTP 202; status=succeeded; duplicate=false',
  );
  expect(output).toContain(
    'Sync: status=succeeded; attempt=2; error_code=none',
  );
  expect(output).toContain('Redelivery: HTTP 200; duplicate=true');
  expect(output).toContain('Smoke: PASSED');
  expect(t.error).not.toHaveBeenCalled();
  expect(output).not.toMatch(
    /private-contact|private-deal|fake-private-token|@/,
  );
});
it('reports existing failed order with its persisted code and no implicit retry', async () => {
  const t = setup({ failed: true, duplicate: true });
  expect(await t.run()).toBe(1);
  expect(t.log.mock.calls[0][0]).toContain(
    'HTTP 200; status=failed; duplicate=true',
  );
  expect(t.error.mock.calls[0][0]).toContain(
    'stage=sync; sync=failed; error_code=HUBSPOT_HTTP_503',
  );
  expect(t.transport).toHaveBeenCalledTimes(2);
  expect(t.error.mock.calls[0][0]).not.toMatch(/fake-private-token|@/);
});
it('reports rejected webhook HTTP status and response code', async () => {
  const t = setup({ rejected: true });
  expect(await t.run()).toBe(1);
  expect(t.error.mock.calls[0][0]).toContain(
    'error_code=ORDER_CONFLICT. Webhook rejected: HTTP 409',
  );
  expect(t.transport).toHaveBeenCalledTimes(1);
});
it('reports history authentication failure without misreporting a sync failure', async () => {
  const t = setup({ historyStatus: 401 });
  expect(await t.run()).toBe(1);
  expect(t.error.mock.calls[0][0]).toContain('error_code=HISTORY_HTTP_401');
});
it('reports pending timeout and bounds history polling', async () => {
  const t = setup({ pending: true });
  expect(await t.run()).toBe(1);
  expect(t.error.mock.calls[0][0]).toContain(
    'sync=queued; error_code=SYNC_TIMEOUT',
  );
  expect(t.transport).toHaveBeenCalledTimes(121);
  expect(t.sleep).toHaveBeenCalledTimes(119);
});
it.each([
  [
    { mapping: true },
    'stage=deal; sync=succeeded; error_code=DEAL_AMOUNT_MISMATCH',
  ],
  [
    { missingAssociation: true },
    'stage=deal; sync=succeeded; error_code=CONTACT_ASSOCIATION_MISSING',
  ],
  [
    { searchDuplicate: true },
    'stage=uniqueness; sync=succeeded; error_code=DUPLICATE_REMOTE_DEALS',
  ],
] as const)(
  'reports specific verification failure after successful sync %j',
  async (options, expected) => {
    const t = setup(options);
    expect(await t.run()).toBe(1);
    expect(t.error.mock.calls[0][0]).toContain(expected);
  },
);
it('allows bounded CRM search indexing lag', async () => {
  const t = setup({ searchLag: 2 });
  expect(await t.run()).toBe(0);
  expect(t.sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
});
it('distinguishes search visibility timeout from failed order', async () => {
  const t = setup({ searchLag: 99 });
  expect(await t.run()).toBe(1);
  expect(t.error.mock.calls[0][0]).toContain(
    'sync=succeeded; error_code=SEARCH_NOT_VISIBLE',
  );
  expect(t.sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000]);
});
it('withholds arbitrary transport exceptions', async () => {
  const t = setup({ rawError: true });
  expect(await t.run()).toBe(1);
  expect(t.error.mock.calls[0][0]).toContain('error_code=SMOKE_REQUEST_FAILED');
  expect(t.error.mock.calls[0][0]).not.toMatch(/fake-private-token|@/);
});

it('reports missing persisted IDs on an otherwise successful attempt', async () => {
  const t = setup({ missingIds: true });
  expect(await t.run()).toBe(1);
  expect(t.error.mock.calls[0][0]).toContain(
    'sync=succeeded; error_code=MISSING_SAVED_IDS',
  );
});
it('retains webhook HTTP status when a proxy returns non-JSON', async () => {
  const error = vi.fn();
  const result = await runSmoke(env, 'ORD-TEST', {
    transport: vi.fn(
      async () => new Response('upstream unavailable', { status: 502 }),
    ),
    error,
  });
  expect(result).toBe(1);
  expect(error.mock.calls[0][0]).toContain(
    'error_code=WEBHOOK_HTTP_502. Webhook rejected: HTTP 502',
  );
});
