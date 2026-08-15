// tests/board-mcp.test.js
//
// Track 1 Task 6: the /board/mcp mount, the board token, and the full
// board_* verb set — the new wire surface. Wire tests over a REAL HTTP
// mount (harness precedent: no existing mountMcpServer test to copy — see
// tests/peer-invocation-gate.test.js and tests/connect-token.test.js for the
// only other tests touching the HTTP-MCP/token rails, neither of which spins
// up a real listening server). This file does: a real Express app wired the
// same way servers/gateway/index.js wires it (express.json() →
// localTokenAuthMiddleware(cdb) → mountMcpServer for /board and a stub
// /memory mount), a real MCP SDK Client over StreamableHTTPClientTransport,
// and a real migrated tasks.db/crow.db pair (migrations 0001-0004 via the
// runner — same fixture pattern as tests/board-card-service.test.js).
//
// Safety: CROW_HOME/CROW_DATA_DIR point at a scratch dir for the whole file
// (peer-credentials-crow-home.test.js's pattern) so generateBoardToken's real
// file write (<crowHome>/board-token) can never touch ~/.crow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import { SessionManager } from "../servers/gateway/session-manager.js";
import { mountMcpServer } from "../servers/gateway/routes/mcp.js";
import {
  localTokenAuthMiddleware, generateLocalToken, generateBoardToken,
  ensureBoardToken, BOARD_TOKEN_KEYS,
} from "../servers/gateway/local-token.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/registry.js";
import { createBoardMcpServer } from "../servers/gateway/board-mcp.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "scripts", "migrations");

// ---- env isolation (set BEFORE any board-token file write) ----
const savedEnv = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR };
let scratchHome;

// ---- fixture: real migrated tasks.db + crow.db (same shape as
// tests/board-card-service.test.js's fixture(), plus the settings tables the
// token rail needs) ----
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "board-mcp-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");

  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT, archived_at TEXT);
    CREATE TABLE bot_jobs (job_id TEXT PRIMARY KEY, bot_id TEXT, card_id INTEGER, card_action TEXT,
      status TEXT, worker_pid INTEGER, started_at TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, card_id INTEGER, status TEXT,
      pi_session_dir TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (key, instance_id));
    INSERT INTO project_spaces (id, name, slug, archived_at) VALUES (1, 'R4 TEHCY', 'r4-tehcy', NULL);`);
  c.close();

  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.close();

  return { root, dbPath, tasksDbPath };
}

let state = {};

function payload(result) {
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function connectClient(path, token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${state.port}${path}`),
    { requestInit: { headers } },
  );
  const client = new Client({ name: "board-mcp-test", version: "0" });
  await client.connect(transport);
  return client;
}

before(async () => {
  scratchHome = mkdtempSync(join(tmpdir(), "board-mcp-home-"));
  process.env.CROW_HOME = scratchHome;
  process.env.CROW_DATA_DIR = join(scratchHome, "data");

  const f = fixture();
  state.root = f.root;

  await runMigrations({ migrationsDir: MIGRATIONS_DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });

  const tdb = createDbClient(f.tasksDbPath);
  const cdb = createDbClient(f.dbPath);
  state.tdb = tdb;
  state.cdb = cdb;

  // Project cards board: pending/in_progress/done, 'done' terminal.
  await tdb.execute({
    sql: "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (1,'R4 TEHCY',?,?,'[]')",
    args: ['["pending","in_progress","done"]', '["done"]'],
  });
  // Slug tracker board: intake, 'shipped' terminal.
  await tdb.execute({
    sql: "INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('intake','Intake',?,?,'[]')",
    args: ['["pending","working","shipped"]', '["shipped"]'],
  });

  state.localToken = await generateLocalToken(cdb);
  state.boardToken = await generateBoardToken(cdb);

  const app = express();
  app.use(express.json());
  app.use(localTokenAuthMiddleware(cdb));
  const noAuth = (req, res) => res.status(401).json({
    jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: "unauthorized" },
  });
  const sessionManager = new SessionManager();
  mountMcpServer(app, "/board", () => createBoardMcpServer({ tdb, cdb }), sessionManager, noAuth);
  // Stub /memory mount: only the auth boundary is under test here, not the
  // real memory server (which pulls in embeddings/providers machinery this
  // file has no reason to load).
  mountMcpServer(app, "/memory", () => new McpServer({ name: "stub-memory", version: "0" }), sessionManager, noAuth);

  state.httpServer = app.listen(0);
  await new Promise((resolve, reject) => {
    state.httpServer.once("listening", resolve);
    state.httpServer.once("error", reject);
  });
  state.port = state.httpServer.address().port;
});

after(async () => {
  await new Promise((resolve) => state.httpServer.close(resolve));
  try { state.tdb.close(); } catch {}
  try { state.cdb.close(); } catch {}
  try { rmSync(state.root, { recursive: true, force: true }); } catch {}
  try { rmSync(scratchHome, { recursive: true, force: true }); } catch {}
  if (savedEnv.CROW_HOME === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = savedEnv.CROW_HOME;
  if (savedEnv.CROW_DATA_DIR === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = savedEnv.CROW_DATA_DIR;
});

// ---- board token minting ----

test("generateBoardToken persists the raw token to <crowHome>/board-token mode 0600", () => {
  const path = join(scratchHome, "board-token");
  assert.ok(existsSync(path), "board-token file exists");
  assert.equal(readFileSync(path, "utf8"), state.boardToken);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("the board token hash key is NOT syncable (per-instance, never replicated)", () => {
  assert.equal(isSyncable(BOARD_TOKEN_KEYS.HASH_KEY), false);
  assert.equal(isSyncable(BOARD_TOKEN_KEYS.CREATED_KEY), false);
});

test("ensureBoardToken is idempotent: no-op when hash + file both already exist", async () => {
  const before1 = readFileSync(join(scratchHome, "board-token"), "utf8");
  const { minted } = await ensureBoardToken(state.cdb);
  assert.equal(minted, false);
  assert.equal(readFileSync(join(scratchHome, "board-token"), "utf8"), before1, "token unchanged");
});

// ---- auth boundary ----

test("local token reaches /board/mcp", async () => {
  const client = await connectClient("/board/mcp", state.localToken);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tl) => tl.name === "board_list_boards"), "board tools are served");
  await client.close();
});

test("board token reaches /board/mcp but 401s on /memory/mcp", async () => {
  const client = await connectClient("/board/mcp", state.boardToken);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tl) => tl.name === "board_list_boards"));
  await client.close();

  await assert.rejects(
    () => connectClient("/memory/mcp", state.boardToken),
    "a board token must not authenticate a non-board MCP mount",
  );
});

test("no token 401s on /board/mcp", async () => {
  await assert.rejects(() => connectClient("/board/mcp", null));
});

// ---- verb round trip ----

test("verb round trip: create -> list excludes archived -> get -> move -> archive/unarchive (both id spaces) -> plan -> result -> decide -> briefing", async () => {
  const client = await connectClient("/board/mcp", state.localToken);

  // create card
  const created = payload(await client.callTool({ name: "board_create_item", arguments: { title: "Wire test card", project_id: 1 } }));
  assert.ok(Number.isInteger(created.id));
  const cardId = created.id;

  // list — includes the new card
  const listed1 = payload(await client.callTool({ name: "board_list_items", arguments: { project_id: 1 } }));
  assert.ok(listed1.items.some((r) => r.id === cardId));

  // get — plan head null, no results, a recorded 'create' mutation
  const got1 = payload(await client.callTool({ name: "board_get_item", arguments: { id: cardId } }));
  assert.equal(got1.kind, "card");
  assert.equal(got1.plan, null);
  assert.deepEqual(got1.results, []);
  assert.equal(got1.mutations[0].verb, "create");

  // move — def-validated
  const moved = payload(await client.callTool({ name: "board_move_item", arguments: { id: cardId, status: "in_progress" } }));
  assert.equal(moved.status, "in_progress");
  const badMove = await client.callTool({ name: "board_move_item", arguments: { id: cardId, status: "not-a-status" } });
  assert.equal(badMove.isError, true, "an off-def status is refused");

  // archive/unarchive — card id-space
  const archived = payload(await client.callTool({ name: "board_archive_item", arguments: { id: cardId } }));
  assert.equal(archived.archived, true);
  const listed2 = payload(await client.callTool({ name: "board_list_items", arguments: { project_id: 1 } }));
  assert.ok(!listed2.items.some((r) => r.id === cardId), "default view excludes archived");
  const listed2All = payload(await client.callTool({ name: "board_list_items", arguments: { project_id: 1, include_archived: true } }));
  assert.ok(listed2All.items.some((r) => r.id === cardId), "include_archived surfaces it");
  const unarchived = payload(await client.callTool({ name: "board_unarchive_item", arguments: { id: cardId } }));
  assert.equal(unarchived.archived, false);

  // archive/unarchive — tracker item id-space (board_id IS NOT NULL)
  const trackerItem = payload(await client.callTool({ name: "board_create_item", arguments: { title: "Tracker item", slug: "intake" } }));
  assert.ok(Number.isInteger(trackerItem.id));
  const tArchived = payload(await client.callTool({ name: "board_archive_item", arguments: { id: trackerItem.id } }));
  assert.equal(tArchived.archived, true);
  const tUnarchived = payload(await client.callTool({ name: "board_unarchive_item", arguments: { id: trackerItem.id } }));
  assert.equal(tUnarchived.archived, false);

  // plan: save_plan -> approve_plan
  const saved = payload(await client.callTool({ name: "board_save_plan", arguments: { item_id: cardId, body_md: "# plan v1" } }));
  assert.equal(saved.version, 1);
  const approved = payload(await client.callTool({ name: "board_approve_plan", arguments: { item_id: cardId, version: 1 } }));
  assert.equal(approved.status, "approved");
  const planHead = payload(await client.callTool({ name: "board_get_plan", arguments: { item_id: cardId } }));
  assert.equal(planHead.current.version, 1);
  assert.equal(planHead.current.status, "approved");

  // report_result -> decide_result (card still non-terminal: 'in_progress',
  // autonomy default 'gated' => no auto-move, result stays 'recorded')
  const reported = payload(await client.callTool({
    name: "board_report_result",
    arguments: { item_id: cardId, outcome: "success", summary_md: "did it", plan_id: saved.id },
  }));
  assert.equal(reported.status, "recorded");
  const decided = payload(await client.callTool({ name: "board_decide_result", arguments: { item_id: cardId, result_id: reported.id, decision: "approved" } }));
  assert.equal(decided.status, "approved");

  // get_item surfaces the result with its plan version + supersede flag
  const got2 = payload(await client.callTool({ name: "board_get_item", arguments: { id: cardId } }));
  assert.equal(got2.results.length, 1);
  assert.equal(got2.results[0].plan_version, 1);
  assert.equal(got2.results[0].plan_superseded, false);

  // briefing: store -> list -> get(by date) -> get(latest) -> snapshot
  const stored = payload(await client.callTool({ name: "board_store_briefing", arguments: { briefing_date: "2026-08-15", content: "# hi" } }));
  assert.equal(stored.briefing_date, "2026-08-15");
  const listB = payload(await client.callTool({ name: "board_list_briefings", arguments: {} }));
  assert.ok(listB.items.some((b) => b.briefing_date === "2026-08-15"));
  const getB = payload(await client.callTool({ name: "board_get_briefing", arguments: { briefing_date: "2026-08-15" } }));
  assert.equal(getB.content, "# hi");
  const getLatest = payload(await client.callTool({ name: "board_get_briefing", arguments: {} }));
  assert.equal(getLatest.briefing_date, "2026-08-15");
  const snap = payload(await client.callTool({ name: "board_briefing_snapshot", arguments: {} }));
  assert.ok(snap.by_status && typeof snap.by_status === "object");
  assert.equal(typeof snap.due_within_7_days, "number");
  assert.equal(typeof snap.awaiting_review, "number");

  // list_boards — sanity: both boards present with counts
  const boards = payload(await client.callTool({ name: "board_list_boards", arguments: {} }));
  assert.ok(boards.boards.some((b) => b.kind === "project" && b.project_id === 1));
  assert.ok(boards.boards.some((b) => b.kind === "tracker" && b.slug === "intake"));

  await client.close();
});

// ---- provenance (D-T1.3 actor resolution) ----

test("actor headers land in board_mutations (bot + job id) on a token-authed request", async () => {
  const client = await connectClient("/board/mcp", state.localToken, {
    "X-Crow-Actor-Kind": "bot",
    "X-Crow-Actor-Id": "bot-wire-test",
    "X-Crow-Job-Id": "job-wire-42",
  });
  const created = payload(await client.callTool({ name: "board_create_item", arguments: { title: "bot-created card", project_id: 1 } }));
  await client.close();

  const row = (await state.tdb.execute({
    sql: "SELECT actor_kind, actor_id, job_id FROM board_mutations WHERE item_id=? AND verb='create'",
    args: [created.id],
  })).rows[0];
  assert.equal(row.actor_kind, "bot");
  assert.equal(row.actor_id, "bot-wire-test");
  assert.equal(row.job_id, "job-wire-42");
});

test("a headerless token call records actor_kind 'session'", async () => {
  const client = await connectClient("/board/mcp", state.boardToken);
  const created = payload(await client.callTool({ name: "board_create_item", arguments: { title: "session-created card", project_id: 1 } }));
  await client.close();

  const row = (await state.tdb.execute({
    sql: "SELECT actor_kind, actor_id, job_id FROM board_mutations WHERE item_id=? AND verb='create'",
    args: [created.id],
  })).rows[0];
  assert.equal(row.actor_kind, "session");
  assert.equal(row.actor_id, null);
  assert.equal(row.job_id, null);
});

// ---- board_report_result 409 -> MCP isError (Task 7 session-done detection) ----

test("board_report_result 409s (terminal card) arrive as isError:true", async () => {
  const client = await connectClient("/board/mcp", state.localToken);
  const created = payload(await client.callTool({ name: "board_create_item", arguments: { title: "terminal card", project_id: 1 } }));
  await client.callTool({ name: "board_move_item", arguments: { id: created.id, status: "done" } });

  const result = await client.callTool({ name: "board_report_result", arguments: { item_id: created.id, outcome: "success" } });
  assert.equal(result.isError, true, "a refused report must be an MCP error result, never a bare success");
  assert.match(result.content[0].text, /^\[409 terminal\]/);
  await client.close();
});

test("board_report_result 409s (archived card) arrive as isError:true", async () => {
  const client = await connectClient("/board/mcp", state.localToken);
  const created = payload(await client.callTool({ name: "board_create_item", arguments: { title: "archived card", project_id: 1 } }));
  await client.callTool({ name: "board_archive_item", arguments: { id: created.id } });

  const result = await client.callTool({ name: "board_report_result", arguments: { item_id: created.id, outcome: "success" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^\[409 archived\]/);
  await client.close();
});
