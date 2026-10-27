import { it, expect } from 'vitest';
import { parseOrder, canonical } from '../../apps/api/src/order.js';
import { sample } from '../fixtures/order.js';
it('rejects nonfinite money at the schema boundary', () => {
  for (const total of [NaN, Infinity, -Infinity])
    expect(() => parseOrder({ ...sample, total })).toThrow();
});
it('accepts zero PHP totals and exact minor-unit arithmetic', () => {
  expect(
    parseOrder({
      ...sample,
      items: [{ name: 'Free', quantity: 1, price: 0 }],
      total: 0,
    }).total,
  ).toBe(0);
  expect(
    parseOrder({
      ...sample,
      items: [{ name: 'Fraction', quantity: 3, price: 0.1 }],
      total: 0.3,
    }).total,
  ).toBe(0.3);
});
it('canonicalizes normalized values and key order while preserving original timestamp instant', () => {
  const order = parseOrder(sample);
  expect(
    canonical(parseOrder(Object.fromEntries(Object.entries(sample).reverse()))),
  ).toBe(canonical(order));
  expect(order.customer.email).toBe('test@example.invalid');
  expect(order.created_at).toBe(sample.created_at);
});
