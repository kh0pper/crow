// scripts/migrations/0023-sync-conflict-expiry.mjs
//
// Two nullable columns on sync_conflicts so an old conflict can expire on its
// own and the review page can tell a person's decision apart from the sweep's:
//
//   opened_at    TEXT  — a person opened this row on the review page. The
//                        expiry sweep leaves it alone: once seen, it is theirs.
//   resolved_via TEXT  — 'expired' (the sweep), 'operator' (keep-current /
//                        resolve-all) or 'bulk' (resolve-all-older-than-N).
//
// Additive only, no SCHEMA_GENERATION bump (init-db.js is untouched) — the
// registry is the rail for columns a running instance can pick up on boot.
// Idempotent and absent-table tolerant: sync_conflicts is created by
// init-db.js, but an instance whose crow.db was restored from a partial backup
// can still be missing it, so this defers with a reason instead of failing.
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0001-board-stages.mjs";

export const id = "0023-sync-conflict-expiry";

// rollbackSafe: two additive sync_conflicts columns; older code ignores them.
export const rollbackSafe = true;

export const COLUMNS = [
  ["opened_at", "TEXT"],
  ["resolved_via", "TEXT"],
];

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    let absent = false;
    for (const [col, ddl] of COLUMNS) {
      const r = addColumnIfMissing(db, "sync_conflicts", col, ddl);
      log(`  sync_conflicts.${col}: ${r}`);
      if (r === "absent") absent = true;
    }
    // Not recorded as applied: the owning schema has not been built yet, and a
    // recorded deferral would leave the columns missing forever (runner.mjs).
    if (absent) return { deferred: true, reason: "sync_conflicts absent" };
    return { applied: true };
  } finally {
    db.close();
  }
}