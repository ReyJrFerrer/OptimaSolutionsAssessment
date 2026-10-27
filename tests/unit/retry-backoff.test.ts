import { it, expect, vi } from 'vitest';
import { HubSpotClient } from '../../apps/api/src/hubspot.js';
const settings = {
  token: 'secret-token',
  pipeline: 'default',
  stage: 'closedwon',
  phpConfirmed: true,
};
const response = (status: number, headers = {}) =>
  new Response(
    JSON.stringify({
      message: 'secret-token maria@example.com',
      correlationId: 'bad@private',
    }),
    { status, headers },
  );
it.each([429, 500, 502, 503, 504])(
  'recovers transient %i with exponential bounded jitter',
  async (status) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const transport = vi
      .fn()
      .mockImplementationOnce(async () => response(status))
      .mockImplementationOnce(async () => response(status))
      .mockImplementationOnce(async () => response(status))
      .mockImplementationOnce(async () => response(200));
    const sleep = vi.fn(async (_ms: number) => {});
    await new HubSpotClient(settings, transport, sleep).request('/test');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1125, 2125, 4125]);
    expect(transport).toHaveBeenCalledTimes(4);
  },
);
it.each([400, 401, 403, 503])(
  'bounds failures and redacts %i',
  async (status) => {
    const transport = vi.fn(async () => response(status));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      new HubSpotClient(settings, transport, sleep).request('/test'),
    ).rejects.toThrow('HUBSPOT_HTTP_' + status);
    expect(transport).toHaveBeenCalledTimes(status === 503 ? 4 : 1);
    expect(sleep).toHaveBeenCalledTimes(status === 503 ? 3 : 0);
    try {
      await new HubSpotClient(settings, transport, sleep).request('/test');
    } catch (e) {
      expect(String(e)).not.toMatch(/secret-token|@/);
    }
  },
);
it.each(['9', 'Tue, 27 Oct 2026 00:00:09 GMT', '999999', 'invalid'])(
  'honors or safely caps Retry-After %s',
  async (header) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-27T00:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(response(429, { 'Retry-After': header }))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn(async (_ms: number) => {});
    await new HubSpotClient(settings, transport, sleep).request('/test');
    expect(sleep).toHaveBeenCalledWith(
      header === '999999' ? 30000 : header === 'invalid' ? 1000 : 9000,
    );
  },
);
it('retries network failures at most four times', async () => {
  const transport = vi
    .fn()
    .mockRejectedValue(new Error('private secret-token'));
  const sleep = vi.fn(async (_ms: number) => {});
  await expect(
    new HubSpotClient(settings, transport, sleep).request('/test'),
  ).rejects.toThrow('HUBSPOT_NETWORK');
  expect(transport).toHaveBeenCalledTimes(4);
  expect(sleep).toHaveBeenCalledTimes(3);
});
it('times out a hung transport and recovers without real waiting', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  });
  const transport = vi
    .fn()
    .mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Error('timeout')));
        }),
    )
    .mockResolvedValueOnce(response(200));
  const pending = new HubSpotClient(
    settings,
    transport,
    async () => {},
  ).request('/test');
  await vi.advanceTimersByTimeAsync(10000);
  await pending;
  expect(AbortSignal.timeout).toHaveBeenCalledWith(10000);
  expect(transport).toHaveBeenCalledTimes(2);
});
