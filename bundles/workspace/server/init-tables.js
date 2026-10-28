/**
 * The bundle's own crow.db table (spec §5.6, the ramble pattern: CREATE IF NOT EXISTS, no SCHEMA_GENERATION bump).
 * `verified` (R-LIVE): a live claim-ack is never proof; a change counts as applied only after the postcondition
 * held on the SAVED file.
 */
export async function initWorkspaceTables(db) {
  await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS workspace_pending_changes (
  id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL, doc_key TEXT,
  tool TEXT NOT NULL, args_json TEXT NOT NULL, precondition_json TEXT, state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER, lease_owner TEXT, claim_count INTEGER NOT NULL DEFAULT 0, result_json TEXT, version_id TEXT,
  inverse_json TEXT, open_by_json TEXT, requested_by TEXT, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  actor_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_wpc_file_seq ON workspace_pending_changes(file_id, seq);
CREATE INDEX IF NOT EXISTS ix_wpc_state ON workspace_pending_changes(state);
CREATE INDEX IF NOT EXISTS ix_wpc_key ON workspace_pending_changes(doc_key);`);
  // actor_json (who queued the change, for comment authors at close time) on tables created before it. Every process
  // runs this, so two can both see it missing: the loser's "duplicate column name" is success.
  const cols = (await db.execute("PRAGMA table_info(workspace_pending_changes)")).rows.map((r) => r.name);
  if (!cols.includes("actor_json")) {
    try { await db.execute("ALTER TABLE workspace_pending_changes ADD COLUMN actor_json TEXT"); }
    catch (e) { if (!/duplicate column name/i.test(String(e?.message))) throw e; }
  }
}
