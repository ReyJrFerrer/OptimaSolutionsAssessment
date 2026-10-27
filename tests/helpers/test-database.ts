import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../apps/api/src/db/store.js';
export function database() {
  const dir = mkdtempSync(join(tmpdir(), 'optima-tests-'));
  const path = join(dir, 'orders.sqlite');
  const store = new Store(path);
  return {
    store,
    path,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true });
    },
  };
}
