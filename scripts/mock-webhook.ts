import { createHmac } from 'node:crypto';
const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw Error('WEBHOOK_SECRET is required');
const orderId = process.argv[2] ?? 'ORD-10482';
const body = JSON.stringify({
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
});
const response = await fetch(
  `http://127.0.0.1:${process.env.PORT ?? 3001}/api/webhooks/orders`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Order-Signature':
        'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
    signal: AbortSignal.timeout(10000),
  },
);
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
