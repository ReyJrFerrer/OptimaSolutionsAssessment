import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.js';
import { HubSpotClient } from '../src/hubspot.js';
import { processOne } from '../src/worker.js';
import { parseOrder } from '../src/order.js';
import { sample } from './fixture.js';
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe('persistent worker with stubbed HubSpot', () => {
  it('restarts queued and interrupted jobs from a real database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optima-'));
    let store = new Store(join(dir, 'orders.sqlite'));
    try {
      store.reserve(parseOrder(sample));
      store.close();
      store = new Store(join(dir, 'orders.sqlite'));
      const interrupted = store.claim(Date.now() - 600001)!;
      store.saveIds(interrupted, 'c-stub', 'd-stub');
      store.close();
      store = new Store(join(dir, 'orders.sqlite'));
      await processOne(store, {
        sync: async (_order, save) => save('c-stub', 'd-stub'),
      });
      expect(store.get(sample.order_id)!.status).toBe('succeeded');
      expect(store.attempts(50).map((a) => a.status)).toEqual([
        'succeeded',
        'failed',
      ]);
      expect(store.attempts(50)[1].hubspot_deal_id).toBe('d-stub');
    } finally {
      store.close();
      rmSync(dir, { recursive: true });
    }
  });
  it('contact success / deal outage persists IDs; retry reuses contact, keeps audit, creates one deal', async () => {
    const store = new Store(':memory:');
    let contact = false,
      deal = false,
      outage = true,
      creates = 0;
    const transport: typeof fetch = async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      if (path.includes('/crm/properties/'))
        return reply({
          name: 'external_order_id',
          type: 'string',
          fieldType: 'text',
          hasUniqueValue: true,
        });
      if (path.includes('/crm/pipelines/'))
        return reply({ stages: [{ id: 'closedwon' }] });
      if (path.endsWith('/contacts/search'))
        return reply({ results: contact ? [{ id: 'contact-stub' }] : [] });
      if (path.endsWith('/contacts') && method === 'POST') {
        contact = true;
        return reply({ id: 'contact-stub' });
      }
      if (path.includes('/contacts/') && method === 'PATCH')
        return reply({ id: 'contact-stub' });
      if (path.includes('idProperty=external_order_id'))
        return deal ? reply({ id: 'deal-stub' }) : reply({}, 404);
      if (path.endsWith('/deals') && method === 'POST') {
        if (outage) return reply({ message: 'private@example.invalid' }, 503);
        creates++;
        deal = true;
        return reply({ id: 'deal-stub' });
      }
      if (path.includes('/associations/')) return reply({});
      throw Error('Unexpected path');
    };
    try {
      store.reserve(parseOrder(sample));
      const client = new HubSpotClient(
        {
          token: 'fake',
          pipeline: 'default',
          stage: 'closedwon',
          phpConfirmed: true,
        },
        transport,
        async () => {},
      );
      await processOne(store, client);
      expect(store.get(sample.order_id)).toMatchObject({
        status: 'failed',
        hubspot_contact_id: 'contact-stub',
        hubspot_deal_id: null,
      });
      const failed = store.attempts(50)[0];
      expect(failed.error_message).not.toContain('@');
      outage = false;
      store.retry(sample.order_id);
      await processOne(store, client);
      expect(store.get(sample.order_id)!.status).toBe('succeeded');
      expect(creates).toBe(1);
      expect(store.attempts(50)[1]).toEqual({
        ...failed,
        current_order_state: 'succeeded',
      });
    } finally {
      store.close();
    }
  });
  it('refuses to sync without a verified remote unique property', async () => {
    const methods: string[] = [];
    const transport: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return reply({
        name: 'external_order_id',
        type: 'string',
        fieldType: 'text',
        hasUniqueValue: false,
      });
    };
    await expect(
      new HubSpotClient(
        {
          token: 'fake',
          pipeline: 'default',
          stage: 'closedwon',
          phpConfirmed: true,
        },
        transport,
      ).sync(parseOrder(sample), () => {}),
    ).rejects.toThrow('UNIQUE_PROPERTY_REQUIRED');
    expect(methods).toEqual(['GET']);
  });
});
