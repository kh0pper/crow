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
//   4. The SAME rebuild is applied to every distinct per-project card store
//      (project_spaces.tasks_db_uri) — the resolution cardsDbForBot and
//      handleInbound actually use. Leaving those with the old CHECK would make
//      a configured vocabulary unwritable exactly where the cards live.
//      Board_defs themselves stay in the instance-global tasks.db (the single
//      place resolveBoardDef reads).
//
// Boot-time safety: each rebuild is one transaction on a busy_timeout 10000
// connection; the stdio tasks server is read-mostly and retries on busy — the
// same exposure 0001 already accepted. A sidecar backup is taken with SQLite's
// ONLINE backup API before any rebuild (a checkpoint+file-copy can tear if a
// concurrent writer commits between the two steps).
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveSqlitePath } from "../pi-bots/instance-paths.mjs";

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

/**
 * Bring ONE store's tasks_items to the converged shape (no status CHECK, no
 * stage, data_json present). Online-backup first; verifies afterwards and
 * throws rather than record a wrong shape. Returns "rebuilt" | "converged" |
 * "absent".
 */
async function rebuildStore(dbh, dbFilePath, log) {
  const table = dbh.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get();
  if (!table) return "absent";

  const cols = dbh.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  const hasStage = cols.includes("stage");
  const hasCheck = /CHECK\s*\(\s*status\s+IN/i.test(table.sql);
  if (!hasStage && !hasCheck) return "converged";

  if (hasStage) {
    for (const r of dbh.prepare("SELECT id, stage FROM tasks_items WHERE stage IS NOT NULL").all()) {
      log(`  dropping tasks_items.stage value: card #${r.id} stage='${r.stage}'`);
    }
  }
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${dbFilePath}.bak-0002-${ts}`;
  await dbh.backup(bak);
  log(`  backup: ${bak}`);

  const newDdl = deriveNewDdl(table.sql);
  const copyCols = cols.filter((c) => c !== "stage");
  // Indexes AND triggers ride through the rebuild — a DROP TABLE destroys
  // both, and this migration must tolerate shapes it did not author.
  const objSqls = dbh.prepare(
    "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='tasks_items' AND sql IS NOT NULL"
  ).all().map((r) => r.sql);

  // foreign_keys must be toggled OUTSIDE the transaction (no-op inside).
  dbh.pragma("foreign_keys = OFF");
  try {
    dbh.transaction(() => {
      dbh.exec(newDdl);
      dbh.exec(
        `INSERT INTO tasks_items_new (${copyCols.join(", ")}, data_json) ` +
        `SELECT ${copyCols.join(", ")}, '{}' FROM tasks_items`
      );
      dbh.exec("DROP TABLE tasks_items");
      dbh.exec("ALTER TABLE tasks_items_new RENAME TO tasks_items");
      for (const sql of objSqls) dbh.exec(sql);
    })();
  } finally {
    dbh.pragma("foreign_keys = ON");
  }

  // Verify the rebuild actually converged — fail loudly, never record wrong.
  const afterCols = dbh.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  const afterSql = dbh.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
  if (afterCols.includes("stage") || /CHECK\s*\(\s*status\s+IN/i.test(afterSql) || !afterCols.includes("data_json")) {
    throw new Error("0002: rebuild did not converge — refusing to record");
  }
  return "rebuilt";
}

export async function run({ dbPath, tasksDbPath, log = () => {} }) {
  // ---- The instance-global store: rebuild + board_defs + seeding. ----
  const tdb = open(tasksDbPath);
  try {
    tdb.exec(BOARD_DEFS_DDL);

    const outcome = await rebuildStore(tdb, tasksDbPath, log);
    if (outcome === "absent") {
      log("  tasks_items: absent — deferred (board_defs created)");
      return { deferred: true };
    }
    log(`  tasks_items: ${outcome === "rebuilt" ? "rebuilt (CHECK dropped, stage dropped, data_json added)" : "already converged — no rebuild"}`);

    // ---- Seeding: one def per project that has cards. INSERT OR IGNORE so an
    // operator's later edits always win over a re-run. Guarded on the columns
    // existing (registry contract: shape-tolerant) — a tasks_items without
    // project_id is not a cards store and has nothing to seed.
    const seedCols = tdb.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    const projects = !seedCols.includes("project_id") ? [] : tdb.prepare(
      "SELECT DISTINCT project_id FROM tasks_items WHERE project_id IS NOT NULL ORDER BY project_id"
    ).all().map((r) => Number(r.project_id));

    const names = new Map();
    const projectDbUris = [];
    try {
      const cdb = open(dbPath);
      try {
        for (const r of cdb.prepare("SELECT id, name, tasks_db_uri FROM project_spaces").all()) {
          if (r.name) names.set(Number(r.id), String(r.name));
          if (r.tasks_db_uri) projectDbUris.push(String(r.tasks_db_uri));
        }
      } finally { cdb.close(); }
    } catch { /* crow.db lookup is best-effort — fallback names, no project stores */ }

    const ins = tdb.prepare(
      "INSERT OR IGNORE INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?)"
    );
    const hasPhase = seedCols.includes("phase");
    for (const pid of projects) {
      const phases = !hasPhase ? [] : tdb.prepare(
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

    // ---- Per-project card stores (distinct tasks_db_uri ≠ the global store):
    // same rebuild, so the CHECK cannot survive where the cards actually live.
    // Best-effort per store, but LOUD on failure — a store left legacy makes a
    // configured vocabulary unwritable there, and silence would hide it.
    const globalReal = resolveSqlitePath(tasksDbPath);
    const seen = new Set([globalReal]);
    for (const uri of projectDbUris) {
      const real = resolveSqlitePath(uri);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      if (!existsSync(real)) { log(`  project store ${uri}: file absent — skipped`); continue; }
      try {
        const pdb = open(real);
        try {
          const o = await rebuildStore(pdb, real, log);
          log(`  project store ${real}: ${o}`);
        } finally { pdb.close(); }
      } catch (e) {
        log(`  project store ${real}: REBUILD FAILED — custom statuses will be unwritable there until fixed: ${(e && e.message) || e}`);
      }
    }
  } finally {
    tdb.close();
  }
}
