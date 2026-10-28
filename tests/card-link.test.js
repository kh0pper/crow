/**
 * P6 (rulings Q1/Q5/Q14): cardDrawerHref, the one "open this card" link. The card's
 * drawer on its own project's card-board bot, else the standalone no-JS card view
 * (never another project's board); null for a card that isn't there.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "card-link-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, project_id INTEGER,
    board_id INTEGER, archived_at TEXT)`);
  t.prepare("INSERT INTO tasks_items (id, title, project_id) VALUES (9, 'on project 5', 5)").run();
  t.prepare("INSERT INTO tasks_items (id, title, project_id) VALUES (10, 'on project 6', 6)").run();
  t.prepare("INSERT INTO tasks_items (id, title, project_id) VALUES (11, 'no project', NULL)").run();
  t.prepare("INSERT INTO tasks_items (id, title, project_id, board_id) VALUES (20, 'a tracker item', 5, 1)").run();
  t.close();
  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  c.close();
}

let cardDrawerHref, db;
before(async () => {
  ({ cardDrawerHref } = await import("../servers/gateway/board/card-link.js"));
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { const c = new Database(process.env.CROW_DB_PATH); c.exec("DELETE FROM pi_bot_defs"); c.close(); });

const tracker = (type) => JSON.stringify({ tracker_config: { type } });
function bot(id, { type = "kanban", project = null, enabled = 1 } = {}) {
  const c = new Database(process.env.CROW_DB_PATH);
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)").run(id, id, tracker(type), enabled, project);
  c.close();
}

test("the card's project bot opens its drawer", async () => {
  bot("aaa-other", { project: 6 });
  bot("custom-on-5", { type: "custom", project: 5 });
  bot("board-5", { type: "task-list", project: 5 });
  assert.equal(await cardDrawerHref(db, 9), "/dashboard/bot-board?bot=board-5#open=9");
  assert.equal(await cardDrawerHref(db, 10), "/dashboard/bot-board?bot=aaa-other#open=10");
});

test("no board bot on the card's project: the standalone card view, never another project's board", async () => {
  bot("aaa-unboarded", { project: null });
  bot("bbb-off", { project: 5, enabled: 0 });
  bot("ccc-none", { type: "none", project: 5 });
  bot("ddd-board", { project: 6 }); // another project's kanban bot
  assert.equal(await cardDrawerHref(db, 9), "/dashboard/bot-board?card=9");
  assert.equal(await cardDrawerHref(db, 11), "/dashboard/bot-board?card=11", "a card with no project");
  assert.equal(await cardDrawerHref(db, 10), "/dashboard/bot-board?bot=ddd-board#open=10", "its own project's bot still opens it");
});

test("no card-board bot at all: the standalone card view", async () => {
  bot("custom", { type: "custom", project: 5 });
  bot("crow.voice", { project: 5 }); // the voice bot is never a board
  assert.equal(await cardDrawerHref(db, 9), "/dashboard/bot-board?card=9");
});

test("an unknown card has no link", async () => {
  bot("board-5", { project: 5 });
  assert.equal(await cardDrawerHref(db, 404), null);
  assert.equal(await cardDrawerHref(db, 20), null, "a tracker item is not a card");
  assert.equal(await cardDrawerHref(db, "9; DROP"), null);
  assert.equal(await cardDrawerHref(db, 0), null);
});

test("bot ids are URL-encoded", async () => {
  bot("a b&c", { project: 5 });
  assert.equal(await cardDrawerHref(db, 9), "/dashboard/bot-board?bot=a%20b%26c#open=9");
});

// ---- R1 follow-ups Task 1: the one URL shape and the batched resolver ----

test("drawerHref is the one URL shape", async () => {
  const { drawerHref } = await import("../servers/gateway/board/card-link.js");
  assert.equal(drawerHref(9, "board-5"), "/dashboard/bot-board?bot=board-5#open=9");
  assert.equal(drawerHref("9", "a b&c"), "/dashboard/bot-board?bot=a%20b%26c#open=9");
  assert.equal(drawerHref(9, null), "/dashboard/bot-board?card=9");
  assert.equal(drawerHref(9, ""), "/dashboard/bot-board?card=9");
  assert.equal(drawerHref(0, "x"), null);
  assert.equal(drawerHref("9; DROP", null), null);
});

test("drawerHrefs: one bots lookup for many cards, the same rule as cardDrawerHref", async () => {
  const { drawerHrefs } = await import("../servers/gateway/board/card-link.js");
  bot("board-5", { project: 5 });
  bot("aaa-other", { project: 6 });
  let botQueries = 0;
  const counting = { execute: (q) => { if (/pi_bot_defs/.test(q.sql || q)) botQueries++; return db.execute(q); } };
  // Rows the caller already read (project_id given): no tasks.db read.
  const m = await drawerHrefs(counting, [{ id: 9, project_id: 5 }, { id: 10, project_id: 6 }, { id: 11, project_id: null }, { id: 12, project_id: 7 }]);
  assert.equal(botQueries, 1, "one bots lookup");
  assert.equal(m.get(9), "/dashboard/bot-board?bot=board-5#open=9");
  assert.equal(m.get(10), "/dashboard/bot-board?bot=aaa-other#open=10");
  assert.equal(m.get(11), "/dashboard/bot-board?card=11");
  assert.equal(m.get(12), "/dashboard/bot-board?card=12", "no board bot on project 7: never another project's board");
  // Bare ids are read from tasks.db: an unknown id or a tracker item has no entry.
  const ids = await drawerHrefs(db, [9, "10", 11, 404, 20, "x"]);
  assert.deepEqual([...ids.entries()].sort(), [
    [10, "/dashboard/bot-board?bot=aaa-other#open=10"],
    [11, "/dashboard/bot-board?card=11"],
    [9, "/dashboard/bot-board?bot=board-5#open=9"],
  ].sort());
  // Nothing on a project: no bots lookup at all.
  botQueries = 0;
  const none = await drawerHrefs(counting, [{ id: 11, project_id: null }]);
  assert.equal(botQueries, 0);
  assert.equal(none.get(11), "/dashboard/bot-board?card=11");
  assert.equal((await drawerHrefs(db, [])).size, 0);
});
