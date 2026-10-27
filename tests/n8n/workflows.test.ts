import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { parseOrder } from '../../apps/api/src/order.js';
// n8n items are dynamic JSON; this adapter executes the exported Code verbatim.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;
const load = (file: string) =>
  JSON.parse(
    readFileSync(new URL('../../n8n/' + file, import.meta.url), 'utf8'),
  );
const main = load('order-to-hubspot.json'),
  error = load('error-notification.json');
const sample = load('fixtures/sample-order.json');
async function execute(
  name: string,
  input: Item,
  previous?: Item,
  workflow = main,
): Promise<Item> {
  const source = workflow.nodes.find((n: Item) => n.name === name).parameters
    .jsCode;
  const result = await runInNewContext(
    '(async function(){' + source + '\n}).call(context)',
    {
      context: {},
      $input: { first: () => ({ json: input }) },
      $: () => ({ item: { json: previous } }),
      Buffer,
      structuredClone,
      require: (id: string) => {
        if (id !== 'crypto') throw Error('Unexpected module');
        return { timingSafeEqual };
      },
    },
  );
  return result[0].json;
}
async function validate(body = JSON.stringify(sample), signature?: string) {
  const expectedSignature = createHmac('sha256', 'synthetic-secret')
    .update(body)
    .digest('hex');
  return execute('Verify Signature and Validate Order', {
    raw: Buffer.from(body).toString('base64'),
    expectedSignature,
    headers: {
      'content-type': 'application/json',
      'x-order-signature': signature ?? 'sha256=' + expectedSignature,
    },
  });
}
function crm(options: Item = {}) {
  let deal = !!options.existingDeal,
    contact = !!options.existingContact;
  const calls: Item[] = [];
  return {
    calls,
    response(s: Item) {
      calls.push(structuredClone(s.request));
      const stage = s.stage;
      const ok = (body: Item = {}, statusCode = 200) => ({ statusCode, body });
      if (options.failStage === stage) return ok({}, options.status ?? 503);
      if (stage === 'property')
        return ok({
          name: 'external_order_id',
          type: 'string',
          fieldType: 'text',
          hasUniqueValue: options.unique !== false,
        });
      if (stage === 'pipeline') return ok({ stages: [{ id: 'closedwon' }] });
      if (stage === 'dealSearch')
        return ok({ results: deal ? [{ id: 'deal-synthetic' }] : [] });
      if (stage === 'dealLookup')
        return deal ? ok({ id: 'deal-synthetic' }) : ok({}, 404);
      if (stage === 'contactSearch')
        return ok({ results: contact ? [{ id: 'contact-synthetic' }] : [] });
      if (stage === 'contactLookup')
        return contact ? ok({ id: 'contact-synthetic' }) : ok({}, 404);
      if (stage === 'contactCreate') {
        contact = true;
        return options.contactConflict
          ? ok({}, 409)
          : ok({ id: 'contact-synthetic' });
      }
      if (stage === 'contactUpdate') return ok({ id: 'contact-synthetic' });
      if (stage === 'dealCreate') {
        if (deal) return ok({}, 409);
        deal = true;
        return options.lost
          ? { error: 'SENSITIVE UPSTREAM' }
          : options.conflict
            ? ok({}, 409)
            : ok({ id: 'deal-synthetic' });
      }
      if (stage === 'associate') return ok();
      throw Error('Unexpected stage');
    },
  };
}
async function sync(mock = crm(), state?: Item) {
  let s = state ?? (await validate());
  s.config.phpConfirmed = true;
  for (let i = 0; i < 80; i++) {
    s = await execute('Plan HubSpot Request', s);
    if (s.done) return s;
    s = await execute('Handle HubSpot Result', mock.response(s), s);
    if (s.done) return s;
  }
  throw Error('Unbounded workflow loop');
}
it('exports complete connected built-in workflows with no embedded secrets or pinned execution data', () => {
  for (const w of [main, error]) {
    expect(w.active).toBe(false);
    expect(w.pinData).toEqual({});
    const names = w.nodes.map((n: Item) => n.name);
    for (const [name, c] of Object.entries(w.connections)) {
      expect(names).toContain(name);
      for (const outputs of (c as Item).main)
        for (const target of outputs) expect(names).toContain(target.node);
    }
    for (const n of w.nodes)
      for (const credential of Object.values(n.credentials ?? {}))
        expect((credential as Item).id).toMatch(/^CONFIGURE_/);
  }
  expect(main.settings.errorWorkflow).toBe('CONFIGURE_ERROR_WORKFLOW_ID');
  expect(
    main.nodes.find((n: Item) => n.name === 'Compute HMAC').typeVersion,
  ).toBe(2);
});
it('accepts exact formatted Unicode bytes and normalizes like backend', async () => {
  const p = {
    ...sample,
    customer: {
      ...sample.customer,
      first_name: ' José ',
      email: ' N8N.TEST@EXAMPLE.COM ',
    },
  };
  const result = await validate(JSON.stringify(p, null, 2));
  expect(JSON.stringify(result.order)).toBe(JSON.stringify(parseOrder(p)));
});
it.each([
  '',
  'sha256=' + '0'.repeat(64),
  'SHA256=' + 'a'.repeat(64),
  'sha256=bad',
])('rejects invalid signature %s before JSON parsing', async (sig) => {
  expect((await validate('{broken', sig)).http).toBe(401);
});
it('rejects bytes modified after signing', async () => {
  const body = JSON.stringify(sample);
  const signature =
    'sha256=' +
    createHmac('sha256', 'synthetic-secret').update(body).digest('hex');
  expect((await validate(body + ' ', signature)).http).toBe(401);
});
it('returns 400 for authenticated malformed JSON', async () =>
  expect((await validate('{bad')).http).toBe(400));
it.each([
  { event: 'other' },
  { currency: 'USD' },
  { total: 1 },
  { total: -1 },
  { created_at: '2026-02-30T12:00:00Z' },
  { items: [] },
  { items: [{ name: 'item', qty: 2, price: 450 }] },
  { customer: { email: 'bad', first_name: 'X', last_name: 'Y' } },
  { items: [{ name: 'item', quantity: 1, price: 0.001 }] },
  { created_at: 'yesterday' },
])('rejects invalid schema %j before CRM', async (patch) =>
  expect((await validate(JSON.stringify({ ...sample, ...patch }))).http).toBe(
    400,
  ),
);
it('creates mapped Contact and associated Deal', async () => {
  const mock = crm();
  const result = await sync(mock);
  expect(result.body.status).toBe('synced');
  const created = mock.calls.find(
    (r) => r.method === 'POST' && r.url.endsWith('/deals'),
  );
  expect(created?.body.properties).toMatchObject({
    amount: '900.00',
    dealname: 'Order N8N-ASSESSMENT-001 — N8N Assessment',
    closedate: '2026-09-20T12:00:00.000Z',
    external_order_id: sample.order_id,
    pipeline: 'default',
    dealstage: 'closedwon',
    deal_currency_code: 'PHP',
  });
  expect(created?.body.associations[0].types[0].associationTypeId).toBe(3);
  expect(mock.calls.at(-1)?.method).toBe('PUT');
});
it('sequential duplicate reuses Deal and repairs association', async () => {
  const mock = crm();
  await sync(mock);
  const second = await sync(mock);
  expect(second.body.duplicate).toBe(true);
  expect(
    mock.calls.filter((r) => r.method === 'POST' && r.url.endsWith('/deals')),
  ).toHaveLength(1);
  expect(mock.calls.filter((r) => r.method === 'PUT')).toHaveLength(2);
});
it('existing Contact is updated and missing phone never clears CRM data', async () => {
  const mock = crm({ existingContact: true });
  await sync(mock);
  expect(
    mock.calls.some((r) => r.method === 'POST' && r.url.endsWith('/contacts')),
  ).toBe(false);
  expect(
    mock.calls.find((r) => r.method === 'PATCH')?.body.properties,
  ).not.toHaveProperty('phone');
});
it.each([{ lost: true }, { conflict: true }, { contactConflict: true }])(
  'reconciles uncertain/conflicting creates %j',
  async (options) => {
    const mock = crm(options);
    expect((await sync(mock)).body.success).toBe(true);
    expect(
      mock.calls.filter((r) => r.method === 'POST' && r.url.endsWith('/deals')),
    ).toHaveLength(1);
  },
);
it('same Contact, different orders produce different external keys', async () => {
  const calls: Item[] = [];
  for (const order_id of ['N8N-ONE', 'N8N-TWO']) {
    const mock = crm({ existingContact: true });
    const s = await validate(JSON.stringify({ ...sample, order_id }));
    await sync(mock, s);
    calls.push(...mock.calls);
  }
  expect(
    calls
      .filter((r) => r.url.endsWith('/deals'))
      .map((r) => r.body.properties.external_order_id),
  ).toEqual(['N8N-ONE', 'N8N-TWO']);
});
it('failed association is repaired on a later delivery with existing Deal', async () => {
  const first = await sync(crm({ failStage: 'associate', status: 400 }));
  expect(first.failure).toBe(true);
  const mock = crm({ existingDeal: true, existingContact: true });
  expect((await sync(mock)).body.duplicate).toBe(true);
  expect(
    mock.calls.some((r) => r.method === 'POST' && r.url.endsWith('/deals')),
  ).toBe(false);
});
it.each([429, 500, 502, 503, 504])(
  'bounds transient HTTP %i retries',
  async (status) => {
    const mock = crm({ failStage: 'property', status });
    const result = await sync(mock);
    expect(result.http).toBe(502);
    expect(result.failure).toBe(true);
    expect(mock.calls).toHaveLength(4);
  },
);
it.each([400, 401, 403])('fails permanent HTTP %i promptly', async (status) => {
  const mock = crm({ failStage: 'property', status });
  await sync(mock);
  expect(mock.calls).toHaveLength(1);
});
it('honors Retry-After and recovers transient failure', async () => {
  const s = await validate();
  s.config.phpConfirmed = true;
  const planned = await execute('Plan HubSpot Request', s);
  const retry = await execute(
    'Handle HubSpot Result',
    { statusCode: 429, headers: { 'retry-after': '10' } },
    planned,
  );
  expect(retry.waitMs).toBe(10000);
  expect((await sync(crm(), retry)).body.success).toBe(true);
});
it('fails closed when currency or unique property is unconfirmed', async () => {
  expect(
    (await execute('Plan HubSpot Request', await validate())).body.error,
  ).toBe('PHP_CURRENCY_NOT_CONFIRMED');
  expect((await sync(crm({ unique: false }))).body.error).toBe(
    'UNIQUE_PROPERTY_REQUIRED',
  );
});
it('notifications allowlist details and exclude arbitrary upstream text', async () => {
  const output = await execute(
    'Sanitize Failure Details',
    {
      workflow: { name: main.name },
      execution: {
        id: 'synthetic-42',
        lastNodeExecuted: 'Raise Operational Failure',
        error: {
          message:
            'OPTIMA HUBSPOT_HTTP_503 order=N8N-TEST stage=associate; bearer-secret customer@example.com',
        },
      },
    },
    undefined,
    error,
  );
  expect(output.text).toContain('N8N-TEST');
  expect(output.text).toContain('HUBSPOT_HTTP_503');
  expect(output.text).not.toContain('bearer-secret');
  expect(output.text).not.toContain('customer@example.com');
});
it('unexpected failures redact message and tolerate missing execution metadata', async () => {
  const output = await execute(
    'Sanitize Failure Details',
    { trigger: { error: { message: 'secret@example.com TOKEN' } } },
    undefined,
    error,
  );
  expect(output.text).toContain('UNEXPECTED_EXECUTION_FAILURE');
  expect(output.text).not.toContain('secret@example.com');
});

it('concurrent deliveries reconcile against a unique fake remote key', async () => {
  const mock = crm();
  const results = await Promise.all([sync(mock), sync(mock)]);
  expect(results.every((r) => r.body.success)).toBe(true);
  expect(new Set(results.map((r) => r.body.deal_id)).size).toBe(1);
});
it('permanent create validation error reconciles once and never blindly repeats create', async () => {
  const mock = crm({ failStage: 'dealCreate', status: 400 });
  const result = await sync(mock);
  expect(result.body.error).toBe('CREATE_CONFLICT_UNRESOLVED');
  expect(
    mock.calls.filter((r) => r.method === 'POST' && r.url.endsWith('/deals')),
  ).toHaveLength(1);
});
it('applies the signed-body size limit', async () => {
  expect((await validate(' '.repeat(262145))).http).toBe(413);
});

it('receives HTTP responses as text so non-JSON errors retain their status', () => {
  const http = main.nodes.find((n: Item) => n.name === 'HubSpot Request');
  expect(http.parameters.options.response.response.responseFormat).toBe('text');
  expect(http.parameters.options.response.response.outputPropertyName).toBe(
    'body',
  );
});
it.each(['', 'Not Found'])(
  'handles a non-JSON Deal lookup 404 without a network retry: %j',
  async (body) => {
    const s = await validate();
    s.config.phpConfirmed = true;
    s.stage = 'dealLookup';
    const result = await execute(
      'Handle HubSpot Result',
      { statusCode: 404, body },
      s,
    );
    expect(result.stage).toBe('contactSearch');
    expect(result.retry).toBe(0);
  },
);
it('parses successful text JSON from HTTP Request', async () => {
  const s = await validate();
  s.config.phpConfirmed = true;
  const mock = crm();
  const planned = await execute('Plan HubSpot Request', s);
  const response: Item = mock.response(planned);
  response.body = JSON.stringify(response.body);
  const result = await execute('Handle HubSpot Result', response, planned);
  expect(result.stage).toBe('pipeline');
});
it('fails safely for malformed successful JSON while preserving non-JSON failure status', async () => {
  const s = await validate();
  s.config.phpConfirmed = true;
  const invalid = await execute(
    'Handle HubSpot Result',
    { statusCode: 200, body: '<html>upstream secret</html>' },
    s,
  );
  expect(invalid.body.error).toBe('HUBSPOT_INVALID_RESPONSE');
  const failure = await execute(
    'Handle HubSpot Result',
    { statusCode: 401, body: 'Unauthorized upstream secret' },
    s,
  );
  expect(failure.body.error).toBe('HUBSPOT_HTTP_401');
  expect(JSON.stringify(failure)).not.toContain('upstream secret');
});
