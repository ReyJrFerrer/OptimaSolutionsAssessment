import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc, sql } from 'drizzle-orm';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { orders, attempts } from './schema.js';
import { canonical, type Order } from '../order.js';
export type Job = { order: typeof orders.$inferSelect; attemptId: number };
export class Store {
  private sqlite: Database.Database;
  private db;
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.exec(
      readFileSync(new URL('./0001.sql', import.meta.url), 'utf8'),
    );
    this.db = drizzle(this.sqlite);
  }
  close() {
    this.sqlite.close();
  }
  get(id: string) {
    return this.db.select().from(orders).where(eq(orders.order_id, id)).get();
  }
  reserve(o: Order) {
    return this.db.transaction(
      (tx) => {
        const payload = canonical(o),
          hash = createHash('sha256').update(payload).digest('hex'),
          now = Date.now();
        const inserted = tx
          .insert(orders)
          .values({
            order_id: o.order_id,
            payload_json: payload,
            payload_sha256: hash,
            status: 'queued',
            created_at: now,
            updated_at: now,
          })
          .onConflictDoNothing()
          .returning()
          .get();
        const row =
          inserted ??
          tx
            .select()
            .from(orders)
            .where(eq(orders.order_id, o.order_id))
            .get()!;
        return {
          row,
          duplicate: !inserted,
          conflict: row.payload_sha256 !== hash,
        };
      },
      { behavior: 'immediate' },
    );
  }
  claim(now = Date.now()): Job | undefined {
    return this.db.transaction(
      (tx) => {
        const expired = tx
          .select()
          .from(orders)
          .where(
            sql`${orders.status}='processing' AND ${orders.lease_expires_at} <= ${now}`,
          )
          .all();
        for (const o of expired) {
          tx.update(attempts)
            .set({
              status: 'failed',
              error_code: 'LEASE_EXPIRED',
              error_message: 'Worker interrupted; reconciliation scheduled',
              finished_at: now,
            })
            .where(
              sql`${attempts.order_id}=${o.order_id} AND ${attempts.status}='processing'`,
            )
            .run();
          tx.update(orders)
            .set({ status: 'queued', lease_expires_at: null, updated_at: now })
            .where(eq(orders.order_id, o.order_id))
            .run();
        }
        const order = tx
          .select()
          .from(orders)
          .where(
            sql`${orders.status}='queued' AND (${orders.next_run_at} IS NULL OR ${orders.next_run_at}<=${now})`,
          )
          .orderBy(orders.created_at)
          .get();
        if (!order) return;
        const count = tx
          .select({
            n: sql<number>`coalesce(max(${attempts.attempt_number}),0)`,
          })
          .from(attempts)
          .where(eq(attempts.order_id, order.order_id))
          .get()!.n;
        tx.update(orders)
          .set({
            status: 'processing',
            lease_expires_at: now + 600000,
            updated_at: now,
          })
          .where(eq(orders.order_id, order.order_id))
          .run();
        const attempt = tx
          .insert(attempts)
          .values({
            order_id: order.order_id,
            attempt_number: count + 1,
            status: 'processing',
            hubspot_contact_id: order.hubspot_contact_id,
            hubspot_deal_id: order.hubspot_deal_id,
            started_at: now,
          })
          .returning()
          .get()!;
        return { order, attemptId: attempt.id };
      },
      { behavior: 'immediate' },
    );
  }
  saveIds(job: Job, contact: string, deal?: string) {
    this.db.transaction((tx) => {
      const ids = {
        hubspot_contact_id: contact,
        ...(deal ? { hubspot_deal_id: deal } : {}),
      };
      tx.update(orders)
        .set({ ...ids, updated_at: Date.now() })
        .where(eq(orders.order_id, job.order.order_id))
        .run();
      tx.update(attempts).set(ids).where(eq(attempts.id, job.attemptId)).run();
    });
  }
  finish(
    job: Job,
    status: 'succeeded' | 'failed',
    code: string | null = null,
    message: string | null = null,
  ) {
    this.db.transaction((tx) => {
      tx.update(attempts)
        .set({
          status,
          error_code: code,
          error_message: message,
          finished_at: Date.now(),
        })
        .where(eq(attempts.id, job.attemptId))
        .run();
      tx.update(orders)
        .set({
          status,
          last_error: message,
          lease_expires_at: null,
          updated_at: Date.now(),
        })
        .where(eq(orders.order_id, job.order.order_id))
        .run();
    });
  }
  retry(id: string) {
    return this.db
      .update(orders)
      .set({ status: 'queued', last_error: null, updated_at: Date.now() })
      .where(sql`${orders.order_id}=${id} AND ${orders.status}='failed'`)
      .returning({ id: orders.order_id })
      .get();
  }
  attempts(limit: number) {
    return this.db
      .select({
        id: attempts.id,
        order_id: attempts.order_id,
        attempt_number: attempts.attempt_number,
        status: attempts.status,
        hubspot_contact_id: attempts.hubspot_contact_id,
        hubspot_deal_id: attempts.hubspot_deal_id,
        error_code: attempts.error_code,
        error_message: attempts.error_message,
        started_at: attempts.started_at,
        finished_at: attempts.finished_at,
        current_order_state: orders.status,
      })
      .from(attempts)
      .innerJoin(orders, eq(attempts.order_id, orders.order_id))
      .orderBy(desc(attempts.started_at), desc(attempts.id))
      .limit(Math.min(50, Math.max(1, limit)))
      .all();
  }
}
