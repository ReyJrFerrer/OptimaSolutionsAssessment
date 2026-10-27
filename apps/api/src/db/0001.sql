CREATE TABLE IF NOT EXISTS orders (
 order_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','processing','succeeded','failed')),
 hubspot_contact_id TEXT, hubspot_deal_id TEXT, last_error TEXT, next_run_at INTEGER, lease_expires_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_attempts (
 id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(order_id), attempt_number INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('processing','succeeded','failed')),
 hubspot_contact_id TEXT, hubspot_deal_id TEXT, error_code TEXT, error_message TEXT,
 started_at INTEGER NOT NULL, finished_at INTEGER,
 UNIQUE(order_id,attempt_number)
);
CREATE INDEX IF NOT EXISTS attempts_started ON sync_attempts(started_at DESC);
