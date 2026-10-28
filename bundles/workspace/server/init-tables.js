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
  // Comment loop (Phase 1, shadow mode): watch row, editor sessions, per-file scan state, and the event log.
  // Times are epoch ms except mtime (epoch s, as dav.js returns it). Never stores full comment text.
  await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS workspace_comment_watch (
  id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL DEFAULT 'off', watch_since INTEGER, lease_owner TEXT,
  lease_until INTEGER, blocked_reason TEXT, provider_ok_json TEXT
);
CREATE TABLE IF NOT EXISTS workspace_editor_sessions (
  doc_key TEXT PRIMARY KEY, file_id INTEGER NOT NULL, uids_json TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wes_file ON workspace_editor_sessions(file_id);
CREATE TABLE IF NOT EXISTS workspace_comment_state (
  file_id INTEGER PRIMARY KEY, etag TEXT, mtime INTEGER, threads_json TEXT NOT NULL DEFAULT '[]', own_put_etag TEXT,
  first_seen_at INTEGER NOT NULL, scanned_at INTEGER, skip_reason TEXT
);
CREATE TABLE IF NOT EXISTS workspace_comment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, file_id INTEGER, kind TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wce_kind_at ON workspace_comment_events(kind, at);`);
}
