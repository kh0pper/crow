// 0022-archived-name-cleanup + the project pickers: both archive kinds are hidden from every picker,
// and the cleanup strips the old " — archived" suffix only from status-archived, not-deleted rows.
// Scratch DBs only; never touches ~/.crow.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const mod = await import("../scripts/migrations/0022-archived-name-cleanup.mjs");
const { discoverMigrations, runMigrations } = await import("../scripts/migrations/runner.mjs");
const { activeProjectWhere } = await import("../servers/shared/shell-items.js");

const REPO = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(REPO, "scripts", "migrations");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }

const SFX = " — archived";
let n = 0;
function seed(dbPath) {
  const d = new Database(dbPath);
  const ins = d.prepare("INSERT INTO project_spaces (slug, name, status, archived_at, type) VALUES (?, ?, ?, ?, ?)");
  const rows = {
    active: ins.run("p-active", "Active", "active", null, "general").lastInsertRowid,
    archivedOld: ins.run("p-old", "Old plan" + SFX, "archived", null, "general").lastInsertRowid,
    archivedPlain: ins.run("p-plain", "Plain archived", "archived", null, "general").lastInsertRowid,
    archivedMid: ins.run("p-mid", "Mid — archived thing", "archived", null, "general").lastInsertRowid,
    archivedOnlySfx: ins.run("p-only", SFX, "archived", null, "general").lastInsertRowid,
    deleted: ins.run("p-del", "Gone" + SFX, "archived", "2026-10-01 00:00:00", "general").lastInsertRowid,
    deletedActive: ins.run("p-del2", "Tombstone" + SFX, "active", "2026-10-01 00:00:00", "general").lastInsertRowid,
    activeSfx: ins.run("p-act-sfx", "Live" + SFX, "active", null, "general").lastInsertRowid,
    learner: ins.run("p-learn", "Kid", "active", null, "learner_profile").lastInsertRowid,
  };
  d.close();
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Number(v)]));
}
function freshDb() {
  const dir = tmp("m0022-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const dbPath = join(dir, "crow.db");
  return { dir, dbPath, ids: seed(dbPath) };
}
const snapshot = (dbPath) => {
  const d = new Database(dbPath, { readonly: true });
  const o = d.prepare("SELECT id, name, status, archived_at, updated_at FROM project_spaces ORDER BY id").all();
  d.close();
  return o;
};

test("the module id matches its filename and is discovered", () => {
  assert.equal(mod.id, "0022-archived-name-cleanup");
  assert.ok(discoverMigrations(MIGRATIONS).some((p) => p.endsWith("/0022-archived-name-cleanup.mjs")));
});

test("picker hides archived_at rows and status-archived rows", () => {
  const { dbPath, ids } = freshDb();
  const d = new Database(dbPath, { readonly: true });
  try {
    const shown = (alias) => d.prepare(alias
      ? `SELECT p.id FROM project_spaces p WHERE ${activeProjectWhere(alias)} ORDER BY p.id`
      : `SELECT id FROM project_spaces WHERE ${activeProjectWhere()} ORDER BY id`).all().map((r) => r.id);
    const live = shown().filter((id) => Object.values(ids).includes(id));
    assert.deepEqual(live, [ids.active, ids.activeSfx].sort((a, b) => a - b));
    assert.deepEqual(shown("p").filter((id) => Object.values(ids).includes(id)), live);
  } finally { d.close(); }
});

// Each picker takes its list from activeProjectWhere(), never the old archived_at-only filter.
const PICKERS = [
  "servers/gateway/dashboard/panels/bot-builder/html.js",
  "servers/gateway/dashboard/panels/bot-builder/voice-bot-editor.js",
  "servers/gateway/dashboard/panels/bot-builder/tab-advanced.js",
  "servers/gateway/board-mcp.js",
  "servers/gateway/routes/bot-board-api.js",
];
for (const f of PICKERS) {
  test(`picker ${f} uses activeProjectWhere`, () => {
    const src = readFileSync(join(REPO, f), "utf8");
    assert.match(src, /FROM project_spaces WHERE \$\{activeProjectWhere\(\)\} ORDER BY id/);
    assert.doesNotMatch(src, /FROM project_spaces WHERE archived_at IS NULL ORDER BY id/);
    assert.match(src, /import \{ activeProjectWhere \} from /);
  });
}

test("cleanup strips the suffix only on status-archived rows without archived_at", async () => {
  const { dbPath, ids } = freshDb();
  // init-db already ran the step on an empty table; reseed ran after it, so run the rail now.
  const out = await runMigrations({ migrationsDir: MIGRATIONS, dbPath, tasksDbPath: join(tmp("m0022-t-"), "tasks.db") });
  assert.ok(out.applied.includes("0022-archived-name-cleanup"));
  const by = Object.fromEntries(snapshot(dbPath).map((r) => [r.id, r]));
  assert.equal(by[ids.archivedOld].name, "Old plan");
  assert.equal(by[ids.archivedPlain].name, "Plain archived");
  assert.equal(by[ids.archivedMid].name, "Mid — archived thing");
  assert.equal(by[ids.archivedOnlySfx].name, SFX, "a name that is only the suffix is left alone");
  assert.equal(by[ids.deleted].name, "Gone" + SFX, "a deleted row is untouched");
  assert.equal(by[ids.deletedActive].name, "Tombstone" + SFX);
  assert.equal(by[ids.activeSfx].name, "Live" + SFX, "an active row is untouched");
});

test("cleanup never writes archived_at", () => {
  const { dbPath, ids } = freshDb();
  const before = snapshot(dbPath);
  mod.run({ dbPath });
  const after_ = snapshot(dbPath);
  assert.deepEqual(after_.map((r) => r.archived_at), before.map((r) => r.archived_at));
  assert.equal(after_.find((r) => r.id === ids.archivedOld).archived_at, null);
  assert.deepEqual(after_.map((r) => r.status), before.map((r) => r.status));
  assert.deepEqual(after_.map((r) => r.updated_at), before.map((r) => r.updated_at));
});

test("cleanup is idempotent, through the module, the runner and init-db", async () => {
  const { dir, dbPath, ids } = freshDb();
  assert.equal(mod.run({ dbPath }).applied, true);
  const once = snapshot(dbPath);
  mod.run({ dbPath });
  assert.deepEqual(snapshot(dbPath), once);
  const tasksDbPath = join(tmp("m0022-t2-"), "tasks.db");
  const first = await runMigrations({ migrationsDir: MIGRATIONS, dbPath, tasksDbPath });
  const second = await runMigrations({ migrationsDir: MIGRATIONS, dbPath, tasksDbPath });
  assert.ok(first.applied.includes("0022-archived-name-cleanup"));
  assert.ok(second.skipped.includes("0022-archived-name-cleanup"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  assert.deepEqual(snapshot(dbPath), once);
  assert.equal(once.find((r) => r.id === ids.archivedOld).name, "Old plan");
});

test("init-db itself converges an old install (the guarded step)", () => {
  const { dir, dbPath, ids } = freshDb();
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const by = Object.fromEntries(snapshot(dbPath).map((r) => [r.id, r]));
  assert.equal(by[ids.archivedOld].name, "Old plan");
  assert.equal(by[ids.deleted].name, "Gone" + SFX);
  assert.equal(by[ids.deleted].archived_at, "2026-10-01 00:00:00");
});

test("a database without project_spaces defers instead of failing", () => {
  const p = join(tmp("m0022-none-"), "crow.db");
  new Database(p).close();
  assert.deepEqual(mod.run({ dbPath: p }), { deferred: true });
});
