import type { Store } from './db/store.js';
import type { Order } from './order.js';
import { HubSpotError } from './hubspot.js';
export interface SyncClient {
  sync(
    order: Order,
    save: (contact: string, deal?: string) => void,
  ): Promise<void>;
}
export async function processOne(store: Store, client: SyncClient) {
  const job = store.claim();
  if (!job) return false;
  try {
    await client.sync(JSON.parse(job.order.payload_json), (contact, deal) =>
      store.saveIds(job, contact, deal),
    );
    store.finish(job, 'succeeded');
  } catch (error) {
    const code = error instanceof HubSpotError ? error.code : 'SYNC_FAILED';
    const message =
      error instanceof HubSpotError
        ? error.message
        : 'Sync failed; inspect server configuration and retry';
    store.finish(job, 'failed', code, message);
    console.error(JSON.stringify({ code, orderId: job.order.order_id }));
  }
  return true;
}
export function startWorker(store: Store, client: SyncClient) {
  let stopped = false;
  let wake: () => void = () => {};
  const done = (async () => {
    while (!stopped) {
      try {
        if (await processOne(store, client)) continue;
      } catch {
        console.error(JSON.stringify({ code: 'WORKER_DB_ERROR' }));
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
    }
  })();
  return async () => {
    stopped = true;
    wake();
    await done;
  };
}
