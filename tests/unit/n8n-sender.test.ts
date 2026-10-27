import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
it('n8n sender signs the exact fixture bytes and supports an explicit webhook URL', async () => {
  const original = [...process.argv];
  vi.stubEnv('WEBHOOK_SECRET', 'synthetic-sender-secret');
  process.argv = [
    'node',
    'send-n8n-webhook',
    'http://localhost:5678/webhook-test/optima-orders',
    'N8N-SENDER-TEST',
  ];
  const transport = vi.fn(async (_url: URL, init: RequestInit) => {
    const body = String(init.body);
    expect(JSON.parse(body).order_id).toBe('N8N-SENDER-TEST');
    expect(JSON.parse(body).items[0].quantity).toBe(2);
    expect((init.headers as Record<string, string>)['X-Order-Signature']).toBe(
      'sha256=' +
        createHmac('sha256', 'synthetic-sender-secret')
          .update(body)
          .digest('hex'),
    );
    return new Response('{"success":true,"deal_id":"synthetic-withheld"}');
  });
  vi.stubGlobal('fetch', transport);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await import('../../scripts/send-n8n-webhook.js');
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      'http://localhost:5678/webhook-test/optima-orders',
    );
    expect(log).toHaveBeenCalledWith('n8n webhook HTTP 200');
  } finally {
    process.argv = original;
    vi.unstubAllEnvs();
  }
});
