import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';
export const orders = sqliteTable('orders', {
  order_id: text().primaryKey(),
  payload_json: text().notNull(),
  payload_sha256: text().notNull(),
  status: text({
    enum: ['queued', 'processing', 'succeeded', 'failed'],
  }).notNull(),
  hubspot_contact_id: text(),
  hubspot_deal_id: text(),
  last_error: text(),
  next_run_at: integer(),
  lease_expires_at: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});
export const attempts = sqliteTable(
  'sync_attempts',
  {
    id: integer().primaryKey(),
    order_id: text()
      .notNull()
      .references(() => orders.order_id),
    attempt_number: integer().notNull(),
    status: text({ enum: ['processing', 'succeeded', 'failed'] }).notNull(),
    hubspot_contact_id: text(),
    hubspot_deal_id: text(),
    error_code: text(),
    error_message: text(),
    started_at: integer().notNull(),
    finished_at: integer(),
  },
  (t) => [
    uniqueIndex('order_attempt').on(t.order_id, t.attempt_number),
    index('attempts_started').on(t.started_at),
  ],
);
