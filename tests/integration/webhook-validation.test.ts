import { it, expect, vi } from 'vitest';
import request from 'supertest';
import { sample } from '../fixtures/order.js';
import { database } from '../helpers/test-database.js';
import { sign, secret, admin } from '../helpers/webhook-signer.js';
import { createApp } from '../../apps/api/src/app.js';
const invalid: [string, unknown][] = [
  ['missing fields', {}],
  ['email', { ...sample, customer: { ...sample.customer, email: 'bad' } }],
  ['negative total', { ...sample, total: -1 }],
  ['currency', { ...sample, currency: 'USD' }],
  ['short currency', { ...sample, currency: 'PH' }],
  ['event', { ...sample, event: 'order.updated' }],
  ['empty items', { ...sample, items: [] }],
  ['total', { ...sample, total: 99 }],
  ...[0, -1, 1.5].map(
    (quantity) =>
      [
        'quantity ' + quantity,
        { ...sample, items: [{ name: 'x', quantity, price: 10 }] },
      ] as [string, unknown],
  ),
  ...[-1, 0.001, 1e100].map(
    (price) =>
      [
        'price ' + price,
        { ...sample, items: [{ name: 'x', quantity: 1, price }] },
      ] as [string, unknown],
  ),
  ['date without zone', { ...sample, created_at: '2026-09-20T12:00:00' }],
];
it.each(invalid)(
  'rejects authenticated invalid %s without reservation',
  async (_name, body) => {
    const db = database();
    try {
      const reserve = vi.spyOn(db.store, 'reserve');
      const raw = JSON.stringify(body);
      const r = await request(createApp(db.store, secret, admin))
        .post('/api/webhooks/orders')
        .set('Content-Type', 'application/json')
        .set('X-Order-Signature', sign(raw))
        .send(raw);
      expect(r.status).toBe(400);
      expect(reserve).not.toHaveBeenCalled();
      expect(db.store.attempts(50)).toEqual([]);
    } finally {
      db.cleanup();
    }
  },
);
it('rejects wrong secret and missing signature; signed malformed JSON is 400', async () => {
  const db = database();
  try {
    const app = createApp(db.store, secret, admin);
    for (const signature of [sign('{', 'wrong'), '']) {
      expect(
        (
          await request(app)
            .post('/api/webhooks/orders')
            .set('Content-Type', 'application/json')
            .set('X-Order-Signature', signature)
            .send('{')
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await request(app)
          .post('/api/webhooks/orders')
          .set('Content-Type', 'application/json')
          .set('X-Order-Signature', sign('{'))
          .send('{')
      ).body,
    ).toEqual({ error: 'INVALID_JSON' });
    expect(db.store.get(sample.order_id)).toBeUndefined();
  } finally {
    db.cleanup();
  }
});
it('returns safe 500 on reservation failure so delivery can retry', async () => {
  const db = database();
  try {
    vi.spyOn(db.store, 'reserve').mockImplementation(() => {
      throw Error('private token');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify(sample);
    const r = await request(createApp(db.store, secret, admin))
      .post('/api/webhooks/orders')
      .set('Content-Type', 'application/json')
      .set('X-Order-Signature', sign(raw))
      .send(raw);
    expect(r.status).toBe(500);
    expect(
      JSON.stringify(r.body) + JSON.stringify(log.mock.calls),
    ).not.toContain('private');
  } finally {
    db.cleanup();
  }
});
