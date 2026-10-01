export async function initPhoneTables(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS phone_calls (
      id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      deliver_to TEXT,
      business_name TEXT NOT NULL,
      number_e164 TEXT NOT NULL,
      goal TEXT NOT NULL,
      limits_json TEXT NOT NULL DEFAULT '{}',
      shareable_json TEXT NOT NULL DEFAULT '{}',
      language TEXT NOT NULL DEFAULT 'en',
      notes TEXT,
      allow_cloud INTEGER NOT NULL DEFAULT 0,
      model_used TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_approval',
      plan_hash TEXT NOT NULL,
      token_hash TEXT,
      approved_by_session TEXT,
      approved_at TEXT,
      run_after TEXT,
      started_at TEXT,
      ended_at TEXT,
      outcome TEXT,
      booking_json TEXT,
      summary TEXT,
      transcript_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      event_seq INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_phone_calls_status ON phone_calls(status);
    CREATE INDEX IF NOT EXISTS idx_phone_calls_number ON phone_calls(number_e164, started_at);
    CREATE TABLE IF NOT EXISTS phone_suppression (
      number_e164 TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS phone_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, actor TEXT NOT NULL, event TEXT NOT NULL,
      detail_json TEXT, at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_phone_audit_call ON phone_audit(call_id);
  `);
  // Spec 2026-10-01 §4.6: transient-delivery backoff. Bundle-owned columns (no
  // SCHEMA_GENERATION). Guarded: the /phone mount and the panel router both run
  // this at boot, so a concurrent duplicate ALTER is expected and ignored.
  const cols = new Set((await db.execute("PRAGMA table_info(phone_calls)")).rows.map((r) => r.name));
  for (const [name, ddl] of [["delivery_busy", "INTEGER NOT NULL DEFAULT 0"], ["delivery_retry_at", "TEXT"]]) {
    if (cols.has(name)) continue;
    try { await db.execute(`ALTER TABLE phone_calls ADD COLUMN ${name} ${ddl}`); }
    catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
}
