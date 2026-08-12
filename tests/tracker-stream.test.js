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
let boardId;
let lockedItemId;
let freeItemId;

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
      data_json TEXT NOT NULL DEFAULT '{}',
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
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)").run(
    BOT_ID, "Scout",
    JSON.stringify({ tracker_config: { type: "custom", tracker_slug: SLUG } })
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
