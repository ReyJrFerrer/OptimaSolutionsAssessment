// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { App } from '../../apps/web/src/App';
let host: HTMLDivElement, root: Root;
const row = (id: number, state = 'failed') => ({
  id,
  order_id: 'ORD-10482',
  attempt_number: id,
  status: state,
  current_order_state: state,
  started_at: 1,
  finished_at: 2,
  hubspot_contact_id: 'c-mock',
  hubspot_deal_id: 'd-mock',
  error_code: state === 'failed' ? 'HUBSPOT_HTTP_503' : null,
  error_message: state === 'failed' ? 'Service unavailable' : null,
});
const reply = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;
const button = (label: string) =>
  Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )!;
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function connect() {
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'admin-test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('shows disconnected, loading, empty and rejected token states', async () => {
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(reply({}, 401));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<App />));
  expect(host.textContent).toContain('Connect to view attempts.');
  await connect();
  expect(host.textContent).toContain('Refreshing…');
  await act(async () => resolve(reply([])));
  expect(host.textContent).toContain('No attempts yet');
  await click('Refresh');
  expect(host.querySelector('[role=alert]')!.textContent).toBe(
    'Admin token was rejected.',
  );
  expect(fetcher.mock.calls[0]).toEqual([
    '/api/sync-attempts?limit=50',
    { headers: { Authorization: 'Bearer admin-test' } },
  ]);
});
it('renders repeated history, errors and IDs and limits Retry to failed orders', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        reply([
          row(3, 'succeeded'),
          row(2),
          { ...row(1, 'processing'), order_id: 'ACTIVE' },
        ]),
      ),
  );
  await act(async () => root.render(<App />));
  await connect();
  expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(host.textContent).toContain('Service unavailable');
  expect(host.textContent).toContain('c-mock');
  expect(host.textContent).toContain('d-mock');
  expect(
    Array.from(host.querySelectorAll('button')).filter(
      (b) => b.textContent === 'Retry',
    ),
  ).toHaveLength(1);
  expect(button('processing').disabled).toBe(true);
});
it('queues retry once, disables action while pending, refreshes new attempt and polls', async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply([row(1)]))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(
      reply([{ ...row(1), current_order_state: 'queued' }]),
    )
    .mockResolvedValue(
      reply([
        row(2, 'succeeded'),
        { ...row(1), current_order_state: 'succeeded' },
      ]),
    );
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<App />));
  await connect();
  await click('Retry');
  expect(button('Queuing…').disabled).toBe(true);
  expect(fetcher.mock.calls[1]).toEqual([
    '/api/orders/ORD-10482/retry',
    { method: 'POST', headers: { Authorization: 'Bearer admin-test' } },
  ]);
  await act(async () => resolve(reply({}, 202)));
  expect(button('queued').disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(host.textContent).toContain('Attempt 2');
  expect(
    Array.from(host.querySelectorAll('button')).some(
      (b) => b.textContent === 'Retry',
    ),
  ).toBe(false);
  await click('Disconnect');
  expect(host.querySelector('table')).toBeNull();
});
it.each([409, 500])(
  'shows retry %i failure and re-enables retry',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply([row(1)]))
        .mockResolvedValueOnce(reply({}, status)),
    );
    await act(async () => root.render(<App />));
    await connect();
    await click('Retry');
    expect(host.querySelector('[role=alert]')!.textContent).toBe(
      status === 409
        ? 'Order is already queued or no longer failed.'
        : 'Retry failed.',
    );
    expect(button('Retry').disabled).toBe(false);
  },
);
it('shows network error without losing control of the page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('Offline')));
  await act(async () => root.render(<App />));
  await connect();
  expect(host.querySelector('[role=alert]')!.textContent).toBe('Offline');
  expect(button('Refresh').disabled).toBe(false);
});
it('does not restore private history when an outstanding request finishes after disconnect', async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  await act(async () => root.render(<App />));
  await connect();
  await click('Disconnect');
  await act(async () => resolve(reply([row(1)])));
  expect(host.querySelector('table')).toBeNull();
  expect(host.textContent).toContain('Connect to view attempts.');
});

it('keeps newer polling data when an older request finishes last', async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValueOnce(reply([row(2, 'succeeded')])),
  );
  await act(async () => root.render(<App />));
  await connect();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(host.textContent).toContain('Attempt 2');
  await act(async () => resolve(reply([row(1)])));
  expect(host.textContent).toContain('Attempt 2');
  expect(host.textContent).not.toContain('Attempt 1');
  expect(
    Array.from(host.querySelectorAll('button')).some(
      (b) => b.textContent === 'Retry',
    ),
  ).toBe(false);
});
