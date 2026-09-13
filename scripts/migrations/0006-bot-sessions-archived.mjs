// scripts/migrations/0006-bot-sessions-archived.mjs
//
// bot_sessions.archived_at (Perch session archive, audit item 14) is an
// ADDITIVE column with no SCHEMA_GENERATION bump — by design, so the boot
// schema guard never fires for it and init-db's DROP TABLE rail is never
// re-run against a live DB. The flip side is the exact 2026-09-12 R4 outage
// that 0005 exists for: co-hosted instances converge onto the shared
// checkout's new code on their own restart schedule, their boot guard skips
// init-db (generation matches), so nothing adds the column — and the new
// /roost SELECT that names `archived_at` 500s, taking every Perch hub surface
// on that instance with it. This rail adds the column independently of
// SCHEMA_GENERATION, so a converging instance is current on its own restart.
//
// Guarded additive ALTER, idempotent, absent-table tolerant. SQLite ADD
// COLUMN never rebuilds the table, so the bot_sessions control-CHECK rebuild
// block in init-db.js is unaffected either way.
import Database from "better-sqlite3";

export const id = "0006-bot-sessions-archived";

/** "added" | "no-op" | "absent" — never throws on a missing table. */
export function addColumnIfMissing(db, table, column, ddl) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!t) return "absent";
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (have.includes(column)) return "no-op";
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  return "added";
}

export function run({ dbPath, log = () => {} }) {
  const results = [];
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    // DDL matches init-db.js's own addColumnIfMissing call verbatim
    // (archived_at: ~2670) — one shape, two rails.
    const r = addColumnIfMissing(db, "bot_sessions", "archived_at", "TEXT");
    log(`  bot_sessions.archived_at: ${r}`);
    results.push(r);
  } finally {
    db.close();
  }
  // bot_sessions is CORE crow.db (init-db creates it on every instance), so an
  // "absent" read here is a store that predates the bot tables entirely —
  // recording applied is correct: when init-db creates the table it carries
  // archived_at in the CREATE body, and there is nothing left to retry.
  return { applied: true, results };
}
