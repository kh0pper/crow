/**
 * P6 (rulings Q1/Q5): cardDrawerHref, the one "open this card" link. The card's
 * drawer on its project's card-board bot, else on any enabled card-board bot that
 * has a board, else the standalone no-JS card view; null for a card that isn't there.
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

test("no bot on the card's project: any enabled card-board bot with a board", async () => {
  bot("aaa-unboarded", { project: null }); // a card board with no project shows no board
  bot("bbb-off", { project: 6, enabled: 0 });
  bot("ccc-none", { type: "none", project: 6 });
  bot("ddd-board", { project: 6 });
  assert.equal(await cardDrawerHref(db, 9), "/dashboard/bot-board?bot=ddd-board#open=9");
  assert.equal(await cardDrawerHref(db, 11), "/dashboard/bot-board?bot=ddd-board#open=11", "a card with no project");
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
