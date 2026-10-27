import { vi } from 'vitest';
export const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
export function stub(
  options: {
    existing?: boolean;
    lost?: boolean;
    associationFail?: boolean;
    contactConflict?: boolean;
    remoteDeal?: boolean;
    dealConflict?: boolean;
  } = {},
) {
  let deal = options.remoteDeal ?? false,
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
        if (options.dealConflict) return json({}, 409);
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
export const settings = {
  token: 'not-real',
  pipeline: 'default',
  stage: 'closedwon',
  phpConfirmed: true,
};
