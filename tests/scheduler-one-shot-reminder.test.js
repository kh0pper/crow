/**
 * One-shot Crow reminders: task "reminder:<text>", cron_expression "@once", absolute next_run.
 * The scheduler fires one exactly once, switches it off (never deletes), and never computes
 * a next run for it. Real init-db into a tmpdir (never ~/.crow).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { _tickForTest, _bootRecomputeForTest, computeNextRun, _setComputeNextRunForTest } from "../servers/gateway/scheduler.js";
import { registerSchedulerHook, unregisterSchedulerHook } from "../servers/gateway/scheduler-hooks.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-oneshot-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
});
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => { try { db.close(); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
async function seed(task, cron, nextRun) {
  const r = await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, description, next_run) VALUES (?, ?, ?, ?)",
    args: [task, cron, "Set by Crow's voice", nextRun],
  });
  return Number(r.lastInsertRowid);
}
const row = async (id) => (await db.execute({ sql: "SELECT * FROM schedules WHERE id = ?", args: [id] })).rows[0];
const notes = async (id) => (await db.execute({ sql: "SELECT * FROM notifications WHERE schedule_id = ?", args: [id] })).rows;

test("a due one-shot fires once and turns itself off; an ordinary reminder stays on", async () => {
  let hookRuns = 0;
  registerSchedulerHook("t-oneshot", { reminder: async () => { hookRuns++; } });
  try {
    const once = await seed("reminder:stretch", "@once", iso(-60_000));
    const daily = await seed("reminder:water", "0 9 * * *", iso(-60_000));
    await _tickForTest(db);
    const o = await row(once);
    assert.equal(Number(o.enabled), 0);
    assert.ok(o.next_run, "next_run kept for the record");
    assert.ok(o.last_run);
    assert.equal((await notes(once)).length, 1);
    const d = await row(daily);
    assert.equal(Number(d.enabled), 1);
    assert.ok(new Date(d.next_run) > new Date());
    assert.equal(hookRuns, 2); // one-shot + daily
    await _tickForTest(db);
    assert.equal((await notes(once)).length, 1, "no second notification");
  } finally { unregisterSchedulerHook("t-oneshot"); }
});

test("two racing ticks fire a one-shot exactly once", async () => {
  const id = await seed("reminder:race", "@once", iso(-1000));
  await Promise.all([_tickForTest(db), _tickForTest(db)]);
  assert.equal((await notes(id)).length, 1);
  assert.equal(Number((await row(id)).enabled), 0);
});

test("a reminder missed while the gateway was down fires once at the next tick and is not moved to next year", async () => {
  const next = iso(-3_600_000);
  const id = await seed("reminder:missed", "@once", next);
  await _bootRecomputeForTest(db);
  assert.equal((await row(id)).next_run, next);
  assert.equal(Number((await row(id)).enabled), 1);
  await _tickForTest(db);
  assert.equal((await notes(id)).length, 1);
  assert.equal((await row(id)).next_run, next);
});

// Spy on the cron computation: an @once row must never reach it (the old code did, and only
// survived because cron-parser throws on "@once" and computeNextRun swallows that).
function spyCompute() {
  const calls = [];
  const restore = _setComputeNextRunForTest((c, ...r) => { calls.push(c); return computeNextRun(c, ...r); });
  return { calls, restore };
}

test("TZ does not shift it, and the boot recompute never computes an @once row", async () => {
  const prev = process.env.TZ;
  const spy = spyCompute();
  try {
    process.env.TZ = "Asia/Tokyo";
    const next = iso(3_600_000);
    const id = await seed("reminder:tz", "@once", next);
    const ord = await seed("reminder:ord", "0 9 * * *", iso(3_600_000));
    await _bootRecomputeForTest(db);
    assert.equal((await row(id)).next_run, next);
    assert.ok(spy.calls.includes("0 9 * * *"), "positive control: ordinary rows are computed");
    assert.ok(!spy.calls.includes("@once"), "computeNextRun never called for @once");
    assert.ok(ord);
  } finally {
    spy.restore();
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

test("firing an @once row never computes a next run", async () => {
  const spy = spyCompute();
  try {
    const id = await seed("reminder:nocalc", "@once", iso(-1000));
    await _tickForTest(db);
    assert.equal((await notes(id)).length, 1);
    assert.ok(!spy.calls.includes("@once"));
  } finally { spy.restore(); }
});

test("the needsNextRun loop skips an enabled @once row with no next_run", async () => {
  const spy = spyCompute();
  try {
    const id = await seed("reminder:null", "@once", null);
    await _tickForTest(db);
    assert.ok(!spy.calls.includes("@once"));
    const r = await row(id);
    assert.equal(r.next_run, null);
    assert.equal(Number(r.enabled), 1);
  } finally { spy.restore(); }
});
