// tests/tracker-stream.test.js
//
// Track 0 Phase B: the SSE bot-board stream's custom-tracker tick used to read
// crow.db's dropped tracker_defs/tracker_items tables. Migration 0003 moved
// slug boards into tasks.db (board_defs + tasks_items.board_id); this test
// proves the tick was converted to read the unified store, and that slug
// boards now get the SAME `board-config` frame the kanban board got in
// Phase A (the drift-catch that stops a stale-column client from silently
// mis-rendering).
//
// Harness mirrors tests/board-job-lock.test.js exactly: scratch tasks.db +
// crow.db via env, ephemeral express server, plain fetch, SSE frames parsed
// by EVENT NAME (never a bare `data:` regex — the stream also carries the
// named `event: board-config` frame, and a line-level match reads its
// payload as the snapshot).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "tracker-stream-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

const BOT_ID = "scout";
const SLUG = "toolkit-assets";
const KANBAN_BOT_ID = "planner";
const KANBAN_PROJECT_ID = 42;
let boardId;
let lockedItemId;
let freeItemId;
let archivedCustomItemId;
let kanbanFreeCardId;
let kanbanArchivedCardId;

// Seed BEFORE importing anything that reads the env at module load.
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
      project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
      terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
      due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
      assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT,
      next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
      data_json TEXT NOT NULL DEFAULT '{}', archived_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.prepare(
    "INSERT INTO board_defs (slug, display_name, status_values, terminal_values) VALUES (?,?,?,?)"
  ).run(SLUG, "Toolkit Assets", JSON.stringify(["planned", "drafting", "drafted"]), JSON.stringify(["drafted"]));
  boardId = t.prepare("SELECT id FROM board_defs WHERE slug=?").get(SLUG).id;
  const ins = t.prepare(
    "INSERT INTO tasks_items (title, board_id, bot_id, status, priority, processing_lease_status) VALUES (?,?,?,?,?,?)"
  );
  lockedItemId = ins.run("Flyer ES", boardId, BOT_ID, "drafting", 3, "in-progress").lastInsertRowid;
  freeItemId = ins.run("Poster EN", boardId, BOT_ID, "drafted", 2, null).lastInsertRowid;
  // Track 1 (D-T1.6): an archived custom-tracker item — the SSE tick's
  // board_id=? row set (streams.js) must exclude it.
  archivedCustomItemId = ins.run("Retired banner", boardId, BOT_ID, "planned", 1, null).lastInsertRowid;
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(archivedCustomItemId);

  // A SEPARATE project-linked (kanban) bot + cards — exercises the OTHER row
  // set in the same tick handler (streams.js's project_id=? branch), which
  // the custom-tracker fixture above never reaches.
  const insCard = t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES (?,?,?)");
  kanbanFreeCardId = insCard.run("Free card", KANBAN_PROJECT_ID, "pending").lastInsertRowid;
  kanbanArchivedCardId = insCard.run("Archived card", KANBAN_PROJECT_ID, "pending").lastInsertRowid;
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(kanbanArchivedCardId);
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)").run(
    BOT_ID, "Scout",
    JSON.stringify({ tracker_config: { type: "custom", tracker_slug: SLUG } })
  );
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)").run(
    KANBAN_BOT_ID, "Planner", JSON.stringify({ tracker_config: { type: "kanban" } }), KANBAN_PROJECT_ID
  );
  c.close();
}

let server;
before(async () => {
  const { default: express } = await import("express");
  const { default: streamsRouter } = await import("../servers/gateway/routes/streams.js");
  const app = express();
  app.use((req, res, next) => { req.dashboardSession = "test-session"; next(); });
  app.use(streamsRouter((req, res, next) => next())); // auth stub
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
});
after(() => server && server.close());

// Consume the stream and split into named-event frames vs the bare snapshot,
// exactly like board-job-lock.test.js's SSE test — never a bare `data:` regex.
async function readStream(url) {
  const ctrl = new AbortController();
  let snapshot = null;
  let boardConfig = null;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop(); // keep the trailing partial frame
      for (const frame of frames) {
        const ev = (frame.match(/^event: (.+)$/m) || [])[1] || null;
        const data = (frame.match(/^data: (\{.*\})$/m) || [])[1];
        if (!data) continue;
        if (ev === "board-config") boardConfig = JSON.parse(data);
        else if (ev == null) snapshot = JSON.parse(data);
      }
      if (snapshot && boardConfig) break;
    }
    await reader.cancel();
  } finally {
    ctrl.abort();
  }
  return { snapshot, boardConfig };
}

test("the SSE custom-tracker tick reads the unified store and slug boards get board-config", async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/dashboard/streams/bot-board?bot=" + BOT_ID;
  const { snapshot, boardConfig } = await readStream(url);

  assert.ok(boardConfig && Array.isArray(boardConfig.statuses), "no board-config frame arrived");
  assert.deepEqual(boardConfig.statuses, ["planned", "drafting", "drafted"],
    "the config frame must carry the slug def's status list, not the default four");

  assert.ok(snapshot && Array.isArray(snapshot.cards), "no SSE snapshot arrived");
  const ids = snapshot.cards.map((c) => Number(c.id)).sort((a, b) => a - b);
  assert.deepEqual(ids, [Number(lockedItemId), Number(freeItemId)].sort((a, b) => a - b),
    "the snapshot must carry both tasks_items rows for this board, queried by board_id");

  const byId = new Map(snapshot.cards.map((c) => [Number(c.id), c.status]));
  assert.equal(byId.get(Number(lockedItemId)), "drafting");
  assert.equal(byId.get(Number(freeItemId)), "drafted");

  assert.equal(snapshot.locks[Number(lockedItemId)], true, "the leased item must be locked");
  assert.ok(!Object.hasOwn(snapshot.locks, String(freeItemId)) && !Object.hasOwn(snapshot.locks, Number(freeItemId)),
    "the unleased item must not appear in the lock map");
});

// F5: a custom-typed bot whose tracker_slug doesn't resolve (missing/deleted
// board_defs row) must get NO board-config frame — not the PROJECT's, even
// though tdb is now always open and this bot's project_id happens to be set.
// Before the fix, the `else if` branch only checked `Number.isInteger
// (resolvedProjectId)` and fired regardless of trackerType, leaking the
// project's status list onto a custom board that expects its own.
test("custom tracker with a missing slug def gets no board-config frame (never the project's)", async () => {
  const c = new Database(process.env.CROW_DB_PATH);
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)").run(
    "ghost", "Ghost",
    JSON.stringify({ tracker_config: { type: "custom", tracker_slug: "does-not-exist" } }),
    1
  );
  c.close();

  const url = "http://127.0.0.1:" + server.address().port + "/dashboard/streams/bot-board?bot=ghost";
  const ctrl = new AbortController();
  // Actively abort after the window — the ghost bot legitimately never sends
  // ANY frame (custom + no resolvable board = the tick's early `return`), so
  // waiting on reader.read() alone would block on the 30s heartbeat instead
  // of the intended short window.
  const timer = setTimeout(() => ctrl.abort(), 1500);
  let sawBoardConfig = false;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    // Sanity: the stream must have actually connected (SSE headers, 200) —
    // otherwise "no board-config frame" would trivially and uselessly hold.
    assert.equal(res.status, 200, "the SSE connection itself must succeed");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("event: board-config")) { sawBoardConfig = true; break; }
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e; // abort = the window elapsed with nothing seen — expected
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  assert.equal(sawBoardConfig, false,
    "a custom tracker with a missing slug def must not leak the project's board-config frame");
});

// ---------------------------------------------------------------------------
// Track 1 Task 5 (D-T1.6): the SSE tick's row sets must exclude archived
// cards/items — these are TWO separate query sites in streams.js (the
// custom-tracker board_id=? branch and the kanban/task-list project_id=?
// branch), each gets its own dedicated test so a mutation dropping just one
// site's filter fails exactly one of these.
// ---------------------------------------------------------------------------

test("[SITE streams.js custom-tracker tick] an archived item is excluded from the row set", async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/dashboard/streams/bot-board?bot=" + BOT_ID;
  const { snapshot } = await readStream(url);
  assert.ok(snapshot && Array.isArray(snapshot.cards), "no SSE snapshot arrived");
  const ids = snapshot.cards.map((c) => Number(c.id));
  assert.ok(ids.includes(Number(freeItemId)), "sanity: the live item is still present");
  assert.ok(!ids.includes(Number(archivedCustomItemId)),
    "an archived custom-tracker item must not appear in the SSE row set");
});

test("[SITE streams.js kanban/project tick] an archived card is excluded from the row set", async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/dashboard/streams/bot-board?bot=" + KANBAN_BOT_ID;
  const { snapshot } = await readStream(url);
  assert.ok(snapshot && Array.isArray(snapshot.cards), "no SSE snapshot arrived");
  const ids = snapshot.cards.map((c) => Number(c.id));
  assert.ok(ids.includes(Number(kanbanFreeCardId)), "sanity: the live card is still present");
  assert.ok(!ids.includes(Number(kanbanArchivedCardId)),
    "an archived project-board card must not appear in the SSE row set");
});

// ---------------------------------------------------------------------------
// Track 3 Task 11 (spec §5.6): bird state is engine-sourced and rides a
// SEPARATE named `bird-state` SSE event — it must never fold into the
// default {cards, locks} frame (whose client response is a full reload on
// any diff). Two servers against the SAME fixture DB, one with a fake
// interactive engine and one with none, prove: (a) the default frame is
// byte-for-byte identical either way, (b) a gateway with no engine emits no
// bird-state event at all, and (c) an engine-backed one does, shaped
// {<cardId>: {state, sid}}.
// ---------------------------------------------------------------------------

// Frame reader that keeps the default frame's RAW `data:` text (for a strict
// byte comparison) alongside the parsed named `bird-state` event, if any.
async function readFramesRaw(url, { expectBirdState } = {}) {
  const ctrl = new AbortController();
  let snapshotRaw = null;
  let birdState = null;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const frame of frames) {
        const ev = (frame.match(/^event: (.+)$/m) || [])[1] || null;
        const dataMatch = frame.match(/^data: (.*)$/m);
        if (!dataMatch) continue;
        if (ev === "bird-state") birdState = JSON.parse(dataMatch[1]);
        else if (ev == null) snapshotRaw = dataMatch[1];
      }
      if (snapshotRaw && (birdState || !expectBirdState)) break;
    }
    await reader.cancel();
  } finally {
    ctrl.abort();
  }
  return { snapshotRaw, birdState };
}

test("bird-state rides its own named SSE event; a gateway with no engine emits none at all", async () => {
  const { default: express } = await import("express");
  const { default: streamsRouter } = await import("../servers/gateway/routes/streams.js");

  const fakeEngine = {
    async list() {
      return [{
        sessionId: "bird-1", botId: KANBAN_BOT_ID, state: "awake", pendingUi: null,
        cardId: Number(kanbanFreeCardId), turnInFlight: true,
      }];
    },
  };

  const appNoEngine = express();
  appNoEngine.use((req, res, next) => { req.dashboardSession = "test-session"; next(); });
  appNoEngine.use(streamsRouter((req, res, next) => next(), { interactiveEngine: () => null }));
  const srvNoEngine = await new Promise((r) => { const s = appNoEngine.listen(0, () => r(s)); });

  const appEngine = express();
  appEngine.use((req, res, next) => { req.dashboardSession = "test-session"; next(); });
  appEngine.use(streamsRouter((req, res, next) => next(), { interactiveEngine: () => fakeEngine }));
  const srvEngine = await new Promise((r) => { const s = appEngine.listen(0, () => r(s)); });

  const urlNoEngine = "http://127.0.0.1:" + srvNoEngine.address().port + "/dashboard/streams/bot-board?bot=" + KANBAN_BOT_ID;
  const urlEngine = "http://127.0.0.1:" + srvEngine.address().port + "/dashboard/streams/bot-board?bot=" + KANBAN_BOT_ID;

  try {
    const noEngine = await readFramesRaw(urlNoEngine, { expectBirdState: false });
    const withEngine = await readFramesRaw(urlEngine, { expectBirdState: true });

    assert.ok(noEngine.snapshotRaw, "the no-engine server's default frame arrived");
    assert.ok(withEngine.snapshotRaw, "the engine-backed server's default frame arrived");
    assert.equal(withEngine.snapshotRaw, noEngine.snapshotRaw,
      "the default frame is byte-for-byte identical whether or not bird state exists");

    assert.equal(noEngine.birdState, null, "a gateway with no engine must emit no bird-state event at all");

    assert.ok(withEngine.birdState, "the engine-backed server sent a bird-state named event");
    assert.deepEqual(withEngine.birdState, { [String(kanbanFreeCardId)]: { state: "working", sid: "bird-1" } });
  } finally {
    // closeAllConnections: an aborted-but-not-yet-reaped keep-alive socket
    // otherwise leaves plain close() waiting on the OS/undici pool to reap it
    // (observed ~4s on the first of the two servers torn down here) — force it.
    srvNoEngine.closeAllConnections();
    srvEngine.closeAllConnections();
    await new Promise((r) => srvNoEngine.close(r));
    await new Promise((r) => srvEngine.close(r));
  }
});
