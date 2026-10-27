import { z } from 'zod';
const schema = z.object({
  HUBSPOT_ACCESS_TOKEN: z.string().min(1),
  HUBSPOT_PIPELINE_ID: z.string().min(1),
  HUBSPOT_DEAL_STAGE_ID: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(32),
  DASHBOARD_ADMIN_TOKEN: z.string().min(32),
  HUBSPOT_PHP_CONFIRMED: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().default('./data/orders.sqlite'),
});
export function config() {
  const result = schema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      'Invalid environment variables: ' +
        result.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  return result.data;
}
