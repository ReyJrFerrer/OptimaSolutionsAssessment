import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../../apps/api/src/config.js';

afterEach(() => vi.unstubAllEnvs());
it('defaults to local binding and accepts an explicit container binding', () => {
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'synthetic');
  vi.stubEnv('HUBSPOT_PIPELINE_ID', 'default');
  vi.stubEnv('HUBSPOT_DEAL_STAGE_ID', 'closedwon');
  vi.stubEnv('WEBHOOK_SECRET', 's'.repeat(32));
  vi.stubEnv('DASHBOARD_ADMIN_TOKEN', 'a'.repeat(32));
  vi.stubEnv('HOST', undefined);
  expect(config().HOST).toBe('127.0.0.1');
  vi.stubEnv('HOST', '0.0.0.0');
  expect(config().HOST).toBe('0.0.0.0');
  vi.stubEnv('HOST', '');
  expect(() => config()).toThrow('HOST');
});
