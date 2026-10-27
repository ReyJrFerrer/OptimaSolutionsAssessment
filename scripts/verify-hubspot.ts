import { config } from '../apps/api/src/config.js';
import { HubSpotClient, HubSpotError } from '../apps/api/src/hubspot.js';
const env = config();
const client = new HubSpotClient({
  token: env.HUBSPOT_ACCESS_TOKEN,
  pipeline: env.HUBSPOT_PIPELINE_ID,
  stage: env.HUBSPOT_DEAL_STAGE_ID,
  phpConfirmed: env.HUBSPOT_PHP_CONFIRMED === 'true',
});
try {
  await client.verifySetup();
  console.log(
    'Unique Deal text property and configured pipeline/stage: verified',
  );
  await client.request('/crm/objects/2026-09/deals?limit=1');
  console.log('Deals read authentication: verified (response withheld)');
  console.log(
    `PHP currency confirmation: ${env.HUBSPOT_PHP_CONFIRMED === 'true' ? 'set locally; confirm in portal UI' : 'still required in portal UI'}`,
  );
} catch (e) {
  console.error(
    e instanceof HubSpotError
      ? e.message
      : 'Configuration or connection check failed',
  );
  process.exitCode = 1;
}
