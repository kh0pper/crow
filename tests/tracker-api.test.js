// tests/tracker-api.test.js
//
// Track 0 Phase B: the tracker endpoints (POST /tracker, POST /tracker/:slug,
// GET /trackers, GET /tracker/:slug/items, GET|POST /tracker-item/:id,
// POST /tracker-item/:id/move, POST /tracker-item, POST
// /tracker-item/:id/force-clear-lease) re-point from crow.db's dropped
// tracker_defs/tracker_items onto tasks.db's board_defs/tasks_items (slug
// rows, migration 0003). Harness mirrors tests/board-card-api.test.js
// (ephemeral express server, plain fetch, auth-stub pass-through) and the
// env-before-import seeding of tests/board-panel-config.test.js.
//
// Contract under test (per task-3-brief.md): paths and response JSON KEYS AND
// VALUE TYPES are byte-compatible with the crow.db era. Def envelopes
// (status_values / columns_json) are raw JSON STRINGS, never parsed arrays —
// the untouched client.js JSON.parses them (client.js:118/124/426); handing
// it an array throws and empties the drawer. Items expose `label` (alias of
// `title`). GET /trackers keeps `id` in its key set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "tracker-api-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

let boardId, itemAId, itemBId, cardId;

// Seed BEFORE importing the router (module reads env at import time).
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    board_id INTEGER, bot_id TEXT, assigned_bot TEXT, plan_ref TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated',
    data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT, archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Track 1 Task 9: the six-route convergence means every write below now
  // goes through card-service.js, which records a board_mutations row and
  // (for GET /card/:id) reads board_plans/board_results for the additive
  // plan_head/latest_results keys — all three must exist even though this
  // fixture predates the 0004 migration (same minimal-table pattern as
  // tests/board-job-lock.test.js).
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.exec(`CREATE TABLE board_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    version INTEGER NOT NULL, body_md TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    created_actor_kind TEXT NOT NULL, created_actor_id TEXT, decided_at TEXT, decided_via TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.exec(`CREATE TABLE board_results (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    plan_id INTEGER, job_id TEXT, actor_kind TEXT NOT NULL, actor_id TEXT, outcome TEXT NOT NULL,
    summary_md TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'recorded',
    decided_at TEXT, decided_via TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  const fields = JSON.stringify([{ key: "asset_type", label: "Type", type: "text", readonly: false, storage: "data" }]);
  t.prepare(
    "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('intake','Intake',?,?,?)"
  ).run('["planned","drafting","done"]', '["done"]', fields);
  boardId = t.prepare("SELECT id FROM board_defs WHERE slug='intake'").get().id;

  // A project board_defs row (slug NULL) — must never leak into the tracker
  // selector or the /tracker/:slug/items path (isolation).
  t.prepare(
    "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (9,'Proj',?,?,?)"
  ).run('["todo","done"]', '["done"]', "[]");

  const insItem = t.prepare(
    `INSERT INTO tasks_items (board_id, bot_id, status, priority, title, data_json, action_needed, processing_lease, processing_lease_status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  itemAId = Number(insItem.run(boardId, null, "planned", 2, "Poster EN", '{"asset_type":"poster"}', null, null, null).lastInsertRowid);
  itemBId = Number(insItem.run(boardId, "scout", "drafting", 3, "Flyer ES", '{"asset_type":"flyer"}', "needs review", "lease-1", "in-progress").lastInsertRowid);

  // A plain project card (project_id set, board_id NULL) — proves isolation
  // the other direction: the tracker items query must not pick it up, and a
  // project-board query (project_id=?) must not pick up tracker items.
  cardId = Number(t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES ('Standalone Card', 9, 'todo')").run().lastInsertRowid);

  t.close();
}

let server, base, tdbFile;
before(async () => {
  const { default: express } = await import("express");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter((req, res, next) => next())); // auth stub
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/bot-board-api";
  tdbFile = process.env.CROW_TASKS_DB_PATH;
});
after(() => server && server.close());

test("GET /trackers def envelopes are JSON STRINGS, not arrays", async () => {
  const r = await (await fetch(base + "/trackers")).json();
  assert.ok(Array.isArray(r.trackers));
  const t = r.trackers.find((x) => x.slug === "intake");
  assert.ok(t, "intake tracker present");
  assert.equal(typeof t.status_values, "string", "status_values must be a raw JSON string");
  assert.equal(typeof t.columns_json, "string", "columns_json must be a raw JSON string");
  assert.deepEqual(Object.keys(t).sort(), ["columns_json", "display_name", "id", "slug", "status_values"].sort());
  assert.deepEqual(JSON.parse(t.status_values), ["planned", "drafting", "done"]);
  // the project board_defs row (slug NULL) must not appear in the tracker list
  assert.ok(!r.trackers.some((x) => x.display_name === "Proj"), "project boards must not leak into /trackers");
});

test("GET /tracker-item/:id tracker envelope is strings too, and entry keys incl. type survive", async () => {
  const r = await (await fetch(base + "/tracker-item/" + itemAId)).json();
  assert.equal(typeof r.tracker.status_values, "string");
  assert.equal(typeof r.tracker.columns_json, "string");
  const cols = JSON.parse(r.tracker.columns_json);
  assert.equal(cols[0].key, "asset_type");
  assert.equal(cols[0].type, "text", "the `type` entry key must survive mapFields — the client branches on it");
  assert.equal(cols[0].readonly, false, "the `readonly` entry key must survive too");
  assert.equal(r.item.label, "Poster EN");
  assert.deepEqual(r.item.data, { asset_type: "poster" });
  assert.equal(r.locked, false);
});

test("GET /tracker/:slug/items returns items with the label key", async () => {
  const r = await (await fetch(base + "/tracker/intake/items")).json();
  assert.equal(typeof r.tracker.status_values, "string");
  assert.equal(typeof r.tracker.columns_json, "string");
  const labels = r.items.map((i) => i.label).sort();
  assert.deepEqual(labels, ["Flyer ES", "Poster EN"]);
  assert.ok(!r.items.some((i) => i.label === "Standalone Card"), "the plain project card must not appear");
  const flyer = r.items.find((i) => i.label === "Flyer ES");
  const poster = r.items.find((i) => i.label === "Poster EN");
  assert.equal(r.locks[flyer.id], true, "locked item (lease in-progress) reflected in locks");
  assert.ok(!Object.hasOwn(r.locks, String(poster.id)), "unlocked item absent from locks");
});

test("POST /tracker-item creates with default status = first def status", async () => {
  const r = await fetch(base + "/tracker-item", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tracker_slug: "intake", label: "New Card" }),
  });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const d = new Database(tdbFile);
  const row = d.prepare("SELECT title, status, board_id FROM tasks_items WHERE id=?").get(id);
  d.close();
  assert.deepEqual(row, { title: "New Card", status: "planned", board_id: boardId });
});

test("POST /tracker-item/:id/move validates against the def and 400s off-list", async () => {
  const ok = await fetch(base + "/tracker-item/" + itemAId + "/move", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }),
  });
  assert.equal(ok.status, 200);
  const d = new Database(tdbFile);
  assert.equal(d.prepare("SELECT status FROM tasks_items WHERE id=?").get(itemAId).status, "done");
  d.close();
  const bad = await fetch(base + "/tracker-item/" + itemAId + "/move", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "bogus" }),
  });
  assert.equal(bad.status, 400);
  // restore for later tests
  const d2 = new Database(tdbFile);
  d2.prepare("UPDATE tasks_items SET status='planned' WHERE id=?").run(itemAId);
  d2.close();
});

test("POST /tracker-item/:id edit merges data_json and maps label→title", async () => {
  const r = await fetch(base + "/tracker-item/" + itemAId, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Poster EN v2", data: { color: "blue" } }),
  });
  assert.equal(r.status, 200);
  const d = new Database(tdbFile);
  const row = d.prepare("SELECT title, data_json FROM tasks_items WHERE id=?").get(itemAId);
  d.close();
  assert.equal(row.title, "Poster EN v2");
  assert.deepEqual(JSON.parse(row.data_json), { asset_type: "poster", color: "blue" }, "merge, not replace");
});

test("locked item (lease in-progress) 409s on edit and move", async () => {
  const edit = await fetch(base + "/tracker-item/" + itemBId, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "nope" }),
  });
  assert.equal(edit.status, 409);
  const move = await fetch(base + "/tracker-item/" + itemBId + "/move", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }),
  });
  assert.equal(move.status, 409);
});

test("POST /tracker creates a board_defs slug row with the done-terminal rule", async () => {
  const r = await fetch(base + "/tracker", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: "Reviews", display_name: "Reviews",
      status_values: ["todo", "done"],
      columns_json: [{ key: "assignee", label: "Assignee", type: "text" }],
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json().catch(() => ({}))));
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.slug, "reviews");
  const d = new Database(tdbFile);
  const row = d.prepare("SELECT status_values, terminal_values, fields_json FROM board_defs WHERE id=?").get(body.id);
  d.close();
  assert.equal(row.terminal_values, '["done"]', "'done' present in status_values → terminal-seeded");
  assert.deepEqual(JSON.parse(row.fields_json), [{ key: "assignee", label: "Assignee", type: "text", storage: "data" }],
    "spread-preserving: unknown entry keys (type) survive the normalization");

  // no 'done' in the list → empty terminals
  const r2 = await fetch(base + "/tracker", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "no-done", display_name: "No Done", status_values: ["a", "b"], columns_json: [] }),
  });
  assert.equal(r2.status, 200);
  const { id: id2 } = await r2.json();
  const d2 = new Database(tdbFile);
  assert.equal(d2.prepare("SELECT terminal_values FROM board_defs WHERE id=?").get(id2).terminal_values, "[]");
  d2.close();
});

test("tracker items never leak into a project board query and vice versa", async () => {
  const r = await (await fetch(base + "/tracker/intake/items")).json();
  assert.ok(!r.items.some((i) => i.label === "Standalone Card"));
  const d = new Database(tdbFile);
  // mirrors the project board's own query shape (html.js:298 — SELECT * FROM
  // tasks_items WHERE project_id=?)
  const projectRows = d.prepare("SELECT title FROM tasks_items WHERE project_id=9").all();
  d.close();
  assert.deepEqual(projectRows.map((r2) => r2.title), ["Standalone Card"], "tracker items carry no project_id");
});

test("POST /tracker/:slug updates display_name/status_values/columns_json; 404 on missing slug", async () => {
  const r = await fetch(base + "/tracker/intake", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Intake v2", columns_json: [{ key: "notes", label: "Notes", readonly: true }] }),
  });
  assert.equal(r.status, 200);
  const d = new Database(tdbFile);
  const row = d.prepare("SELECT display_name, fields_json FROM board_defs WHERE id=?").get(boardId);
  d.close();
  assert.equal(row.display_name, "Intake v2");
  assert.deepEqual(JSON.parse(row.fields_json), [{ key: "notes", label: "Notes", readonly: true, storage: "data" }]);

  const missing = await fetch(base + "/tracker/does-not-exist", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "X" }),
  });
  assert.equal(missing.status, 404);
});

test("POST /tracker-item/:id/force-clear-lease unlocks a locked item, no-ops on an unlocked one", async () => {
  const clear = await fetch(base + "/tracker-item/" + itemBId + "/force-clear-lease", { method: "POST" });
  assert.equal(clear.status, 200);
  const d = new Database(tdbFile);
  const row = d.prepare("SELECT processing_lease, processing_lease_status FROM tasks_items WHERE id=?").get(itemBId);
  d.close();
  assert.deepEqual(row, { processing_lease: null, processing_lease_status: null });
  const again = await (await fetch(base + "/tracker-item/" + itemBId + "/force-clear-lease", { method: "POST" })).json();
  assert.equal(again.ok, true);
  assert.equal(again.message, "already unlocked");
});

// F2: tasks_items is a MERGED id space — card ids (board_id NULL) and
// tracker-item ids (board_id set) share one AUTOINCREMENT sequence. Every
// tracker-item by-id endpoint must 404 on a card id (never read/write it with
// card validation skipped), and symmetrically every card by-id endpoint must
// 404 on a tracker-item id.

test("POST /tracker-item/<cardId>/move 404s on a plain card id and leaves the card untouched", async () => {
  const before = (() => {
    const d = new Database(tdbFile);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(cardId);
    d.close();
    return r;
  })();
  const r = await fetch(base + "/tracker-item/" + cardId + "/move", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "todo" }),
  });
  assert.equal(r.status, 404, "a card id must not resolve as a tracker item");
  const after = (() => {
    const d = new Database(tdbFile);
    const r2 = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(cardId);
    d.close();
    return r2;
  })();
  assert.deepEqual(after, before, "the card row must be byte-unchanged");
});

test("GET/POST /tracker-item/<cardId> and force-clear-lease all 404 on a plain card id", async () => {
  const get = await fetch(base + "/tracker-item/" + cardId);
  assert.equal(get.status, 404);
  const edit = await fetch(base + "/tracker-item/" + cardId, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "hijacked" }),
  });
  assert.equal(edit.status, 404);
  const clear = await fetch(base + "/tracker-item/" + cardId + "/force-clear-lease", { method: "POST" });
  assert.equal(clear.status, 404);
  const d = new Database(tdbFile);
  const row = d.prepare("SELECT title FROM tasks_items WHERE id=?").get(cardId);
  d.close();
  assert.equal(row.title, "Standalone Card", "edit must not have hijacked the card's title");
});

test("card move endpoint on a tracker-item id 404s and leaves the item untouched (symmetric guard)", async () => {
  const before = (() => {
    const d = new Database(tdbFile);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(itemAId);
    d.close();
    return r;
  })();
  const r = await fetch(base + "/card/" + itemAId + "/move", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }),
  });
  assert.equal(r.status, 404, "a tracker-item id must not resolve as a card");
  const after = (() => {
    const d = new Database(tdbFile);
    const r2 = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(itemAId);
    d.close();
    return r2;
  })();
  assert.deepEqual(after, before, "the tracker item row must be byte-unchanged");
});

test("card GET/edit/cancel all 404 on a tracker-item id (symmetric guard)", async () => {
  const before = (() => {
    const d = new Database(tdbFile);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(itemAId);
    d.close();
    return r;
  })();
  const get = await fetch(base + "/card/" + itemAId);
  assert.equal(get.status, 404);
  const edit = await fetch(base + "/card/" + itemAId, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "hijacked" }),
  });
  assert.equal(edit.status, 404);
  const cancel = await fetch(base + "/card/" + itemAId + "/cancel", { method: "POST" });
  assert.equal(cancel.status, 404);
  const after = (() => {
    const d = new Database(tdbFile);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(itemAId);
    d.close();
    return r;
  })();
  assert.deepEqual(after, before, "the tracker item row must be byte-unchanged (edit must not have hijacked it)");
});
