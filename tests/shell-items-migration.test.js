// 0010-shell-items: the shell_items table (a project for Perch threads, artifacts and Workspace
// files) on both rails — init-db's CREATE and this numbered migration — plus its best-effort backfill.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0010-shell-items.mjs";

const { run, id, SHELL_ITEMS_DDL } = mod;

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function shape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const out = {
    cols: d.prepare("PRAGMA table_info(shell_items)").all(),
    idx: d.prepare("PRAGMA index_list(shell_items)").all().map(({ seq, ...rest }) => rest),
  };
  d.close();
  return out;
}

test("the module id matches its filename", () => {
  assert.equal(id, "0010-shell-items");
});

test("the shape matches what init-db produces", () => {
  const dir = tmp("shell-init-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const want = shape(join(dir, "crow.db"));
  const fresh = join(tmp("shell-fresh-"), "crow.db");
  const db = new Database(fresh);
  db.exec(SHELL_ITEMS_DDL);
  db.close();
  assert.ok(want.cols.length > 0, "init-db created shell_items");
  assert.deepEqual(shape(fresh), want);
});

test("a thread row cannot carry a card", () => {
  const db = new Database(":memory:");
  db.exec(SHELL_ITEMS_DDL);
  assert.throws(
    () => db.prepare("INSERT INTO shell_items (item_kind,item_ref,project_id,card_id,set_by) VALUES ('perch_thread','perchlive-a',NULL,7,'origin')").run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test("run is idempotent", () => {
  const dbPath = join(tmp("shell-idem-"), "crow.db");
  new Database(dbPath).close();
  const r1 = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare("INSERT INTO shell_items (item_kind,item_ref,set_by) VALUES ('artifact','art_1','operator')").run();
  const n1 = db.prepare("SELECT COUNT(*) AS n FROM shell_items").get().n;
  db.close();
  const r2 = run({ dbPath, log: () => {} });
  const db2 = new Database(dbPath, { readonly: true });
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM shell_items").get().n, n1);
  db2.close();
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);
});

test("it never drops or deletes", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/migrations/0010-shell-items.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
});

test("bot_sessions is untouched", () => {
  const dbPath = join(tmp("shell-bs-"), "crow.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, card_id INTEGER)");
  const before = db.prepare("PRAGMA table_info(bot_sessions)").all();
  db.close();
  run({ dbPath, log: () => {} });
  const after_ = new Database(dbPath, { readonly: true });
  assert.deepEqual(after_.prepare("PRAGMA table_info(bot_sessions)").all(), before);
  after_.close();
});

test("the DDL is byte-identical to init-db's block", async () => {
  const { readFileSync } = await import("node:fs");
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.ok(init.includes(SHELL_ITEMS_DDL));
});

// ---- Task 1.2: the best-effort backfill ----
import { existsSync } from "node:fs";
import { deriveThreadProject, deriveArtifactProject, ACTIVE_PROJECT_WHERE } from "../servers/shared/shell-items.js";

test("deriveThreadProject prefers the thread's card, then the session, then the bot", () => {
  assert.equal(deriveThreadProject({ cardProjectId: 4, sessionProjectId: 2, botProjectId: 3, liveProjectIds: new Set([2, 3, 4]) }), 4);
  assert.equal(deriveThreadProject({ cardProjectId: null, sessionProjectId: 9, botProjectId: 3, liveProjectIds: new Set([3]) }), 3);
  assert.equal(deriveThreadProject({ cardProjectId: null, sessionProjectId: null, botProjectId: null, liveProjectIds: new Set([1]) }), null);
});

test("deriveArtifactProject prefers the card, then the origin thread, then the bot", () => {
  assert.equal(deriveArtifactProject({ cardProjectId: 4, threadProjectId: 2, botProjectId: 3, liveProjectIds: new Set([2, 3, 4]) }), 4);
  assert.equal(deriveArtifactProject({ cardProjectId: null, threadProjectId: 2, botProjectId: 3, liveProjectIds: new Set([2, 3]) }), 2);
  assert.equal(deriveArtifactProject({ cardProjectId: null, threadProjectId: null, botProjectId: 3, liveProjectIds: new Set([3]) }), 3);
});

test("an archived or deleted project derives to null", () => {
  assert.equal(deriveThreadProject({ cardProjectId: 4, sessionProjectId: 2, botProjectId: 3, liveProjectIds: new Set([9]) }), null);
  assert.equal(deriveArtifactProject({ cardProjectId: 4, threadProjectId: 2, botProjectId: 3, liveProjectIds: new Set() }), null);
  assert.match(ACTIVE_PROJECT_WHERE, /archived_at IS NULL/);
});

/** A crow.db with the tables the backfill reads, plus an optional tasks.db with one card. */
function world({ tasks = true, brokenBots = false } = {}) {
  const dir = tmp("shell-bf-");
  const dbPath = join(dir, "crow.db");
  const tasksDbPath = join(dir, "tasks.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, type TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active', archived_at TEXT);
    INSERT INTO project_spaces (id, slug, name) VALUES (2,'a','A'),(3,'b','B'),(5,'c','C');
    INSERT INTO project_spaces (id, slug, name, status) VALUES (6,'old','Old','archived');
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, ${brokenBots ? "" : "project_id INTEGER,"} enabled INTEGER);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, gateway_thread_id TEXT,
      project_id INTEGER, card_id INTEGER, kind TEXT NOT NULL DEFAULT 'chat');
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, title TEXT, created_by_bot TEXT, origin_session TEXT, origin_card INTEGER, deleted_at TEXT);
  `);
  db.prepare(brokenBots ? "INSERT INTO pi_bot_defs (bot_id, display_name, enabled) VALUES ('bot1','Bot',1)"
    : "INSERT INTO pi_bot_defs (bot_id, display_name, project_id, enabled) VALUES ('bot1','Bot',3,1)").run();
  const ins = db.prepare("INSERT INTO bot_sessions (bot_id, gateway_thread_id, project_id, card_id, kind) VALUES (?,?,?,?,'perch-live')");
  ins.run("bot1", "perchlive-a", null, null); // older
  ins.run("bot1", "perchlive-a", 2, 7);        // newer: project 2, card 7
  db.prepare("INSERT INTO artifacts (id, title, created_by_bot, origin_session, origin_card) VALUES ('art_1','T','bot1','perchlive-a',NULL)").run();
  db.prepare("INSERT INTO artifacts (id, title, created_by_bot, deleted_at) VALUES ('art_gone','T','bot1','2026-01-01')").run();
  db.close();
  if (tasks) {
    const t = new Database(tasksDbPath);
    t.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT, project_id INTEGER); INSERT INTO tasks_items (id,title,project_id) VALUES (7,'card',5)");
    t.close();
  }
  return { dir, dbPath, tasksDbPath };
}

const rows = (dbPath) => {
  const d = new Database(dbPath, { readonly: true });
  const r = d.prepare("SELECT item_kind, item_ref, project_id, card_id, set_by FROM shell_items ORDER BY item_kind, item_ref").all();
  d.close();
  return r;
};

test("backfill files threads and artifacts", () => {
  const { dbPath, tasksDbPath } = world();
  const r = run({ dbPath, tasksDbPath, log: () => {} });
  assert.equal(r.applied, true);
  assert.deepEqual(rows(dbPath), [
    { item_kind: "artifact", item_ref: "art_1", project_id: 5, card_id: null, set_by: "backfill" },
    { item_kind: "perch_thread", item_ref: "perchlive-a", project_id: 5, card_id: null, set_by: "backfill" },
  ]);
});

test("a locked tasks.db never fails the migration", () => {
  const { dbPath, tasksDbPath } = world();
  const locker = new Database(tasksDbPath);
  locker.exec("BEGIN EXCLUSIVE");
  try {
    const r = run({ dbPath, tasksDbPath, log: () => {} });
    assert.equal(r.applied, true);
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
  }
  const t = rows(dbPath).find((x) => x.item_kind === "perch_thread");
  assert.equal(t.project_id, 2, "falls back to the session's project");
});

test("a missing tasks.db: the card step is skipped", () => {
  const { dbPath, tasksDbPath } = world({ tasks: false });
  assert.equal(existsSync(tasksDbPath), false);
  const r = run({ dbPath, tasksDbPath, log: () => {} });
  assert.equal(r.applied, true);
  assert.equal(rows(dbPath).find((x) => x.item_kind === "perch_thread").project_id, 2);
});

test("a backfill error still applies the DDL", () => {
  const { dbPath, tasksDbPath } = world({ brokenBots: true });
  const logs = [];
  const r = run({ dbPath, tasksDbPath, log: (m) => logs.push(m) });
  assert.equal(r.applied, true);
  assert.ok(logs.some((m) => /shell_items backfill: skipped/.test(m)), logs.join("\n"));
  const d = new Database(dbPath, { readonly: true });
  assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='shell_items'").get());
  d.close();
});

test("backfill never overwrites an operator choice", () => {
  const { dbPath, tasksDbPath } = world();
  run({ dbPath, tasksDbPath, log: () => {} });
  const d = new Database(dbPath);
  d.prepare("UPDATE shell_items SET project_id = 3, set_by = 'operator' WHERE item_ref = 'perchlive-a'").run();
  d.prepare("UPDATE shell_items SET project_id = NULL, set_by = 'operator' WHERE item_ref = 'art_1'").run();
  d.close();
  run({ dbPath, tasksDbPath, log: () => {} });
  assert.deepEqual(rows(dbPath).map((x) => [x.item_ref, x.project_id, x.set_by]),
    [["art_1", null, "operator"], ["perchlive-a", 3, "operator"]]);
});

test("an absent bot_sessions table is tolerated", () => {
  const dbPath = join(tmp("shell-abs-"), "crow.db");
  new Database(dbPath).close();
  const r = run({ dbPath, log: () => {} });
  assert.equal(r.applied, true);
  assert.deepEqual(rows(dbPath), []);
});
