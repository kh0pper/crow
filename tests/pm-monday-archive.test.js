// tests/pm-monday-archive.test.js
//
// Track 1, Task 8: Monday-sync archiving invariants (D-T1.6 "Monday sync:
// mapped-archived rows are pull-only"). Drives bundles/pm-workspace/server/
// sync/monday.js's syncTwowayBoard directly against scratch crow.db/tasks.db
// clients, mirroring tests/pm-monday-mirror.test.js's harness (createDbClient
// from servers/db.js, hand-rolled pm_sync_state/pm_sync_log + tasks_items
// tables — no bundle install needed).
//
// Invariants under test:
//   1. an archived+mapped row with a pending local edit does NOT push
//      (localChanged branch skips archived rows — the edit stays local).
//   2. an archived+unmapped done card is NOT created remotely by the
//      unmapped create-scan (column-guarded archived_at IS NULL — without
//      it, every archived-but-unmapped card gets RE-CREATED on Monday,
//      resurrecting the backlog).
//   3. a pull targeting an archived row updates it in place, STAYS
//      archived, logs the distinct action `pull_archived_update`, and does
//      NOT re-INSERT a duplicate row.
//   4. a second identical pull does not duplicate anything.
//   5. a store WITHOUT archived_at (legacy shape) runs every path without
//      crashing — proof the column-guard is real, not assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// Full Track-1 tasks_items shape (autonomy + archived_at present, no
// plan_ref — matches migration 0004's converged output).
const TASKS_ITEMS_DDL = `CREATE TABLE tasks_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
  due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
  board_id INTEGER, bot_id TEXT, assigned_bot TEXT, autonomy TEXT NOT NULL DEFAULT 'gated',
  archived_at TEXT, data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT,
  next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT
)`;

// Legacy pre-0004 shape — no autonomy, no archived_at.
const TASKS_ITEMS_LEGACY_DDL = `CREATE TABLE tasks_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
  due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
  board_id INTEGER, bot_id TEXT, assigned_bot TEXT,
  data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT,
  next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT
)`;

const SYNC_TABLES_DDL = `
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
`;

const BOARD_ID = "555";
const PROJECT_ID = 42;

function fixture({ legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pm-monday-archive-"));
  const crowDbPath = join(dir, "crow.db");
  const tasksDbPath = join(dir, "tasks.db");

  const c = new Database(crowDbPath);
  c.exec(SYNC_TABLES_DDL);
  c.close();

  const t = new Database(tasksDbPath);
  t.exec(legacy ? TASKS_ITEMS_LEGACY_DDL : TASKS_ITEMS_DDL);
  t.close();

  return { dir, crowDbPath, tasksDbPath };
}

function cleanup(f) {
  rmSync(f.dir, { recursive: true, force: true });
}

function kanbanBoard(overrides = {}) {
  return {
    board_id: BOARD_ID,
    mode: "twoway",
    target: { kind: "kanban", project_id: PROJECT_ID },
    column_map: {},
    status_map: { "Working on it": "in_progress", Done: "done" },
    status_column_id: "status_col",
    ...overrides,
  };
}

// Guards a test against an unexpected Monday API call: pushLocalToMonday /
// createMondayFromLocal both go through global fetch. Throwing on any call
// makes an accidental push/create fail loudly instead of silently no-op'ing
// against a fake network.
function stubFetchThrows() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("fetch must not be called for an archived row");
  };
  return { restore: () => { globalThis.fetch = original; }, count: () => calls };
}

function stubFetchOk() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({ data: { change_multiple_column_values: { id: "x" }, create_item: { id: "monday-new", updated_at: "2026-08-15T00:00:00Z" } } }),
    };
  };
  return { restore: () => { globalThis.fetch = original; }, count: () => calls };
}

// ---------------------------------------------------------------------------
// 1. archived + mapped row with a pending local edit does NOT push
// ---------------------------------------------------------------------------
test("syncTwowayBoard: archived+mapped row with a pending local edit does not push", async () => {
  const f = fixture();
  const fetchStub = stubFetchThrows();
  try {
    const { createDbClient } = await import("../servers/db.js");
    const { syncTwowayBoard } = await import("../bundles/pm-workspace/server/sync/monday.js");

    const t = new Database(f.tasksDbPath);
    const rowId = Number(
      t.prepare(
        "INSERT INTO tasks_items (title, status, project_id, archived_at) VALUES (?,?,?,?)"
      ).run("Archived Card", "in_progress", PROJECT_ID, "2026-08-10T00:00:00Z").lastInsertRowid
    );
    t.close();

    const c = new Database(f.crowDbPath);
    c.prepare(
      "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
    ).run(BOARD_ID, "item-A", "kanban", rowId, "stale-hash-from-before-archiving", "2026-01-01T00:00:00Z");
    c.close();

    const cdb = createDbClient(f.crowDbPath);
    const tdb = createDbClient(f.tasksDbPath);

    const board = kanbanBoard();
    const items = [
      {
        id: "item-A", name: "Archived Card", updated_at: "2026-01-01T00:00:00Z",
        group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
      },
    ];
    const totals = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };

    await syncTwowayBoard(cdb, tdb, board, items, "test-token", totals);

    assert.equal(totals.pushed, 0, "must not count as pushed");
    assert.equal(totals.errors, 0);
    assert.equal(fetchStub.count(), 0, "must never call the Monday API");

    // sync_state left untouched — the drift keeps being (harmlessly) skipped
    const state = (await cdb.execute({ sql: "SELECT content_hash FROM pm_sync_state WHERE board_id=? AND item_id=?", args: [BOARD_ID, "item-A"] })).rows[0];
    assert.equal(state.content_hash, "stale-hash-from-before-archiving");

    // local row untouched and still archived
    const row = (await tdb.execute({ sql: "SELECT title, status, archived_at FROM tasks_items WHERE id=?", args: [rowId] })).rows[0];
    assert.equal(row.title, "Archived Card");
    assert.equal(row.archived_at, "2026-08-10T00:00:00Z");

    await cdb.close();
    await tdb.close();
  } finally {
    fetchStub.restore();
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// 2. archived + unmapped done card is NOT created remotely
// ---------------------------------------------------------------------------
test("syncTwowayBoard: archived+unmapped done card is not created remotely (no resurrection)", async () => {
  const f = fixture();
  const fetchStub = stubFetchThrows();
  try {
    const { createDbClient } = await import("../servers/db.js");
    const { syncTwowayBoard } = await import("../bundles/pm-workspace/server/sync/monday.js");

    const t = new Database(f.tasksDbPath);
    const rowId = Number(
      t.prepare(
        "INSERT INTO tasks_items (title, status, project_id, archived_at) VALUES (?,?,?,?)"
      ).run("Archived Done Card", "done", PROJECT_ID, "2026-08-10T00:00:00Z").lastInsertRowid
    );
    t.close();

    const cdb = createDbClient(f.crowDbPath);
    const tdb = createDbClient(f.tasksDbPath);

    const board = kanbanBoard();
    const totals = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };

    await syncTwowayBoard(cdb, tdb, board, [], "test-token", totals);

    assert.equal(totals.created, 0, "must not create a remote item for the archived card");
    assert.equal(totals.errors, 0);
    assert.equal(fetchStub.count(), 0, "must never call the Monday API");

    const state = (await cdb.execute({ sql: "SELECT * FROM pm_sync_state WHERE local_kind='kanban' AND local_id=?", args: [rowId] })).rows;
    assert.deepEqual(state, [], "no mapping must be created for the archived row");

    await cdb.close();
    await tdb.close();
  } finally {
    fetchStub.restore();
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// 3. pull targeting an archived row updates in place, stays archived, logs
//    pull_archived_update, does not re-INSERT
// ---------------------------------------------------------------------------
test("syncTwowayBoard: pull targeting an archived row updates in place, stays archived, logs pull_archived_update", async () => {
  const f = fixture();
  try {
    const { createDbClient } = await import("../servers/db.js");
    const { syncTwowayBoard, contentHash } = await import("../bundles/pm-workspace/server/sync/monday.js");

    const t = new Database(f.tasksDbPath);
    const rowId = Number(
      t.prepare(
        "INSERT INTO tasks_items (title, status, project_id, archived_at) VALUES (?,?,?,?)"
      ).run("Old Title", "in_progress", PROJECT_ID, "2026-08-10T00:00:00Z").lastInsertRowid
    );
    t.close();

    // content_hash must match the row's CURRENT mapped shape (kanbanRowShape:
    // {title, status}, board.column_map is empty) so localChanged is false
    // and the remote-newer-only branch is the one that fires.
    const localHash = contentHash({ title: "Old Title", status: "in_progress" });
    const c = new Database(f.crowDbPath);
    c.prepare(
      "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
    ).run(BOARD_ID, "item-Z", "kanban", rowId, localHash, "2026-01-01T00:00:00Z");
    c.close();

    const cdb = createDbClient(f.crowDbPath);
    const tdb = createDbClient(f.tasksDbPath);

    const board = kanbanBoard();
    const items = [
      {
        id: "item-Z", name: "New Title From Monday", updated_at: "2026-08-15T00:00:00Z",
        group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
      },
    ];
    const totals = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };

    await syncTwowayBoard(cdb, tdb, board, items, "test-token", totals);

    assert.equal(totals.updated, 1);
    assert.equal(totals.created, 0, "must not INSERT a duplicate");

    const rowCount = (await tdb.execute({ sql: "SELECT COUNT(*) AS n FROM tasks_items", args: [] })).rows[0].n;
    assert.equal(Number(rowCount), 1, "no duplicate row");

    const row = (await tdb.execute({ sql: "SELECT title, archived_at FROM tasks_items WHERE id=?", args: [rowId] })).rows[0];
    assert.equal(row.title, "New Title From Monday", "updated in place");
    assert.equal(row.archived_at, "2026-08-10T00:00:00Z", "stays archived");

    const state = (await cdb.execute({ sql: "SELECT local_id FROM pm_sync_state WHERE board_id=? AND item_id=?", args: [BOARD_ID, "item-Z"] })).rows[0];
    assert.equal(Number(state.local_id), rowId, "mapping still points at the same row");

    const logRows = (await cdb.execute({ sql: "SELECT action FROM pm_sync_log WHERE item_ref=?", args: ["New Title From Monday"] })).rows;
    assert.ok(logRows.some((r) => r.action === "pull_archived_update"), `expected a pull_archived_update log row; got: ${JSON.stringify(logRows)}`);
    assert.ok(!logRows.some((r) => r.action === "update_local"), "must use the distinct action, not the normal one");

    await cdb.close();
    await tdb.close();
  } finally {
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// 4. a second identical pull does not duplicate anything
// ---------------------------------------------------------------------------
test("syncTwowayBoard: a second identical pull against an archived row does not duplicate", async () => {
  const f = fixture();
  try {
    const { createDbClient } = await import("../servers/db.js");
    const { syncTwowayBoard, contentHash } = await import("../bundles/pm-workspace/server/sync/monday.js");

    const t = new Database(f.tasksDbPath);
    const rowId = Number(
      t.prepare(
        "INSERT INTO tasks_items (title, status, project_id, archived_at) VALUES (?,?,?,?)"
      ).run("Old Title", "in_progress", PROJECT_ID, "2026-08-10T00:00:00Z").lastInsertRowid
    );
    t.close();

    const localHash = contentHash({ title: "Old Title", status: "in_progress" });
    const c = new Database(f.crowDbPath);
    c.prepare(
      "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
    ).run(BOARD_ID, "item-Z2", "kanban", rowId, localHash, "2026-01-01T00:00:00Z");
    c.close();

    const cdb = createDbClient(f.crowDbPath);
    const tdb = createDbClient(f.tasksDbPath);

    const board = kanbanBoard();
    const item = {
      id: "item-Z2", name: "New Title From Monday", updated_at: "2026-08-15T00:00:00Z",
      group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
    };

    const totals1 = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };
    await syncTwowayBoard(cdb, tdb, board, [item], "test-token", totals1);
    assert.equal(totals1.updated, 1);

    // Second pass: same item, same updated_at — remoteChanged is now false
    // (monday_updated_at converged), localChanged is false (content_hash
    // converged) → lands in the no-op branch.
    const totals2 = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };
    await syncTwowayBoard(cdb, tdb, board, [item], "test-token", totals2);
    assert.equal(totals2.created, 0);
    assert.equal(totals2.updated, 0);
    assert.equal(totals2.errors, 0);

    const rowCount = (await tdb.execute({ sql: "SELECT COUNT(*) AS n FROM tasks_items", args: [] })).rows[0].n;
    assert.equal(Number(rowCount), 1, "still exactly one row");

    const stateRows = (await cdb.execute({ sql: "SELECT COUNT(*) AS n FROM pm_sync_state WHERE board_id=? AND item_id=?", args: [BOARD_ID, "item-Z2"] })).rows;
    assert.equal(Number(stateRows[0].n), 1, "still exactly one mapping row");

    await cdb.close();
    await tdb.close();
  } finally {
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// 5. legacy store without archived_at runs every path without crashing
// ---------------------------------------------------------------------------
test("syncTwowayBoard: a store without archived_at (legacy shape) runs all paths without crashing", async () => {
  const f = fixture({ legacy: true });
  const fetchStub = stubFetchOk();
  try {
    const { createDbClient } = await import("../servers/db.js");
    const { syncTwowayBoard, contentHash } = await import("../bundles/pm-workspace/server/sync/monday.js");

    const t = new Database(f.tasksDbPath);
    // mapped row with a pending local edit → push path
    const pushRowId = Number(
      t.prepare("INSERT INTO tasks_items (title, status, project_id) VALUES (?,?,?)")
        .run("Legacy Push Card", "in_progress", PROJECT_ID).lastInsertRowid
    );
    // mapped row → remote-newer pull path
    const pullRowId = Number(
      t.prepare("INSERT INTO tasks_items (title, status, project_id) VALUES (?,?,?)")
        .run("Legacy Old Title", "in_progress", PROJECT_ID).lastInsertRowid
    );
    // unmapped row → create-scan path
    t.prepare("INSERT INTO tasks_items (title, status, project_id) VALUES (?,?,?)")
      .run("Legacy Unmapped Card", "done", PROJECT_ID);
    t.close();

    const c = new Database(f.crowDbPath);
    c.prepare(
      "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
    ).run(BOARD_ID, "item-push", "kanban", pushRowId, "stale-hash-forces-local-change", "2026-01-01T00:00:00Z");
    const pullLocalHash = contentHash({ title: "Legacy Old Title", status: "in_progress" });
    c.prepare(
      "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
    ).run(BOARD_ID, "item-pull", "kanban", pullRowId, pullLocalHash, "2026-01-01T00:00:00Z");
    c.close();

    const cdb = createDbClient(f.crowDbPath);
    const tdb = createDbClient(f.tasksDbPath);

    const board = kanbanBoard();
    const items = [
      {
        id: "item-push", name: "Legacy Push Card", updated_at: "2026-01-01T00:00:00Z",
        group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
      },
      {
        id: "item-pull", name: "Legacy New Title", updated_at: "2026-08-15T00:00:00Z",
        group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
      },
    ];
    const totals = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };

    await assert.doesNotReject(
      syncTwowayBoard(cdb, tdb, board, items, "test-token", totals),
      "must not crash on a store lacking archived_at"
    );

    assert.equal(totals.errors, 0);
    assert.equal(totals.updated, 1, "the pull-target row updates");
    assert.equal(totals.created, 1, "the unmapped done card creates remotely (no archived_at to guard on)");

    const logRows = (await cdb.execute({ sql: "SELECT action FROM pm_sync_log", args: [] })).rows;
    assert.ok(logRows.some((r) => r.action === "update_local"), "legacy row uses the normal action, not pull_archived_update");
    assert.ok(!logRows.some((r) => r.action === "pull_archived_update"));

    await cdb.close();
    await tdb.close();
  } finally {
    fetchStub.restore();
    cleanup(f);
  }
});
