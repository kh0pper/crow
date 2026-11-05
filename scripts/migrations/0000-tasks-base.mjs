// scripts/migrations/0000-tasks-base.mjs
//
// The Bot Board's card store — the instance-global tasks.db (tasksDbPath() in
// scripts/pi-bots/instance-paths.mjs) — gets its base tables back on a fresh
// install.
//
// WHY IT EXISTS. tasks_items and friends used to be created by a tasks bundle
// that no longer ships. scripts/init-db.js builds crow.db only, and 0001-0004
// ALTER / rebuild / converge tasks_items but DEFER when it is absent ("the
// bundle has not started yet"). On a fresh install nothing created it at all,
// so the first card insert in servers/gateway/board/card-service.js failed with
// "no such table: tasks_items" — the board had no cards, and no way to get one.
//
// WHY 0000. It sorts FIRST, so on a fresh store 0001-0004 run right after it in
// the SAME pass and converge this table exactly the way they converged every
// existing instance. The runner orders by filename and never assumes ids start
// at 0001 or are contiguous (0012 is already missing), so a lower number is the
// whole mechanism — no runner change, no init-db change, no SCHEMA_GENERATION
// bump.
//
// WHY THE LEGACY SHAPE AND NOT THE CONVERGED ONE. The DDL below is the original
// bundle CREATE, verbatim from a pre-migration backup (including the status
// CHECK and the ON DELETE clauses), because 0002's deriveNewDdl() regexes are
// written against exactly this text — it rebuilds the table by transforming the
// live sqlite_master string. Shipping the CONVERGED shape here instead would
// create a second path to the converged shape, and fresh stores would be the
// only stores that never went through 0001-0004; the two paths would drift.
// 0001-0004 stay the single path, so a fresh store and an old store end up
// identical (tests/migration-0000-tasks-base.test.js asserts that parity).
//
// SHAPE RULE. CREATE ... IF NOT EXISTS only — never an ALTER, never a DROP. A
// table that already exists is never touched, whatever its shape: every
// existing instance (and every store restored from backup) keeps its own
// schema text byte-for-byte, and its rows. That includes the bundle's indexes:
// an index belongs to its table, so the index statements run only for a table
// THIS run created. Every real store already has them (from the bundle DDL, or
// re-created by 0002's rebuild), and on a foreign shape a CREATE INDEX naming a
// column that store does not have would abort the whole registry — which would
// take 0001-0004 down with it.
//
// It never defers: it is the migration that MAKES the targets exist, so there
// is nothing to wait for. Per-project card stores (project_spaces.tasks_db_uri)
// are out of scope — they are opt-in, and 0002/0004 already skip a store file
// that does not exist.
import Database from "better-sqlite3";

export const id = "0000-tasks-base";

// rollbackSafe: CREATE TABLE/INDEX IF NOT EXISTS only, so older code (which
// never selects from these tables) keeps working on the wider shape.
export const rollbackSafe = true;

/** The three base tables this migration is responsible for. */
export const TASKS_BASE_TABLES = ["tasks_recurrence", "tasks_items", "tasks_briefings"];

// The original bundle DDL, verbatim — tables and indexes as the bundle wrote
// them. Split only so run() can decide about the indexes per table; the two
// pieces concatenate back into the original text (TASKS_BASE_DDL, which tests
// also use as the legacy fixture).
export const TASKS_BASE_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS tasks_recurrence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL CHECK (pattern IN ('daily','weekly','monthly','yearly')),
      interval INTEGER NOT NULL DEFAULT 1,
      until_date TEXT,
      next_occurrence TEXT,
      last_occurrence TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE IF NOT EXISTS tasks_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
      due_date TEXT,
      phase TEXT,
      owner TEXT,
      tags TEXT,
      project_id INTEGER,
      parent_id INTEGER REFERENCES tasks_items(id) ON DELETE CASCADE,
      recurrence_id INTEGER REFERENCES tasks_recurrence(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
CREATE TABLE IF NOT EXISTS tasks_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      briefing_date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
`;

export const TASKS_BASE_INDEXES = [
  ["tasks_briefings", "CREATE INDEX IF NOT EXISTS idx_tasks_briefings_date ON tasks_briefings(briefing_date DESC);"],
  ["tasks_items", "CREATE INDEX IF NOT EXISTS idx_tasks_items_due ON tasks_items(due_date);"],
  ["tasks_items", "CREATE INDEX IF NOT EXISTS idx_tasks_items_parent ON tasks_items(parent_id);"],
  ["tasks_items", "CREATE INDEX IF NOT EXISTS idx_tasks_items_project ON tasks_items(project_id);"],
  ["tasks_items", "CREATE INDEX IF NOT EXISTS idx_tasks_items_recurrence ON tasks_items(recurrence_id);"],
  ["tasks_items", "CREATE INDEX IF NOT EXISTS idx_tasks_items_status ON tasks_items(status);"],
  ["tasks_recurrence", "CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_next ON tasks_recurrence(next_occurrence);"],
];

/** The whole bundle DDL as one string: the legacy fixture shape for tests. */
export const TASKS_BASE_DDL = TASKS_BASE_TABLES_DDL + TASKS_BASE_INDEXES.map(([, sql]) => sql).join("\n") + "\n";

export function run({ tasksDbPath, log = () => {} }) {
  const db = new Database(tasksDbPath);
  db.pragma("busy_timeout = 10000");
  try {
    // Presence is read BEFORE the DDL so the log names what this run did, not
    // what the store looks like afterwards (CREATE IF NOT EXISTS is silent).
    const had = new Map(
      TASKS_BASE_TABLES.map((t) => [
        t,
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t),
      ]),
    );
    db.transaction(() => {
      db.exec(TASKS_BASE_TABLES_DDL);
      for (const [table, sql] of TASKS_BASE_INDEXES) {
        // An index is an object ON its table, so on a table this run did not
        // create the index set is not ours to change — the shape rule keeps an
        // existing table untouched, and a foreign shape may not even have the
        // indexed column (a CREATE INDEX there would abort the whole registry,
        // taking 0001-0004 down with it). Every real store already carries
        // these indexes, from the bundle DDL or from 0002's rebuild.
        if (had.get(table)) continue;
        db.exec(sql);
      }
    })();
    for (const t of TASKS_BASE_TABLES) log(`  ${t}: ${had.get(t) ? "present" : "created"}`);
  } finally {
    db.close();
  }
  // Nothing returned: applied. There is no deferral state here (see header).
}