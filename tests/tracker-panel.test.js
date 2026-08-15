// tests/tracker-panel.test.js
//
// Track 0 Phase B: the custom-tracker SSR render (renderCustomTracker) and
// the no-JS tracker_move POST handler read/write the UNIFIED store —
// tasks.db's board_defs (slug rows) + tasks_items(board_id=...) — instead of
// crow.db's dropped tracker_defs/tracker_items. Harness mirrors
// tests/board-panel-config.test.js (env-seeded temp DBs before import).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "tracker-panel-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

let boardId, openItemId, lockedItemId;

// Seed BEFORE importing (modules read env at import time).
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    board_id INTEGER, bot_id TEXT, assigned_bot TEXT, plan_ref TEXT,
    data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT, archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // board_mutations (Track 1): the no-JS tracker_move handler now writes
  // through card-service's moveItem, which records every move here.
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  const fields = JSON.stringify([{ key: "asset_type", label: "Type", storage: "data" }]);
  t.prepare(
    "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('pir','PIR',?,?,?)"
  ).run('["open","review","done"]', '["done"]', fields);
  boardId = t.prepare("SELECT id FROM board_defs WHERE slug='pir'").get().id;

  const insItem = t.prepare(
    `INSERT INTO tasks_items (board_id, bot_id, status, priority, title, data_json, action_needed, processing_lease, processing_lease_status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  openItemId = Number(insItem.run(boardId, null, "open", 2, "Open Item", '{"asset_type":"poster"}', null, null, null).lastInsertRowid);
  lockedItemId = Number(insItem.run(boardId, "scout", "review", 3, "Locked Item", '{"asset_type":"flyer"}', "needs review", "lease-1", "in-progress").lastInsertRowid);

  // A plain project card (project_id set, board_id NULL) — must NOT appear
  // on the tracker board (isolation).
  t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES ('Plain Project Card', 9, 'todo')").run();

  t.close();
}

let renderCustomTracker, handleBotBoardPost, createDbClient;
before(async () => {
  ({ renderCustomTracker } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
  ({ handleBotBoardPost } = await import("../servers/gateway/dashboard/panels/bot-board/api-handlers.js"));
  ({ createDbClient } = await import("../servers/db.js"));
});

function selBot(trackerSlug, contextFields) {
  return {
    botId: "scout", displayName: "Scout", projectId: null,
    trackerType: "custom", trackerSlug,
    definition: contextFields ? { tracker_config: { type: "custom", tracker_slug: trackerSlug, context_fields: contextFields } } : {},
  };
}
const layout = (o) => o.content;

async function render(trackerSlug, contextFields, q = {}) {
  const db = createDbClient();
  try {
    return await renderCustomTracker({}, {}, {
      db, layout, selBot: selBot(trackerSlug, contextFields), bots: [], notice: "", switcher: "", q, lang: "en",
    });
  } finally { db.close(); }
}

test("renderCustomTracker draws a bb-col per def status, items via label, lock badge, isolation", async () => {
  const html = await render("pir");
  for (const s of ["open", "review", "done"]) {
    assert.ok(html.includes(`data-col="${s}"`), `column ${s}`);
  }
  assert.ok(html.includes("Open Item"), "open item title renders");
  assert.ok(html.includes("Locked Item"), "locked item title renders");
  assert.ok(!html.includes("Plain Project Card"), "plain project card must not appear on a tracker board");
  // locked item carries bb-locked; open item's card does not.
  const lockedCardStart = html.indexOf(`data-card="${lockedItemId}"`);
  const lockedCardHtmlStart = html.lastIndexOf('<div class="bb-card', lockedCardStart);
  const lockedCardTag = html.slice(lockedCardHtmlStart, lockedCardHtmlStart + 80);
  assert.ok(lockedCardTag.includes("bb-locked"), "locked item's card carries bb-locked: " + lockedCardTag);
  const openCardStart = html.indexOf(`data-card="${openItemId}"`);
  const openCardHtmlStart = html.lastIndexOf('<div class="bb-card', openCardStart);
  const openCardTag = html.slice(openCardHtmlStart, openCardHtmlStart + 80);
  assert.ok(!openCardTag.includes("bb-locked"), "open item's card must not carry bb-locked: " + openCardTag);
});

test("contextFields fall back to def.fields when the bot has none configured", async () => {
  const html = await render("pir"); // no context_fields on the bot definition
  assert.ok(html.includes("Type: poster"), "def.fields drives card-face meta when the bot has no context_fields: " + html);
});

test("bot-configured context_fields still take priority over def.fields", async () => {
  const html = await render("pir", [{ key: "asset_type", label: "Kind" }]);
  assert.ok(html.includes("Kind: poster"), "bot context_fields label wins: " + html);
  assert.ok(!html.includes("Type: poster"), "def.fields label must not also render");
});

test("tracker not found still renders the existing not-found branch", async () => {
  const html = await render("does-not-exist");
  assert.ok(html.includes("does-not-exist"), "slug echoed in the not-found message: " + html);
});

test("no-JS tracker_move: on-def status moves the row", async () => {
  const calls = [];
  const res = { redirectAfterPost: (u) => calls.push(u) };
  const db = createDbClient();
  try {
    await handleBotBoardPost({ body: { action: "tracker_move", item_id: String(openItemId), status: "review", bot: "scout" } }, res, { db });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes("err="), "on-def value accepted: " + calls[0]);
    const t = new Database(process.env.CROW_TASKS_DB_PATH);
    assert.equal(t.prepare("SELECT status FROM tasks_items WHERE id=?").get(openItemId).status, "review");
    t.prepare("UPDATE tasks_items SET status='open' WHERE id=?").run(openItemId);
    t.close();
  } finally { db.close(); }
});

test("no-JS tracker_move: off-def status redirects err=bad_move and leaves the row untouched", async () => {
  const calls = [];
  const res = { redirectAfterPost: (u) => calls.push(u) };
  const db = createDbClient();
  try {
    await handleBotBoardPost({ body: { action: "tracker_move", item_id: String(openItemId), status: "bogus", bot: "scout" } }, res, { db });
    assert.ok(calls[0].includes("err=bad_move"), "off-def value refused: " + calls[0]);
    const t = new Database(process.env.CROW_TASKS_DB_PATH);
    assert.equal(t.prepare("SELECT status FROM tasks_items WHERE id=?").get(openItemId).status, "open", "row untouched");
    t.close();
  } finally { db.close(); }
});

test("no-JS tracker_move: lease-locked item redirects err=locked and leaves the row untouched", async () => {
  const calls = [];
  const res = { redirectAfterPost: (u) => calls.push(u) };
  const db = createDbClient();
  try {
    await handleBotBoardPost({ body: { action: "tracker_move", item_id: String(lockedItemId), status: "done", bot: "scout" } }, res, { db });
    assert.ok(calls[0].includes("err=locked"), "locked item refused: " + calls[0]);
    const t = new Database(process.env.CROW_TASKS_DB_PATH);
    assert.equal(t.prepare("SELECT status FROM tasks_items WHERE id=?").get(lockedItemId).status, "review", "row untouched");
    t.close();
  } finally { db.close(); }
});
