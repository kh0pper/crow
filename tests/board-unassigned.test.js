/**
 * Unassigned cards (queue item 20, PR 2; T5 + T8): a card that belongs to no
 * board — `board_id IS NULL AND project_id IS NULL` — used to appear nowhere.
 * listUnassignedCards() reads them from the instance-global tasks.db only;
 * the kanban view and the Turn-on view render them as an Unassigned lane.
 *
 * Excluded: tracker items (board_id set), archived cards, subtasks
 * (parent_id), cards already on a project, and cards in a terminal status
 * (done/cancelled — the builtin def's terminals, since a project-less card
 * has no board def of its own).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-unassigned-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

let createDbClient, listUnassignedCards;
const ids = {};

before(async () => {
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare("INSERT INTO tasks_items (title, project_id, board_id, parent_id, archived_at, status, assigned_bot, priority, tags) VALUES (?,?,?,?,?,?,?,?,?)");
  const add = (k, o) => { ids[k] = Number(ins.run(o.title || k, o.project ?? null, o.board ?? null, o.parent ?? null, o.archived ?? null, o.status || "pending", o.bot ?? null, o.priority ?? 3, o.tags ?? null).lastInsertRowid); };
  add("loose", { tags: "home,urgent" });
  add("item", { board: 4 });
  add("archived", { archived: "2026-10-01 00:00:00" });
  add("sub", { parent: 1 });
  add("onboard", { project: 9 });
  add("given", { bot: "hank" });
  add("done", { status: "done" });
  add("cancelled", { status: "cancelled" });
  add("doing", { status: "in_progress", priority: 1 });
  t.close();
  ({ createDbClient } = await import("../servers/db.js"));
  ({ listUnassignedCards } = await import("../servers/gateway/dashboard/panels/bot-board/data-queries.js"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function list() {
  const tdb = createDbClient(process.env.CROW_TASKS_DB_PATH);
  try { return await listUnassignedCards(tdb); } finally { tdb.close(); }
}

test("a top-level card with no board and no project is unassigned", async () => {
  const rows = await list();
  const loose = rows.find((r) => Number(r.id) === ids.loose);
  assert.ok(loose, "the loose card is listed");
  assert.equal(loose.title, "loose");
  assert.equal(loose.tags, "home,urgent");
  assert.ok(loose.created_at, "carries created_at for the 'added N ago' line");
});

test("tracker items, archived cards, subtasks and cards on a project are not", async () => {
  const got = new Set((await list()).map((r) => Number(r.id)));
  for (const k of ["item", "archived", "sub", "onboard"]) assert.ok(!got.has(ids[k]), k + " must not be listed");
});

test("cards in a terminal status (done, cancelled) are not", async () => {
  const got = new Set((await list()).map((r) => Number(r.id)));
  assert.ok(!got.has(ids.done));
  assert.ok(!got.has(ids.cancelled));
  assert.ok(got.has(ids.doing), "a non-terminal status other than pending still counts");
});

test("a card with assigned_bot but no project is still unassigned and carries the bot", async () => {
  const given = (await list()).find((r) => Number(r.id) === ids.given);
  assert.ok(given);
  assert.equal(given.assigned_bot, "hank");
});

test("ordered by priority, then id", async () => {
  const rows = await list();
  assert.equal(Number(rows[0].id), ids.doing, "priority 1 first");
  const rest = rows.slice(1).map((r) => Number(r.id));
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
});
