// The run engine: what a run executes, what it records, and what it refuses.
//
// Harness: a real init-db'd scratch crow.db, copied per test (CROW_DATA_DIR under a temp dir, so nothing
// can touch a real Crow data dir), real report and revision rows, a fixed keychain seed injected through
// `deps.approvals.loadSeed`, and go-live through the approvals module's own `approveGoLive` (with an
// injected preview run reader), so a "live report" here is live the way production makes one. The run
// tables are the real ones: migration 0032's DDL is what init-db built.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-run-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const {
  DELIVERY_NOT_WIRED_TEXT, NOT_LIVE_TEXT, RESTARTED_TEXT, executeRun, getRun, getRunForApproval,
  listRuns, startRun, statusAuditOk,
} = await import("../servers/gateway/reports/run.js");
const {
  claimRunRequests, pruneRunRequests, requestRun,
} = await import("../servers/gateway/reports/run-requests.js");
const { approveGoLive, ownerSaveRecipe, pauseReport } = await import(
  "../servers/gateway/reports/approvals.js"
);
const {
  createReport, getReport, saveRecipe, updateReportColumns,
} = await import("../servers/gateway/reports/store.js");
const { gatewayRunId } = await import("../servers/gateway/run-id.js");

const OWNER = Object.freeze({ kind: "owner" });
const SEED = Buffer.alloc(32, 3);
const PROJECT = 7;
const SENDER = "ma-0011223344556677";
const T0 = 1_700_000_000_000;

/** The block registry a later PR ships; here it is a stub that marks the two free block types. */
const REGISTRY = Object.freeze({
  mail_list: { sourceBearing: true },
  custom_step: { sourceBearing: true },
  columns: { sourceBearing: false },
  sort: { sourceBearing: false },
});

const SOURCE_RECIPE = {
  blocks: [
    { id: "b1", type: "mail_list", settings: { account: SENDER, sinceDays: 7 } },
    { id: "b2", type: "columns", settings: { columns: ["subject", "date"] } },
  ],
};

/** A newer head revision whose source block reads something else: a live report must not run this. */
const NEWER_HEAD_RECIPE = {
  blocks: [
    { id: "b1", type: "mail_list", settings: { account: SENDER, sinceDays: 30 } },
    { id: "b2", type: "columns", settings: { columns: ["subject"] } },
  ],
};

const dirs = [];
const open = [];

after(() => {
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

/* ------------------------------------------------------------------- the harness */

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

/** The approvals module's deps (the seal seed, the clock, the sender reader, the block registry). */
function approvalsDeps(over = {}) {
  return {
    loadSeed: () => ({ seed: SEED }),
    now: () => T0,
    getRun: async () => null,
    senderReady: async () => true,
    registry: REGISTRY,
    ...over,
  };
}

/** The run engine's deps, with everything a test wants to change. */
function runDeps(over = {}) {
  return {
    approvals: approvalsDeps(),
    now: () => T0,
    getSecrets: () => [],
    runBlocks: async () => ({ items: [], sourceErrors: [] }),
    deliver: async () => {},
    ...over,
  };
}

async function addSchedule(db, { cron = "0 7 * * 1", tz = "Europe/Berlin" } = {}) {
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', ?, ?)",
    args: [cron, tz],
  });
  const { rows } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  return Number(rows[0].id);
}

/** One report, saved once at rev 1 and set up the way go-live needs it. */
async function prepare(db, { recipe = SOURCE_RECIPE } = {}) {
  const scheduleId = await addSchedule(db);
  const { id } = await createReport(db, {
    projectId: PROJECT, owner: "owner", botId: "bot-1", title: "Weekly listings",
  });
  const saved = await saveRecipe(db, { reportId: id, recipe, authorKind: "owner", registry: REGISTRY });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: SENDER,
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: 0,
  });
  return { id, rev: saved.rev, scheduleId };
}

/** A live report: the world most tests here start from. */
async function liveReport(options = {}) {
  const db = await freshDb();
  const report = await prepare(db, options);
  const runs = {
    "prv-1": { id: "prv-1", reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev },
  };
  const deps = approvalsDeps({ ...(options.deps || {}), getRun: async (_db, runId) => runs[runId] ?? null });
  await approveGoLive(db, deps, { reportId: report.id, previewRunId: "prv-1", actor: OWNER });
  return { db, report, deps };
}

async function queueRun(db, reportId, over = {}) {
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "manual", requestedBy: "owner", ...over,
  });
  return runId;
}

/* -------------------------------------------------------------------- the run row */

test("startRun queues a run and records who asked and which window it is", async () => {
  const db = await freshDb();
  const report = await prepare(db);

  const manual = await queueRun(db, report.id);
  const row = await getRun(db, manual);
  assert.match(row.id, /^rrn-[0-9a-f]{16}$/);
  assert.equal(row.reportId, report.id);
  assert.equal(row.trigger, "manual");
  assert.equal(row.requestedBy, "owner");
  assert.equal(row.status, "queued");
  assert.equal(row.scheduledFor, null);
  assert.equal(row.late, 0);
  assert.equal(row.startedAt, null);
  assert.equal(row.endedAt, null);
  assert.equal(row.recipeRev, null, "a manual run takes its revision from the live seal, not the head");
  assert.equal(row.artifactVersion, null);
  assert.equal(row.blockLog, null);
  assert.equal(row.errorText, null);
  assert.equal(row.gatewayRunId, gatewayRunId(), "the process that queued it");
  assert.equal(row.createdAt, T0);

  const preview = await queueRun(db, report.id, { trigger: "preview" });
  assert.equal((await getRun(db, preview)).recipeRev, report.rev, "a preview names the head revision");
  assert.equal((await getRun(db, preview)).trigger, "preview");

  await assert.rejects(
    () => startRun(db, {}, { reportId: report.id, trigger: "on-a-whim", requestedBy: OWNER.kind }),
    { code: "bad_input" },
  );
  for (const requestedBy of ["a bot", "bot:", "", 7, null]) {
    await assert.rejects(
      () => startRun(db, {}, { reportId: report.id, trigger: "manual", requestedBy }),
      { code: "bad_input" },
      String(requestedBy),
    );
  }
  await assert.rejects(
    () => startRun(db, {}, { reportId: "rpt-ffffffffffffffff", trigger: "manual", requestedBy: "owner" }),
    { code: "not_found" },
  );
  const bot = await queueRun(db, report.id, { requestedBy: "bot:bot-1" });
  assert.equal((await getRun(db, bot)).requestedBy, "bot:bot-1");
});

test("a duplicate scheduled window is not an error and does not make a second run", async () => {
  const db = await freshDb();
  const report = await prepare(db);

  const first = await startRun(db, {}, {
    reportId: report.id, trigger: "schedule", requestedBy: "schedule", scheduledFor: T0, late: 1,
  });
  assert.match(first.runId, /^rrn-[0-9a-f]{16}$/);
  const second = await startRun(db, {}, {
    reportId: report.id, trigger: "schedule", requestedBy: "schedule", scheduledFor: T0,
  });
  assert.deepEqual(second, { runId: null, duplicate: true });

  const third = await startRun(db, {}, {
    reportId: report.id, trigger: "schedule", requestedBy: "schedule", scheduledFor: T0 + 1000,
  });
  assert.match(third.runId, /^rrn-[0-9a-f]{16}$/);

  const runs = await listRuns(db, report.id);
  assert.equal(runs.length, 2, "one run per window");
  assert.deepEqual(runs.map((r) => r.scheduledFor).sort((a, b) => a - b), [T0, T0 + 1000]);
  assert.equal(runs.find((r) => r.scheduledFor === T0).late, 1, "the catch-up run is late");
  assert.equal(runs.find((r) => r.scheduledFor === T0 + 1000).late, 0);

  // Two manual runs may share the same (null) window: the unique index covers scheduled runs only.
  await queueRun(db, report.id);
  await queueRun(db, report.id);
  assert.equal((await listRuns(db, report.id)).length, 4);
});

test("listRuns is newest first, capped, and leaves the gateway id out", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  for (let i = 0; i < 3; i += 1) await queueRun(db, report.id);

  const all = await listRuns(db, report.id);
  assert.equal(all.length, 3);
  assert.ok(all.every((r) => !Object.hasOwn(r, "gatewayRunId")), "a list does not carry the process id");
  assert.deepEqual(all.map((r) => r.createdAt), [T0, T0, T0], "same fake clock");
  const limited = await listRuns(db, report.id, { limit: 2 });
  assert.equal(limited.length, 2);
});

/* --------------------------------------------------------------------- the statuses */

test("a source error gives failed, and the text names the source", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const seen = [];
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({
      items: [{ subject: "one" }],
      sourceErrors: [
        { source: "Mail", message: "connection refused" },
        { source: "RSS feed", message: "404" },
      ],
    }),
    deliver: async (_db, payload) => { seen.push(payload); },
  }), runId);

  assert.deepEqual(out, { status: "failed", artifactVersion: null });
  const row = await getRun(db, runId);
  assert.equal(row.status, "failed");
  assert.match(row.errorText, /Couldn't reach Mail\./);
  assert.match(row.errorText, /Couldn't reach RSS feed\./);
  assert.deepEqual(row.blockLog, {
    items: 1,
    sourceErrors: [
      { source: "Mail", message: "connection refused" },
      { source: "RSS feed", message: "404" },
    ],
  });
  assert.equal(typeof row.startedAt, "number");
  assert.equal(row.endedAt, T0);
  assert.equal(seen.length, 1, "a failed run still reports itself");
  assert.equal(seen[0].status, "failed");
});

test("zero items with no errors gives empty, not ok", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const seen = [];
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({ items: [], sourceErrors: [] }),
    deliver: async (_db, payload) => { seen.push(payload); },
  }), runId);
  assert.deepEqual(out, { status: "empty", artifactVersion: null });
  const row = await getRun(db, runId);
  assert.equal(row.status, "empty");
  assert.equal(row.errorText, null);
  assert.deepEqual(row.blockLog, { items: 0, sourceErrors: [] });
  assert.equal(seen[0].status, "empty");
});

test("items with no errors give ok", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const seen = [];
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({ items: [{ subject: "a" }, { subject: "b" }] }),
    deliver: async (_db, payload) => { seen.push(payload); },
  }), runId);
  assert.deepEqual(out, { status: "ok", artifactVersion: null });
  const row = await getRun(db, runId);
  assert.equal(row.status, "ok");
  assert.deepEqual(row.blockLog, { items: 2, sourceErrors: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].run.status, "ok");
});

test("a throw from a block run is a failed run, never a throw out of executeRun", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => { throw new Error("the block runner fell over"); },
  }), runId);
  assert.deepEqual(out, { status: "failed", artifactVersion: null });
  assert.equal((await getRun(db, runId)).errorText, "the block runner fell over");
});

test("a read that throws after the claim leaves the run failed, not running", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  let failReads = false;
  const flakyDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (/UPDATE report_runs SET status = 'running'/.test(sql)) {
        const out = await db.execute(arg);
        failReads = true;
        return out;
      }
      if (failReads && /FROM reports WHERE id = \?/.test(sql)) {
        throw new Error("the reports read refused");
      }
      return db.execute(arg);
    },
  };

  const out = await executeRun(flakyDb, runDeps({ approvals: deps }), runId);
  assert.deepEqual(out, { status: "failed", artifactVersion: null });
  const row = await getRun(db, runId);
  assert.equal(row.status, "failed", "the run is not left running");
  assert.equal(row.errorText, "the reports read refused");
  assert.equal(typeof row.endedAt, "number", "and it has an end");
});

/* ---------------------------------------------------------------------- the preview */

test("a preview runs a draft's saved revision and never calls deliver", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  assert.equal((await getReport(db, report.id)).status, "draft");

  const runId = await queueRun(db, report.id, { trigger: "preview" });
  let blocks = 0;
  let deliverCalls = 0;
  let sawRecipe = null;
  let sawLive = "not set";
  const out = await executeRun(db, runDeps({
    approvals: approvalsDeps(),
    runBlocks: async ({ recipe, live }) => {
      blocks += 1;
      sawRecipe = recipe;
      sawLive = live;
      return { items: [{ subject: "a" }] };
    },
    deliver: async () => { deliverCalls += 1; },
  }), runId);

  assert.deepEqual(out, { status: "ok", artifactVersion: null });
  assert.equal(blocks, 1, "a draft previews");
  assert.equal(deliverCalls, 0, "a preview never leaves the instance");
  assert.deepEqual(sawRecipe, SOURCE_RECIPE);
  assert.equal(sawLive, null, "no live set is involved in a preview");
  const row = await getRun(db, runId);
  assert.equal(row.recipeRev, report.rev);
  assert.equal(row.status, "ok");
});

test("a preview of a revision that is gone is failed, and no block runs", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  const runId = await queueRun(db, report.id, { trigger: "preview" });
  await db.execute({
    sql: "DELETE FROM report_recipe_revisions WHERE report_id = ? AND rev = ?",
    args: [report.id, report.rev],
  });
  let blocks = 0;
  const out = await executeRun(db, runDeps({
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }), runId);
  assert.equal(out.status, "failed");
  assert.equal(blocks, 0);
  assert.match((await getRun(db, runId)).errorText, /revision for this preview is missing/);
});

/* ------------------------------------------------------- what a run may not do */

test("a scheduled run of a draft report is failed and runs no blocks", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  const runId = await queueRun(db, report.id, { trigger: "schedule", requestedBy: "schedule", scheduledFor: T0 });
  let blocks = 0;
  const seen = [];
  const out = await executeRun(db, runDeps({
    approvals: approvalsDeps(),
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
    deliver: async (_db, payload) => { seen.push(payload); },
  }), runId);

  assert.equal(out.status, "failed");
  assert.equal(blocks, 0, "nothing read the owner's sources");
  const row = await getRun(db, runId);
  assert.equal(row.errorText, NOT_LIVE_TEXT);
  assert.equal(row.recipeRev, null);
  assert.equal(seen.length, 0,
    "a refused run never calls deliver: it has no verified live set, and the hook sends the notice");
});

test("a run whose report row is gone is failed and never calls deliver", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  await db.execute({ sql: "DELETE FROM reports WHERE id = ?", args: [report.id] });
  let deliverCalls = 0;
  const out = await executeRun(db, runDeps({
    approvals: deps,
    deliver: async () => { deliverCalls += 1; },
  }), runId);
  assert.equal(out.status, "failed");
  assert.match((await getRun(db, runId)).errorText, /no longer exists/);
  assert.equal(deliverCalls, 0, "there is no report and no live set, so nothing goes out");
});

test("a scheduled run of a paused report whose seal no longer verifies is failed and runs no blocks", async () => {
  const { db, report, deps } = await liveReport();
  await pauseReport(db, deps, { reportId: report.id, actor: OWNER });
  // A live-set column changed by hand while paused breaks the seal, so even a flip back to 'live' would
  // not read live; here the report simply stays paused.
  await db.execute({ sql: "UPDATE reports SET delivery_mode = 'both' WHERE id = ?", args: [report.id] });
  assert.equal((await getReport(db, report.id)).status, "paused");

  const runId = await queueRun(db, report.id, { trigger: "schedule", requestedBy: "schedule", scheduledFor: T0 });
  let blocks = 0;
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }), runId);
  assert.equal(out.status, "failed");
  assert.equal(blocks, 0);
  assert.equal((await getRun(db, runId)).errorText, NOT_LIVE_TEXT);
});

test("a scheduled run executes the SEALED live revision, not a newer head revision", async () => {
  const { db, report, deps } = await liveReport();
  // A newer head revision that reads a different source set: saved by the owner, never re-stamped.
  const saved = await ownerSaveRecipe(db, deps, {
    reportId: report.id, recipe: NEWER_HEAD_RECIPE, actor: OWNER,
  });
  assert.equal(saved.needsGoLive, true);
  assert.equal((await getReport(db, report.id)).recipe_rev, saved.rev, "the head moved");

  const runId = await queueRun(db, report.id, { trigger: "schedule", requestedBy: "schedule", scheduledFor: T0 });
  let sawRecipe = null;
  let sawLive = null;
  let sawReport = null;
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async ({ recipe, live, report: reportArg }) => {
      sawRecipe = recipe;
      sawLive = live;
      sawReport = reportArg;
      return { items: [{ subject: "a" }] };
    },
  }), runId);

  assert.equal(out.status, "ok");
  assert.deepEqual(sawRecipe, SOURCE_RECIPE, "the recipe the owner approved");
  assert.notDeepEqual(sawRecipe, NEWER_HEAD_RECIPE);
  assert.equal(sawLive.rev, report.rev, "at the sealed revision");
  assert.equal(sawLive.botId, "bot-1", "the bot from the verified live set");
  assert.equal(sawLive.projectId, PROJECT);
  assert.equal(sawLive.senderAccountId, SENDER);
  assert.equal(sawReport.id, report.id);

  const row = await getRun(db, runId);
  assert.equal(row.recipeRev, report.rev, "the run records the revision it executed");
  assert.equal(row.status, "ok");
});

test("a report flipped back to live by a direct UPDATE after a pause refuses to run", async () => {
  const { db, report, deps } = await liveReport();
  await pauseReport(db, deps, { reportId: report.id, actor: OWNER });
  await db.execute({ sql: "UPDATE reports SET status = 'live' WHERE id = ?", args: [report.id] });
  const flipped = await getReport(db, report.id);
  assert.equal(flipped.status, "live");
  assert.ok(flipped.live_seal, "a pause keeps the seal, so the seal still verifies over the row");
  assert.equal(await statusAuditOk(db, report.id), false,
    "the newest live-kind decision is the pause's refusal");

  const runId = await queueRun(db, report.id);
  let blocks = 0;
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }), runId);
  assert.equal(out.status, "failed");
  assert.equal(blocks, 0);
  assert.equal((await getRun(db, runId)).errorText, NOT_LIVE_TEXT);
});

test("a report that was never live, forced to live by a direct UPDATE, refuses to run", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  await db.execute({ sql: "UPDATE reports SET status = 'live' WHERE id = ?", args: [report.id] });
  assert.equal(await statusAuditOk(db, report.id), false, "no audit row is not an approval");

  const runId = await queueRun(db, report.id);
  let blocks = 0;
  const out = await executeRun(db, runDeps({
    approvals: approvalsDeps(),
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
  }), runId);
  assert.equal(out.status, "failed");
  assert.equal(blocks, 0);
  assert.equal((await getRun(db, runId)).errorText, NOT_LIVE_TEXT);
});

test("a scheduled run with no delivery seam is failed and runs no blocks at all", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id, { trigger: "schedule", requestedBy: "schedule", scheduledFor: T0 });
  let blocks = 0;
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => { blocks += 1; return { items: [{}] }; },
    deliver: undefined,
  }), runId);
  assert.equal(out.status, "failed");
  assert.equal(blocks, 0, "a run that cannot be delivered does not read the sources");
  const row = await getRun(db, runId);
  assert.equal(row.errorText, DELIVERY_NOT_WIRED_TEXT);
  assert.equal(row.blockLog, null);
});

/* -------------------------------------------------------------------- delivery */

test("a delivery throw keeps the run's status and is appended to its error text", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({ items: [{ subject: "a" }] }),
    deliver: async () => { throw new Error("the mail server refused"); },
  }), runId);
  assert.deepEqual(out, { status: "ok", artifactVersion: null });
  const row = await getRun(db, runId);
  assert.equal(row.status, "ok", "the run happened");
  assert.equal(row.errorText, "Delivery failed: the mail server refused");
  assert.deepEqual(row.blockLog, { items: 1, sourceErrors: [] });
});

test("delivery gets the finished run row, the verified live set and the version", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const seen = [];
  await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({ items: [{ subject: "a" }] }),
    writeVersion: async () => ({ artifactVersion: 12 }),
    deliver: async (_db, payload) => { seen.push(payload); },
  }), runId);
  assert.equal(seen.length, 1);
  const payload = seen[0];
  assert.equal(payload.status, "ok");
  assert.equal(payload.artifactVersion, 12);
  assert.equal(payload.run.id, runId);
  assert.equal(payload.run.status, "ok");
  assert.equal(payload.run.recipeRev, report.rev);
  assert.equal(payload.live.rev, report.rev, "the live set the run executed");
  assert.equal(payload.report.id, report.id);
});

/* ------------------------------------------------------------------- the secrets */

test("a secret echoed by a source never reaches the error text or the block log", async () => {
  const { db, report, deps } = await liveReport();
  const SECRET = "swordfish-value";
  const runId = await queueRun(db, report.id);
  const out = await executeRun(db, runDeps({
    approvals: deps,
    getSecrets: () => [SECRET],
    runBlocks: async () => ({
      items: [],
      sourceErrors: [{ source: "Mail", message: `login failed for ${SECRET}` }],
    }),
  }), runId);
  assert.equal(out.status, "failed");

  const { rows } = await db.execute({
    sql: "SELECT error_text, block_log_json FROM report_runs WHERE id = ?",
    args: [runId],
  });
  assert.equal(rows[0].error_text.includes(SECRET), false, "no secret in the error text");
  assert.match(rows[0].error_text, /Couldn't reach Mail/, "the text names the source, not its message");
  assert.equal(rows[0].block_log_json.includes(SECRET), false, "no secret in the block log");
  assert.equal(rows[0].block_log_json.includes("[redacted]"), true);
});

test("a secret in a thrown message is redacted too, and the text is capped", async () => {
  const { db, report, deps } = await liveReport();
  const SECRET = "swordfish-value";
  const runId = await queueRun(db, report.id);
  await executeRun(db, runDeps({
    approvals: deps,
    getSecrets: () => [SECRET],
    runBlocks: async () => { throw new Error(`${SECRET} ${"x".repeat(5000)}`); },
  }), runId);
  const row = await getRun(db, runId);
  assert.equal(row.status, "failed");
  assert.equal(row.errorText.includes(SECRET), false);
  assert.ok(row.errorText.length <= 2000, `capped (${row.errorText.length})`);
});

/* ------------------------------------------------------------------- concurrency */

test("two executors on one queued run execute it once", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  let blocks = 0;
  const deps2 = runDeps({
    approvals: deps,
    runBlocks: async () => {
      blocks += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { items: [{ subject: "a" }] };
    },
  });
  const [first, second] = await Promise.all([
    executeRun(db, deps2, runId),
    executeRun(db, deps2, runId),
  ]);
  assert.equal(blocks, 1, "the blocks ran once");
  assert.deepEqual([first.status, second.status].sort(), ["ok", "running"],
    "the second executor answers the state it found and does nothing");
  assert.equal((await getRun(db, runId)).status, "ok");
});

test("a swept run is not overwritten by a late finish", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => {
      // A boot sweep inside another process's shoes: the run is closed while the blocks are working.
      await db.execute({
        sql: "UPDATE report_runs SET status = 'failed', error_text = ?, ended_at = ? WHERE id = ?",
        args: [RESTARTED_TEXT, T0 + 5, runId],
      });
      return { items: [{ subject: "a" }] };
    },
  }), runId);

  const row = await getRun(db, runId);
  assert.equal(row.status, "failed", "the sweep owns the row");
  assert.equal(row.errorText, RESTARTED_TEXT);
  assert.equal(row.endedAt, T0 + 5, "the late finish did not touch the row");
  assert.deepEqual(out, { status: "failed", artifactVersion: null },
    "the executor answers what is stored");
});

/* --------------------------------------------------------------------- versions */

test("a written version is stored on the run; a failed write fails the run", async () => {
  const { db, report, deps } = await liveReport();
  const okRun = await queueRun(db, report.id);
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({ items: [{ subject: "a" }] }),
    writeVersion: async (_db, input) => ({ artifactVersion: 4, sawRecipe: input.result.items.length }),
  }), okRun);
  assert.deepEqual(out, { status: "ok", artifactVersion: 4 });
  assert.equal((await getRun(db, okRun)).artifactVersion, 4);

  const failedRun = await queueRun(db, report.id);
  const failed = await executeRun(db, runDeps({
    approvals: deps,
    getSecrets: () => ["swordfish-value"],
    runBlocks: async () => ({ items: [{ subject: "a" }] }),
    writeVersion: async () => { throw new Error("storage refused swordfish-value"); },
  }), failedRun);
  assert.deepEqual(failed, { status: "failed", artifactVersion: null });
  const row = await getRun(db, failedRun);
  assert.equal(row.status, "failed");
  assert.equal(row.errorText.includes("swordfish-value"), false);
  assert.match(row.errorText, /storage refused/);
  assert.equal(row.artifactVersion, null);
});

test("without a version writer the run keeps no artifact version", async () => {
  const { db, report, deps } = await liveReport();
  const runId = await queueRun(db, report.id);
  const out = await executeRun(db, runDeps({
    approvals: deps,
    runBlocks: async () => ({ items: [{ subject: "a" }] }),
  }), runId);
  assert.deepEqual(out, { status: "ok", artifactVersion: null });
  assert.equal((await getRun(db, runId)).artifactVersion, null);
});

/* ----------------------------------------------------------------- approvals seam */

test("getRunForApproval maps the trigger to the kind go-live checks", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  const preview = await queueRun(db, report.id, { trigger: "preview" });
  assert.deepEqual(await getRunForApproval(db, preview), {
    id: preview, reportId: report.id, kind: "preview", status: "queued", recipeRev: report.rev,
  });

  const manual = await queueRun(db, report.id);
  const mapped = await getRunForApproval(db, manual);
  assert.equal(mapped.kind, "run", "a full run never approves a go-live");
  assert.equal(mapped.recipeRev, null);
  assert.equal(mapped.status, "queued");

  const scheduled = await queueRun(db, report.id, {
    trigger: "schedule", requestedBy: "schedule", scheduledFor: T0,
  });
  assert.equal((await getRunForApproval(db, scheduled)).kind, "run");

  assert.equal(await getRunForApproval(db, "rrn-ffffffffffffffff"), null);
  assert.equal(await getRunForApproval(db, null), null);
});

test("statusAuditOk follows the NEWEST live-kind decision", async () => {
  const { db, report, deps } = await liveReport();
  assert.equal(await statusAuditOk(db, report.id), true, "go-live approved it");
  await pauseReport(db, deps, { reportId: report.id, actor: OWNER });
  assert.equal(await statusAuditOk(db, report.id), false, "the pause refused it");
  await db.execute({ sql: "UPDATE reports SET status = 'live' WHERE id = ?", args: [report.id] });
  assert.equal(await statusAuditOk(db, report.id), false, "a status column is not a decision");
  assert.equal(await statusAuditOk(db, "rpt-ffffffffffffffff"), false, "no row at all");
});

/* --------------------------------------------------------------- run requests */

test("run requests: the claim is atomic and a claimed row is never handed out twice", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  for (const kind of ["preview", "run_now", "preview"]) {
    const { id } = await requestRun(db, { reportId: report.id, kind, requestedBy: "owner", now: T0 });
    assert.ok(Number.isInteger(id) && id > 0);
  }
  const [, , , fourth] = [
    null, null, null,
    (await requestRun(db, { reportId: report.id, kind: "run_now", requestedBy: "bot:bot-1", now: T0 })).id,
  ];

  const [first, second] = await Promise.all([
    claimRunRequests(db, { limit: 2, now: T0 + 1 }),
    claimRunRequests(db, { limit: 2, now: T0 + 2 }),
  ]);
  const ids = [...first, ...second].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no row was claimed twice");
  assert.equal(ids.length, 4, "the two claims split the queue");
  assert.equal(ids.includes(fourth), true);
  assert.ok([...first, ...second].every((r) => r.claimedAt === T0 + 1 || r.claimedAt === T0 + 2));
  assert.deepEqual([...first, ...second].map((r) => r.kind).sort(), ["preview", "preview", "run_now", "run_now"]);

  assert.deepEqual(await claimRunRequests(db, { now: T0 + 3 }), [], "an empty queue hands out nothing");

  // Pruning removes claimed rows only: a request nobody has picked up yet stays.
  const pending = await requestRun(db, { reportId: report.id, kind: "preview", requestedBy: "owner", now: T0 });
  const pruned = await pruneRunRequests(db, { olderThanMs: 0, now: T0 + 100_000 });
  assert.deepEqual(pruned, { deleted: 4 });
  const left = await claimRunRequests(db, { now: T0 + 100_001 });
  assert.deepEqual(left.map((r) => r.id), [pending.id], "the unclaimed request survived the prune");
});

test("run requests validate the kind, the requester and the report", async () => {
  const db = await freshDb();
  const report = await prepare(db);
  await assert.rejects(
    () => requestRun(db, { reportId: report.id, kind: "send", requestedBy: "owner" }),
    { code: "bad_input" },
  );
  for (const requestedBy of ["schedule", "bot:", "a bot", 7, null]) {
    await assert.rejects(
      () => requestRun(db, { reportId: report.id, kind: "preview", requestedBy }),
      { code: "bad_input" },
      String(requestedBy),
    );
  }
  await assert.rejects(
    () => requestRun(db, { reportId: "rpt-ffffffffffffffff", kind: "preview", requestedBy: "owner" }),
    { code: "not_found" },
  );
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM report_run_requests", args: [] });
  assert.equal(Number(rows[0].n), 0, "a refused request wrote nothing");
});

/* ------------------------------------------------------------------- the seam */

test("run.js imports neither the delivery module, the reports door, nor anything under mail", () => {
  const src = readFileSync(new URL("../servers/gateway/reports/run.js", import.meta.url), "utf8");
  const importLines = src.match(/^import[\s\S]*?;$/gm) ?? [];
  assert.ok(importLines.length >= 5, "the import lines were found");
  for (const line of importLines) {
    assert.doesNotMatch(line, /delivery/i, line);
    assert.doesNotMatch(line, /reports-door/i, line);
    assert.doesNotMatch(line, /mail\//i, line);
    assert.doesNotMatch(line, /\.\.\/mail/i, line);
  }
  // The same for a dynamic import anywhere in the file: the one outgoing seam is injected.
  for (const m of src.matchAll(/import\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    assert.doesNotMatch(m[1], /delivery|reports-door|mail\//i, m[1]);
  }
  // And run-requests.js never imports the run engine: a bot's request cannot start a run.
  const requests = readFileSync(
    new URL("../servers/gateway/reports/run-requests.js", import.meta.url), "utf8");
  assert.doesNotMatch(requests, /from\s+["'][^"']*run\.js["']/);
});