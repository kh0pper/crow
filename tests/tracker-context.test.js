// tests/tracker-context.test.js
//
// Track 0 Phase B: the bridge's custom-tracker context builder
// (tracker.mjs's customTrackerContext, reached via the public
// getTrackerContext dispatch) used to read crow.db's dropped
// tracker_defs/tracker_items tables. Migration 0003 moved slug boards into
// tasks.db (board_defs slug rows + tasks_items.board_id); this test proves
// the bridge context reader was converted to the unified store, using the
// SAME tasksDbPath override the public dispatch already threads through to
// kanbanContext/taskListContext. Harness mirrors tests/tracker-panel.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getTrackerContext } from "../scripts/pi-bots/tracker.mjs";

const dir = mkdtempSync(join(tmpdir(), "tracker-context-"));
const TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS_DB_PATH;
process.env.CROW_DB_PATH = join(dir, "crow.db");

const SLUG = "intake";
let openId1, leasedId, openId2;

{
  const t = new Database(TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    board_id INTEGER, bot_id TEXT, assigned_bot TEXT, plan_ref TEXT,
    data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  t.prepare(
    "INSERT INTO board_defs (slug, display_name, status_values, terminal_values) VALUES (?,?,?,?)"
  ).run(SLUG, "Intake", JSON.stringify(["open", "leased", "done"]), JSON.stringify(["done"]));
  const boardId = t.prepare("SELECT id FROM board_defs WHERE slug=?").get(SLUG).id;

  const insItem = t.prepare(
    `INSERT INTO tasks_items (board_id, status, priority, title, action_needed, processing_lease_status)
     VALUES (?,?,?,?,?,?)`
  );
  openId1 = insItem.run(boardId, "open", 1, "Triage inbox", null, null).lastInsertRowid;
  leasedId = insItem.run(boardId, "leased", 2, "Draft flyer", null, "in-progress").lastInsertRowid;
  openId2 = insItem.run(boardId, "open", 3, "Follow up call", "call Monday", null).lastInsertRowid;
  t.close();
}

function botDef(queueFilter) {
  const tc = { type: "custom", tracker_slug: SLUG };
  if (queueFilter) tc.queue_filter = queueFilter;
  return { tracker_config: tc };
}

test("customTrackerContext (via getTrackerContext): unfiltered text carries every item, status marker, and action line", () => {
  const text = getTrackerContext(botDef(), null, TASKS_DB_PATH);
  assert.match(text, new RegExp("#" + openId1 + " Triage inbox"));
  assert.match(text, new RegExp("#" + leasedId + " Draft flyer"));
  assert.match(text, new RegExp("#" + openId2 + " Follow up call"));
  assert.match(text, /\[open\]/);
  assert.match(text, /\[leased\]/);
  assert.match(text, /action: call Monday/);
});

test("customTrackerContext: queueFilter {status:'open'} keeps only open items", () => {
  const text = getTrackerContext(botDef({ status: "open" }), null, TASKS_DB_PATH);
  assert.match(text, new RegExp("#" + openId1 + " Triage inbox"));
  assert.match(text, new RegExp("#" + openId2 + " Follow up call"));
  assert.doesNotMatch(text, new RegExp("#" + leasedId + " Draft flyer"));
  assert.doesNotMatch(text, /\[leased\]/);
});

test("customTrackerContext: unknown slug reports not-found without throwing", () => {
  const text = getTrackerContext(botDef(), null, TASKS_DB_PATH);
  assert.doesNotThrow(() => getTrackerContext({ tracker_config: { type: "custom", tracker_slug: "nope" } }, null, TASKS_DB_PATH));
  const missing = getTrackerContext({ tracker_config: { type: "custom", tracker_slug: "nope" } }, null, TASKS_DB_PATH);
  assert.match(missing, /tracker 'nope' not found/);
  assert.match(text, /Intake tracker:/);
});
