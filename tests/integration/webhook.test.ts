import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { createHmac } from 'node:crypto';
import { Store } from '../../apps/api/src/db/store.js';
import { createApp } from '../../apps/api/src/app.js';
import { parseOrder } from '../../apps/api/src/order.js';
import { processOne } from '../../apps/api/src/worker.js';

import { sample } from '../fixtures/order.js';
const stores: Store[] = [];
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  return { store, app: createApp(store, 's'.repeat(32), 'a'.repeat(32)) };
}
function send(app: ReturnType<typeof createApp>, body = sample) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/webhooks/orders')
    .set('Content-Type', 'application/json')
    .set(
      'X-Order-Signature',
      'sha256=' +
        createHmac('sha256', 's'.repeat(32)).update(raw).digest('hex'),
    )
    .send(raw);
}
afterEach(() => stores.splice(0).forEach((s) => s.close()));
describe('signed durable ingress', () => {
  it('accepts a signed order and normalizes email', async () => {
    const { app, store } = setup();
    expect((await send(app)).status).toBe(202);
    expect(JSON.parse(store.get('TEST-1')!.payload_json).customer.email).toBe(
      'test@example.invalid',
    );
  });
  it('rejects missing, malformed and tampered signatures before JSON parsing', async () => {
    const { app, store } = setup();
    for (const signature of ['', 'sha256=abc', 'sha256=' + '0'.repeat(64)])
      expect(
        (
          await request(app)
            .post('/api/webhooks/orders')
            .set('Content-Type', 'application/json')
            .set('X-Order-Signature', signature)
            .send('{bad')
        ).status,
      ).toBe(401);
    expect(store.get('TEST-1')).toBeUndefined();
  });
  it('rejects compressed bodies rather than verifying decompressed bytes', async () => {
    const { app, store } = setup();
    const raw = JSON.stringify(sample);
    const response = await request(app)
      .post('/api/webhooks/orders')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .set(
        'X-Order-Signature',
        'sha256=' +
          createHmac('sha256', 's'.repeat(32)).update(raw).digest('hex'),
      )
      .send(gzipSync(raw));
    expect(response.status).toBe(415);
    expect(store.get(sample.order_id)).toBeUndefined();
  });
  it('checks original UTF-8 bytes and canonicalizes JSON key order', async () => {
    const { app } = setup();
    const body = {
      ...sample,
      customer: { ...sample.customer, first_name: 'José' },
    };
    const raw = JSON.stringify(body, null, 2);
    const signature =
      'sha256=' +
      createHmac('sha256', 's'.repeat(32)).update(raw).digest('hex');
    expect(
      (
        await request(app)
          .post('/api/webhooks/orders')
          .set('Content-Type', 'application/json')
          .set('X-Order-Signature', signature)
          .send(raw + ' ')
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/webhooks/orders')
          .set('Content-Type', 'application/json')
          .set('X-Order-Signature', signature)
          .send(raw)
      ).status,
    ).toBe(202);
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect((await send(app, reordered as typeof sample)).body.duplicate).toBe(
      true,
    );
  });
  it('rejects authenticated invalid payload and totals', async () => {
    const { app } = setup();
    for (const body of [
      { ...sample, total: 1 },
      { ...sample, event: 'other' },
      { ...sample, items: [] },
      { ...sample, items: [{ name: 'x', quantity: 1, price: 0.001 }] },
    ])
      expect((await send(app, body as typeof sample)).status).toBe(400);
  });
  it('rejects malformed signed JSON and oversized body', async () => {
    const { app } = setup();
    const raw = '{';
    expect(
      (
        await request(app)
          .post('/api/webhooks/orders')
          .set('Content-Type', 'application/json')
          .set(
            'X-Order-Signature',
            'sha256=' +
              createHmac('sha256', 's'.repeat(32)).update(raw).digest('hex'),
          )
          .send(raw)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/webhooks/orders')
          .set('Content-Type', 'application/json')
          .send('x'.repeat(270000))
      ).status,
    ).toBe(413);
  });
  it('reserves once under concurrent and sequential deliveries; conflicts preserve original', async () => {
    const { app, store } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send(app)),
    );
    expect(results.every((r) => [200, 202].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.body.duplicate).length).toBe(9);
    expect((await send(app)).body.duplicate).toBe(true);
    expect(
      (await send(app, { ...sample, created_at: '2026-09-21T00:00:00Z' }))
        .status,
    ).toBe(409);
    expect(store.get('TEST-1')!.status).toBe('queued');
    expect(JSON.parse(store.get('TEST-1')!.payload_json).created_at).toBe(
      sample.created_at,
    );
    expect(store.claim()).toBeDefined();
    expect(store.claim()).toBeUndefined();
  });
  it('protects dashboard/retry and persists separate immutable attempts', async () => {
    const { app, store } = setup();
    await send(app);
    expect((await request(app).get('/api/sync-attempts')).status).toBe(401);
    const fail = {
      sync: vi
        .fn()
        .mockRejectedValue(
          new Error('private customer@example.invalid secret'),
        ),
    };
    await processOne(store, fail);
    const first = store.attempts(50)[0];
    expect(first.error_message).not.toContain('@');
    expect(
      (
        await request(app)
          .post('/api/orders/TEST-1/retry')
          .set('Authorization', 'Bearer ' + 'a'.repeat(32))
      ).status,
    ).toBe(202);
    expect(
      (
        await request(app)
          .post('/api/orders/TEST-1/retry')
          .set('Authorization', 'Bearer ' + 'a'.repeat(32))
      ).status,
    ).toBe(409);
    await processOne(store, {
      sync: async (_o, save) => {
        save('contact-test', 'deal-test');
      },
    });
    expect(store.attempts(50)).toHaveLength(2);
    expect(store.attempts(50)[1]).toEqual({
      ...first,
      current_order_state: 'succeeded',
    });
    expect(store.get('TEST-1')!.status).toBe('succeeded');
  });
  it('recovers expired processing leases and keeps interrupted attempt', () => {
    const { store } = setup();
    store.reserve(parseOrder(sample));
    store.claim(0);
    expect(store.claim(Date.now() + 600001)).toBeDefined();
    expect(store.attempts(50).map((a) => a.status)).toEqual([
      'processing',
      'failed',
    ]);
  });
  it('lists newest 50 attempts, including repeated orders', async () => {
    const { app, store } = setup();
    store.reserve(parseOrder(sample));
    for (let i = 0; i < 55; i++) {
      const job = store.claim()!;
      store.finish(job, 'failed', 'TEST', 'safe');
      store.retry('TEST-1');
    }
    const response = await request(app)
      .get('/api/sync-attempts?limit=100')
      .set('Authorization', 'Bearer ' + 'a'.repeat(32));
    expect(response.body).toHaveLength(50);
    expect(response.body[0].attempt_number).toBe(55);
    expect(response.body[0]).not.toHaveProperty('payload_json');
  });
});
