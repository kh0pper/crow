/**
 * Bot cron — Plan B Part 1 Stage 4 (recurring bot jobs).
 *
 * Two surfaces over the repurposed `schedules` table (task "pipeline:botcron:<bot>",
 * job spec JSON in description):
 *  - bot_scheduler.tickBotSchedules(): a due bot-cron row ENQUEUES a bot_jobs row
 *    (never spawns pi), advances next_run, and leaves non-botcron rows untouched
 *    (the C1 guard — the gateway scheduler owns those).
 *  - gateway tools crow_schedule_bot / crow_list_bot_schedules / crow_delete_bot_schedule.
 */
import { test, before, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "botcron-test-"));
const dbPath = join(dir, "crow.db");
process.env.CROW_DB_PATH = dbPath;

let scheduler, createToolExecutor, getChatTools;
before(async () => {
  const init = new Database(dbPath);
  init.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL,
      description TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, next_run TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER, project_id INTEGER);
    CREATE TABLE bot_jobs (
      job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      deliver_to TEXT, source TEXT, schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, pi_session_id TEXT, tool_calls INTEGER,
      worker_pid INTEGER, claimed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, ended_at TEXT
    );`);
  init.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('botA','Bot A','{}',1)").run();
  init.close();
  scheduler = await import("../scripts/pi-bots/bot_scheduler.mjs");
  ({ createToolExecutor, getChatTools } = await import("../servers/gateway/ai/tool-executor.js"));
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function reset() {
  const c = new Database(dbPath);
  c.exec("DELETE FROM schedules; DELETE FROM bot_jobs;");
  c.close();
}

test("tickBotSchedules enqueues a job for a due bot-cron row + advances next_run", () => {
  reset();
  const c = new Database(dbPath);
  c.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:botA", "*/5 * * * *",
      JSON.stringify({ goal: "daily digest", deliver_to: { kind: "memory" } }), "2020-01-01T00:00:00.000Z");
  c.close();

  const r = scheduler.tickBotSchedules();
  assert.strictEqual(r.fired, 1);

  const c2 = new Database(dbPath);
  const job = c2.prepare("SELECT bot_id, goal, status, source, schedule_id, deliver_to FROM bot_jobs").get();
  const sch = c2.prepare("SELECT next_run, last_run FROM schedules").get();
  c2.close();
  assert.strictEqual(job.bot_id, "botA");
  assert.strictEqual(job.goal, "daily digest");
  assert.strictEqual(job.status, "queued");
  assert.strictEqual(job.source, "schedule");
  assert.deepStrictEqual(JSON.parse(job.deliver_to), { kind: "memory" });
  assert.ok(sch.next_run > "2020-01-01", "next_run advanced into the future");
  assert.ok(sch.last_run, "last_run stamped");
});

test("tickBotSchedules leaves non-botcron pipeline rows untouched (C1 guard)", () => {
  reset();
  const c = new Database(dbPath);
  c.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:research-digest", "*/5 * * * *", "{}", "2020-01-01T00:00:00.000Z");
  c.close();

  const r = scheduler.tickBotSchedules();
  assert.strictEqual(r.fired, 0);
  const c2 = new Database(dbPath);
  const jobs = c2.prepare("SELECT COUNT(*) n FROM bot_jobs").get().n;
  const sch = c2.prepare("SELECT next_run FROM schedules").get();
  c2.close();
  assert.strictEqual(jobs, 0);
  assert.strictEqual(sch.next_run, "2020-01-01T00:00:00.000Z"); // not advanced by us
});

test("tickBotSchedules does not fire a future schedule", () => {
  reset();
  const c = new Database(dbPath);
  c.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:botA", "*/5 * * * *", JSON.stringify({ goal: "x" }), "2099-01-01T00:00:00.000Z");
  c.close();
  assert.strictEqual(scheduler.tickBotSchedules().fired, 0);
});

test("crow_schedule_bot creates a botcron row; list + delete round-trip", async () => {
  reset();
  const ex = createToolExecutor({ botDef: { bot_id: "botA" } });
  const created = await ex.executeTool("crow_schedule_bot",
    { goal: "morning brief", cron: "0 8 * * *", bot: "botA", deliver_to: { kind: "memory" }, label: "AM brief" });
  assert.strictEqual(created.isError, false);
  const { scheduleId, next_run } = JSON.parse(created.result);
  assert.ok(scheduleId);
  assert.ok(next_run);

  // Stored under the protected prefix with the spec JSON.
  const c = new Database(dbPath);
  const row = c.prepare("SELECT task, cron_expression, description FROM schedules WHERE id=?").get(scheduleId);
  c.close();
  assert.strictEqual(row.task, "pipeline:botcron:botA");
  assert.strictEqual(JSON.parse(row.description).goal, "morning brief");

  const listed = JSON.parse((await ex.executeTool("crow_list_bot_schedules", { bot: "botA" })).result);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].goal, "morning brief");
  assert.strictEqual(listed[0].label, "AM brief");

  const del = await ex.executeTool("crow_delete_bot_schedule", { scheduleId });
  assert.strictEqual(JSON.parse(del.result).deleted, scheduleId);
  const after = JSON.parse((await ex.executeTool("crow_list_bot_schedules", {})).result);
  assert.strictEqual(after.length, 0);
  await ex.close();
});

test("crow_schedule_bot validation: bad cron, missing goal, unknown bot", async () => {
  const ex = createToolExecutor({ botDef: { bot_id: "botA" } });
  assert.match((await ex.executeTool("crow_schedule_bot", { goal: "x", cron: "not a cron", bot: "botA" })).result, /invalid cron/);
  assert.strictEqual((await ex.executeTool("crow_schedule_bot", { cron: "0 8 * * *", bot: "botA" })).isError, true);
  assert.match((await ex.executeTool("crow_schedule_bot", { goal: "x", cron: "0 8 * * *", bot: "ghost" })).result, /unknown bot/);
  await ex.close();
});

test("crow_delete_bot_schedule refuses a non-botcron schedule id (guard)", async () => {
  reset();
  const c = new Database(dbPath);
  const info = c.prepare("INSERT INTO schedules (task, cron_expression, enabled, next_run) VALUES ('pipeline:research','* * * * *',1,'2020-01-01T00:00:00.000Z')").run();
  c.close();
  const ex = createToolExecutor();
  const r = await ex.executeTool("crow_delete_bot_schedule", { scheduleId: info.lastInsertRowid });
  assert.strictEqual(r.isError, true);
  assert.match(r.result, /no bot schedule/);
  await ex.close();
});

test("schedule tools are advertised unbound only; delegate is advertised in both", () => {
  const unbound = new Set(getChatTools().map((t) => t.name));
  const bound = new Set(getChatTools({ botDef: { bot_id: "botA", tools: { crow_mcp: ["memory/crow_store_memory"] } } }).map((t) => t.name));
  assert.ok(unbound.has("crow_schedule_bot") && unbound.has("crow_list_bot_schedules") && unbound.has("crow_delete_bot_schedule"));
  assert.ok(!bound.has("crow_schedule_bot"), "schedule tools kept out of the scoped voice surface");
  assert.ok(bound.has("crow_delegate") && unbound.has("crow_delegate"));
});
