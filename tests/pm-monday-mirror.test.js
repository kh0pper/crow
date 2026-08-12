// tests/pm-monday-mirror.test.js
//
// Track 0 Phase B, Task 7: pm-workspace's Monday mirror sync (syncMirrorBoard)
// converges onto the unified tasks.db store — defs/items move from crow.db's
// dropped tracker_defs/tracker_items onto tasks.db's board_defs/tasks_items
// (migration 0003). pm_sync_state/pm_sync_log STAY on crow.db; local_kind
// stays 'tracker' but local_id now addresses a tasks_items row.
//
// ALSO (round-2 Critical #2 data-loss guard): the bot-builder editor's
// tracker-def query was selecting only `id, slug, display_name` while the
// def editor further down the same render reads `selTracker.status_values`
// / `.columns_json` from that same row — both undefined, so the editor drew
// an EMPTY status list and fields table, and its "Save tracker definition"
// button then wrote that emptiness back, wiping the def's fields. The fix
// adds `status_values, fields_json AS columns_json` to the SELECT. This
// test drives the real renderBotEditor() tracker tab against a seeded
// board_defs row and asserts the rendered def editor is NOT empty.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), "pm-monday-mirror-"));
const crowDbPath = join(dir, "crow.db");
const tasksDbPath = join(dir, "tasks.db");

const MONDAY_BOARD_ID = "999";
const SLUG = "monday-team-mirror";

let existingItemId; // pre-existing tasks_items row already mapped via pm_sync_state
let standaloneItemId; // unrelated card (board_id NULL) — must stay untouched
let boardId; // board_defs.id for SLUG

before(async () => {
  // ---- crow.db: real schema via init-db.js (gives us pi_bot_defs,
  // project_spaces, etc. for the editor render), then the pm-workspace
  // bundle's own pm_sync_state/pm_sync_log tables (init-db.js never
  // creates those — they're bundle-owned, see init-tables.js) layered on
  // top by hand — this mirrors bot-builder-engine-gate.test.js's pattern.
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO_ROOT,
  });

  const c = new Database(crowDbPath);
  c.exec(`
    CREATE TABLE pm_sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, board_id TEXT, item_id TEXT, local_kind TEXT, local_id INTEGER,
      content_hash TEXT, monday_updated_at TEXT, last_synced_at TEXT,
      UNIQUE(board_id, item_id)
    );
    CREATE INDEX idx_pm_sync_state_local ON pm_sync_state(local_kind, local_id);
    CREATE TABLE pm_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT DEFAULT (datetime('now')),
      direction TEXT, board_id TEXT, action TEXT, item_ref TEXT, detail TEXT, ok INTEGER
    );
  `);

  // Bot whose tracker tab points at SLUG (custom tracker, no linked project)
  // — drives the editor.js round-trip assertion below.
  c.prepare(
    "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)"
  ).run(
    "mirror-editor-bot", "Mirror Editor Bot",
    JSON.stringify({ tracker_config: { type: "custom", tracker_slug: SLUG }, tools: {}, models: {} })
  );
  c.close();

  // ---- tasks.db: converged Phase B shape (board_defs + tasks_items),
  // matching the migration-0003 output (tests/tracker-convergence-migration
  // .test.js / tests/tracker-api.test.js).
  const t = new Database(tasksDbPath);
  t.exec(`
    CREATE TABLE tasks_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
      due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
      board_id INTEGER, bot_id TEXT, assigned_bot TEXT, plan_ref TEXT,
      data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT, next_followup_date TEXT,
      processing_lease TEXT, processing_lease_status TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT
    );
    CREATE TABLE board_defs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, project_id INTEGER UNIQUE,
      display_name TEXT NOT NULL, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const fields = JSON.stringify([{ key: "assignee", label: "Assignee", type: "text", required: false, storage: "data" }]);
  t.prepare(
    "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?)"
  ).run(SLUG, "Team Mirror", '["pending","in_progress","done"]', '["done"]', fields);
  boardId = t.prepare("SELECT id FROM board_defs WHERE slug=?").get(SLUG).id;

  existingItemId = Number(
    t.prepare("INSERT INTO tasks_items (board_id, status, priority, title, data_json) VALUES (?,?,3,?,?)")
      .run(boardId, "pending", "Old Title", "{}").lastInsertRowid
  );
  standaloneItemId = Number(
    t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES (?,?,?)")
      .run("Standalone Card", 9, "todo").lastInsertRowid
  );
  t.close();

  // pm_sync_state row mapping Monday item "monday-1" → the existing card.
  const c2 = new Database(crowDbPath);
  c2.prepare(
    "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
  ).run(MONDAY_BOARD_ID, "monday-1", "tracker", existingItemId, "stale-hash", "2026-01-01T00:00:00Z");
  c2.close();

  // env-before-import: bot-builder/data-queries.js computes TASKS_DB at
  // import time from CROW_TASKS_DB_PATH (see tests/tracker-api.test.js for
  // the same pattern).
  process.env.CROW_TASKS_DB_PATH = tasksDbPath;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CROW_TASKS_DB_PATH;
});

// ---------------------------------------------------------------------------
// syncMirrorBoard — mirror pull writes defs/items on tdb, sync bookkeeping
// on cdb, and never touches an unrelated card.
// ---------------------------------------------------------------------------

test("syncMirrorBoard: matched item updates in place, new item inserts, unrelated card untouched", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { syncMirrorBoard } = await import("../bundles/pm-workspace/server/sync/monday.js");

  const cdb = createDbClient(crowDbPath);
  const tdb = createDbClient(tasksDbPath);

  const board = {
    board_id: MONDAY_BOARD_ID,
    mode: "mirror",
    target: { kind: "tracker", slug: SLUG },
    column_map: {},
    status_map: { "Working on it": "in_progress", "Done": "done" },
    status_column_id: "status_col",
  };
  const items = [
    { // matches the pre-existing pm_sync_state row → UPDATE in place
      id: "monday-1", name: "Updated Title", updated_at: "2026-08-11T00:00:00Z",
      group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
    },
    { // no sync-state row yet → INSERT
      id: "monday-2", name: "New Item", updated_at: "2026-08-11T00:00:00Z",
      group: { id: "g1" }, column_values: [{ id: "status_col", text: "Done", value: null }],
    },
  ];
  const totals = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };

  await syncMirrorBoard(cdb, tdb, board, items, totals);

  assert.equal(totals.updated, 1);
  assert.equal(totals.created, 1);
  assert.equal(totals.errors, 0);

  // matched item: same id, fields updated, still on tdb
  const updated = (await tdb.execute({ sql: "SELECT id, title, status, board_id FROM tasks_items WHERE id=?", args: [existingItemId] })).rows[0];
  assert.deepEqual(updated, { id: existingItemId, title: "Updated Title", status: "in_progress", board_id: boardId });
  const stateForMonday1 = (await cdb.execute({ sql: "SELECT local_id, local_kind FROM pm_sync_state WHERE board_id=? AND item_id=?", args: [MONDAY_BOARD_ID, "monday-1"] })).rows[0];
  assert.equal(stateForMonday1.local_id, existingItemId, "same tasks_items id — an UPDATE, not a new row");
  assert.equal(stateForMonday1.local_kind, "tracker");

  // new item: fresh tasks_items row + fresh pm_sync_state row pointing at it
  const stateForMonday2 = (await cdb.execute({ sql: "SELECT local_id, local_kind FROM pm_sync_state WHERE board_id=? AND item_id=?", args: [MONDAY_BOARD_ID, "monday-2"] })).rows[0];
  assert.ok(stateForMonday2, "monday-2 must get a pm_sync_state row");
  assert.equal(stateForMonday2.local_kind, "tracker");
  assert.notEqual(Number(stateForMonday2.local_id), existingItemId);
  const created = (await tdb.execute({ sql: "SELECT title, status, board_id FROM tasks_items WHERE id=?", args: [stateForMonday2.local_id] })).rows[0];
  assert.deepEqual(created, { title: "New Item", status: "done", board_id: boardId });

  // unrelated card (board_id NULL) never touched
  const standalone = (await tdb.execute({ sql: "SELECT title, status, board_id FROM tasks_items WHERE id=?", args: [standaloneItemId] })).rows[0];
  assert.deepEqual(standalone, { title: "Standalone Card", status: "todo", board_id: null });

  await cdb.close();
  await tdb.close();
});

// ---------------------------------------------------------------------------
// editor.js data-loss guard (round-2 Critical #2)
// ---------------------------------------------------------------------------

test("bot-builder editor tracker tab: def editor round-trips status_values + columns_json (not empty)", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js");

  const db = createDbClient(crowDbPath);
  const layout = ({ content }) => content;
  const req = { method: "GET", query: { bot: "mirror-editor-bot", tab: "tracker" }, body: {}, cookies: {}, headers: {} };
  const res = { html: null, send(s) { this.html = s; return this; } };

  await renderBotEditor(req, res, {
    db, layout, lang: "en", PAGE_CSS: "", botId: "mirror-editor-bot", notice: "", q: req.query,
  });

  assert.ok(res.html, "editor must render");
  // Display name + non-empty status list (pre-fix: undefined → JSON.parse
  // fallback [] → "" → an EMPTY input, which the save handler would then
  // write back as an empty status_values array).
  assert.match(res.html, /id="bb-tdef-name" value="Team Mirror"/);
  assert.match(res.html, /id="bb-tdef-statuses"[^>]*value="pending, in_progress, done"/,
    "status_values must reach the editor — pre-fix this rendered empty (undefined status_values)");
  // Non-empty fields table (pre-fix: undefined columns_json → [] → zero
  // <tr> rows, and a save would wipe fields_json to '[]').
  assert.match(res.html, /name="col_key_0" value="assignee"/,
    "columns_json (fields_json) must reach the editor — pre-fix this rendered an empty fields table");

  await db.close();
});
