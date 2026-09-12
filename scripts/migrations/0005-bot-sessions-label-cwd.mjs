// scripts/migrations/0005-bot-sessions-label-cwd.mjs
//
// bot_sessions.label (session rename, shipped with the perch rename wave) and
// bot_sessions.cwd (open-anywhere PR2, #360) are ADDITIVE columns with no
// SCHEMA_GENERATION bump — by design, so the boot schema guard never fires
// for them and init-db's DROP TABLE rail is never re-run against a live DB.
// The flip side, measured live on 2026-09-12: co-hosted instances converge
// onto the shared checkout's new code on their own restart schedule, and
// their boot guard skips init-db (generation matches), so nothing ever adds
// the columns. The R4 instance restarted onto post-#360 code at 17:53 with a
// bot_sessions table carrying NEITHER column: routes/perch.js's /roost
// SELECT (… control, label FROM bot_sessions …) 500'd — every Perch hub on
// R4 read "Could not reach the session list" and no bot could be opened —
// while the engine's writeRow cwd= stamp failed silently per session. The
// primary instance only escaped because its operator ran init-db by hand
// after deploying #360; a rail that depends on that is exactly the drift
// this registry exists to end (same story as 0001's header).
//
// Guarded additive ALTERs, idempotent, absent-table tolerant. SQLite ADD
// COLUMN never rebuilds the table, so the bot_sessions control-CHECK rebuild
// block in init-db.js is unaffected either way.
import Database from "better-sqlite3";

export const id = "0005-bot-sessions-label-cwd";

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
    // DDL matches init-db.js's own addColumnIfMissing calls verbatim
    // (label: ~2657, cwd: ~2668) — one shape, two rails.
    for (const col of ["label", "cwd"]) {
      const r = addColumnIfMissing(db, "bot_sessions", col, "TEXT");
      log(`  bot_sessions.${col}: ${r}`);
      results.push(r);
    }
  } finally {
    db.close();
  }
  // bot_sessions is CORE crow.db (init-db creates it on every instance), so
  // an "absent" read here is a store that predates the bot tables entirely —
  // recording applied is correct: when init-db creates the table it carries
  // both columns in the CREATE body, and there is nothing left to retry.
  return { applied: true, results };
}
