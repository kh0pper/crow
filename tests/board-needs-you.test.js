// R1.2 PR 1 Task 1: one "N need you" count for the drawer, the project home and the Board badge.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-needs-you-"));
process.env.CROW_DATA_DIR = dir;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
delete process.env.CROW_DB_PATH;

let db, counts, needsYouCounts, items, clearCache, label, cards, ensureItem, A, B, C, OWN;
const DECISION = JSON.stringify({ decision: { question: "q", options: [{ label: "a" }, { label: "b" }] } });
const ids = {};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const t = new Database(TASKS);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER, action_needed TEXT,
    data_json TEXT NOT NULL DEFAULT '{}', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE board_results (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'success', status TEXT NOT NULL DEFAULT 'recorded');
    CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, project_id INTEGER UNIQUE,
      display_name TEXT NOT NULL, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]')`);
  ({ createDbClient: globalThis.__c } = await import("../servers/db.js"));
  db = globalThis.__c();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  A = (await createProjectSpace(db, { name: "Alpha" })).id;
  B = (await createProjectSpace(db, { name: "Beta" })).id;
  C = (await createProjectSpace(db, { name: "Gamma" })).id;
  OWN = (await createProjectSpace(db, { name: "Own store" })).id;
  await db.execute({ sql: "UPDATE project_spaces SET tasks_db_uri = ? WHERE id = ?", args: ["file:" + join(dir, "other.db"), OWN] });
  // Beta's board treats "shipped" as terminal, so a "shipped" card with action_needed is done there.
  t.prepare("INSERT INTO board_defs (slug, project_id, display_name, status_values, terminal_values) VALUES ('b', ?, 'Beta', ?, ?)")
    .run(B, JSON.stringify(["pending", "shipped"]), JSON.stringify(["shipped"]));
  const ins = t.prepare("INSERT INTO tasks_items (title, project_id, status, action_needed, data_json, priority) VALUES (?,?,?,?,?,?)");
  const add = (k, pid, status, ask, data, pr = 3) => { ids[k] = Number(ins.run(k, pid, status, ask, data || "{}", pr).lastInsertRowid); };
  add("a_ask", A, "pending", "look at this", null, 2);
  add("a_dec", A, "pending", null, DECISION, 1);
  add("a_rev", A, "pending", null, null, 3);
  add("a_quiet", A, "pending", null, null);
  add("b_shipped", B, "shipped", "stale ask", null);
  add("b_ask", B, "pending", "needs me", null);
  add("c_ask", C, "pending", "held", null);
  t.prepare("INSERT INTO board_results (item_id, status) VALUES (?, 'recorded')").run(ids.a_rev);
  t.close();
  ({ ensureItem } = await import("../servers/shared/shell-items.js"));
  ({ needsYouCounts, needsYouLabel: label, needsYouCards: cards, needsYouItems: items, clearNeedsYouCache: clearCache } = await import("../servers/gateway/dashboard/panels/board/needs-you.js"));
  // The suite changes state between calls on purpose, so every plain call here bypasses the 5 s cache.
  counts = (db_, list, o = {}) => needsYouCounts(db_, list, { cacheMs: 0, ...o });
});
after(() => { try { db && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const engineOf = (sessions) => ({ list: async () => sessions });
async function file(thread, pid) { await ensureItem(db, "perch_thread", thread, { projectId: pid, setBy: "operator" }); }

test("counts needs-you cards per project through each board def", async () => {
  const m = await counts(db, [{ id: A }, { id: B }]);
  assert.equal(m.get(A), 3);
  assert.equal(m.get(B), 1); // the shipped card is done on Beta's own board
});

test("own store shows unknown", async () => {
  const m = await counts(db, [{ id: OWN, tasks_db_uri: "file:" + join(dir, "other.db") }, { id: A }]);
  assert.equal(m.get(OWN), null);
  assert.equal(m.get(A), 3);
  assert.deepEqual(await cards(db, { id: OWN, tasks_db_uri: "file:" + join(dir, "other.db") }), []);
});

test("a project row id is looked up for its store", async () => {
  const m = await counts(db, [OWN, A]);
  assert.equal(m.get(OWN), null);
  assert.equal(m.get(A), 3);
});

test("session holding a needs-you card counts once; a bare waiting session adds one", async () => {
  await file("t-hold", C); await file("t-bare", C);
  const engine = engineOf([
    { sessionId: "t-hold", pendingUi: true, cardId: ids.c_ask },
    { sessionId: "t-bare", pendingUi: true, cardId: null },
    { sessionId: "t-idle", pendingUi: false, cardId: null },
  ]);
  const m = await counts(db, [{ id: C }], { engine });
  assert.equal(m.get(C), 2); // c_ask once + t-bare
  // The split the shell's tabs read: the card on Board, the bare chat on Chat.
  assert.deepEqual(m.parts.get(C), { cards: 1, chats: 1 });
});

test("a waiting session filed elsewhere doesn't count here", async () => {
  await file("t-else", B);
  const m = await counts(db, [{ id: C }], { engine: engineOf([{ sessionId: "t-else", pendingUi: true, cardId: null }]) });
  assert.equal(m.get(C), 1);
});

test("an engine cardId of null still finds the DB row's card, counted once", async () => {
  await file("t-dbcard", C);
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, kind, status, gateway_thread_id, card_id) VALUES (?,?,?,?,?)",
    args: ["hank", "perch-live", "active", "t-dbcard", ids.c_ask] });
  const m = await counts(db, [{ id: C }], { engine: engineOf([{ sessionId: "t-dbcard", botId: "hank", pendingUi: true, cardId: null }]) });
  assert.equal(m.get(C), 1);
});

test("an unfiled thread falls back to its bot's live project", async () => {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: ["bobby", "Bobby", "{}", B] });
  const engine = engineOf([{ sessionId: "t-legacy", botId: "bobby", pendingUi: true, cardId: null }]);
  const m = await counts(db, [{ id: A }, { id: B }], { engine });
  assert.equal(m.get(B), 2); // b_ask + the legacy thread
  assert.equal(m.get(A), 3);
});

test("no engine, an idle session or a stopped one adds nothing", async () => {
  await file("t-quiet", A);
  assert.equal((await counts(db, [{ id: A }])).get(A), 3);
  const engine = engineOf([
    { sessionId: "t-quiet", botId: "hank", pendingUi: false, cardId: null },
    { sessionId: "t-quiet", botId: "hank", pendingUi: true, state: "stopped", cardId: null },
  ]);
  assert.equal((await counts(db, [{ id: A }], { engine })).get(A), 3);
});

test("missing tasks.db still counts waiting sessions", async () => {
  await file("t-nodb", C);
  const engine = engineOf([{ sessionId: "t-nodb", pendingUi: true, cardId: null }]);
  const m = await counts(db, [{ id: A }, { id: C }], { tasksDbPath: join(dir, "nope.db"), engine });
  assert.deepEqual([...m], [[A, 0], [C, 1]]);
  const it = await items(db, { id: C }, { tasksDbPath: join(dir, "nope.db"), engine });
  assert.deepEqual(it, { cards: [], waiting: [{ sid: "t-nodb" }] });
});

test("an archived waiting session counts nowhere", async () => {
  await file("t-arch", C);
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, kind, status, gateway_thread_id, archived_at) VALUES (?,?,?,?,datetime('now'))",
    args: ["hank", "perch-live", "active", "t-arch"] });
  const engine = engineOf([{ sessionId: "t-arch", pendingUi: true, cardId: null }]);
  assert.equal((await counts(db, [{ id: C }], { engine })).get(C), 1); // c_ask only
  assert.deepEqual((await items(db, { id: C }, { engine })).waiting, []);
});

test("project rows without tasks_db_uri are looked up in one query", async () => {
  let n = 0;
  const spy = { execute: (q) => { if (/FROM project_spaces/.test(q.sql || q)) n++; return db.execute(q); } };
  const m = await counts(spy, [OWN, A, B]);
  assert.equal(n, 1);
  assert.equal(m.get(OWN), null);
});

test("counts are cached for 5 s per project set and tasks.db, then re-read", async () => {
  clearCache();
  let at = 1000;
  const now = () => at;
  const t = new Database(TASKS);
  const call = () => needsYouCounts(db, [{ id: B }], { now });
  const first = (await call()).get(B);
  t.prepare("INSERT INTO tasks_items (title, project_id, status, action_needed) VALUES ('cache_probe', ?, 'pending', 'new ask')").run(B);
  at += 4000;
  assert.equal((await call()).get(B), first, "within 5 s: the cached count, tasks.db not read again");
  at += 1500;
  assert.equal((await call()).get(B), first + 1, "after 5 s: re-read");
  t.prepare("DELETE FROM tasks_items WHERE title = 'cache_probe'").run();
  t.close();
  clearCache();
});

test("the count cache drops expired entries when read and never exceeds 64", async () => {
  const { needsYouCacheSize } = await import("../servers/gateway/dashboard/panels/board/needs-you.js");
  clearCache();
  let at = 0;
  const now = () => at;
  await needsYouCounts(db, [{ id: A }], { now });
  assert.equal(needsYouCacheSize(), 1);
  at = 6000;
  await needsYouCounts(db, [{ id: A }], { now }); // expired: replaced, not accumulated
  assert.equal(needsYouCacheSize(), 1);
  for (let i = 0; i < 100; i++) { at += 1; await needsYouCounts(db, [{ id: 100000 + i, tasks_db_uri: null }], { now }); }
  assert.equal(needsYouCacheSize(), 64, "capped, oldest dropped");
  clearCache();
});

test("missing tasks.db is zero for all", async () => {
  const m = await counts(db, [{ id: A }, { id: B }], { tasksDbPath: join(dir, "nope.db") });
  assert.deepEqual([...m], [[A, 0], [B, 0]]);
});

test("unreadable tasks.db is unknown for all", async () => {
  const bad = join(dir, "bad.db");
  writeFileSync(bad, "this is not a sqlite database, just some bytes ".repeat(40));
  const m = await counts(db, [{ id: A }, { id: B }], { tasksDbPath: bad });
  assert.deepEqual([...m], [[A, null], [B, null]]);
});

test("needsYouItems: a card with no ask has a null kind; an own-store project has nothing", async () => {
  const t = new Database(TASKS);
  const id = Number(t.prepare("INSERT INTO tasks_items (title, project_id, status, action_needed, priority) VALUES ('kindless', ?, 'pending', ?, 1)").run(A, "   ").lastInsertRowid);
  try {
    const { kindOf } = await import("../servers/gateway/dashboard/panels/board/needs-you.js");
    assert.equal(kindOf({ id, action_needed: "   ", data_json: "{}" }), null);
  } finally { t.prepare("DELETE FROM tasks_items WHERE id = ?").run(id); t.close(); }
  const own = { id: OWN, tasks_db_uri: "file:" + join(dir, "other.db") };
  assert.deepEqual(await items(db, own, { engine: engineOf([{ sessionId: "x", pendingUi: true }]) }), { cards: [], waiting: [] });
});

test("needsYouLabel: 0 → null, null → \"?\", 2 → \"2 need you\"", () => {
  assert.equal(label(0, "en"), null);
  assert.equal(label(null, "en"), "?");
  assert.equal(label(2, "en"), "2 need you");
  assert.equal(label(2, "es"), "2 te necesitan");
  assert.equal(label(1, "en"), "1 needs you");
  assert.equal(label(1, "es"), "1 te necesita");
});

test("needsYouCards: board order, one card per kind, limit", async () => {
  const rows = await cards(db, { id: A }, { limit: 3 });
  assert.deepEqual(rows.map((r) => [r.title, r.kind]), [["a_dec", "decision"], ["a_ask", "question"], ["a_rev", "review"]]);
  assert.equal(rows[0].id, ids.a_dec);
  assert.equal(typeof rows[0].project_id, "number");
  assert.equal((await cards(db, { id: A }, { limit: 2 })).length, 2);
  assert.deepEqual(await cards(db, { id: A }, { tasksDbPath: join(dir, "nope.db") }), []);
});
