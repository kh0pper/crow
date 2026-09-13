// scripts/migrations/0007-perch-session-files.mjs
//
// perch_session_files (Perch PR-E, audit item 12): the durable card-history
// rail for files an agent sends to a perch chat via send_user_file's
// crow-file: relay. A NEW TABLE carries no SCHEMA_GENERATION bump by design
// (a bump re-runs every DROP/CREATE against live DBs — this rail has no
// reason to ride it), which is exactly the 2026-09-12 convergence gap 0005
// and 0006 exist for: a co-hosted instance on a shared checkout converges
// onto new code on its OWN restart, its boot guard skips init-db (generation
// matches), and code that INSERTs into a table nobody created 500s. This rail
// creates the table independently, byte-identical to init-db.js's own CREATE
// body (one shape, two rails), so either rail running first wins and both
// are idempotent.
//
// Idempotent, never destructive: CREATE TABLE/INDEX IF NOT EXISTS only.
import Database from "better-sqlite3";

export const id = "0007-perch-session-files";

const DDL = [
  `CREATE TABLE IF NOT EXISTS perch_session_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id     TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    stored     TEXT,
    mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size       INTEGER NOT NULL DEFAULT 0,
    caption    TEXT NOT NULL DEFAULT '',
    servable   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_perch_session_files_thread
     ON perch_session_files (bot_id, thread_id)`,
];

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    const had = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='perch_session_files'").get();
    for (const sql of DDL) db.prepare(sql).run();
    log(`  perch_session_files: ${had ? "no-op" : "created"}`);
  } finally {
    db.close();
  }
  return { applied: true, results: ["table"] };
}
