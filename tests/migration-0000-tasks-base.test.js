// tests/migration-0000-tasks-base.test.js
//
// 0000-tasks-base: a fresh install gets the Bot Board's base tables
// (tasks_items, tasks_recurrence, tasks_briefings) in the instance-global
// tasks.db, in the LEGACY bundle shape — so migrations 0001-0004, which run
// right after it in the same pass, converge it exactly the way they converged
// every existing instance. Before this migration nothing in the product created
// those tables on a fresh store (init-db builds crow.db only, and 0001-0004
// defer when tasks_items is absent), so the first card insert in
// servers/gateway/board/card-service.js failed with "no such table".
//
// Every fixture is a real scratch data dir with a real scripts/init-db.js
// crow.db and a real tasks.db; nothing here can reach a real instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import * as base from "../scripts/migrations/0000-tasks-base.mjs";
import { TASKS_BASE_DDL, TASKS_BASE_TABLES } from "../scripts/migrations/0000-tasks-base.mjs";
import { discoverMigrations, runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import { createCard, getCard } from "../servers/gateway/board/card-service.js";
import { _resetWidgetsChangedForTest } from "../servers/gateway/widgets/changed.js";

const REPO = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(REPO, "scripts", "migrations");
// The chain AFTER 0000: what every existing instance went through.
const CHAIN = ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"];

const dirs = [];
after(() => {
  _resetWidgetsChangedForTest(); // recordMutation opens a 5 s widget window
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch instance: real init-db crow.db, plus the data dir for a tasks.db. */
function instance(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db — blank it, or a shell
    // exporting it would build the migration against a REAL database.
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_INSTANCE_SYNC: "1", CROW_DISABLE_NOSTR: "1" },
    stdio: "pipe",
    cwd: REPO,
  });
  return { dir, dbPath: join(dir, "crow.db"), tasksDbPath: join(dir, "tasks.db") };
}

/** The real fresh-install state: an empty tasks.db file, no tables at all. */
function freshStore(prefix) {
  const s = instance(prefix);
  new Database(s.tasksDbPath).close();
  return s;
}

/** A migrations dir carrying only 0001-0004, symlinked from the repo. */
function chainDir(parent) {
  const dir = join(parent, "migrations-0001-0004");
  mkdirSync(dir);
  for (const f of CHAIN) symlinkSync(join(MIGRATIONS, f), join(dir, f));
  return dir;
}

const runAll = (s, dir = MIGRATIONS) =>
  runMigrations({ migrationsDir: dir, dbPath: s.dbPath, tasksDbPath: s.tasksDbPath, sha: "test", log: () => {} });

const raw = (p) => new Database(p, { readonly: true });
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const cols = (db, table = "tasks_items") => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** Every schema object's DDL, in a stable order — the "nothing was touched" proof. */
function schemaText(p) {
  const db = raw(p);
  try {
    return JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all());
  } finally { db.close(); }
}

/** PRAGMA table_info as a name-keyed set: column ORDER may differ (0002 copies
 *  the columns in PRAGMA order), so parity is compared set-wise, not by index. */
function tableShape(p) {
  const db = raw(p);
  try {
    const rows = db.prepare("PRAGMA table_info(tasks_items)").all();
    const shape = new Map(rows.map((c) => [c.name, { name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value }]));
    return shape;
  } finally { db.close(); }
}

/** Non-autoindex index names on one table, sorted. */
function indexNames(p, table) {
  const db = raw(p);
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name")
      .all(table).map((r) => r.name);
  } finally { db.close(); }
}

test("0000 sorts first and is discovered; id matches the filename", () => {
  assert.equal(base.id, "0000-tasks-base");
  const found = discoverMigrations(MIGRATIONS);
  assert.ok(found[0].endsWith("/0000-tasks-base.mjs"),
    `0000 must sort FIRST so 0001-0004 run right after it; first was ${found[0]}`);
});

test("fresh store: 0000-0004 all recorded applied, none deferred, and tasks_items ends converged", async () => {
  const s = freshStore("mig0000-fresh-");

  const r = await runAll(s);
  for (const id of ["0000-tasks-base", "0001-board-stages", "0002-board-defs", "0003-tracker-convergence", "0004-track1-card-model"]) {
    assert.ok(r.applied.includes(id), `${id} must be recorded applied; applied=${JSON.stringify(r.applied)}`);
    assert.ok(!r.deferred.includes(id), `${id} must not defer on a store 0000 just built; deferred=${JSON.stringify(r.deferred)}`);
  }

  // Recorded in the bookkeeping table too — `applied` is the runner's own claim.
  const book = raw(s.dbPath);
  try {
    for (const id of ["0000-tasks-base", "0001-board-stages", "0002-board-defs", "0003-tracker-convergence", "0004-track1-card-model"]) {
      assert.ok(book.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(id), `${id} must have a schema_migrations row`);
    }
  } finally { book.close(); }

  const db = raw(s.tasksDbPath);
  try {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
    const columns = cols(db);
    assert.ok(!columns.includes("stage"), "0002 drops stage");
    assert.ok(!/CHECK\s*\(\s*status/i.test(sql), "0002 drops the status CHECK");
    for (const c of [
      "data_json", // 0002
      "assigned_bot", // 0001, dormant but surviving
      "board_id", "bot_id", "action_needed", "next_followup_date", "processing_lease", "processing_lease_status", // 0003
      "autonomy", "archived_at", // 0004
    ]) {
      assert.ok(columns.includes(c), `converged tasks_items must have ${c}`);
    }
    assert.ok(!columns.includes("plan_ref"), "0004 drops plan_ref");

    for (const t of ["board_defs", "board_plans", "board_results", "board_mutations"]) {
      assert.ok(hasTable(db, t), `${t} must exist on a fresh store`);
    }
    // 0000's own tables, still there after the chain rebuilt tasks_items.
    for (const t of TASKS_BASE_TABLES) assert.ok(hasTable(db, t), `${t} must exist on a fresh store`);
  } finally { db.close(); }

  // The bundle's indexes are part of the shape 0002 rebuilds (it re-creates
  // every index it finds), plus the two 0003 adds. A fresh store must start
  // from the same index set as an old one.
  assert.deepEqual(indexNames(s.tasksDbPath, "tasks_items"), [
    "idx_tasks_items_board", "idx_tasks_items_due", "idx_tasks_items_lease",
    "idx_tasks_items_parent", "idx_tasks_items_project", "idx_tasks_items_recurrence",
    "idx_tasks_items_status",
  ]);
  assert.ok(indexNames(s.tasksDbPath, "tasks_briefings").includes("idx_tasks_briefings_date"));
});

test("converged parity: fresh (0000 then 0001-0004) has the same tasks_items shape as a legacy store (0001-0004 alone)", async () => {
  const fresh = freshStore("mig0000-parity-fresh-");
  await runAll(fresh);

  // The original legacy store: the bundle DDL verbatim, with a row in it.
  const legacy = instance("mig0000-parity-legacy-");
  const t = new Database(legacy.tasksDbPath);
  t.exec(TASKS_BASE_DDL);
  t.prepare(
    "INSERT INTO tasks_items (title, status, priority, phase, project_id, tags) VALUES (?,?,?,?,?,?)",
  ).run("legacy card", "in_progress", 2, "Drafting", 11, "legacy-gated");
  t.close();

  const r = await runAll(legacy, chainDir(legacy.dir));
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence", "0004-track1-card-model"]) {
    assert.ok(r.applied.includes(id), `${id} must apply over the legacy store; deferred=${JSON.stringify(r.deferred)}`);
  }

  const a = tableShape(fresh.tasksDbPath);
  const b = tableShape(legacy.tasksDbPath);
  // Compared as SETS: 0002 copies columns in PRAGMA order, so a column's index
  // is an artifact of how the table was built, not part of the shape.
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "same column names");
  for (const [name, want] of b) {
    assert.deepEqual(a.get(name), want, `column ${name}: same type/NOT NULL/default on both paths`);
  }
  assert.deepEqual(indexNames(fresh.tasksDbPath, "tasks_items"), indexNames(legacy.tasksDbPath, "tasks_items"),
    "same index set on both paths");
});

test("a card can be created on the fresh store through the real card-service path", async () => {
  const s = freshStore("mig0000-card-");
  await runAll(s);

  const tdb = createDbClient(s.tasksDbPath);
  try {
    // createCard is the lowest-level exported writer that INSERTs into
    // tasks_items (board routes and MCP tools all funnel through it); it also
    // records the board_mutations row, so the whole write path is exercised.
    const { id } = await createCard(tdb, { title: "first card on a fresh install" }, { kind: "human", id: "operator", jobId: null });
    assert.ok(Number.isInteger(id) && id > 0, `createCard must return a row id, got ${id}`);

    const card = await getCard(tdb, id);
    assert.equal(card.title, "first card on a fresh install");
    assert.equal(card.status, "pending", "builtin default status");
    assert.equal(card.autonomy, "gated", "0004's default applies to a card created afterwards");

    const { rows } = await tdb.execute({ sql: "SELECT verb FROM board_mutations WHERE item_id=?", args: [id] });
    assert.deepEqual(rows.map((x) => x.verb), ["create"], "provenance row written (board_mutations exists on a fresh store)");
  } finally {
    await tdb.close();
  }
});

test("0000 never touches an existing table: on a converged store every table is 'present' and the schema text is byte-identical", async () => {
  const s = freshStore("mig0000-converged-");
  await runAll(s);

  const before = schemaText(s.tasksDbPath);
  const lines = [];
  base.run({ dbPath: s.dbPath, tasksDbPath: s.tasksDbPath, log: (m) => lines.push(m) });
  const after = schemaText(s.tasksDbPath);

  assert.equal(after, before, "no CREATE, no ALTER, no DROP — the schema text must not change at all");
  for (const t of TASKS_BASE_TABLES) {
    assert.ok(lines.some((l) => l.includes(`${t}: present`)), `${t} must log 'present'; log was:\n${lines.join("\n")}`);
  }
});

test("0000 never rebuilds or alters an existing tasks_items, whatever its shape", () => {
  const s = instance("mig0000-foreign-");
  const t = new Database(s.tasksDbPath);
  // A shape 0000's DDL could never have produced — not even the columns its
  // indexes name. Creating an index here would abort the registry, so a table
  // that already exists gets none (it is not ours to change).
  const FOREIGN = "CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)";
  t.exec(FOREIGN);
  t.prepare("INSERT INTO tasks_items (title) VALUES (?)").run("someone else's table");
  const before = JSON.stringify(t.prepare("SELECT type, name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all());
  t.close();

  const lines = [];
  base.run({ tasksDbPath: s.tasksDbPath, log: (m) => lines.push(m) });

  const db = raw(s.tasksDbPath);
  try {
    const after = JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all());
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks_items'").get().sql;
    assert.equal(sql, FOREIGN, "the foreign shape is untouched — no ALTER, no rebuild, no added index");
    assert.deepEqual(cols(db), ["id", "title"], "no column was added to it");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n, 1, "its rows survive");
    // The two absent tables are still created next to it — and only they change.
    assert.ok(hasTable(db, "tasks_recurrence") && hasTable(db, "tasks_briefings"));
    assert.notEqual(after, before, "the two missing tables were created");
  } finally { db.close(); }

  assert.ok(lines.some((l) => l.includes("tasks_items: present")), `log was:\n${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.includes("tasks_recurrence: created")), `log was:\n${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.includes("tasks_briefings: created")), `log was:\n${lines.join("\n")}`);
});

test("0000 run twice on a fresh store: the second run is a no-op", () => {
  const s = freshStore("mig0000-twice-");

  const first = [];
  base.run({ tasksDbPath: s.tasksDbPath, log: (m) => first.push(m) });
  const mid = schemaText(s.tasksDbPath);

  const second = [];
  base.run({ tasksDbPath: s.tasksDbPath, log: (m) => second.push(m) });

  assert.equal(schemaText(s.tasksDbPath), mid, "the second run creates nothing");
  for (const t of TASKS_BASE_TABLES) {
    assert.ok(first.some((l) => l.includes(`${t}: created`)), `${t} created on the first run; log:\n${first.join("\n")}`);
    assert.ok(second.some((l) => l.includes(`${t}: present`)), `${t} present on the second run; log:\n${second.join("\n")}`);
  }
});

test("a legacy store with rows keeps them through 0000 then 0001-0004", async () => {
  const s = instance("mig0000-legacy-rows-");
  const t = new Database(s.tasksDbPath);
  t.exec(TASKS_BASE_DDL);
  const ins = t.prepare("INSERT INTO tasks_items (title, status, priority, project_id, phase) VALUES (?,?,?,?,?)");
  ins.run("keep me one", "pending", 3, 4, null);
  ins.run("keep me two", "in_progress", 1, 4, "Drafting");
  ins.run("keep me three", "done", 5, null, null);
  const beforeCount = t.prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n;
  t.close();

  const lines = [];
  base.run({ tasksDbPath: s.tasksDbPath, log: (m) => lines.push(m) });
  for (const tbl of TASKS_BASE_TABLES) {
    assert.ok(lines.some((l) => l.includes(`${tbl}: present`)), `${tbl} already existed; log:\n${lines.join("\n")}`);
  }

  await runAll(s, chainDir(s.dir));

  const db = raw(s.tasksDbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n, beforeCount, "no row lost or duplicated");
    assert.deepEqual(
      db.prepare("SELECT title FROM tasks_items ORDER BY id").all().map((r) => r.title),
      ["keep me one", "keep me two", "keep me three"],
    );
  } finally { db.close(); }
});
test("0000 alone writes the LEGACY bundle shape, not the converged one", () => {
  const d = mkdtempSync(join(tmpdir(), "tb-raw-"));
  dirs.push(d);
  const tasksDbPath = join(d, "tasks.db");
  base.run({ tasksDbPath });
  const db = new Database(tasksDbPath, { readonly: true });
  try {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
    // 0002's deriveNewDdl is written against this exact text; 0001-0004 stay the
    // only path to the converged shape.
    assert.match(sql, /CHECK \(status IN \('pending','in_progress','done','cancelled'\)\)/);
    const cols = db.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    for (const c of ["data_json", "stage", "assigned_bot", "board_id", "archived_at"]) {
      assert.ok(!cols.includes(c), `0000 must not add ${c}: that is the chain's job`);
    }
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tasks_%' ORDER BY name").all().map((r) => r.name);
    assert.equal(idx.length, 7, "the bundle's seven indexes");
  } finally {
    db.close();
  }
});
