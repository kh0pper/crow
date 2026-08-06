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

  // (b) All targets present → applied, columns added, re-runnable.
  const f = fixture();
  try {
    const t = new Database(f.tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    const c = new Database(f.dbPath);
    c.prepare("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY)").run();
    c.prepare("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)").run();
    c.close();

    const r = await runMigrations({ migrationsDir: dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.ok(r.applied.includes("0001-board-stages"), "all targets present → applied");

    const t2 = new Database(f.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    t2.close();
    for (const col of ["stage", "assigned_bot", "plan_ref"]) {
      assert.ok(cols.includes(col), `tasks_items.${col} must exist`);
    }

    // Shape-level idempotence: re-run directly, bypassing the record. A missing
    // guard would throw "duplicate column name".
    const mod = await import(join(dir, "0001-board-stages.mjs"));
    await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    const t3 = new Database(f.tasksDbPath);
    const after = t3.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    t3.close();
    assert.deepEqual(after, cols, "a re-run must not change the column set");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
