/**
 * give-service.js — the Give-a-task core the voice hand-off calls: a task with a
 * description onto a bot's board, the started thread id, and filing that thread
 * under the card's project. Scratch DBs and a fake engine; no pi child spawns.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "give-service-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const TASKS = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let svc, createDbClient, setStatus, db, tdb, PID;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const raw = new Database(DB_FILE);
  PID = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES ('voice-p','Voice P')").run().lastInsertRowid);
  const seed = (id, def) => raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)")
    .run(id, id, JSON.stringify(def), PID);
  seed("writer", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } });
  seed("plain", { gateways: [{ type: "glasses" }], tracker_config: { type: "kanban" } });
  raw.close();
  const t = new Database(TASKS);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();
  ({ createDbClient } = await import("../servers/db.js"));
  ({ _setEngineStatusForTest: setStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  svc = await import("../servers/gateway/board/give-service.js");
  db = createDbClient();
  tdb = createDbClient(TASKS);
});
after(() => { setStatus(null); try { db.close(); tdb.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const fakeEngine = () => ({
  checkCardFree: async () => {},
  spawn: async () => ({ sessionId: "s1", threadId: "t-77", state: "starting" }),
  message: async () => {},
});

test("createTaskForBot carries a description and the builtin autonomy", async () => {
  const { cardId, row } = await svc.createTaskForBot(db, tdb, "writer", {
    title: "Draft the memo", description: "Two paragraphs, plain tone.", tags: "crow-voice", audit: { via: "voice" },
  });
  assert.equal(Number(row.project_id), PID);
  const card = (await tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id=?", args: [cardId] })).rows[0];
  assert.equal(card.description, "Two paragraphs, plain tone.");
  assert.equal(card.autonomy, "gated");
  assert.equal(card.assigned_bot, "writer");
  assert.equal(Number(card.project_id), PID);
  assert.equal(card.tags, "crow-voice");
  const audits = (await db.execute({ sql: "SELECT payload FROM project_audit_log WHERE action='card_given' AND target=?", args: [`card:${cardId}`] })).rows;
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].payload).via, "voice");
});

test("startAfterGive returns the thread id of the started session", async () => {
  setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const { cardId, row } = await svc.createTaskForBot(db, tdb, "writer", { title: "Start me" });
  const ctx = { tdb };
  const out = await svc.startAfterGive(ctx, { row, getEng: fakeEngine, botId: "writer", cardId, start: true, note: "go" });
  assert.equal(out.started, true);
  assert.equal(out.sessionId, "s1");
  assert.equal(out.threadId, "t-77");
});

test("fileStartedThread files the thread under the card's project", async () => {
  const { projectOfItems } = await import("../servers/shared/shell-items.js");
  await svc.fileStartedThread(db, { threadId: "t-file-1", projectId: PID });
  const m = await projectOfItems(db, "perch_thread", ["t-file-1"]);
  assert.equal(Number(m.get ? m.get("t-file-1") : m["t-file-1"]), PID);
});

test("a perch-less bot is assigned, not started", async () => {
  setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const raw = new Database(DB_FILE);
  const row = raw.prepare("SELECT * FROM pi_bot_defs WHERE bot_id='plain'").get();
  raw.close();
  const { id } = await (await import("../servers/gateway/board/card-service.js")).createCard(tdb, { title: "No perch", project_id: PID, assigned_bot: "plain" }, svc.DASHBOARD_ACTOR);
  const out = await svc.startAfterGive({ tdb }, { row, getEng: fakeEngine, botId: "plain", cardId: id, start: true });
  assert.equal(out.assigned, true);
  assert.equal(out.started, false);
  assert.equal(out.code, "perch_not_attached");
});
