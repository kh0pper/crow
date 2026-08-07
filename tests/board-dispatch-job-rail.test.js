/**
 * The board dispatches onto the job rail.
 *
 * Before this, execute/plan-dispatch spawned a detached `bridge.mjs --inject`
 * into the CONVERSATIONAL rail (bot_sessions) — so the board's work never
 * appeared in bot_jobs, never got scan-gated pickup, retry, or telemetry, and
 * could not be recovered if the worker died.
 *
 * These run the real router against throwaway DBs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-jobrail-"));
const crowDb = join(dir, "crow.db");
const tasksDb = join(dir, "tasks.db");

process.env.CROW_DB_PATH = crowDb;
process.env.CROW_TASKS_DB_PATH = tasksDb;

function seed() {
  const c = new Database(crowDb);
  c.exec(BOT_JOBS_DDL);
  c.exec(`CREATE TABLE IF NOT EXISTS pi_bot_defs (
    bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER,
    created_at TEXT, updated_at TEXT);`);
  c.exec(`CREATE TABLE IF NOT EXISTS bot_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, pi_session_id TEXT,
    pi_session_dir TEXT, gateway_type TEXT, gateway_thread_id TEXT, project_id INTEGER,
    card_id INTEGER, plan_path TEXT, status TEXT NOT NULL DEFAULT 'active',
    control TEXT NOT NULL DEFAULT 'run', model TEXT, escalated INTEGER DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'chat', narrowed_tools TEXT,
    created_at TEXT, updated_at TEXT);`);
  c.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,enabled) VALUES ('r4-assistant','R4',1)").run();
  c.close();

  const t = new Database(tasksDb);
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY, title TEXT, status TEXT, stage TEXT,
    assigned_bot TEXT, plan_ref TEXT, project_id INTEGER, updated_at TEXT);`);
  t.prepare("INSERT INTO tasks_items (id,title,status,stage,assigned_bot) VALUES (?,?,?,?,?)")
    .run(120, "card", "pending", "ready", "r4-assistant");
  t.close();
}

let server, port;
before(async () => {
  seed();
  const { default: boardRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(boardRouter((req, res, next) => next()));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
});
after(() => {
  try { server.closeAllConnections?.(); server.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const post = (path) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
const jobs = () => new Database(crowDb).prepare("SELECT * FROM bot_jobs").all();

test("execute enqueues one card-sourced job", async () => {
  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.jobId, "the caller must learn the job id it created");

  const rows = jobs();
  assert.equal(rows.length, 1, "exactly one job per dispatch");
  assert.equal(rows[0].card_id, 120, "the job must name its card");
  assert.equal(rows[0].source, "card");
  assert.equal(rows[0].status, "queued", "the worker claims it — the API must not run it inline");
  assert.equal(rows[0].bot_id, "r4-assistant");
  assert.deepEqual(JSON.parse(rows[0].deliver_to), { kind: "card", card_id: 120 });
});

test("a second execute while the job is queued is refused, not duplicated", async () => {
  // The first execute (above) also flipped the card's stage to 'executing',
  // which the "must be Ready" guard would 409 on for an UNRELATED reason —
  // that would let this test pass even if the job-rail lock itself were
  // broken. Reset the card to 'ready' first, so a 409 here can only come
  // from lockState seeing the queued job.
  const t = new Database(tasksDb);
  t.prepare("UPDATE tasks_items SET stage='ready', status='pending' WHERE id=120").run();
  t.close();

  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 409, "a queued job must lock the card");
  assert.deepEqual(await res.json(), { reason: "bot is working this card" });
  assert.equal(jobs().length, 1, "the card must not accumulate duplicate work");
});
