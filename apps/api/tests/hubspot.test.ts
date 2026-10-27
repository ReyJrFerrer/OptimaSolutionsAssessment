import { describe, it, expect, vi } from 'vitest';
import { HubSpotClient, HubSpotError } from '../src/hubspot.js';
import { parseOrder } from '../src/order.js';
import { sample } from './fixture.js';
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
function stub(
  options: {
    existing?: boolean;
    lost?: boolean;
    associationFail?: boolean;
    contactConflict?: boolean;
  } = {},
) {
  let deal = false,
    assocFails = options.associationFail;
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const transport = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('https://api.hubapi.com', ''),
        method = init?.method ?? 'GET',
        body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ path, method, body });
      if (path.includes('/crm/properties/'))
        return json({
          name: 'external_order_id',
          type: 'string',
          fieldType: 'text',
          hasUniqueValue: true,
        });
      if (path.includes('/crm/pipelines/'))
        return json({ stages: [{ id: 'closedwon' }] });
      if (path.includes('/contacts/search'))
        return json({ results: options.existing ? [{ id: 'c-test' }] : [] });
      if (path.includes('/contacts/') && method === 'GET')
        return json({ id: 'c-test' });
      if (path.endsWith('/contacts') && method === 'POST')
        return options.contactConflict ? json({}, 409) : json({ id: 'c-test' });
      if (path.includes('/contacts/') && method === 'PATCH')
        return json({ id: 'c-test' });
      if (path.includes('/deals/') && method === 'GET')
        return deal ? json({ id: 'd-test' }) : json({}, 404);
      if (path.endsWith('/deals') && method === 'POST') {
        deal = true;
        if (options.lost) throw new Error('response lost');
        return json({ id: 'd-test' });
      }
      if (path.includes('/associations/')) {
        if (assocFails) {
          assocFails = false;
          return json({}, 400);
        }
        return json({});
      }
      throw Error('Unexpected route ' + path);
    },
  );
  return { transport, calls };
}
const settings = {
  token: 'not-real',
  pipeline: 'default',
  stage: 'closedwon',
  phpConfirmed: true,
};
describe('HubSpot transport and mapping', () => {
  it('updates existing contact and creates associated mapped Deal once', async () => {
    const { transport, calls } = stub({ existing: true });
    const c = new HubSpotClient(settings, transport, async () => {});
    const save = vi.fn();
    await c.sync(parseOrder(sample), save);
    await c.sync(parseOrder(sample), save);
    expect(
      calls.filter((x) => x.method === 'POST' && x.path.endsWith('/deals')),
    ).toHaveLength(1);
    expect(calls.some((x) => x.method === 'PATCH')).toBe(true);
    expect(calls.find((x) => x.path.endsWith('/deals'))!.body).toMatchObject({
      properties: {
        amount: '20.50',
        external_order_id: 'TEST-1',
        pipeline: 'default',
        dealstage: 'closedwon',
        deal_currency_code: 'PHP',
      },
      associations: [{ to: { id: 'c-test' } }],
    });
    expect(save).toHaveBeenCalledWith('c-test', 'd-test');
    expect(
      calls
        .filter((x) => x.path.includes('/associations/'))
        .every(
          (x) =>
            x.path ===
              '/crm/objects/2026-09/deals/d-test/associations/default/contacts/c-test' &&
            x.method === 'PUT',
        ),
    ).toBe(true);
  });
  it('reconciles lost create response using unique key before another create', async () => {
    const { transport, calls } = stub({ lost: true });
    await new HubSpotClient(settings, transport, async () => {}).sync(
      parseOrder(sample),
      () => {},
    );
    expect(
      calls.filter((x) => x.method === 'POST' && x.path.endsWith('/deals')),
    ).toHaveLength(1);
  });
  it('repairs association on manual retry without creating another Deal', async () => {
    const { transport, calls } = stub({
      associationFail: true,
      existing: true,
    });
    const c = new HubSpotClient(settings, transport, async () => {});
    await expect(c.sync(parseOrder(sample), () => {})).rejects.toThrow();
    await c.sync(parseOrder(sample), () => {});
    expect(
      calls.filter((x) => x.method === 'POST' && x.path.endsWith('/deals')),
    ).toHaveLength(1);
  });
  it('recovers contact conflict through direct email read', async () => {
    const { transport } = stub({ contactConflict: true });
    await expect(
      new HubSpotClient(settings, transport, async () => {}).sync(
        parseOrder(sample),
        () => {},
      ),
    ).resolves.toBeUndefined();
  });
  it.each([429, 500])('retries %s and honors Retry-After', async (status) => {
    const sleep = vi.fn(async (_ms: number) => {});
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({}, status, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(json({ id: 'ok' }));
    const c = new HubSpotClient(settings, transport, sleep);
    await c.request('/test');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(3000);
  });
  it.each([400, 401, 503])(
    'bounds requests and sanitizes %s',
    async (status) => {
      const transport = vi.fn(async () =>
        json(
          {
            message: 'secret email@example.invalid',
            correlationId: 'fake-correlation',
          },
          status,
        ),
      );
      const c = new HubSpotClient(settings, transport, async () => {});
      try {
        await c.request('/test');
        expect.fail('must fail');
      } catch (e) {
        expect(e).toBeInstanceOf(HubSpotError);
        expect((e as Error).message).not.toContain('@');
      }
      expect(transport).toHaveBeenCalledTimes(status === 503 ? 4 : 1);
    },
  );
  it('keeps actionable allowlisted validation codes without upstream PII', async () => {
    const transport = vi.fn(async () =>
      json(
        {
          message: 'Email private@example.invalid is invalid',
          errors: [
            { code: 'INVALID_EMAIL', message: 'private@example.invalid' },
          ],
        },
        400,
      ),
    );
    const c = new HubSpotClient(settings, transport, async () => {});
    await expect(c.request('/test')).rejects.toThrow('INVALID_EMAIL');
  });
  it('refuses writes until currency is confirmed', async () => {
    const transport = vi.fn();
    await expect(
      new HubSpotClient({ ...settings, phpConfirmed: false }, transport).sync(
        parseOrder(sample),
        () => {},
      ),
    ).rejects.toThrow('PHP');
    expect(transport).not.toHaveBeenCalled();
  });
});
