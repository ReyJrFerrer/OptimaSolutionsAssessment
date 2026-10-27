import { readFileSync } from 'node:fs';
import { it, expect, vi } from 'vitest';
import request from 'supertest';
import { parseOrder } from '../../apps/api/src/order.js';
import { createApp } from '../../apps/api/src/app.js';
import { processOne } from '../../apps/api/src/worker.js';
import { HubSpotClient } from '../../apps/api/src/hubspot.js';
import { database } from '../helpers/test-database.js';
import { stub, settings } from '../helpers/mock-hubspot.js';
import { sign, secret, admin } from '../helpers/webhook-signer.js';
const sample = JSON.parse(
  readFileSync(
    new URL('../fixtures/sample-order.json', import.meta.url),
    'utf8',
  ),
);
it('maps assessment order exactly, normalizes lookup and UTC, never clears absent phone', async () => {
  const { transport, calls } = stub();
  const save = vi.fn();
  await new HubSpotClient(settings, transport, async () => {}).sync(
    parseOrder({
      ...sample,
      customer: { ...sample.customer, email: ' MARIA.SANTOS@example.com ' },
    }),
    save,
  );
  expect(calls.find((c) => c.path.endsWith('/contacts/search'))!.body).toEqual({
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'email',
            operator: 'EQ',
            value: 'maria.santos@example.com',
          },
        ],
      },
    ],
    limit: 1,
  });
  expect(
    calls.find((c) => c.path.endsWith('/contacts') && c.method === 'POST')!
      .body,
  ).toEqual({
    properties: {
      email: 'maria.santos@example.com',
      firstname: 'Maria',
      lastname: 'Santos',
    },
  });
  expect(calls.find((c) => c.method === 'PATCH')!.body).not.toHaveProperty(
    'properties.phone',
  );
  expect(
    calls.find((c) => c.path.endsWith('/deals') && c.method === 'POST')!.body,
  ).toMatchObject({
    properties: {
      dealname: 'Order ORD-10482 — Maria Santos',
      amount: '900.00',
      deal_currency_code: 'PHP',
      pipeline: 'default',
      dealstage: 'closedwon',
      closedate: '2026-09-20T12:00:00.000Z',
      external_order_id: 'ORD-10482',
    },
    associations: [
      {
        to: { id: 'c-test' },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 },
        ],
      },
    ],
  });
  expect(save).toHaveBeenLastCalledWith('c-test', 'd-test');
});
it.each([{ remoteDeal: true }, { dealConflict: true }])(
  'reconciles remote unique Deal and repairs association %j',
  async (options) => {
    const { transport, calls } = stub(options);
    await new HubSpotClient(settings, transport, async () => {}).sync(
      parseOrder(sample),
      () => {},
    );
    expect(
      calls.filter((c) => c.path.endsWith('/deals') && c.method === 'POST'),
    ).toHaveLength(options.remoteDeal ? 0 : 1);
    expect(
      calls
        .filter((c) => c.path.includes('idProperty=external_order_id'))
        .every((c) => c.path.includes('ORD-10482')),
    ).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  },
);
it('concurrent and sequential HTTP duplicates produce one attempt and one remote Deal', async () => {
  const db = database();
  try {
    const app = createApp(db.store, secret, admin);
    const raw = JSON.stringify(sample);
    const send = () =>
      request(app)
        .post('/api/webhooks/orders')
        .set('Content-Type', 'application/json')
        .set('X-Order-Signature', sign(raw))
        .send(raw);
    const replies = await Promise.all(Array.from({ length: 10 }, send));
    expect(replies.filter((r) => r.status === 202)).toHaveLength(1);
    const { transport, calls } = stub();
    const client = new HubSpotClient(settings, transport, async () => {});
    expect(
      await Promise.all([
        processOne(db.store, client),
        processOne(db.store, client),
      ]),
    ).toEqual([true, false]);
    expect((await send()).body).toMatchObject({
      duplicate: true,
      status: 'succeeded',
    });
    expect(await processOne(db.store, client)).toBe(false);
    expect(
      calls.filter((c) => c.path.endsWith('/deals') && c.method === 'POST'),
    ).toHaveLength(1);
    expect(db.store.attempts(50)).toHaveLength(1);
  } finally {
    db.cleanup();
  }
});
it('different orders reuse an existing Contact and create distinct Deals', async () => {
  const db = database();
  try {
    const deals = new Map<string, string>();
    let creates = 0;
    const mock = stub({ existing: true });
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('idProperty=external_order_id')) {
        const id = decodeURIComponent(url.split('/').at(-1)!.split('?')[0]);
        return new Response(
          JSON.stringify(deals.has(id) ? { id: deals.get(id) } : {}),
          { status: deals.has(id) ? 200 : 404 },
        );
      }
      if (url.endsWith('/deals') && init?.method === 'POST') {
        const id = JSON.parse(String(init.body)).properties.external_order_id;
        const deal = 'deal-' + ++creates;
        deals.set(id, deal);
        return new Response(JSON.stringify({ id: deal }));
      }
      return mock.transport(input, init);
    };
    const client = new HubSpotClient(settings, transport, async () => {});
    for (const order_id of ['ORDER-A', 'ORDER-B']) {
      db.store.reserve(parseOrder({ ...sample, order_id }));
      await processOne(db.store, client);
    }
    expect(creates).toBe(2);
    expect(
      db.store
        .attempts(50)
        .every(
          (a) => a.hubspot_contact_id === 'c-test' && a.status === 'succeeded',
        ),
    ).toBe(true);
    expect(
      new Set(db.store.attempts(50).map((a) => a.hubspot_deal_id)).size,
    ).toBe(2);
    expect(
      mock.calls.some(
        (c) => c.path.endsWith('/contacts') && c.method === 'POST',
      ),
    ).toBe(false);
  } finally {
    db.cleanup();
  }
});
it('remote success then local save failure reconciles on manual retry with immutable original', async () => {
  const db = database();
  try {
    db.store.reserve(parseOrder(sample));
    const { transport, calls } = stub();
    const client = new HubSpotClient(settings, transport, async () => {});
    const original = db.store.saveIds.bind(db.store);
    let failed = false;
    vi.spyOn(db.store, 'saveIds').mockImplementation((job, contact, deal) => {
      if (deal && !failed) {
        failed = true;
        throw Error('disk write failed private');
      }
      original(job, contact, deal);
    });
    await processOne(db.store, client);
    expect(db.store.get(sample.order_id)!.status).toBe('failed');
    const first = db.store.attempts(50)[0];
    const originalPayload = db.store.get(sample.order_id)!.payload_json;
    const app = createApp(db.store, secret, admin);
    const retry = () =>
      request(app)
        .post('/api/orders/ORD-10482/retry')
        .set('Authorization', 'Bearer ' + admin)
        .send({ total: 1 });
    expect(
      (await request(app).post('/api/orders/ORD-10482/retry')).status,
    ).toBe(401);
    expect(
      (await Promise.all([retry(), retry()])).map((r) => r.status).sort(),
    ).toEqual([202, 409]);
    await processOne(db.store, client);
    expect((await retry()).status).toBe(409);
    expect(db.store.get(sample.order_id)!.payload_json).toBe(originalPayload);
    expect(db.store.attempts(50)[0].status).toBe('succeeded');
    expect(db.store.attempts(50)[1]).toEqual({
      ...first,
      current_order_state: 'succeeded',
    });
    expect(
      calls.filter((c) => c.path.endsWith('/deals') && c.method === 'POST'),
    ).toHaveLength(1);
  } finally {
    db.cleanup();
  }
});
it('returns exact latest 50 of 65 attempts with equal timestamps and rejects retries in active states', async () => {
  const db = database();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    const app = createApp(db.store, secret, admin);
    db.store.reserve(parseOrder(sample));
    const retry = () =>
      request(app)
        .post('/api/orders/ORD-10482/retry')
        .set('Authorization', 'Bearer ' + admin);
    expect((await retry()).status).toBe(409);
    for (let i = 1; i <= 65; i++) {
      const job = db.store.claim()!;
      if (i === 1) expect((await retry()).status).toBe(409);
      db.store.saveIds(job, 'c-test', 'd-test');
      db.store.finish(
        job,
        i === 65 ? 'succeeded' : 'failed',
        i === 65 ? null : 'TEST',
        i === 65 ? null : 'Safe failure',
      );
      if (i < 65) db.store.retry(sample.order_id);
    }
    const r = await request(app)
      .get('/api/sync-attempts?limit=999')
      .set('Authorization', 'Bearer ' + admin);
    expect(r.status).toBe(200);
    expect(
      r.body.map((a: { attempt_number: number }) => a.attempt_number),
    ).toEqual(Array.from({ length: 50 }, (_, i) => 65 - i));
    expect(r.body[0]).toMatchObject({
      status: 'succeeded',
      hubspot_contact_id: 'c-test',
      hubspot_deal_id: 'd-test',
      error_message: null,
    });
    expect(r.body[1].error_message).toBe('Safe failure');
    expect(JSON.stringify(r.body)).not.toContain('maria');
    for (const limit of ['0', '-1', 'foo', '1.5'])
      expect(
        (
          await request(app)
            .get('/api/sync-attempts?limit=' + limit)
            .set('Authorization', 'Bearer ' + admin)
        ).status,
      ).toBe(400);
  } finally {
    db.cleanup();
  }
});

it('two SQLite connections cannot reserve or claim the same order twice', async () => {
  const db = database();
  const { Store } = await import('../../apps/api/src/db/store.js');
  const other = new Store(db.path);
  try {
    expect(db.store.reserve(parseOrder(sample)).duplicate).toBe(false);
    expect(other.reserve(parseOrder(sample)).duplicate).toBe(true);
    expect(db.store.claim()).toBeDefined();
    expect(other.claim()).toBeUndefined();
    expect(other.attempts(50)).toHaveLength(1);
  } finally {
    other.close();
    db.cleanup();
  }
});
it('terminal database outage leaves lease recoverable and reconciles remote success', async () => {
  const db = database();
  try {
    db.store.reserve(parseOrder(sample));
    const { transport, calls } = stub();
    const client = new HubSpotClient(settings, transport, async () => {});
    const finish = vi.spyOn(db.store, 'finish').mockImplementation(() => {
      throw Error('database unavailable');
    });
    await expect(processOne(db.store, client)).rejects.toThrow(
      'database unavailable',
    );
    expect(db.store.get(sample.order_id)!.status).toBe('processing');
    finish.mockRestore();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    await processOne(db.store, client);
    expect(db.store.attempts(50).map((a) => a.status)).toEqual([
      'succeeded',
      'failed',
    ]);
    expect(
      calls.filter((c) => c.path.endsWith('/deals') && c.method === 'POST'),
    ).toHaveLength(1);
  } finally {
    db.cleanup();
  }
});
