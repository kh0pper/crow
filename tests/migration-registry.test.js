/**
 * Per-instance migration registry (scripts/migrations/).
 *
 * Fixtures are real temp directories with real SQLite files, so the runner's
 * actual import + bookkeeping path is exercised. Fixture migration bodies import
 * ONLY node: builtins — a bare specifier like "better-sqlite3" cannot resolve
 * from os.tmpdir(), which has no node_modules anywhere on its path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations, discoverMigrations } from "../scripts/migrations/runner.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "migreg-"));
  const dir = join(root, "migrations");
  mkdirSync(dir);
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");
  new Database(dbPath).close();
  new Database(tasksDbPath).close();
  return { root, dir, dbPath, tasksDbPath };
}

const wm = (dir, name, body) => writeFileSync(join(dir, name), body);

const sideEffect = (id, file) =>
  `import { appendFileSync } from "node:fs";
   export const id = ${JSON.stringify(id)};
   export function run() { appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(id + "\n")}); }`;

test("runs migrations in filename order, not creation order", async () => {
  const f = fixture();
  try {
    const order = join(f.root, "order.txt");
    // Created out of order deliberately: readdirSync order is unspecified, so a
    // fixture whose files happen to be created in sorted order proves nothing.
    wm(f.dir, "0003-c.mjs", sideEffect("0003-c", order));
    wm(f.dir, "0001-a.mjs", sideEffect("0001-a", order));
    wm(f.dir, "0002-b.mjs", sideEffect("0002-b", order));

    const res = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(res.applied, ["0001-a", "0002-b", "0003-c"]);
    assert.equal(readFileSync(order, "utf8"), "0001-a\n0002-b\n0003-c\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("is idempotent — the body runs exactly once across two calls", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "hits.txt");
    wm(f.dir, "0001-once.mjs", sideEffect("0001-once", hits));

    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(a.applied, ["0001-once"]);
    assert.deepEqual(b.applied, []);
    assert.deepEqual(b.skipped, ["0001-once"]);
    assert.equal(readFileSync(hits, "utf8"), "0001-once\n", "the body must run exactly once");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a DEFERRED migration is NOT recorded and runs again next time", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "deferred.txt");
    wm(f.dir, "0001-defer.mjs",
      `import { appendFileSync } from "node:fs";
       export const id = "0001-defer";
       export function run() { appendFileSync(${JSON.stringify(hits)}, "x"); return { deferred: true }; }`);

    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(a.deferred, ["0001-defer"]);
    assert.deepEqual(a.applied, []);
    assert.deepEqual(b.deferred, ["0001-defer"], "a deferred migration must retry, not be recorded");
    assert.equal(readFileSync(hits, "utf8"), "xx", "the body must run BOTH times");

    const db = new Database(f.dbPath);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    db.close();
    assert.deepEqual(rows, [], "a deferral must leave no bookkeeping row behind");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("creates schema_migrations lazily — never requires init-db", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-noop.mjs", `export const id = "0001-noop"; export function run() {}`);
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    const db = new Database(f.dbPath);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    db.close();
    assert.ok(t, "the runner must CREATE TABLE IF NOT EXISTS its own bookkeeping table");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ignores files that do not match the NNNN-slug.mjs pattern", () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-real.mjs", `export const id = "0001-real"; export function run() {}`);
    wm(f.dir, "README.md", "not a migration");
    wm(f.dir, "helper.mjs", "export const x = 1;");
    wm(f.dir, "0002-draft.mjs.bak", "stray");

    const found = discoverMigrations(f.dir).map((p) => p.split("/").pop());
    assert.deepEqual(found, ["0001-real.mjs"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a throwing migration aborts the rest and records nothing", async () => {
  const f = fixture();
  try {
    const after = join(f.root, "after.txt");
    wm(f.dir, "0001-boom.mjs", `export const id = "0001-boom"; export function run() { throw new Error("boom"); }`);
    wm(f.dir, "0002-after.mjs", sideEffect("0002-after", after));   // observable side effect

    await assert.rejects(
      () => runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath }),
      /boom/,
    );

    assert.equal(existsSync(after), false, "0002 must NOT run after 0001 throws");
    const db = new Database(f.dbPath);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    db.close();
    assert.deepEqual(rows, [], "a failed migration must not be recorded");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0001-board-stages: adds columns, DEFERS when ANY target table is absent", async () => {
  const dir = join(import.meta.dirname, "..", "scripts", "migrations");

  // (a) Every target absent → deferred, not recorded.
  const bare = fixture();
  try {
    const r = await runMigrations({ migrationsDir: dir, dbPath: bare.dbPath, tasksDbPath: bare.tasksDbPath });
    assert.ok(r.deferred.includes("0001-board-stages"),
      "a fresh instance has no tasks_items yet — recording this as applied is the original bug");
    assert.ok(!r.applied.includes("0001-board-stages"));
  } finally { rmSync(bare.root, { recursive: true, force: true }); }

  // (a2) THE PRODUCTION SHAPE: crow.db tables exist (init-db has run at boot),
  // tasks_items does not (the tasks bundle has not started). This is every real
  // instance at boot — an "all absent" rule would wrongly record it as applied
  // here, and the tasks_items columns would never land.
  const mixed = fixture();
  try {
    const c = new Database(mixed.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const r = await runMigrations({ migrationsDir: dir, dbPath: mixed.dbPath, tasksDbPath: mixed.tasksDbPath });
    assert.ok(r.deferred.includes("0001-board-stages"),
      "crow.db tables present + tasks_items absent MUST defer — this is the real-instance shape");
    assert.ok(!r.applied.includes("0001-board-stages"));

    // The crow.db half still applied its column — deferral is about the RECORD.
    const c2 = new Database(mixed.dbPath);
    const cols = c2.prepare("PRAGMA table_info(project_spaces)").all().map((x) => x.name);
    c2.close();
    assert.ok(cols.includes("repo_path"), "present tables must still be migrated");
  } finally { rmSync(mixed.root, { recursive: true, force: true }); }

  // (b) All targets present → 0001 applies its columns and is re-runnable.
  // Scoped to 0001's OWN run() — a whole-directory run no longer preserves
  // these columns (0002 rebuilds the table and drops `stage` by design); the
  // converged end state is case (c) below.
  const f = fixture();
  try {
    const t = new Database(f.tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    const c = new Database(f.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const mod = await import(join(dir, "0001-board-stages.mjs"));
    const out = await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.ok(!out || !out.deferred, "all targets present → not deferred");

    const t2 = new Database(f.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    t2.close();
    for (const col of ["stage", "assigned_bot", "plan_ref"]) {
      assert.ok(cols.includes(col), `tasks_items.${col} must exist`);
    }

    // Shape-level idempotence: re-run directly, bypassing the record. A missing
    // guard would throw "duplicate column name".
    await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    const t3 = new Database(f.tasksDbPath);
    const after = t3.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    t3.close();
    assert.deepEqual(after, cols, "a re-run must not change the column set");
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  // (c) The CONVERGED shape: a whole-directory run over a bundle-shaped store
  // ends with 0002's world — no stage, no status CHECK, data_json + board_defs
  // present — and every migration recorded.
  const g = fixture();
  try {
    const t = new Database(g.tasksDbPath);
    t.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT, " +
      "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')), " +
      "phase TEXT, project_id INTEGER)");
    t.close();
    const c = new Database(g.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const r = await runMigrations({ migrationsDir: dir, dbPath: g.dbPath, tasksDbPath: g.tasksDbPath });
    assert.ok(r.applied.includes("0001-board-stages"));
    assert.ok(r.applied.includes("0002-board-defs"));

    const t2 = new Database(g.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    const sql = t2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
    const hasBoardDefs = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_defs'").get();
    const hasBoardPlans = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_plans'").get();
    const hasBoardResults = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_results'").get();
    const hasBoardMutations = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_mutations'").get();
    const hasTasksBriefings = !!t2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_briefings'").get();
    t2.close();
    assert.ok(!cols.includes("stage"), "converged shape has no stage");
    assert.ok(cols.includes("data_json"), "converged shape has data_json");
    assert.ok(cols.includes("assigned_bot"), "dormant column assigned_bot survives");
    assert.ok(!cols.includes("plan_ref"), "plan_ref is DROPPED by 0004 — no longer a survivor");
    assert.ok(!/CHECK\s*\(\s*status/i.test(sql), "converged shape has no status CHECK");
    assert.ok(hasBoardDefs, "board_defs exists");
    assert.ok(r.applied.includes("0003-tracker-convergence"),
      "no tracker tables in the fixture crow.db → 0003 records as a column-only no-op");
    assert.ok(cols.includes("board_id"), "converged shape has board_id (0003)");
    assert.ok(cols.includes("processing_lease_status"), "converged shape has the lease columns (0003)");
    assert.ok(r.applied.includes("0004-track1-card-model"), "0004 applies over the converged 0001-0003 shape");
    assert.ok(cols.includes("autonomy") && cols.includes("archived_at"), "converged shape has autonomy + archived_at (0004)");
    assert.ok(hasBoardPlans && hasBoardResults && hasBoardMutations, "converged shape has the three Track 1 tables (0004)");
    assert.ok(hasTasksBriefings, "converged shape has tasks_briefings (0004)");
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test("ORDER INVARIANT: registry runs after the schema guard, before the first createDbClient", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "index.js"), "utf8");

  // Anchor on the guard's CALL, not its import: `runGuardedInitDb` first appears
  // in the dynamic-import destructure, so a plain indexOf would also match a
  // registry block wrongly placed INSIDE the guard block.
  const guardCall = src.indexOf("await runGuardedInitDb(");
  const registry = src.indexOf("runMigrations(");
  const firstClient = src.indexOf("initOAuthTables()");

  assert.ok(guardCall > 0, "the schema guard call must be present");
  assert.ok(registry > 0, "the registry call must be present");
  assert.ok(firstClient > 0, "initOAuthTables must be present");
  assert.ok(guardCall < registry, "registry must run AFTER the schema guard");
  assert.ok(registry < firstClient,
    "registry must run BEFORE the first createDbClient — createDbClient registers a " +
    "never-closed per-path WAL keeper, and a later migration-guard restore would " +
    "swap the DB file under a pinned inode (split-brain)");
});
