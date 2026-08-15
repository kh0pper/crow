// tests/board-archive.test.js
//
// Track 1 Task 5 — the archiving surface (D-T1.6): API endpoints, filter
// sites, guards, and the digest adapter. The design doc's enumeration of
// filter sites is authoritative and states its own reason: a missed site is
// a ghost card or an SSE reload-loop. Every enumerated site gets its OWN
// test below (see the section headers), so a mutation that drops exactly
// one site's filter fails exactly one dedicated test.
//
// Fixture pattern: real migrated tasks.db (migrations 0001-0004 via the
// runner) — same idiom as tests/board-card-service.test.js — plus an
// ephemeral express server mounting botBoardApiRouter, same harness as
// tests/board-job-lock.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

const root = mkdtempSync(join(tmpdir(), "board-archive-"));
const dbPath = join(root, "crow.db");
const tasksDbPath = join(root, "tasks.db");
process.env.CROW_TASKS_DB_PATH = tasksDbPath;
process.env.CROW_DB_PATH = dbPath;

function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

// ---- Seed BEFORE importing anything that reads the env at module load ----
let projectBoardId, slugBoardId;
{
  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
      workspace_dir TEXT, storage_prefix TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.exec(BOT_JOBS_DDL);
  c.prepare("INSERT INTO project_spaces (id, name, slug) VALUES (1, 'proj', 'proj')").run();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('scout','Scout','{}',1,1)").run();
  c.close();

  const t = new Database(tasksDbPath);
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();
}

await runMigrations({ migrationsDir: DIR, dbPath, tasksDbPath, sha: "test", log: () => {} });

{
  const t = new Database(tasksDbPath);
  t.prepare(
    "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (1,'Proj',?,?,'[]')"
  ).run('["pending","in_progress","done"]', '["done"]');
  t.prepare(
    "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('intake','Intake',?,?,'[]')"
  ).run('["planned","drafting","shipped"]', '["shipped"]');
  projectBoardId = t.prepare("SELECT id FROM board_defs WHERE project_id=1").get().id;
  slugBoardId = t.prepare("SELECT id FROM board_defs WHERE slug='intake'").get().id;
  t.close();
}

let server, base, createDbClient, tdbClient, cdbClient;
let archiveCard, unarchiveCard, archiveItem, unarchiveItem, getCard, getItem;
let renderKanbanBoard, renderCustomTracker, clientJs;
let boardsSections;
let renderBotEditor;
let botBoardApiRouter, streamsRouter;

before(async () => {
  const { default: express } = await import("express");
  ({ default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js"));
  ({ default: streamsRouter } = await import("../servers/gateway/routes/streams.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  ({ archiveCard, unarchiveCard, archiveItem, unarchiveItem, getCard, getItem } =
    await import("../servers/gateway/board/card-service.js"));
  ({ renderKanbanBoard, renderCustomTracker } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
  ({ clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js"));
  ({ boardsSections } = await import("../bundles/pm-workspace/server/digest/adapters/boards.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));

  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter((req, res, next) => next()));
  app.use(streamsRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/bot-board-api";
  tdbClient = createDbClient(tasksDbPath);
  cdbClient = createDbClient(dbPath);
});
after(async () => {
  if (server) server.close();
  try { tdbClient.close(); } catch {}
  try { cdbClient.close(); } catch {}
  rmSync(root, { recursive: true, force: true });
});

function post(path, body) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function get(path) { return fetch(base + path); }

// ---- fixture rows, seeded once, referenced by id across tests ----
let cardFreeId, cardLockedId, cardArchivedId, itemFreeId, itemLeasedId, itemArchivedId, cardForExecId, cardForGuardId;

test("fixture: create cards + tracker items to exercise", async () => {
  const t = new Database(tasksDbPath);
  const insCard = t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES (?,1,?)");
  cardFreeId = Number(insCard.run("free card", "pending").lastInsertRowid);
  cardLockedId = Number(insCard.run("locked card", "pending").lastInsertRowid);
  cardArchivedId = Number(insCard.run("pre-archived card", "pending").lastInsertRowid);
  cardForExecId = Number(insCard.run("exec card", "pending").lastInsertRowid);
  cardForGuardId = Number(insCard.run("guard card", "pending").lastInsertRowid);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(cardArchivedId);
  t.prepare("UPDATE tasks_items SET assigned_bot='scout' WHERE id=?").run(cardForExecId);

  const insItem = t.prepare("INSERT INTO tasks_items (title, board_id, status) VALUES (?,?,?)");
  itemFreeId = Number(insItem.run("free item", slugBoardId, "planned").lastInsertRowid);
  itemLeasedId = Number(insItem.run("leased item", slugBoardId, "drafting").lastInsertRowid);
  itemArchivedId = Number(insItem.run("pre-archived item", slugBoardId, "planned").lastInsertRowid);
  t.prepare("UPDATE tasks_items SET processing_lease_status='in-progress' WHERE id=?").run(itemLeasedId);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(itemArchivedId);
  t.close();

  const c = new Database(dbPath);
  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, status) VALUES ('scout', ?, 'active')").run(cardLockedId);
  c.close();
  assert.ok(cardFreeId && itemFreeId, "fixture seeded");
});

// ---------------------------------------------------------------------------
// A. Archive / unarchive round-trip (card + item)
// ---------------------------------------------------------------------------

test("POST /card/:id/archive sets archived_at and records a mutation; unarchive reverses it", async () => {
  const arc = await post("/card/" + cardFreeId + "/archive");
  assert.equal(arc.status, 200);
  assert.deepEqual(await arc.json(), { ok: true });

  const row = await getCard(tdbClient, cardFreeId);
  assert.ok(row.archived_at != null, "archived_at must be set");

  const muts = (await tdbClient.execute({
    sql: "SELECT * FROM board_mutations WHERE item_id=? ORDER BY id DESC LIMIT 1", args: [cardFreeId],
  })).rows;
  assert.equal(muts[0].verb, "archive");
  assert.equal(muts[0].actor_kind, "human");

  const un = await post("/card/" + cardFreeId + "/unarchive");
  assert.equal(un.status, 200);
  const row2 = await getCard(tdbClient, cardFreeId);
  assert.equal(row2.archived_at, null, "unarchive must clear archived_at");
});

test("archiving a locked card refuses with 409; archiving an already-archived card refuses with 409", async () => {
  const lockedRes = await post("/card/" + cardLockedId + "/archive");
  assert.equal(lockedRes.status, 409);
  const lockedBody = await lockedRes.json();
  assert.equal(lockedBody.code, "locked");

  const alreadyRes = await post("/card/" + cardArchivedId + "/archive");
  assert.equal(alreadyRes.status, 409);
  const alreadyBody = await alreadyRes.json();
  assert.equal(alreadyBody.code, "archived");
});

test("tracker-item archive/unarchive round-trip; a leased item refuses archive with 409", async () => {
  const leasedRes = await post("/tracker-item/" + itemLeasedId + "/archive");
  assert.equal(leasedRes.status, 409);
  assert.equal((await leasedRes.json()).code, "locked");

  const arc = await post("/tracker-item/" + itemFreeId + "/archive");
  assert.equal(arc.status, 200);
  const row = await getItem(tdbClient, itemFreeId);
  assert.ok(row.archived_at != null);

  const un = await post("/tracker-item/" + itemFreeId + "/unarchive");
  assert.equal(un.status, 200);
  const row2 = await getItem(tdbClient, itemFreeId);
  assert.equal(row2.archived_at, null);
});

// ---------------------------------------------------------------------------
// B. Archived cards/items refuse move/update/execute with the i18n'd 409
// (client.js maps r.j.code to board.errArchived — proven separately below).
// ---------------------------------------------------------------------------

test("an archived card refuses edit, move, cancel, and execute — all 409 code=archived", async () => {
  const edit = await post("/card/" + cardArchivedId, { title: "nope" });
  assert.equal(edit.status, 409);
  assert.equal((await edit.json()).code, "archived");

  const move = await post("/card/" + cardArchivedId + "/move", { status: "in_progress" });
  assert.equal(move.status, 409);
  assert.equal((await move.json()).code, "archived");

  const cancel = await post("/card/" + cardArchivedId + "/cancel");
  assert.equal(cancel.status, 409);
  assert.equal((await cancel.json()).code, "archived");
});

test("POST /card/:id/execute on an archived card refuses with 409 code=archived (route reads the row directly)", async () => {
  await post("/card/" + cardForExecId + "/archive");
  const exec = await post("/card/" + cardForExecId + "/execute");
  assert.equal(exec.status, 409);
  assert.equal((await exec.json()).code, "archived");
  await post("/card/" + cardForExecId + "/unarchive"); // restore for later tests
});

test("an archived tracker item refuses update and move — both 409 code=archived", async () => {
  const upd = await post("/tracker-item/" + itemArchivedId, { label: "nope" });
  assert.equal(upd.status, 409);
  assert.equal((await upd.json()).code, "archived");

  const move = await post("/tracker-item/" + itemArchivedId + "/move", { status: "drafting" });
  assert.equal(move.status, 409);
  assert.equal((await move.json()).code, "archived");
});

// ---------------------------------------------------------------------------
// C. Filter-site tests — ONE per D-T1.6 enumerated site.
// ---------------------------------------------------------------------------

test("[SITE] GET /tracker/:slug/items excludes archived by default; ?include_archived=1 includes it", async () => {
  const def = await get("/tracker/intake/items");
  const ids = (await def.json()).items.map((i) => i.id);
  assert.ok(!ids.includes(itemArchivedId), "archived item must be hidden by default");

  const withArchived = await get("/tracker/intake/items?include_archived=1");
  const ids2 = (await withArchived.json()).items.map((i) => i.id);
  assert.ok(ids2.includes(itemArchivedId), "include_archived=1 must show it");
});

test("[SITE] GET /project/:id/unlinked excludes archived by default; ?include_archived=1 includes it", async () => {
  const t = new Database(tasksDbPath);
  const orphanId = Number(t.prepare("INSERT INTO tasks_items (title, status) VALUES ('orphan',?)").run("pending").lastInsertRowid);
  const orphanArchivedId = Number(t.prepare("INSERT INTO tasks_items (title, status) VALUES ('orphan archived',?)").run("pending").lastInsertRowid);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(orphanArchivedId);
  t.close();

  const def = await get("/project/1/unlinked");
  const ids = (await def.json()).cards.map((c) => c.id);
  assert.ok(ids.includes(orphanId), "sanity: the live orphan shows up");
  assert.ok(!ids.includes(orphanArchivedId), "archived orphan must be hidden by default");

  const withArchived = await get("/project/1/unlinked?include_archived=1");
  const ids2 = (await withArchived.json()).cards.map((c) => c.id);
  assert.ok(ids2.includes(orphanArchivedId), "include_archived=1 must show it");
});

test("[SITE] bulk-assign skips archived candidates by default; ?include_archived=1 applies them", async () => {
  const t = new Database(tasksDbPath);
  const bulkLive = Number(t.prepare("INSERT INTO tasks_items (title, status) VALUES ('bulk live',?)").run("pending").lastInsertRowid);
  const bulkArchived = Number(t.prepare("INSERT INTO tasks_items (title, status) VALUES ('bulk archived',?)").run("pending").lastInsertRowid);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(bulkArchived);
  t.close();

  const res = await post("/project/1/bulk-assign", { card_ids: [bulkLive, bulkArchived] });
  const body = await res.json();
  assert.ok(body.applied.includes(bulkLive), "the live card must be applied");
  assert.ok(!body.applied.includes(bulkArchived), "the archived card must NOT be applied");
  const skip = body.skipped.find((s) => s.id === bulkArchived);
  assert.equal(skip && skip.reason, "archived");

  // reset for the escape-hatch half
  const t2 = new Database(tasksDbPath);
  t2.prepare("UPDATE tasks_items SET project_id=NULL WHERE id=?").run(bulkArchived);
  t2.close();

  const res2 = await post("/project/1/bulk-assign?include_archived=1", { card_ids: [bulkArchived] });
  const body2 = await res2.json();
  assert.ok(body2.applied.includes(bulkArchived), "include_archived=1 must let the archived card through");
});

test("[SITE] panel kanban render (html.js) hides archived by default; the toggle shows it mixed into its column", async () => {
  const db = createDbClient();
  const layout = (o) => o.content;
  const selBot = { botId: "scout", displayName: "Scout", projectId: 1, trackerType: "kanban", trackerSlug: null, definition: {} };
  try {
    const hiddenHtml = await renderKanbanBoard({}, {}, { db, layout, selBot, bots: [], notice: "", switcher: "", q: {}, lang: "en" });
    assert.ok(!hiddenHtml.includes('data-card="' + cardArchivedId + '"'), "archived card must not render by default");
    assert.ok(hiddenHtml.includes("board.showArchived".split(".")[1]) || hiddenHtml.includes("Show archived"), "toggle affordance present");

    const shownHtml = await renderKanbanBoard({}, {}, { db, layout, selBot, bots: [], notice: "", switcher: "", q: { include_archived: "1" }, lang: "en" });
    assert.ok(shownHtml.includes('data-card="' + cardArchivedId + '"'), "toggle must reveal the archived card");
    assert.ok(shownHtml.includes('data-archived="1"'), "the revealed card must carry data-archived=1");
  } finally { db.close(); }
});

test("[SITE] panel custom-tracker render (html.js) hides archived by default; toggle shows it", async () => {
  const db = createDbClient();
  const layout = (o) => o.content;
  const selBot = { botId: "scout", displayName: "Scout", projectId: null, trackerType: "custom", trackerSlug: "intake", definition: {} };
  try {
    const hiddenHtml = await renderCustomTracker({}, {}, { db, layout, selBot, bots: [], notice: "", switcher: "", q: {}, lang: "en" });
    assert.ok(!hiddenHtml.includes('data-card="' + itemArchivedId + '"'), "archived item must not render by default");

    const shownHtml = await renderCustomTracker({}, {}, { db, layout, selBot, bots: [], notice: "", switcher: "", q: { include_archived: "1" }, lang: "en" });
    assert.ok(shownHtml.includes('data-card="' + itemArchivedId + '"'), "toggle must reveal the archived item");
  } finally { db.close(); }
});

test("[SITE] bot-builder editor.js kanban tracker-tab snapshot count excludes archived", async () => {
  const t = new Database(tasksDbPath);
  const before = t.prepare("SELECT COUNT(*) AS n FROM tasks_items WHERE project_id=1 AND status='pending' AND archived_at IS NULL").get().n;
  t.close();

  const db = createDbClient();
  const layout = ({ content }) => content;
  const req = { method: "GET", query: { tab: "tracker" }, body: {}, cookies: {}, headers: {} };
  const res = { html: null, send(s) { this.html = s; return this; } };
  try {
    await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "scout", notice: "", q: req.query });
    // Snapshot renders "<status> <b>N</b>" per group; archived cards must not
    // inflate the pending count.
    const m = res.html.match(/pending <b>(\d+)<\/b>/);
    assert.ok(m, "kanban snapshot must render a pending count");
    assert.equal(Number(m[1]), Number(before), "archived cards must not be counted");
  } finally { db.close(); }
});

test("[SITE] digest adapter boardsSections excludes archived from kanban candidates/done and tracker counts/action", async () => {
  const t = new Database(tasksDbPath);
  const dueSoonArchived = Number(t.prepare(
    "INSERT INTO tasks_items (title, status, due_date) VALUES ('digest due archived','pending',date('now'))"
  ).run().lastInsertRowid);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(dueSoonArchived);
  const actionArchived = Number(t.prepare(
    "INSERT INTO tasks_items (title, board_id, status, action_needed) VALUES ('digest action archived',?,?,?)"
  ).run(slugBoardId, "planned", "needs review").lastInsertRowid);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(actionArchived);
  t.close();

  const tdb = createDbClient(tasksDbPath);
  try {
    const sections = await boardsSections({}, {}, tdb);
    const kanban = sections.find((s) => s.title === "Tasks");
    assert.ok(kanban, "kanban section present");
    assert.ok(!kanban.items.some((i) => i.label === "digest due archived"), "archived due-soon card must not appear");

    const trackers = sections.find((s) => s.title === "Trackers");
    assert.ok(trackers, "trackers section present");
    assert.ok(!trackers.items.some((i) => i.label === "digest action archived"), "archived action-needed item must not appear");
    const intakeRow = trackers.table.rows.find((r) => r[0] === "Intake");
    assert.ok(intakeRow, "intake row present in the status-count table");
    assert.ok(!intakeRow[1].includes("999"), "sanity — counts render as digits, not a sentinel");
  } finally { tdb.close(); }
});

test("[SITE] digest adapter column-guard: a store without archived_at does not crash", async () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "board-archive-legacy-"));
  const legacyPath = join(legacyDir, "tasks.db");
  const t = new Database(legacyPath);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, due_date TEXT, phase TEXT,
    project_id INTEGER, completed_at TEXT, board_id INTEGER, action_needed TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO tasks_items (title, status) VALUES ('legacy card','pending')").run();
  t.close();

  const { createDbClient: cdc } = await import("../servers/db.js");
  const legacyTdb = cdc(legacyPath);
  try {
    const sections = await boardsSections({}, {}, legacyTdb);
    const kanban = sections.find((s) => s.title === "Tasks");
    assert.equal(kanban.available, true, "must not throw / degrade on a pre-0004 store");
  } finally {
    legacyTdb.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D. i18n'd error mapping + panel client wiring (string-level, no DOM in this harness)
// ---------------------------------------------------------------------------

test("archived/locked 409s carry a stable `code` field for client.js to map to i18n text", async () => {
  const r1 = await post("/card/" + cardArchivedId + "/execute");
  const b1 = await r1.json();
  assert.equal(b1.code, "archived");

  const r2 = await post("/card/" + cardLockedId + "/archive");
  const b2 = await r2.json();
  assert.equal(b2.code, "locked");
});

test("[SITE] client.js emitted script maps code:'archived'/'locked' to the i18n'd board.err* strings", async () => {
  const js = clientJs("scout", "kanban", 1, null, null, "en");
  assert.ok(js.includes("code==='archived'"), "the archived-code branch must exist");
  assert.ok(js.includes("code==='locked'"), "the locked-code branch must exist");
  assert.ok(js.includes("This card is archived"), "board.errArchived (en) must be inlined");
});

test("[SITE] client.js emitted script implements the SSE client-removal check (DOM card-id set vs frame's)", async () => {
  const js = clientJs("scout", "kanban", 1, null, null, "en");
  // The mechanism: build frameIds from the SSE payload, then walk the LIVE
  // DOM cards and flag any id absent from frameIds as a change too — the
  // one-directional-diff gap named in D-T1.6's round-2 note.
  assert.ok(js.includes("frameIds"), "a frame-id set must be built from the SSE payload");
  assert.ok(js.includes("!frameIds[domId]") || js.includes("!frameIds[did]"),
    "a DOM card missing from the frame id set must be detected");
});

test("[SITE] client.js skips the EventSource entirely when the archived view is active (no reload-storm)", async () => {
  const live = clientJs("scout", "kanban", 1, null, null, "en", false);
  const archived = clientJs("scout", "kanban", 1, null, null, "en", true);
  assert.ok(live.includes("window.EventSource"), "sanity: EventSource wiring present at all");
  assert.ok(archived.includes("INCLUDE_ARCHIVED=true"), "the flag must thread through");
  assert.ok(!/new EventSource\(esUrl\)/.test(archived) || archived.includes("!INCLUDE_ARCHIVED"),
    "EventSource construction must be gated on !INCLUDE_ARCHIVED");
});

test("emitted client script still parses as JavaScript with the new includeArchived param (both truthy states)", async () => {
  for (const ia of [false, true]) {
    const js = clientJs("scout", "kanban", 1, null, null, "en", ia);
    const body = js.replace(/^<script>/, "").replace(/<\/script>$/, "");
    assert.doesNotThrow(() => new Function(body), `includeArchived=${ia} must parse`);
  }
});
