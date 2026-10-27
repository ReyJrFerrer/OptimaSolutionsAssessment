import { config } from './config.js';
import { Store } from './db/store.js';
import { createApp } from './app.js';
import { HubSpotClient } from './hubspot.js';
import { startWorker } from './worker.js';
import { resolve } from 'node:path';
const env = config();
// npm workspace scripts execute from apps/api; resolve the default database at repository root.
const database = resolve(
  process.cwd().endsWith('/apps/api') ? '../..' : '.',
  env.DATABASE_PATH,
);
const store = new Store(database);
const client = new HubSpotClient({
  token: env.HUBSPOT_ACCESS_TOKEN,
  pipeline: env.HUBSPOT_PIPELINE_ID,
  stage: env.HUBSPOT_DEAL_STAGE_ID,
  phpConfirmed: env.HUBSPOT_PHP_CONFIRMED === 'true',
});
const server = createApp(
  store,
  env.WEBHOOK_SECRET,
  env.DASHBOARD_ADMIN_TOKEN,
).listen(env.PORT, env.HOST, () =>
  console.log(`API listening at http://${env.HOST}:${env.PORT}`),
);
const stop = startWorker(store, client);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      void stop().then(() => {
        store.close();
      });
    });
  });
