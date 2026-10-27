import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw Error('WEBHOOK_SECRET is required');
const url = new URL(
  process.argv[2] ?? 'http://localhost:5678/webhook-test/optima-orders',
);
if (!['http:', 'https:'].includes(url.protocol))
  throw Error('HTTP webhook URL required');
const order = JSON.parse(
  readFileSync(
    new URL('../n8n/fixtures/sample-order.json', import.meta.url),
    'utf8',
  ),
);
order.order_id = process.argv[3] ?? order.order_id;
if (!/^N8N-[A-Za-z0-9_-]{1,180}$/.test(order.order_id))
  throw Error('Use an explicitly labeled N8N- test order ID');
const body = JSON.stringify(order);
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Order-Signature':
      'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
  },
  body,
  signal: AbortSignal.timeout(600000),
});
// Do not print CRM IDs or arbitrary upstream response text.
console.log(`n8n webhook HTTP ${response.status}`);
if (!response.ok) process.exitCode = 1;
