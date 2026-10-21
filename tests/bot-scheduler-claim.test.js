import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let dir, dbPath, prev;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "botcron-claim-"));
  dbPath = join(dir, "crow.db");
  prev = process.env.CROW_DB_PATH;
  process.env.CROW_DB_PATH = dbPath;
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, cron_expression TEXT, description TEXT,
    enabled INTEGER DEFAULT 1, last_run TEXT, next_run TEXT, updated_at TEXT)`);
  d.close();
});
afterEach(() => {
  if (prev === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  const [sched, jr] = await Promise.all([import("../scripts/pi-bots/bot_scheduler.mjs"), import("../scripts/pi-bots/job_runner.mjs")]);
  return { ...sched, ensure: jr.ensureBotJobsSchema };
}
function seed(cron = "*/5 * * * *", goal = "do it") {
  const d = new Database(dbPath);
  const past = new Date(Date.now() - 60000).toISOString();
  d.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:bot-1", cron, JSON.stringify({ goal }), past);
  const row = d.prepare("SELECT id, task, cron_expression, description, next_run FROM schedules").get();
  d.close();
  return row;
}
const jobCount = () => { const d = new Database(dbPath); try { return d.prepare("SELECT COUNT(*) c FROM bot_jobs").get().c; } finally { d.close(); } };

test("two connections claiming the same stale row enqueue exactly one job", async () => {
  const { claimAndEnqueue, ensure } = await load();
  const row = seed();
  const a = new Database(dbPath), b = new Database(dbPath);
  ensure(a);
  const now = new Date().toISOString();
  const r1 = claimAndEnqueue(a, row, now);
  const r2 = claimAndEnqueue(b, row, now);
  a.close(); b.close();
  assert.equal(r1, true);
  assert.equal(r2, false);
  assert.equal(jobCount(), 1);
});

test("a row whose next_run changed after the select is not claimed", async () => {
  const { claimAndEnqueue, ensure } = await load();
  const row = seed();
  const d = new Database(dbPath);
  ensure(d);
  d.prepare("UPDATE schedules SET next_run=? WHERE id=?").run(new Date(Date.now() + 3600000).toISOString(), row.id);
  assert.equal(claimAndEnqueue(d, row, new Date().toISOString()), false);
  d.close();
  assert.equal(jobCount(), 0);
});

test("a bad cron expression runs once, then next_run is NULL and it never ticks again", async () => {
  const { claimAndEnqueue, tickBotSchedules, ensure } = await load();
  const row = seed("not a cron");
  const d = new Database(dbPath);
  ensure(d);
  assert.equal(claimAndEnqueue(d, row, new Date().toISOString()), true);
  assert.equal(d.prepare("SELECT next_run FROM schedules WHERE id=?").get(row.id).next_run, null);
  d.close();
  assert.equal(jobCount(), 1);
  assert.deepEqual(tickBotSchedules(), { fired: 0 });
  assert.equal(jobCount(), 1);
});

test("tickBotSchedules still fires a due schedule once", async () => {
  const { tickBotSchedules, ensure } = await load();
  seed();
  const e = new Database(dbPath); ensure(e); e.close(); // module self-heal flag is per-process, DB is per-test
  assert.deepEqual(tickBotSchedules(), { fired: 1 });
  assert.deepEqual(tickBotSchedules(), { fired: 0 });
  assert.equal(jobCount(), 1);
});

test("a schedule whose previous run is still queued is advanced but not enqueued again (coalesced)", async () => {
  const { tickBotSchedules, ensure } = await load();
  seed();
  const e = new Database(dbPath); ensure(e); e.close();
  assert.equal(tickBotSchedules().fired, 1);
  const due = () => { const d = new Database(dbPath); d.prepare("UPDATE schedules SET next_run=?").run(new Date(Date.now() - 60000).toISOString()); d.close(); };
  due();
  const lines = [];
  assert.equal(tickBotSchedules({ log: (m) => lines.push(m) }).fired, 0);
  assert.equal(jobCount(), 1);
  assert.ok(lines.some((l) => l.includes("previous run still queued")));
  const d = new Database(dbPath);
  assert.ok(d.prepare("SELECT next_run FROM schedules").get().next_run > new Date().toISOString(), "still advanced");
  d.prepare("UPDATE bot_jobs SET status='running'").run(); // the previous run started
  d.close();
  due();
  assert.equal(tickBotSchedules().fired, 1);
  assert.equal(jobCount(), 2);
});
