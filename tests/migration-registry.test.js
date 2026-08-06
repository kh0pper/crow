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
