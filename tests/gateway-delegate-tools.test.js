/**
 * crow_delegate / crow_job_status — Plan B Part 1 Stage 3 (gateway tools).
 *
 * The crow_orchestrate replacement. These are PURE DB ops in the gateway: enqueue
 * a queued bot_jobs row / read one back. The pi-bots host runs + delivers it out
 * of band (covered by the bot-jobs store + delivery tests). Here we prove the
 * gateway surface: the two schemas are advertised (bound + unbound), the bound bot
 * is the default delegate target, validation rejects bad input, and a delegated
 * job round-trips through crow_job_status.
 */
import { test, before, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "delegate-test-"));
const dbPath = join(dir, "crow.db");
process.env.CROW_DB_PATH = dbPath;

let createToolExecutor, getChatTools;
before(async () => {
  const init = new Database(dbPath);
  init.exec(`
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER, project_id INTEGER);
    CREATE TABLE bot_jobs (
      job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
      schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT, error TEXT, pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER,
      claimed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, ended_at TEXT
    );`);
  init.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)")
    .run("botA", "Bot A", "{}");
  init.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,0)")
    .run("botOff", "Disabled", "{}");
  init.close();
  ({ createToolExecutor, getChatTools } = await import("../servers/gateway/ai/tool-executor.js"));
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const names = (tools) => new Set(tools.map((t) => t.name));

test("getChatTools advertises crow_delegate + crow_job_status (unbound)", () => {
  const n = names(getChatTools());
  assert.ok(n.has("crow_delegate"), "crow_delegate advertised unbound");
  assert.ok(n.has("crow_job_status"), "crow_job_status advertised unbound");
});

test("getChatTools advertises them for a bound bot too", () => {
  const n = names(getChatTools({ botDef: { bot_id: "botA", tools: { crow_mcp: ["memory/crow_store_memory"] } } }));
  assert.ok(n.has("crow_delegate"));
  assert.ok(n.has("crow_job_status"));
});

test("crow_delegate enqueues a queued job for the bound bot", async () => {
  const ex = createToolExecutor({ botDef: { bot_id: "botA" } });
  const { result, isError } = await ex.executeTool("crow_delegate", { goal: "research X and report" });
  assert.strictEqual(isError, false);
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.status, "queued");
  assert.strictEqual(parsed.bot, "botA");
  assert.ok(parsed.jobId);

  const c = new Database(dbPath);
  const row = c.prepare("SELECT bot_id, goal, status, source FROM bot_jobs WHERE job_id=?").get(parsed.jobId);
  c.close();
  assert.deepStrictEqual(row, { bot_id: "botA", goal: "research X and report", status: "queued", source: "chat" });
  await ex.close();
});

test("crow_delegate honors explicit deliver_to (memory)", async () => {
  const ex = createToolExecutor({ botDef: { bot_id: "botA" } });
  const { result } = await ex.executeTool("crow_delegate",
    { goal: "draft a write-up", deliver_to: { kind: "memory", memory_category: "notes" } });
  const { jobId, deliver } = JSON.parse(result);
  assert.strictEqual(deliver, "memory");
  const c = new Database(dbPath);
  const row = c.prepare("SELECT deliver_to FROM bot_jobs WHERE job_id=?").get(jobId);
  c.close();
  assert.deepStrictEqual(JSON.parse(row.deliver_to), { kind: "memory", memory_category: "notes" });
  await ex.close();
});

test("crow_delegate falls back to the executor's defaultDeliverTo", async () => {
  const ex = createToolExecutor({
    botDef: { bot_id: "botA" },
    defaultDeliverTo: { kind: "gateway", gateway_type: "discord", gateway_thread_id: "discord:42" },
  });
  const { result } = await ex.executeTool("crow_delegate", { goal: "later task" });
  const { jobId, deliver } = JSON.parse(result);
  assert.strictEqual(deliver, "gateway");
  const c = new Database(dbPath);
  const row = c.prepare("SELECT deliver_to FROM bot_jobs WHERE job_id=?").get(jobId);
  c.close();
  assert.strictEqual(JSON.parse(row.deliver_to).gateway_thread_id, "discord:42");
  await ex.close();
});

test("crow_delegate validation: empty goal, unknown bot, disabled bot, no bound bot", async () => {
  const bound = createToolExecutor({ botDef: { bot_id: "botA" } });
  assert.strictEqual((await bound.executeTool("crow_delegate", { goal: "  " })).isError, true);
  assert.match((await bound.executeTool("crow_delegate", { goal: "x", bot: "ghost" })).result, /unknown bot/);
  assert.match((await bound.executeTool("crow_delegate", { goal: "x", bot: "botOff" })).result, /disabled/);
  await bound.close();

  const unbound = createToolExecutor();
  assert.match((await unbound.executeTool("crow_delegate", { goal: "x" })).result, /no bot is bound/);
  await unbound.close();
});

test("crow_job_status round-trips a delegated job; rejects missing/unknown id", async () => {
  const ex = createToolExecutor({ botDef: { bot_id: "botA" } });
  const { result } = await ex.executeTool("crow_delegate", { goal: "status check" });
  const { jobId } = JSON.parse(result);

  const st = await ex.executeTool("crow_job_status", { jobId });
  assert.strictEqual(st.isError, false);
  const row = JSON.parse(st.result);
  assert.strictEqual(row.job_id, jobId);
  assert.strictEqual(row.status, "queued");

  assert.strictEqual((await ex.executeTool("crow_job_status", {})).isError, true);
  assert.match((await ex.executeTool("crow_job_status", { jobId: "nope" })).result, /no job/);
  await ex.close();
});
