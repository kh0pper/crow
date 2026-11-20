// The reports scheduler hook: due windows (with the R10 catch-up), the run request queue, the row
// guard and broken seal, the boot stale sweep, the primary-gateway lease, and the things it must never
// do (wait for a run, deliver a report row as a reminder, run a stray row).
//
// Harness: a real init-db'd scratch crow.db copied per test, real report/revision/run tables, a live
// report made by the approvals module's own `approveGoLive` (with an injected preview-run reader), the
// gateway run id from run-id.js, and the hook's clock, lease, notify and block-runner seams injected.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-hook-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const {
  SETTINGS_CHANGED_TEXT, deliverNotWired, kickReportsHook, registerReportsHook,
  startReportsAtBoot, _setReportsHookForTest,
} = await import("../servers/gateway/reports/schedule-hook.js");
const { approveGoLive, pauseReport } = await import("../servers/gateway/reports/approvals.js");
const { NOT_LIVE_TEXT, RESTARTED_TEXT, startRun } = await import("../servers/gateway/reports/run.js");
const {
  createReport, getReport, saveRecipe, updateReportColumns,
} = await import("../servers/gateway/reports/store.js");
const { gatewayRunId } = await import("../servers/gateway/run-id.js");
const { LEASE_KEY } = await import("../servers/gateway/reports/lease.js");
const {
  registerSchedulerHook, runSchedulerHooks, unregisterSchedulerHook, getSchedulerHook,
} = await import("../servers/gateway/scheduler-hooks.js");
const {
  _resetForTest, _setNowForTest, _tickForTest,
} = await import("../servers/gateway/scheduler.js");

const OWNER = Object.freeze({ kind: "owner" });
const SEED = Buffer.alloc(32, 7);
const PROJECT = 7;
const SENDER = "ma-0011223344556677";
const BOOT = "boot-aaaa";
const RUN_ID = "run-mine";
const CRON = "0 7 * * 1"; // Mondays at 07:00 UTC
const NOW = Date.parse("2026-10-26T15:00:00.000Z"); // a Monday

const REGISTRY = Object.freeze({
  mail_list: { sourceBearing: true },
  columns: { sourceBearing: false },
});

const RECIPE = {
  blocks: [
    { id: "b1", type: "mail_list", settings: { account: SENDER, sinceDays: 7 } },
    { id: "b2", type: "columns", settings: { columns: ["subject"] } },
  ],
};

const open = [];
let clock = NOW;
let notes = [];

after(async () => {
  await settle(200);
  for (const db of open) { try { db.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
});

beforeEach(() => {
  clock = NOW;
  notes = [];
  unregisterSchedulerHook("reports");
  unregisterSchedulerHook("mail-send");
  _setReportsHookForTest(null);
  _resetForTest();
  _setNowForTest(() => clock);
});

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

let n = 0;

async function freshDb() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  const db = createDbClient(crow);
  open.push(db);
  return db;
}

const rows = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;

/* ------------------------------------------------------------------- the harness */

/** The approvals module's deps: the seal seed, the clock, the sender reader, the block registry. */
function approvalsDeps(report, over = {}) {
  return {
    loadSeed: () => ({ seed: SEED }),
    now: () => NOW,
    getRun: async (_db, runId) => (report && runId === "prv-1"
      ? { id: runId, reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev }
      : null),
    senderReady: async () => true,
    registry: REGISTRY,
    ...over,
  };
}

/** The hook's deps, with everything a test wants to change. */
function hookDeps(report, over = {}) {
  return {
    approvals: approvalsDeps(report),
    now: () => clock,
    concurrency: 1,
    notify: async (_db, note) => { notes.push(note); },
    instanceZone: async () => "UTC",
    graceMs: () => 5 * 60 * 1000,
    getSecrets: () => [],
    lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID },
    deliver: async () => {},
    runBlocks: async () => ({ items: [{ subject: "a" }] }),
    ...over,
  };
}

/** One report at rev 1 with its own `report:<id>` schedule row, set up the way go-live needs it. */
async function seedReport(db, { nextRun = null, ai = 0, title = "Weekly listings" } = {}) {
  const { id } = await createReport(db, { projectId: PROJECT, owner: "owner", botId: "bot-1", title });
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz, next_run) VALUES (?, ?, 'UTC', ?)",
    args: [`report:${id}`, CRON, nextRun],
  });
  const { rows: made } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  const scheduleId = Number(made[0].id);
  const saved = await saveRecipe(db, { reportId: id, recipe: RECIPE, authorKind: "owner", registry: REGISTRY });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: SENDER,
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: ai,
  });
  return { id, scheduleId, rev: saved.rev };
}

/** A live report: the state most tests here start from. */
async function liveReport(db, { nextRun = null, ai = 0, resolver = null, title } = {}) {
  const report = await seedReport(db, { nextRun, ai, title });
  const deps = approvalsDeps(report, resolver ? { resolveModelRef: resolver } : {});
  await approveGoLive(db, deps, { reportId: report.id, previewRunId: "prv-1", actor: OWNER });
  return { ...report, approvals: deps };
}

async function scheduleRow(db, report) {
  return (await rows(db, "SELECT * FROM schedules WHERE id = ?", [report.scheduleId]))[0] ?? null;
}

/* ------------------------------------------------------------- due windows */

test("two missed windows give one late run, and next_run moves past now", async () => {
  const db = await freshDb();
  // Two Mondays were missed: 12 Oct and 19 Oct (this clock is Mon 26 Oct, 15:00 UTC).
  const report = await liveReport(db, { nextRun: "2026-10-12T07:00:00.000Z" });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);

  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1, "exactly one catch-up run, never one per missed window");
  assert.equal(runs[0].trigger, "schedule");
  assert.equal(runs[0].requested_by, "schedule");
  assert.equal(Number(runs[0].late), 1);
  assert.equal(Number(runs[0].scheduled_for), Date.parse("2026-10-26T07:00:00.000Z"),
    "the latest missed window");

  const row = await scheduleRow(db, report);
  assert.equal(row.next_run, "2026-11-02T07:00:00.000Z");
  assert.ok(Date.parse(row.next_run) > clock);
  assert.equal(row.last_run, new Date(clock).toISOString());

  const history = await rows(db, "SELECT * FROM schedule_runs WHERE schedule_id = ?", [report.scheduleId]);
  assert.equal(history.length, 1);
  assert.equal(history[0].source, "clock");
  assert.equal(history[0].status, "late");
  assert.equal(history[0].scheduled_for, "2026-10-26T07:00:00.000Z");
  const detail = JSON.parse(history[0].detail);
  assert.equal(typeof detail.late_ms, "number");
  assert.equal(detail.late_ms, clock - Date.parse("2026-10-26T07:00:00.000Z"));

  await settle();
});

test("a window inside the grace is not late", async () => {
  const db = await freshDb();
  clock = Date.parse("2026-10-26T07:01:00.000Z"); // one minute after the Monday 07:00 window
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);

  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1);
  assert.equal(Number(runs[0].late), 0, "inside the grace, so on time");
  assert.equal(Number(runs[0].scheduled_for), Date.parse("2026-10-26T07:00:00.000Z"));
  const history = await rows(db, "SELECT * FROM schedule_runs");
  assert.equal(history[0].status, "ok");
  assert.equal(JSON.parse(history[0].detail).late_ms, 60_000);
  await settle();
});

test("a paused report advances next_run and makes no run", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  await pauseReport(db, report.approvals, { reportId: report.id, actor: OWNER });

  const hook = registerReportsHook(db, hookDeps(report));
  await hook.tick(db);

  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 0, "nothing ran");
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 0, "and no run was recorded");
  const row = await scheduleRow(db, report);
  assert.equal(row.next_run, "2026-11-02T07:00:00.000Z", "the window moved past now");
});

test("a claimed row is not run twice by two ticks", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  await hook.tick(db);

  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 1);
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 1);
  await settle();
});

test("a run row the database refuses leaves the window to retry", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  const hook = registerReportsHook(db, hookDeps(report));
  let refuse = true;
  const refusingDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (refuse && /INSERT INTO report_runs/.test(sql)) throw new Error("report_runs is busy");
      return db.execute(arg);
    },
  };

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    await hook.tick(refusingDb);
  } finally {
    console.warn = original;
  }

  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 0);
  assert.equal((await scheduleRow(db, report)).next_run, "2026-10-26T07:00:00.000Z",
    "the window was not advanced: there is nothing to advance it for");
  assert.match(warnings.join("\n"), /schedule #\d+/, "the refusal is logged, not silent");

  refuse = false;
  await hook.tick(db);
  await settle(50);
  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 1, "the next tick runs the window");
  assert.equal((await scheduleRow(db, report)).next_run, "2026-11-02T07:00:00.000Z");
});

test("a claim that throws after the run row is written: the next tick runs that same run", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let blocks = 0;
  const hook = registerReportsHook(db, hookDeps(report, {
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }));
  let threw = false;
  const failingDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (!threw && /UPDATE schedules SET next_run = \?, last_run = \?/.test(sql)) {
        threw = true;
        throw new Error("schedules is busy");
      }
      return db.execute(arg);
    },
  };

  await hook.tick(failingDb);
  await settle(50);

  const queued = await rows(db, "SELECT * FROM report_runs");
  assert.equal(queued.length, 1, "the run row was written before the claim threw");
  assert.equal(queued[0].status, "queued", "left queued for the next tick, not failed");
  assert.equal((await scheduleRow(db, report)).next_run, "2026-10-26T07:00:00.000Z",
    "the window is untouched");
  assert.equal(blocks, 0, "nothing ran");

  await hook.tick(db);
  await settle(50);

  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1, "one run in total: the row the first tick wrote");
  assert.equal(runs[0].id, queued[0].id);
  assert.equal(runs[0].status, "ok", "the next tick found the queued row and ran it");
  assert.equal(typeof runs[0].ended_at, "number", "epoch ms, like every other time on the row");
  assert.equal(blocks, 1);
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 1);
  assert.equal((await scheduleRow(db, report)).next_run, "2026-11-02T07:00:00.000Z");
  assert.deepEqual(notes, [], "no notice for a run that happened");
});

test("two passes on one window: one run, and no failed row", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let blocks = 0;
  const hook = registerReportsHook(db, hookDeps(report, {
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }));
  // The row as a second pass read it before the first pass claimed the window. That pass then finds
  // the window used by a run (its startRun answers `duplicate`) and the claim changing no row.
  const staleRow = (await rows(db,
    "SELECT id, task, cron_expression, next_run, tz FROM schedules WHERE id = ?", [report.scheduleId]))[0];
  assert.ok(staleRow, "the schedule row is there");
  const staleDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (/FROM schedules\s+WHERE task GLOB/.test(sql)) return { rows: [staleRow] };
      return db.execute(arg);
    },
  };

  await hook.tick(db); // writes the window's run row, wins the claim, queues it
  await settle(50);
  await hook.tick(staleDb); // the same window again: duplicate, and the claim is lost
  await settle(50);

  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1, "one run row for the window (the unique index)");
  assert.equal(runs[0].status, "ok", "the run the winning pass made");
  assert.equal(typeof runs[0].ended_at, "number", "epoch ms, like every other time on the row");
  assert.equal(blocks, 1, "it executed once");
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 1);
  assert.deepEqual(notes, [], "and nothing is said about a run that was in hand");
});

test("a duplicate window whose run is still queued is queued by the pass that wins it", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let blocks = 0;
  const hook = registerReportsHook(db, hookDeps(report, {
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }));
  // An earlier pass wrote the window's run row and never queued it: it lost the window's claim.
  const earlier = await startRun(db, hookDeps(report), {
    reportId: report.id,
    trigger: "schedule",
    requestedBy: "schedule",
    scheduledFor: Date.parse("2026-10-26T07:00:00.000Z"),
  });
  assert.ok(earlier.runId, "the window's run row exists, still queued");

  await hook.tick(db);
  await settle(50);

  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, earlier.runId, "the row the window already had, not a second one");
  assert.equal(runs[0].status, "ok", "and it ran");
  assert.equal(blocks, 1);
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 1,
    "the window is recorded once");
  assert.equal((await scheduleRow(db, report)).next_run, "2026-11-02T07:00:00.000Z");
});

test("a run whose window another pass claimed stays queued and is not queued here", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let blocks = 0;
  const hook = registerReportsHook(db, hookDeps(report, {
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }));
  let stolen = false;
  const stealingDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const args = Array.isArray(arg?.args) ? arg.args : [];
      if (!stolen && /UPDATE schedules SET next_run = \?, last_run = \?/.test(sql)) {
        stolen = true;
        await db.execute({ sql, args }); // "another pass" wins the claim between our insert and ours
      }
      return db.execute(arg);
    },
  };

  await hook.tick(stealingDb);
  await settle(50);

  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1, "the row was written before the claim");
  assert.equal(runs[0].status, "queued",
    "left for the pass that owns the window, never closed as failed");
  assert.equal(runs[0].ended_at, null, "a run that has not happened has no end time");
  assert.equal(blocks, 0, "and it is not queued here");
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 0,
    "no run history row for a window this pass does not own");
  assert.deepEqual(notes, [], "and no notice either");
});

test("a run refused for not live sends no delivery and notifies the owner once", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let delivered = 0;
  const hook = registerReportsHook(db, hookDeps(report, {
    deliver: async () => { delivered += 1; },
  }));
  // The guard passes, and the report stops being live exactly as the run claims its row: the executor's
  // own live check is what refuses it.
  const racingDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const out = await db.execute(arg);
      if (/UPDATE report_runs SET status = 'running'/.test(sql)) {
        await db.execute({ sql: "UPDATE reports SET status = 'paused' WHERE id = ?", args: [report.id] });
      }
      return out;
    },
  };

  await hook.tick(racingDb);
  await settle(50);

  const run = (await rows(db, "SELECT * FROM report_runs"))[0];
  assert.equal(run.status, "failed");
  assert.equal(run.error_text, NOT_LIVE_TEXT);
  assert.equal(delivered, 0, "a run that never happened calls no delivery seam");
  assert.equal(notes.length, 1, "the owner hears about it once");
  assert.equal(notes[0].title, "Weekly listings did not run");
  assert.equal(notes[0].body, NOT_LIVE_TEXT);
  assert.equal(notes[0].type, "system");
  assert.equal(notes[0].source, "reports");
  assert.deepEqual(notes[0].metadata, { essential: true, reportId: report.id });
});

test("runNow refuses a report that is not live, and runs a live one", async () => {
  const db = await freshDb();
  const draft = await seedReport(db);
  const draftHook = registerReportsHook(db, hookDeps(draft));
  const draftRow = await scheduleRow(db, draft);
  assert.deepEqual(await draftHook.runNow(db, draftRow), { ok: false, error: "not live" });
  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 0, "a draft starts nothing");

  const live = await liveReport(db);
  const hook = registerReportsHook(db, hookDeps(live));
  const liveRow = await scheduleRow(db, live);
  assert.deepEqual(await hook.runNow(db, liveRow), { ok: true });
  assert.equal((await rows(db, "SELECT * FROM report_runs WHERE report_id = ?", [live.id])).length, 1);

  // Live in the column, but the seal no longer verifies: still not runnable.
  await db.execute({ sql: "UPDATE reports SET delivery_mode = 'both' WHERE id = ?", args: [live.id] });
  assert.deepEqual(await hook.runNow(db, liveRow), { ok: false, error: "not live" });
  assert.equal((await rows(db, "SELECT * FROM report_runs WHERE report_id = ?", [live.id])).length, 1);
});

test("stopping the hook releases the lease and unregisters it", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  assert.equal((await rows(db, "SELECT value FROM dashboard_settings WHERE key = ?", [LEASE_KEY])).length, 1);
  assert.equal(typeof getSchedulerHook("reports")?.tick, "function");

  await hook.stop();
  assert.equal((await rows(db, "SELECT value FROM dashboard_settings WHERE key = ?", [LEASE_KEY])).length, 0,
    "a clean stop lets the lease go");
  assert.equal(getSchedulerHook("reports"), undefined, "and the tick hook is unregistered");
});

test("a tick and a kick never interleave their lease refreshes", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  let inside = 0;
  let overlap = 0;
  // Every lease statement is held for a moment, so a second pass that started at the same time would be
  // seen inside the first one. Nothing changes on the database itself: this only widens the window.
  const slowDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const args = Array.isArray(arg?.args) ? arg.args : [];
      const leaseStatement = /dashboard_settings/.test(sql) && args[0] === LEASE_KEY;
      if (!leaseStatement) return db.execute(arg);
      inside += 1;
      overlap = Math.max(overlap, inside);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await db.execute(arg);
      } finally {
        inside -= 1;
      }
    },
  };
  const hook = registerReportsHook(slowDb, hookDeps(report));

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    const ticked = hook.tick(slowDb);
    hook.kick();
    await ticked;
    await settle(150);
  } finally {
    console.warn = original;
  }

  assert.equal(overlap, 1, "one lease statement at a time, whoever started it");
  assert.deepEqual(warnings.filter((line) => /another gateway holds/.test(line)), [],
    "a pass of our own is never logged as another gateway");
});

test("two overlapping guard passes pause a broken report once, with one notice", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({ sql: "UPDATE reports SET sender_account_id = ? WHERE id = ?",
    args: ["ma-8899aabbccddeeff", report.id] });
  // Two hooks over the same database, each with its own pass chain: their guard passes really do
  // overlap, which is what the single guarded UPDATE has to survive.
  const first = registerReportsHook(db, hookDeps(report));
  const second = registerReportsHook(db, hookDeps(report));

  await Promise.all([first.tick(db), second.tick(db)]);

  assert.equal(notes.length, 1, "exactly one pass changed the row, so exactly one notice");
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pause_reason, SETTINGS_CHANGED_TEXT);
  const refusals = await rows(db,
    "SELECT * FROM report_approvals_audit WHERE report_id = ? AND decided = 'refused'", [report.id]);
  assert.equal(refusals.length, 1, "the pause is recorded once");
  assert.equal(refusals[0].actor, "system");
});

test("settlePass never delivers a report: row as a reminder", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });

  await _tickForTest(db); // the gateway scheduler's own tick: settlePass + the hooks + next_run pass

  const delivered = await rows(db, "SELECT * FROM notifications WHERE source LIKE 'scheduler%'");
  assert.deepEqual(delivered, [], "no reminder was delivered");
  assert.equal((await rows(db, "SELECT * FROM schedule_runs")).length, 0, "no reminder run was recorded");
  const row = await scheduleRow(db, report);
  assert.equal(row.next_run, "2026-10-26T07:00:00.000Z", "the reports hook's row was left alone");
  assert.equal(Number(row.enabled), 1);
});

test("a tick returns before a slow run finishes", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let abort = null;
  const slowBlocks = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ items: [{ subject: "a" }] }), 5000);
    timer.unref?.();
    abort = () => { clearTimeout(timer); reject(new Error("aborted by the test")); };
  });
  const hook = registerReportsHook(db, hookDeps(report, { runBlocks: slowBlocks }));

  const startedAt = Date.now();
  await hook.tick(db);
  const took = Date.now() - startedAt;

  assert.ok(took < 100, `the tick took ${took} ms`);
  const runs = await rows(db, "SELECT * FROM report_runs");
  assert.equal(runs.length, 1, "the run was queued");
  for (let i = 0; i < 40 && !abort; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(abort, "the slow run started");
  abort();
  await settle();
});

test("the mail-send hook still fires while a report run is in progress", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  let abort = null;
  const slowBlocks = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ items: [{ subject: "a" }] }), 5000);
    timer.unref?.();
    abort = () => { clearTimeout(timer); reject(new Error("aborted by the test")); };
  });
  const hook = registerReportsHook(db, hookDeps(report, { runBlocks: slowBlocks }));
  let fired = 0;
  registerSchedulerHook("mail-send", { tick: async () => { fired += 1; } });

  await hook.tick(db); // the report run is now in flight
  await runSchedulerHooks("tick", db);

  assert.equal(fired, 1, "the other hook ran while the report run was still working");
  for (let i = 0; i < 40 && !abort; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(abort);
  abort();
  await settle();
  assert.equal(typeof getSchedulerHook("reports")?.runNow, "function");
});

test("a stray report: row never runs, and it is said once", async () => {
  const db = await freshDb();
  const report = await liveReport(db); // a live report with its own row (not due)
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz, next_run) VALUES (?, ?, 'UTC', ?)",
    args: ["report:rpt-ffffffffffffffff", CRON, "2026-10-26T07:00:00.000Z"],
  });
  const hook = registerReportsHook(db, hookDeps(report));
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    await hook.tick(db);
    await hook.tick(db);
  } finally {
    console.warn = original;
  }

  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 0, "no run for a row that names no report");
  const strays = await rows(db, "SELECT * FROM schedules WHERE task LIKE 'report:%' AND task != ?",
    [`report:${report.id}`]);
  assert.equal(strays.length, 1);
  assert.equal(strays[0].next_run, "2026-10-26T07:00:00.000Z", "the stray row is left as it is");
  assert.equal(warnings.filter((line) => /names no report/.test(line)).length, 1, "said exactly once");
});

/* ------------------------------------------------------- the row guard and the seal */

test("a deleted schedule row pauses the live report and notifies once", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({ sql: "DELETE FROM schedules WHERE id = ?", args: [report.scheduleId] });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  const first = await getReport(db, report.id);
  assert.equal(first.status, "paused");
  assert.match(first.pause_reason, /lost its schedule and is paused/);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "system");
  assert.equal(notes[0].source, "reports");
  assert.equal(notes[0].priority, "high");
  assert.equal(notes[0].action_url, "/dashboard/reports");
  assert.equal(notes[0].body, first.pause_reason);
  assert.deepEqual(notes[0].metadata, { essential: true, reportId: report.id });

  await hook.tick(db);
  assert.equal(notes.length, 1, "a second tick sends nothing");
  assert.equal((await getReport(db, report.id)).pause_reason, first.pause_reason);
});

test("a report row disabled by direct SQL pauses the report with one notice", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({ sql: "UPDATE schedules SET enabled = 0 WHERE id = ?", args: [report.scheduleId] });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.pause_reason, /was paused outside the report page/);
  assert.equal(notes.length, 1);
  await hook.tick(db);
  assert.equal(notes.length, 1);
});

test("a live report whose task changed on its row is paused", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({ sql: "UPDATE schedules SET task = 'reminder:something else' WHERE id = ?", args: [report.scheduleId] });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.pause_reason, /lost its schedule and is paused/);
  assert.equal(notes.length, 1);
});

test("a live report with a broken seal pauses with the settings sentence, once", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  await db.execute({ sql: "UPDATE reports SET sender_account_id = ? WHERE id = ?",
    args: ["ma-8899aabbccddeeff", report.id] });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pause_reason, SETTINGS_CHANGED_TEXT);
  assert.match(SETTINGS_CHANGED_TEXT, /Settings changed outside Crow\. Check and go live again\./);
  assert.equal(notes.length, 1);
  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 0, "it never ran");
  const row = await scheduleRow(db, report);
  assert.ok(Date.parse(row.next_run) > clock, "the window it had was only advanced");

  await hook.tick(db);
  assert.equal(notes.length, 1, "no second notice");
});

test("a model-only change pauses with the model sentence", async () => {
  const db = await freshDb();
  let current = { providerId: "local", model: "qwen3.5-4b", locality: "local", baseUrlHost: "localhost:8011" };
  const resolver = async () => current;
  const report = await liveReport(db, { ai: 1, resolver });
  const stored = await getReport(db, report.id);
  assert.ok(stored.model_ref, "going live sealed the resolved model");
  assert.equal(JSON.parse(stored.model_ref).model, "qwen3.5-4b");

  current = { providerId: "openrouter", model: "qwen3.6-35b", locality: "cloud", baseUrlHost: "openrouter.example" };
  const hook = registerReportsHook(db, hookDeps(report, { approvals: approvalsDeps(report, { resolveModelRef: resolver }) }));

  await hook.tick(db);
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pause_reason,
    "The bot's model changed (qwen3.5-4b -> qwen3.6-35b). Check and go live again.");
  assert.equal(notes.length, 1);
  await hook.tick(db);
  assert.equal(notes.length, 1);
});

test("a status flipped back to live after a pause is paused again and never runs", async () => {
  const db = await freshDb();
  const report = await liveReport(db, { nextRun: "2026-10-26T07:00:00.000Z" });
  await pauseReport(db, report.approvals, { reportId: report.id, actor: OWNER });
  await db.execute({ sql: "UPDATE reports SET status = 'live' WHERE id = ?", args: [report.id] });
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(db);
  const after = await getReport(db, report.id);
  assert.equal(after.status, "paused", "a status column is not an approval, so the report stops again");
  assert.equal(after.pause_reason, SETTINGS_CHANGED_TEXT);
  assert.equal(notes.length, 1);
  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 0, "nothing ran");
});

test("buildApprovalsDeps carries the real sender reader, run reader and model resolver", async () => {
  const { buildApprovalsDeps } = await import("../servers/gateway/reports/approvals-deps.js");
  const { defaultResolveModelRef } = await import("../servers/gateway/reports/approvals.js");
  const { senderReady } = await import("../servers/gateway/reports/sender-ready.js");
  const { getRunForApproval } = await import("../servers/gateway/reports/run.js");

  const deps = buildApprovalsDeps();
  assert.equal(deps.senderReady, senderReady);
  assert.equal(deps.getRun, getRunForApproval);
  assert.equal(deps.resolveModelRef, defaultResolveModelRef);

  // An override wins; a member that is absent or not a function falls back to the real reader (a
  // caller saying nothing is not a caller switching the seam off).
  const mine = async () => true;
  assert.equal(buildApprovalsDeps({ senderReady: mine }).senderReady, mine);
  assert.equal(buildApprovalsDeps({ senderReady: undefined }).senderReady, senderReady);
  assert.equal(buildApprovalsDeps({ registry: REGISTRY }).registry, REGISTRY, "other members pass through");
});

test("the model-only pause sentence names the new model through the factory's resolver", async () => {
  const { buildApprovalsDeps } = await import("../servers/gateway/reports/approvals-deps.js");
  const db = await freshDb();
  let current = { providerId: "local", model: "qwen3.5-4b", locality: "local", baseUrlHost: "localhost:8011" };
  const resolver = async () => current;
  const report = await liveReport(db, { ai: 1, resolver });

  current = { providerId: "openrouter", model: "qwen3.6-35b", locality: "cloud", baseUrlHost: "openrouter.example" };
  // The hook is built the way post-listen builds it: the factory, with this test's resolver stubbed in
  // through the override, so the sentence names a real model instead of "unavailable".
  const hook = registerReportsHook(db, hookDeps(report, {
    approvals: buildApprovalsDeps({
      loadSeed: () => ({ seed: SEED }),
      now: () => NOW,
      registry: REGISTRY,
      resolveModelRef: resolver,
      getRun: async (_db, runId) => (runId === "prv-1"
        ? { id: runId, reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev }
        : null),
    }),
  }));

  await hook.tick(db);
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pause_reason,
    "The bot's model changed (qwen3.5-4b -> qwen3.6-35b). Check and go live again.");
  assert.equal(notes.length, 1);
});

/* ---------------------------------------------------------------- the boot sweep */

async function insertRun(db, report, { id, status, gateway = "another-process", endedAt = null }) {
  await db.execute({
    sql: `INSERT INTO report_runs (id, report_id, "trigger", requested_by, status, gateway_run_id, started_at, ended_at, created_at)
          VALUES (?, ?, 'schedule', 'schedule', ?, ?, ?, ?, ?)`,
    args: [id, report.id, status, gateway, NOW - 60_000, endedAt, NOW - 60_000],
  });
}

test("a stale running run becomes failed with one notice; this process's runs are left alone", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await insertRun(db, report, { id: "rrn-0000000000000001", status: "running" });
  await insertRun(db, report, { id: "rrn-0000000000000002", status: "queued" });
  await insertRun(db, report, { id: "rrn-0000000000000003", status: "running", gateway: gatewayRunId() });
  const hook = registerReportsHook(db, hookDeps(report));

  const first = await hook.sweep(db);
  assert.deepEqual(first, { marked: 2 });

  const swept = await rows(db, "SELECT id, status, error_text, ended_at FROM report_runs ORDER BY id");
  assert.equal(swept[0].status, "failed");
  assert.equal(swept[0].error_text, RESTARTED_TEXT);
  assert.equal(Number(swept[0].ended_at), clock);
  assert.equal(swept[1].status, "failed", "a queued row is swept too");
  assert.equal(swept[2].status, "running", "a run this process owns is still in hand");
  assert.equal(notes.length, 2, "one notice per swept run");
  assert.match(notes[0].title, /^Weekly listings: Crow restarted during this run$/);
  assert.equal(notes[0].metadata.reportId, report.id);

  const second = await hook.sweep(db);
  assert.deepEqual(second, { marked: 0 }, "idempotent");
  assert.equal(notes.length, 2, "and a second sweep notifies nothing");
});

test("a run sweep that throws does not skip the send sweep", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await insertRun(db, report, { id: "rrn-0000000000000041", status: "running" });
  await db.execute({
    sql: `INSERT INTO report_sends
            (id, run_id, report_id, recipient_id, attempt, status, claim_token, gateway_run_id,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, 'sending', ?, 'another-process', ?, ?)`,
    args: [
      "rsd-0000000000000041", "rrn-0000000000000041", report.id, "rrc-0000000000000041",
      "c".repeat(32), NOW, NOW,
    ],
  });
  // A database whose run-sweep statement fails: the send sweep must not be behind it.
  const refusing = {
    async execute(arg) {
      if (/UPDATE report_runs/.test(String(arg?.sql ?? ""))) throw new Error("report_runs is busy");
      return db.execute(arg);
    },
  };
  const hook = registerReportsHook(db, hookDeps(report));

  const out = await hook.sweep(refusing);

  assert.deepEqual(out, { marked: 0 }, "the run sweep marked nothing");
  assert.equal((await rows(db, "SELECT status FROM report_runs"))[0].status, "running",
    "the run row was left for the next try");
  assert.equal((await rows(db, "SELECT status FROM report_sends"))[0].status, "unknown",
    "the send sweep ran anyway");
  assert.equal(notes.length, 1, "one notice: the send sweep's");
  await hook.stop();
});

test("a send sweep that throws is retried by the next tick, and marks the row then", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({
    sql: `INSERT INTO report_sends
            (id, run_id, report_id, recipient_id, attempt, status, claim_token, gateway_run_id,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, 'sending', ?, 'another-process', ?, ?)`,
    args: [
      "rsd-0000000000000042", "rrn-0000000000000042", report.id, "rrc-0000000000000042",
      "d".repeat(32), NOW, NOW,
    ],
  });
  let failures = 1;
  const flaky = {
    async execute(arg) {
      if (failures > 0 && /UPDATE report_sends/.test(String(arg?.sql ?? ""))) {
        failures -= 1;
        throw new Error("report_sends is busy");
      }
      return db.execute(arg);
    },
  };
  const hook = registerReportsHook(db, hookDeps(report));

  await hook.tick(flaky);
  assert.equal((await rows(db, "SELECT status FROM report_sends"))[0].status, "sending",
    "the first sweep threw before marking anything");
  assert.equal(notes.length, 0);

  await hook.tick(flaky);
  assert.equal((await rows(db, "SELECT status FROM report_sends"))[0].status, "unknown",
    "the next tick retried it and marked the row");
  assert.equal(notes.length, 1, "and the owner heard once");

  await hook.tick(flaky);
  assert.equal(notes.length, 1, "a successful sweep is not repeated");
  await hook.stop();
});

test("two gateway starts on the same kernel boot id: the old pid is gone, so the sweep fires", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  // The previous gateway's lease: same box (same boot id), its own run id, a pid that is gone now.
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [LEASE_KEY, JSON.stringify({ runId: "run-previous", pid: 999, kernelBootId: BOOT, at: clock - 20_000 })],
  });
  await insertRun(db, report, { id: "rrn-0000000000000011", status: "running", gateway: "run-previous" });

  const result = await startReportsAtBoot({
    db,
    deps: hookDeps(report, { lease: { now: () => clock, pid: 4242, isPidAlive: () => false, kernelBootId: () => BOOT, runId: RUN_ID } }),
  });

  assert.equal(result.started, true);
  assert.deepEqual(result.swept, { marked: 1 });
  assert.equal((await rows(db, "SELECT status FROM report_runs"))[0].status, "failed");
  const lease = JSON.parse((await rows(db, "SELECT value FROM dashboard_settings WHERE key = ?", [LEASE_KEY]))[0].value);
  assert.equal(lease.runId, RUN_ID, "this process took the lease");
  assert.equal(getSchedulerHook("reports") !== undefined, true, "the hook is registered");
  await result.hook.stop();
});

test("a fresh lease held by another live gateway skips the sweep, and the first tick that gets it sweeps", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [LEASE_KEY, JSON.stringify({ runId: "run-other", pid: 777, kernelBootId: BOOT, at: clock })],
  });
  await insertRun(db, report, { id: "rrn-0000000000000021", status: "running", gateway: "run-other" });
  const hook = registerReportsHook(db, hookDeps(report, {
    lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID },
  }));

  const skipped = await hook.sweep(db);
  assert.deepEqual(skipped, { marked: 0, skipped: true });
  assert.equal((await rows(db, "SELECT status FROM report_runs"))[0].status, "running", "left alone");

  // Once the other gateway is gone (its lease is older than three minutes), a tick takes the lease
  // and does the sweep it could not do before.
  clock += 4 * 60 * 1000;
  await hook.tick(db);
  assert.equal((await rows(db, "SELECT status FROM report_runs"))[0].status, "failed");
  assert.equal(notes.length, 1);
});

test("a stale lease (aged out) is taken at boot and the sweep runs", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [LEASE_KEY, JSON.stringify({ runId: "run-old", pid: 999, kernelBootId: BOOT, at: clock - 4 * 60 * 1000 })],
  });
  await insertRun(db, report, { id: "rrn-0000000000000031", status: "queued", gateway: "run-old" });
  const result = await startReportsAtBoot({
    db,
    deps: hookDeps(report, { lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID } }),
  });
  assert.equal(result.started, true);
  assert.deepEqual(result.swept, { marked: 1 });
  await result.hook.stop();
  assert.equal(await rows(db, "SELECT value FROM dashboard_settings WHERE key = ?", [LEASE_KEY]).then((r) => r.length), 0,
    "a clean stop releases the lease");
});

test("a restart within three minutes still registers the hook and takes the lease", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [LEASE_KEY, JSON.stringify({ runId: "run-before-restart", pid: 999, kernelBootId: BOOT, at: clock - 30_000 })],
  });
  const result = await startReportsAtBoot({
    db,
    deps: hookDeps(report, { lease: { now: () => clock, pid: 4242, isPidAlive: () => false, kernelBootId: () => BOOT, runId: RUN_ID } }),
  });
  assert.equal(result.started, true);
  assert.equal(typeof getSchedulerHook("reports")?.tick, "function");
  const lease = JSON.parse((await rows(db, "SELECT value FROM dashboard_settings WHERE key = ?", [LEASE_KEY]))[0].value);
  assert.equal(lease.runId, RUN_ID);
  assert.equal(lease.pid, 4242);
  await result.hook.stop();
  assert.equal(getSchedulerHook("reports"), undefined, "stopping unregisters the hook");
});

test("a --no-auth gateway registers no hook and takes no lease", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  const result = await startReportsAtBoot({ noAuth: true, db, deps: hookDeps(report) });
  assert.deepEqual(result, { started: false, reason: "no-auth" });
  assert.equal(getSchedulerHook("reports"), undefined);
  assert.equal((await rows(db, "SELECT value FROM dashboard_settings WHERE key = ?", [LEASE_KEY])).length, 0,
    "and no lease was taken");
});

test("CROW_DISABLE_INSTANCE_SYNC=1 has no effect on reports", async () => {
  const db = await freshDb();
  const report = await liveReport(db);
  const before = process.env.CROW_DISABLE_INSTANCE_SYNC;
  process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
  try {
    const result = await startReportsAtBoot({ noAuth: false, db, deps: hookDeps(report) });
    assert.equal(result.started, true, "the hook is registered even with instance sync off");
    assert.equal(typeof getSchedulerHook("reports")?.tick, "function");
    await result.hook.stop();
  } finally {
    if (before === undefined) delete process.env.CROW_DISABLE_INSTANCE_SYNC;
    else process.env.CROW_DISABLE_INSTANCE_SYNC = before;
  }
});

/* ------------------------------------------------------------------ the requests */

test("the request queue: a preview always runs, a run now needs a live report", async () => {
  const db = await freshDb();
  const { requestRun } = await import("../servers/gateway/reports/run-requests.js");
  const draft = await seedReport(db);
  const live = await liveReport(db);
  const hook = registerReportsHook(db, hookDeps(live));

  await requestRun(db, { reportId: draft.id, kind: "preview", requestedBy: "owner", now: clock });
  await requestRun(db, { reportId: draft.id, kind: "run_now", requestedBy: "bot:bot-1", now: clock });
  await requestRun(db, { reportId: live.id, kind: "run_now", requestedBy: "owner", now: clock });
  await hook.tick(db);

  const runs = await rows(db, "SELECT * FROM report_runs ORDER BY created_at, id");
  assert.equal(runs.length, 2, "the draft previewed; the draft's run now did not run");
  const preview = runs.find((r) => r.trigger === "preview");
  assert.equal(preview.report_id, draft.id);
  assert.equal(preview.requested_by, "owner");
  const manual = runs.find((r) => r.trigger === "manual");
  assert.equal(manual.report_id, live.id);
  assert.equal(manual.requested_by, "owner");
  const left = await rows(db, "SELECT * FROM report_run_requests WHERE claimed_at IS NULL");
  assert.deepEqual(left, [], "every request was claimed (the refused one is dropped)");
  await settle();
});

test("kick drains the queue in a process with a hook and does nothing without one", async () => {
  const db = await freshDb();
  const { requestRun } = await import("../servers/gateway/reports/run-requests.js");
  const report = await liveReport(db);

  assert.equal(kickReportsHook(), false, "no hook in this process");
  const hook = registerReportsHook(db, hookDeps(report));
  await requestRun(db, { reportId: report.id, kind: "preview", requestedBy: "owner", now: clock });
  assert.equal(kickReportsHook(), true);
  await settle(50);
  assert.equal((await rows(db, "SELECT * FROM report_runs")).length, 1);
  await hook.stop();
  assert.equal(kickReportsHook(), false);
});

/* -------------------------------------------------------------------- the seam */

test("the hook and its boot helper are wired the way post-listen wires them", () => {
  const src = readFileSync(new URL("../servers/gateway/reports/schedule-hook.js", import.meta.url), "utf8");
  for (const line of src.match(/^import[\s\S]*?;$/gm) ?? []) {
    assert.doesNotMatch(line, /delivery/i, line);
    assert.doesNotMatch(line, /reports-door/i, line);
    assert.doesNotMatch(line, /mail\//i, line);
    assert.doesNotMatch(line, /shouldInitInstanceSync/, line);
  }
  for (const m of src.matchAll(/import\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    assert.doesNotMatch(m[1], /delivery|reports-door|mail\//i, m[1]);
  }
  // post-listen starts the hook through the helper, and only when it is not a --no-auth gateway.
  const boot = readFileSync(new URL("../servers/gateway/boot/post-listen.js", import.meta.url), "utf8");
  assert.match(boot, /startReportsAtBoot\(\{/);
  assert.match(boot, /if \(!noAuth\) \{\n\s+setImmediate\(async \(\) => \{[\s\S]{0,600}startReportsAtBoot/);
  assert.match(boot, /deliverNotWired/);
});

test("the pre-PR-5 delivery seam records nothing and sends nothing", async () => {
  assert.deepEqual(await deliverNotWired(), { delivered: false });
});