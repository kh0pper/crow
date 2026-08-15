// tests/board-card-service.test.js
//
// Track 1 Task 2: card-service.js is THE single card/item writer. Tested
// against the REAL migrated tasks.db shape (migrations 0001-0004 via the
// runner) — same fixture pattern as tests/track1-migration.test.js (Task 1):
// mark 0001-0003 done in bookkeeping, hand-seed a post-0003 shape, run the
// runner so 0004 executes for real and leaves board_mutations/autonomy/
// archived_at behind. cdb (crow.db) carries bot_jobs/bot_sessions for the
// lock predicate (board-lock.js) — created empty-shaped here; absent-table
// try/catch degrades to "not locked" so most tests don't need rows in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import {
  getCard, getItem, createCard, updateCard, moveCard,
  archiveCard, unarchiveCard, moveItem, updateItem, archiveItem,
  unarchiveItem, recordMutation,
} from "../servers/gateway/board/card-service.js";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

const HUMAN = { kind: "human", id: "kevin", jobId: null };
const BOT = { kind: "bot", id: "bot-1", jobId: "job-abc" };

function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

function seedPost0003TasksDb(t) {
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

/**
 * A fresh migrated store: real 0004 run, board_defs seeded with a project
 * board (project_id=1, statuses incl a terminal 'done') and a slug board
 * (tracker 'intake', statuses incl terminal 'shipped'). Returns open
 * tdb/cdb clients (libsql-shaped) plus the raw dirs for cleanup.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cardsvc-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");

  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
    CREATE TABLE bot_jobs (job_id TEXT PRIMARY KEY, bot_id TEXT, card_id INTEGER, card_action TEXT,
      status TEXT, worker_pid INTEGER, started_at TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER, status TEXT,
      pi_session_dir TEXT, updated_at TEXT DEFAULT (datetime('now')));`);
  c.close();

  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.close();

  return { root, dbPath, tasksDbPath };
}

async function withStore(fn) {
  const f = fixture();
  try {
    await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });
    const tdb = createDbClient(f.tasksDbPath);
    const cdb = createDbClient(f.dbPath);
    await tdb.execute({
      sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (1,'Proj',?,?,'[]')",
      args: ['["pending","in_progress","done"]', '["done"]'],
    });
    await tdb.execute({
      sql: "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('intake','Intake',?,?,'[]')",
      args: ['["planned","drafting","shipped"]', '["shipped"]'],
    });
    const intakeBoardId = Number((await tdb.execute({ sql: "SELECT id FROM board_defs WHERE slug='intake'", args: [] })).rows[0].id);
    try {
      await fn({ tdb, cdb, tasksDbPath: f.tasksDbPath, dbPath: f.dbPath, intakeBoardId });
    } finally {
      tdb.close();
      cdb.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

async function allMutations(tdb, itemId) {
  return (await tdb.execute({ sql: "SELECT * FROM board_mutations WHERE item_id=? ORDER BY id ASC", args: [itemId] })).rows;
}

async function insertItem(tdb, boardId, fields) {
  const r = await tdb.execute({
    sql: "INSERT INTO tasks_items (title, status, priority, board_id) VALUES (?,?,?,?)",
    args: [fields.title || "item", fields.status || "planned", fields.priority ?? 3, boardId],
  });
  return Number(r.lastInsertRowid);
}

// ---- createCard ----

test("createCard validates status against the resolved def and records a create mutation", async () => {
  await withStore(async ({ tdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    assert.ok(Number.isInteger(id));
    const muts = await allMutations(tdb, id);
    assert.equal(muts.length, 1);
    assert.equal(muts[0].verb, "create");
    assert.equal(muts[0].actor_kind, "human");
    assert.equal(muts[0].actor_id, "kevin");
  });
});

test("createCard rejects an off-def status", async () => {
  await withStore(async ({ tdb }) => {
    await assert.rejects(
      () => createCard(tdb, { title: "t", status: "not-a-status", project_id: 1 }, HUMAN),
      (e) => { assert.equal(e.code, "bad_status"); assert.equal(e.http, 400); return true; },
    );
  });
});

test("createCard parent_id must exist and child inherits project", async () => {
  await withStore(async ({ tdb }) => {
    const parent = await createCard(tdb, { title: "parent", status: "pending", project_id: 1 }, HUMAN);
    const child = await createCard(tdb, { title: "child", status: "pending", parent_id: parent.id }, HUMAN);
    const row = await getCard(tdb, child.id);
    assert.equal(row.project_id, 1);
    assert.equal(row.parent_id, parent.id);

    await assert.rejects(
      () => createCard(tdb, { title: "orphan", status: "pending", parent_id: 999999 }, HUMAN),
      (e) => { assert.equal(e.code, "bad_parent"); assert.equal(e.http, 400); return true; },
    );
  });
});

// ---- updateCard ----

test("updateCard records a field diff and refuses archived cards", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const { id } = await createCard(tdb, { title: "orig", status: "pending", project_id: 1 }, HUMAN);
    await updateCard(tdb, id, { title: "changed", owner: "kevin" }, HUMAN);
    const row = await getCard(tdb, id);
    assert.equal(row.title, "changed");
    assert.equal(row.owner, "kevin");
    const muts = await allMutations(tdb, id);
    const upd = muts.find((m) => m.verb === "update");
    assert.ok(upd);
    const detail = JSON.parse(upd.detail_json);
    assert.deepEqual(detail.title, ["orig", "changed"]);
    assert.deepEqual(detail.owner, [null, "kevin"]);
    assert.ok(!("status" in detail));

    await archiveCard(tdb, cdb, id, HUMAN);
    await assert.rejects(
      () => updateCard(tdb, id, { title: "again" }, HUMAN),
      (e) => { assert.equal(e.code, "archived"); assert.equal(e.http, 409); return true; },
    );
  });
});

// ---- moveCard ----

test("moveCard stamps completed_at on terminal entry and clears on exit", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    let row = await getCard(tdb, id);
    assert.equal(row.completed_at, null);

    await moveCard(tdb, cdb, id, "done", HUMAN);
    row = await getCard(tdb, id);
    assert.equal(row.status, "done");
    assert.ok(row.completed_at, "completed_at set on terminal entry");

    await moveCard(tdb, cdb, id, "in_progress", HUMAN);
    row = await getCard(tdb, id);
    assert.equal(row.status, "in_progress");
    assert.equal(row.completed_at, null, "completed_at cleared on exit from terminal");

    const muts = await allMutations(tdb, id);
    assert.ok(muts.filter((m) => m.verb === "move").length >= 2);
  });
});

test("moveCard refuses tracker-item ids (board_id NOT NULL) with not_found", async () => {
  await withStore(async ({ tdb, cdb, intakeBoardId }) => {
    const itemId = await insertItem(tdb, intakeBoardId, { title: "tracker item", status: "planned" });
    await assert.rejects(
      () => moveCard(tdb, cdb, itemId, "done", HUMAN),
      (e) => { assert.equal(e.code, "not_found"); assert.equal(e.http, 404); return true; },
    );
  });
});

test("moveCard refuses off-def status with bad_status", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    await assert.rejects(
      () => moveCard(tdb, cdb, id, "nope", HUMAN),
      (e) => { assert.equal(e.code, "bad_status"); assert.equal(e.http, 400); return true; },
    );
  });
});

test("moveCard refuses a locked card unless lockExempt matches the job rail", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    await cdb.execute({
      sql: "INSERT INTO bot_jobs (job_id, bot_id, card_id, card_action, status) VALUES (?,?,?,?,?)",
      args: ["job-abc", "bot-1", id, "work", "running"],
    });

    await assert.rejects(
      () => moveCard(tdb, cdb, id, "done", HUMAN),
      (e) => { assert.equal(e.code, "locked"); assert.equal(e.http, 409); return true; },
    );

    // wrong job id does not exempt
    await assert.rejects(
      () => moveCard(tdb, cdb, id, "done", BOT, { lockExempt: { kind: "bot", id: "bot-1", jobId: "job-other" } }),
      (e) => { assert.equal(e.code, "locked"); return true; },
    );

    // matching job id exempts
    await moveCard(tdb, cdb, id, "done", BOT, { lockExempt: { kind: "bot", id: "bot-1", jobId: "job-abc" } });
    const row = await getCard(tdb, id);
    assert.equal(row.status, "done");
  });
});

// ---- archiveCard / unarchiveCard ----

test("archiveCard refuses a locked card / unarchive restores exactly", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    await cdb.execute({
      sql: "INSERT INTO bot_jobs (job_id, bot_id, card_id, card_action, status) VALUES (?,?,?,?,?)",
      args: ["job-x", "bot-1", id, "work", "running"],
    });
    await assert.rejects(
      () => archiveCard(tdb, cdb, id, HUMAN),
      (e) => { assert.equal(e.code, "locked"); assert.equal(e.http, 409); return true; },
    );
    await cdb.execute({ sql: "UPDATE bot_jobs SET status='completed' WHERE job_id=?", args: ["job-x"] });

    await archiveCard(tdb, cdb, id, HUMAN);
    let row = await getCard(tdb, id);
    assert.ok(row.archived_at, "archived_at set");

    await assert.rejects(
      () => archiveCard(tdb, cdb, id, HUMAN),
      (e) => { assert.equal(e.code, "archived"); assert.equal(e.http, 409); return true; },
    );

    await unarchiveCard(tdb, id, HUMAN);
    row = await getCard(tdb, id);
    assert.equal(row.archived_at, null, "unarchive restores exactly");
    assert.equal(row.status, "pending", "unarchive touches archived_at only");

    const muts = await allMutations(tdb, id);
    assert.ok(muts.some((m) => m.verb === "archive"));
    assert.ok(muts.some((m) => m.verb === "unarchive"));
  });
});

// ---- item side ----

test("archiveItem refuses an active lease; moveItem validates against the slug board's def", async () => {
  await withStore(async ({ tdb, intakeBoardId }) => {
    const itemId = await insertItem(tdb, intakeBoardId, { title: "leased", status: "planned" });
    await tdb.execute({
      sql: "UPDATE tasks_items SET processing_lease=?, processing_lease_status='in-progress' WHERE id=?",
      args: ["lease-1", itemId],
    });
    await assert.rejects(
      () => archiveItem(tdb, itemId, HUMAN),
      (e) => { assert.equal(e.code, "locked"); assert.equal(e.http, 409); return true; },
    );
    await tdb.execute({ sql: "UPDATE tasks_items SET processing_lease=NULL, processing_lease_status=NULL WHERE id=?", args: [itemId] });
    await archiveItem(tdb, itemId, HUMAN);
    const row = await getItem(tdb, itemId);
    assert.ok(row.archived_at);

    const itemId2 = await insertItem(tdb, intakeBoardId, { title: "movable", status: "planned" });
    await assert.rejects(
      () => moveItem(tdb, itemId2, "not-a-status", HUMAN),
      (e) => { assert.equal(e.code, "bad_status"); assert.equal(e.http, 400); return true; },
    );
    await moveItem(tdb, itemId2, "shipped", HUMAN);
    const row2 = await getItem(tdb, itemId2);
    assert.equal(row2.status, "shipped");
    assert.ok(row2.completed_at, "terminal entry stamps completed_at for items too");
  });
});

test("item mutations record provenance rows (move/update/archive)", async () => {
  await withStore(async ({ tdb, intakeBoardId }) => {
    const itemId = await insertItem(tdb, intakeBoardId, { title: "provenance", status: "planned" });
    await moveItem(tdb, itemId, "drafting", BOT);
    await updateItem(tdb, itemId, { title: "renamed" }, BOT);
    await archiveItem(tdb, itemId, HUMAN);
    const muts = await allMutations(tdb, itemId);
    const verbs = muts.map((m) => m.verb);
    assert.ok(verbs.includes("move"));
    assert.ok(verbs.includes("update"));
    assert.ok(verbs.includes("archive"));
  });
});

test("updateItem allows lease-field writes on an archived item but refuses other fields", async () => {
  await withStore(async ({ tdb, intakeBoardId }) => {
    const itemId = await insertItem(tdb, intakeBoardId, { title: "leasable", status: "planned" });
    await archiveItem(tdb, itemId, HUMAN);

    await updateItem(tdb, itemId, { processing_lease: "lease-9", processing_lease_status: "in-progress" }, BOT);
    const row = await getItem(tdb, itemId);
    assert.equal(row.processing_lease, "lease-9");
    assert.equal(row.processing_lease_status, "in-progress");

    await assert.rejects(
      () => updateItem(tdb, itemId, { title: "nope" }, BOT),
      (e) => { assert.equal(e.code, "archived"); assert.equal(e.http, 409); return true; },
    );
  });
});

test("unarchiveItem flips archived_at only", async () => {
  await withStore(async ({ tdb, intakeBoardId }) => {
    const itemId = await insertItem(tdb, intakeBoardId, { title: "roundtrip", status: "drafting" });
    await archiveItem(tdb, itemId, HUMAN);
    await unarchiveItem(tdb, itemId, HUMAN);
    const row = await getItem(tdb, itemId);
    assert.equal(row.archived_at, null);
    assert.equal(row.status, "drafting");
  });
});

// ---- mutation rows / provenance details ----

test("mutation rows carry job_id for bot actors", async () => {
  await withStore(async ({ tdb, cdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    await cdb.execute({
      sql: "INSERT INTO bot_jobs (job_id, bot_id, card_id, card_action, status) VALUES (?,?,?,?,?)",
      args: ["job-abc", "bot-1", id, "work", "running"],
    });
    await moveCard(tdb, cdb, id, "done", BOT, { lockExempt: { kind: "bot", id: "bot-1", jobId: "job-abc" } });
    const muts = await allMutations(tdb, id);
    const mv = muts.find((m) => m.verb === "move");
    assert.equal(mv.actor_kind, "bot");
    assert.equal(mv.actor_id, "bot-1");
    assert.equal(mv.job_id, "job-abc");
  });
});

test("recordMutation writes exactly the given verb/actor/detail", async () => {
  await withStore(async ({ tdb }) => {
    const { id } = await createCard(tdb, { title: "t", status: "pending", project_id: 1 }, HUMAN);
    await recordMutation(tdb, { itemId: id, verb: "note", actor: HUMAN, detail: { foo: [1, 2] } });
    const muts = await allMutations(tdb, id);
    const note = muts.find((m) => m.verb === "note");
    assert.ok(note);
    assert.deepEqual(JSON.parse(note.detail_json), { foo: [1, 2] });
  });
});
