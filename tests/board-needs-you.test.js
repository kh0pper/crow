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

let db, counts, label, cards, ensureItem, A, B, C, OWN;
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
  ({ needsYouCounts: counts, needsYouLabel: label, needsYouCards: cards } = await import("../servers/gateway/dashboard/panels/board/needs-you.js"));
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
});

test("a waiting session filed elsewhere doesn't count here", async () => {
  await file("t-else", B);
  const m = await counts(db, [{ id: C }], { engine: engineOf([{ sessionId: "t-else", pendingUi: true, cardId: null }]) });
  assert.equal(m.get(C), 1);
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

test("needsYouLabel: 0 → null, null → \"?\", 2 → \"2 need you\"", () => {
  assert.equal(label(0, "en"), null);
  assert.equal(label(null, "en"), "?");
  assert.equal(label(2, "en"), "2 need you");
  assert.equal(label(2, "es"), "2 te necesitan");
});

test("needsYouCards: board order, one card per kind, limit", async () => {
  const rows = await cards(db, { id: A }, { limit: 3 });
  assert.deepEqual(rows.map((r) => [r.title, r.kind]), [["a_dec", "decision"], ["a_ask", "question"], ["a_rev", "review"]]);
  assert.equal(rows[0].id, ids.a_dec);
  assert.equal(typeof rows[0].project_id, "number");
  assert.equal((await cards(db, { id: A }, { limit: 2 })).length, 2);
  assert.deepEqual(await cards(db, { id: A }, { tasksDbPath: join(dir, "nope.db") }), []);
});
