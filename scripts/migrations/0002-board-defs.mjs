// scripts/migrations/0002-board-defs.mjs
//
// Track 0 Phase A: the cards board becomes configurable.
//
//   1. board_defs — per-board status values, terminal subset, declared fields.
//   2. tasks_items rebuilt with DERIVED DDL: the status CHECK dropped (SQLite
//      cannot ALTER it away), the `stage` column dropped (the stage machine is
//      deleted in this change), `data_json` added for declared fields. Every
//      other column — including the dormant assigned_bot/plan_ref — and every
//      row carries over verbatim. The DDL is derived from the live
//      sqlite_master text, never hardcoded: the table is bundle-owned and its
//      exact shape can drift per instance; a hardcoded target would crash the
//      copy on any variant.
//   3. board_defs seeded per project that has cards: the four legacy statuses
//      (the data guarantee — nothing is renamed), and a column-backed `phase`
//      field iff that project uses phase, its options = the observed values.
//
// Boot-time safety: the rebuild is one transaction on a busy_timeout 10000
// connection; the stdio tasks server is read-mostly and retries on busy — the
// same exposure 0001 already accepted. A sidecar copy of the whole file is
// written beside it first (tasks.db.bak-0002-<utc>), after a WAL checkpoint.
import { copyFileSync } from "node:fs";
import Database from "better-sqlite3";

export const id = "0002-board-defs";

export const BOARD_DEFS_DDL = `CREATE TABLE IF NOT EXISTS board_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  project_id INTEGER UNIQUE,
  display_name TEXT NOT NULL,
  status_values TEXT NOT NULL,
  terminal_values TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const LEGACY_STATUSES = ["pending", "in_progress", "done", "cancelled"];
const LEGACY_TERMINALS = ["done", "cancelled"];

function open(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

/** Derive the rebuilt DDL from the live CREATE TABLE text. Throws on any
 * shape it cannot transform with certainty — failing loudly beats migrating
 * wrong. */
function deriveNewDdl(sql) {
  let out = sql;
  // Drop the inline status CHECK (bundle DDL shape; single-level parens).
  out = out.replace(/\s*CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i, "");
  // Drop the top-level `stage TEXT` column (0001 appended it as ", stage TEXT").
  const before = out;
  out = out.replace(/,\s*stage\s+TEXT\b/i, "");
  if (out === before) out = out.replace(/\bstage\s+TEXT\s*,/i, "");
  // Rename the created table.
  out = out.replace(/CREATE TABLE\s+(["'`]?)tasks_items\1/i, "CREATE TABLE tasks_items_new");
  // Append data_json before the final closing paren.
  const cut = out.lastIndexOf(")");
  if (cut < 0) throw new Error("0002: cannot find closing paren in tasks_items DDL");
  out = out.slice(0, cut) + ", data_json TEXT NOT NULL DEFAULT '{}'" + out.slice(cut);
  return out;
}

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const tdb = open(tasksDbPath);
  try {
    tdb.exec(BOARD_DEFS_DDL);

    const table = tdb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get();
    if (!table) {
      log("  tasks_items: absent — deferred (board_defs created)");
      return { deferred: true };
    }

    const cols = tdb.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    const hasStage = cols.includes("stage");
    const hasCheck = /CHECK\s*\(\s*status\s+IN/i.test(table.sql);

    if (hasStage || hasCheck) {
      if (hasStage) {
        for (const r of tdb.prepare("SELECT id, stage FROM tasks_items WHERE stage IS NOT NULL").all()) {
          log(`  dropping tasks_items.stage value: card #${r.id} stage='${r.stage}'`);
        }
      }
      // Sidecar backup of the whole file, post-checkpoint.
      try { tdb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* non-wal is fine */ }
      const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const bak = `${tasksDbPath}.bak-0002-${ts}`;
      copyFileSync(tasksDbPath, bak);
      log(`  backup: ${bak}`);

      const newDdl = deriveNewDdl(table.sql);
      const copyCols = cols.filter((c) => c !== "stage");
      // Indexes AND triggers ride through the rebuild — a DROP TABLE destroys
      // both, and this migration must tolerate shapes it did not author.
      const indexSqls = tdb.prepare(
        "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='tasks_items' AND sql IS NOT NULL"
      ).all().map((r) => r.sql);

      // foreign_keys must be toggled OUTSIDE the transaction (no-op inside).
      tdb.pragma("foreign_keys = OFF");
      try {
        tdb.transaction(() => {
          tdb.exec(newDdl);
          tdb.exec(
            `INSERT INTO tasks_items_new (${copyCols.join(", ")}, data_json) ` +
            `SELECT ${copyCols.join(", ")}, '{}' FROM tasks_items`
          );
          tdb.exec("DROP TABLE tasks_items");
          tdb.exec("ALTER TABLE tasks_items_new RENAME TO tasks_items");
          for (const ix of indexSqls) tdb.exec(ix);
        })();
      } finally {
        tdb.pragma("foreign_keys = ON");
      }

      // Verify the rebuild actually converged — fail loudly, never record wrong.
      const afterCols = tdb.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
      const afterSql = tdb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
      if (afterCols.includes("stage") || /CHECK\s*\(\s*status\s+IN/i.test(afterSql) || !afterCols.includes("data_json")) {
        throw new Error("0002: rebuild did not converge — refusing to record");
      }
      log("  tasks_items: rebuilt (CHECK dropped, stage dropped, data_json added)");
    } else {
      log("  tasks_items: already converged — no rebuild");
    }

    // ---- Seeding: one def per project that has cards. INSERT OR IGNORE so an
    // operator's later edits always win over a re-run. Guarded on the column
    // existing (registry contract: shape-tolerant) — a tasks_items without
    // project_id is not a cards store and has nothing to seed.
    const seedCols = tdb.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    const projects = !seedCols.includes("project_id") ? [] : tdb.prepare(
      "SELECT DISTINCT project_id FROM tasks_items WHERE project_id IS NOT NULL ORDER BY project_id"
    ).all().map((r) => Number(r.project_id));

    const names = new Map();
    if (projects.length) {
      try {
        const cdb = open(dbPath);
        try {
          for (const r of cdb.prepare("SELECT id, name FROM project_spaces").all()) {
            if (r.name) names.set(Number(r.id), String(r.name));
          }
        } finally { cdb.close(); }
      } catch { /* crow.db lookup is best-effort — fallback names below */ }
    }

    const ins = tdb.prepare(
      "INSERT OR IGNORE INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?)"
    );
    for (const pid of projects) {
      const phases = tdb.prepare(
        "SELECT DISTINCT phase FROM tasks_items WHERE project_id=? AND phase IS NOT NULL AND phase != '' ORDER BY phase"
      ).all(pid).map((r) => String(r.phase));
      const fields = phases.length
        ? [{ key: "phase", label: "Phase", storage: "column", options: phases }]
        : [];
      const r = ins.run(
        pid,
        names.get(pid) || `Project ${pid}`,
        JSON.stringify(LEGACY_STATUSES),
        JSON.stringify(LEGACY_TERMINALS),
        JSON.stringify(fields)
      );
      if (r.changes) log(`  board_defs: seeded project ${pid}${phases.length ? ` (phase × ${phases.length})` : ""}`);
    }
  } finally {
    tdb.close();
  }
}
