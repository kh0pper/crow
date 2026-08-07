// scripts/migrations/0001-board-stages.mjs
//
// Board–plan unification: guarded additive ALTERs. PRAGMA presence check,
// additive, idempotent, absent-table tolerant. SQLite ADD COLUMN never rebuilds
// the table, so existing CHECK constraints are unaffected.
//
// Previously this lived in scripts/migrate-board-stages.mjs, documented "run on
// deploy, both instances" — which meant it reached the primary and silently
// skipped r4, whose tasks.db then lacked stage/assigned_bot/plan_ref and 500'd
// every Bot Board drawer open. That is the drift this registry exists to end.
import Database from "better-sqlite3";

export const id = "0001-board-stages";

/** "added" | "no-op" | "absent" — never throws on a missing table. */
export function addColumnIfMissing(db, table, column, ddl) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!t) return "absent";
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (have.includes(column)) return "no-op";
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  return "added";
}

function open(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const results = [];

  const tdb = open(tasksDbPath);
  try {
    for (const [col, ddl] of [["stage", "TEXT"], ["assigned_bot", "TEXT"], ["plan_ref", "TEXT"]]) {
      const r = addColumnIfMissing(tdb, "tasks_items", col, ddl);
      log(`  tasks_items.${col}: ${r}`);
      results.push(r);
    }
  } finally {
    tdb.close();
  }

  const cdb = open(dbPath);
  try {
    for (const [tbl, col, ddl] of [
      ["project_spaces", "repo_path", "TEXT"],
      ["bot_sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'"],
    ]) {
      const r = addColumnIfMissing(cdb, tbl, col, ddl);
      log(`  ${tbl}.${col}: ${r}`);
      results.push(r);
    }
  } finally {
    cdb.close();
  }

  // ANY absent target means this instance's stores do not all exist YET — not
  // that the work is done. Defer so the runner retries once the owning bundle
  // has started.
  //
  // `any`, NOT `all`: this migration spans two databases. project_spaces and
  // bot_sessions live in crow.db and are created by init-db.js, so they are
  // ALWAYS present by the time the boot registry runs. tasks_items lives in
  // tasks.db and is created by the tasks BUNDLE, which starts after the gateway
  // boots. An `all` rule would therefore never fire on a real instance — one
  // present table would mark the whole migration applied and the tasks_items
  // columns would never land. That is the original bug, reintroduced.
  if (results.includes("absent")) return { deferred: true };
}
