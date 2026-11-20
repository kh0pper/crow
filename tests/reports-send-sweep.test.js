// The stale send sweep: what a restart does to a report send that was in flight, and what it must
// never do (resend, mark this process's own rows, notice twice, or take the run sweep down with it).
//
// Harness: a real init-db'd scratch crow.db copied per test (CROW_DATA_DIR under a temp dir), a real
// live report and run row, real recipient rows through propose + approve, real send rows written the
// way delivery will write them, the gateway run id from run-id.js, and the reports hook's own clock,
// lease and notify seams injected. The door is driven with a fake adapter so "never resent" is a count
// of adapter calls, not an inference.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-send-sweep-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const {
  approveGoLive, approveRecipient, proposeRecipient,
} = await import("../servers/gateway/reports/approvals.js");
const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { sendReportMail } = await import("../servers/gateway/mail/reports-door.js");
const { RESTARTED_TEXT, startRun } = await import("../servers/gateway/reports/run.js");
const { registerReportsHook, _setReportsHookForTest } = await import(
  "../servers/gateway/reports/schedule-hook.js"
);
const {
  RESTARTED_SEND_REASON, RESTARTED_SENDING_TITLE, restartSendNotice, sweepStaleSends,
} = await import("../servers/gateway/reports/send-sweep.js");
const {
  createReport, saveRecipe, updateReportColumns,
} = await import("../servers/gateway/reports/store.js");
const { LEASE_KEY } = await import("../servers/gateway/reports/lease.js");
const { gatewayRunId } = await import("../servers/gateway/run-id.js");
const { unregisterSchedulerHook } = await import("../servers/gateway/scheduler-hooks.js");

const OWNER = Object.freeze({ kind: "owner" });
const SEED = Buffer.alloc(32, 17);
const T0 = 1_700_000_000_000;
const BOOT = "boot-sweep";
const RUN_ID = "run-this-process";

const REGISTRY = Object.freeze({ columns: { sourceBearing: false } });
const RECIPE = { blocks: [{ id: "b1", type: "columns", settings: { columns: ["subject"] } }] };

const open = [];
let notes = [];
let clock = T0;

after(() => {
  unregisterSchedulerHook("reports");
  _setReportsHookForTest(null);
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
  notes = [];
  clock = T0;
  unregisterSchedulerHook("reports");
  _setReportsHookForTest(null);
});

/* ------------------------------------------------------------------- the harness */

function approvalsDeps(over = {}) {
  return {
    loadSeed: () => ({ seed: SEED }),
    now: () => T0,
    getRun: async () => null,
    senderReady: async () => true,
    registry: REGISTRY,
    getSecrets: () => [],
    ...over,
  };
}

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

/** A live report with a sender account, one approved recipient and a scheduled run row. */
async function world({ title = "Weekly listings" } = {}) {
  const db = await freshDb();
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', '0 7 * * 1', 'Europe/Berlin')",
    args: [],
  });
  const { rows: made } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  const scheduleId = Number(made[0].id);
  const account = await createAccount(db, {
    address: "reports@example.com",
    label: "Reports",
    imap: { host: "imap.example.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.example.com", port: 465, security: "ssl" },
  });
  const { id } = await createReport(db, { projectId: 7, owner: "owner", botId: "bot-1", title });
  const saved = await saveRecipe(db, { reportId: id, recipe: RECIPE, authorKind: "owner", registry: REGISTRY });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: account.id,
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: 0,
  });
  const preview = { id: "prv-1", reportId: id, kind: "preview", status: "ok", recipeRev: saved.rev };
  await approveGoLive(db, approvalsDeps({
    getRun: async (_db, runId) => (runId === "prv-1" ? preview : null),
  }), { reportId: id, previewRunId: "prv-1", actor: OWNER });
  const proposed = await proposeRecipient(db, approvalsDeps(), {
    reportId: id, address: "alex@example.com", displayName: "Alex", proposedBy: "owner",
  });
  const recipient = await approveRecipient(db, approvalsDeps(), { recipientId: proposed.id, actor: OWNER });
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId: id, trigger: "schedule", requestedBy: "schedule", scheduledFor: T0,
  });
  return { db, reportId: id, account, recipient, runId, scheduleId };
}

let sendSeq = 0;

/** One send row. `gateway` is the process the row's claim names (null for `pending`). */
async function sendRow(db, {
  runId, reportId, recipientId, attempt = 1, status = "pending", gateway = null,
}) {
  const id = `rsd-${(++sendSeq).toString(16).padStart(16, "0")}`;
  await db.execute({
    sql: `INSERT INTO report_sends
            (id, run_id, report_id, recipient_id, attempt, account_id, status, claim_token,
             gateway_run_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    args: [
      id, runId, reportId, recipientId, attempt, status,
      status === "sending" ? "c".repeat(32) : null, gateway, T0, T0,
    ],
  });
  return id;
}

const rowOf = async (db, id) => (await db.execute({
  sql: "SELECT * FROM report_sends WHERE id = ?", args: [id],
})).rows[0];

/** A hook over one database, its clock, lease and owner notice injected. */
function hookDeps(over = {}) {
  return {
    approvals: approvalsDeps(),
    now: () => clock,
    concurrency: 1,
    notify: async (_db, note) => { notes.push(note); },
    instanceZone: async () => "UTC",
    graceMs: () => 5 * 60 * 1000,
    getSecrets: () => [],
    lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID },
    deliver: async () => {},
    runBlocks: async () => ({ items: [] }),
    ...over,
  };
}

/* ------------------------------------------------------------------------ the sweep */

test("a sending row from another process becomes unknown, and one notice carries the run's counts", async () => {
  const { db, reportId, runId, recipient } = await world();
  const sent = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, attempt: 1, status: "sent", gateway: "run-old",
  });
  const inFlight = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, attempt: 2, status: "sending", gateway: "run-old",
  });
  const waiting = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, attempt: 3, status: "pending",
  });
  const alreadyUnknown = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, attempt: 4, status: "unknown", gateway: "run-older",
  });

  const out = await sweepStaleSends(db, {
    gatewayRunId: gatewayRunId(), now: T0 + 5000, notify: (note) => notes.push(note),
  });

  assert.deepEqual(out.marked, 1);
  assert.deepEqual(out.runs, [{ runId, reportId }]);
  const swept = await rowOf(db, inFlight);
  assert.equal(swept.status, "unknown");
  assert.equal(swept.reason, RESTARTED_SEND_REASON);
  assert.equal(Number(swept.updated_at), T0 + 5000);
  assert.equal((await rowOf(db, sent)).status, "sent", "a sent row is untouched");
  assert.equal((await rowOf(db, waiting)).status, "pending", "a pending row stays pending");
  assert.equal((await rowOf(db, alreadyUnknown)).status, "unknown", "and an unknown row is left alone");

  assert.equal(notes.length, 1, "one notice for the run");
  assert.equal(notes[0].reportId, reportId);
  assert.equal(notes[0].runId, runId);
  assert.equal(notes[0].title, `Weekly listings: ${RESTARTED_SENDING_TITLE}`);
  assert.equal(notes[0].body, "1 sent, 2 unknown, 1 not sent.");

  // Nothing is marked twice, and a second sweep says nothing at all.
  const second = await sweepStaleSends(db, {
    gatewayRunId: gatewayRunId(), now: T0 + 6000, notify: (note) => notes.push(note),
  });
  assert.deepEqual(second, { marked: 0, runs: [] });
  assert.equal(notes.length, 1);
});

test("this process's own sending rows are left alone", async () => {
  const { db, reportId, runId, recipient } = await world();
  const mine = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, status: "sending", gateway: RUN_ID,
  });
  const out = await sweepStaleSends(db, {
    gatewayRunId: RUN_ID, now: T0, notify: (note) => notes.push(note),
  });
  assert.deepEqual(out, { marked: 0, runs: [] });
  const row = await rowOf(db, mine);
  assert.equal(row.status, "sending", "a row this process is sending is not swept");
  assert.equal(notes.length, 0);
});

test("a sending row with no gateway run id is swept: nobody can say which process wrote it", async () => {
  const { db, reportId, runId, recipient } = await world();
  const orphan = await sendRow(db, { runId, reportId, recipientId: recipient.id, status: "sending" });
  const out = await sweepStaleSends(db, { gatewayRunId: RUN_ID, now: T0, notify: (note) => notes.push(note) });
  assert.equal(out.marked, 1);
  assert.equal((await rowOf(db, orphan)).status, "unknown");
});

test("the sweep's notice strips a title's control characters and bounds it", async () => {
  const notice = restartSendNotice({
    title: `Weekly\r\nlistings ${"x".repeat(200)}`,
    sent: 2,
    unknown: 1,
    notSent: 1,
  });
  assert.equal(/[\r\n]/.test(notice.title), false, "no line break in a bell title");
  assert.ok(notice.title.length <= 80 + 2 + RESTARTED_SENDING_TITLE.length);
  assert.equal(notice.body, "2 sent, 1 unknown, 1 not sent.");
  assert.deepEqual(restartSendNotice({}), {
    title: `This report: ${RESTARTED_SENDING_TITLE}`, body: "0 sent, 0 unknown, 0 not sent.",
  });
});

/* --------------------------------------------------------------- the door's own half */

test("a swept row is never sent again, however often the door is called", async () => {
  const { db, account, reportId, runId, recipient } = await world();
  const inFlight = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, status: "sending", gateway: "run-old",
  });
  await sweepStaleSends(db, { gatewayRunId: gatewayRunId(), now: T0, notify: (note) => notes.push(note) });
  assert.equal((await rowOf(db, inFlight)).status, "unknown");

  const messages = [];
  const deps = {
    approvals: approvalsDeps(),
    adapterFor: async (_account, fn) => fn({
      send: async (message) => {
        messages.push(message);
        return { accepted: [{ address: recipient.address }], messageId: "<provider-1@example.com>" };
      },
    }),
    getSecrets: () => [],
    now: () => T0,
  };
  for (let i = 0; i < 2; i += 1) {
    const out = await sendReportMail(db, deps, {
      sendId: inFlight, subject: "Your weekly listings", text: "Here is your report",
    });
    assert.deepEqual(out, { status: "refused", reason: "not_pending" });
  }
  assert.equal(messages.length, 0, "an unknown row is never handed to an adapter");
  const row = await rowOf(db, inFlight);
  assert.equal(row.status, "unknown", "and the sweep's verdict stands");
  assert.equal(row.reason, RESTARTED_SEND_REASON);
  assert.equal(row.claim_token, "c".repeat(32), "the claim it died under is still its own");
  assert.equal(row.account_id, null, "nothing about the sender was rewritten");
  assert.ok(account.id, "the sender account is real");
});

/* ------------------------------------------------------------------- the hook's gate */

test("the hook runs the send sweep only under the lease", async () => {
  const { db, reportId, runId, recipient } = await world();
  await db.execute({
    sql: `INSERT INTO report_runs (id, report_id, "trigger", status, gateway_run_id, requested_by, started_at, created_at)
          VALUES (?, ?, 'schedule', 'running', ?, 'schedule', ?, ?)`,
    args: ["rrn-0000000000000011", reportId, "run-other", T0, T0],
  });
  await db.execute({
    sql: "INSERT INTO report_sends (id, run_id, report_id, recipient_id, attempt, status, gateway_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'sending', 'run-other', ?, ?)",
    args: ["rsd-0000000000000011", runId, reportId, recipient.id, T0, T0],
  });
  // Another live gateway holds the lease.
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)",
    args: [LEASE_KEY, JSON.stringify({ runId: "run-other", pid: 777, kernelBootId: BOOT, at: T0 })],
  });
  const hook = registerReportsHook(db, hookDeps({
    lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID },
  }));

  const skipped = await hook.sweep(db);
  assert.deepEqual(skipped, { marked: 0, skipped: true });
  assert.equal((await rowOf(db, "rsd-0000000000000011")).status, "sending", "no send was swept");
  assert.equal(notes.length, 0);
  await hook.stop();

  // Its lease is gone: this process takes it and both sweeps run.
  clock += 4 * 60 * 1000;
  const mine = registerReportsHook(db, hookDeps({
    lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID },
  }));
  const swept = await mine.sweep(db);
  assert.equal(swept.marked, 1, "the run sweep still answers the runs it marked");
  assert.equal((await rowOf(db, "rsd-0000000000000011")).status, "unknown", "the send sweep ran too");
  const { rows: runs } = await db.execute({
    sql: "SELECT status, error_text FROM report_runs WHERE id = ?", args: ["rrn-0000000000000011"],
  });
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error_text, RESTARTED_TEXT);
  assert.equal(notes.length, 2, "one notice for the run, one for its sends");
  assert.ok(notes.some((note) => String(note.title).includes(RESTARTED_SENDING_TITLE)));
  await mine.stop();
});

test("a send sweep that throws does not stop the run sweep or the tick", async () => {
  const { db, reportId, recipient, runId } = await world();
  await db.execute({
    sql: `INSERT INTO report_runs (id, report_id, "trigger", status, gateway_run_id, requested_by, started_at, created_at)
          VALUES (?, ?, 'schedule', 'running', ?, 'schedule', ?, ?)`,
    args: ["rrn-0000000000000021", reportId, "run-other", T0, T0],
  });
  await db.execute({
    sql: "INSERT INTO report_sends (id, run_id, report_id, recipient_id, attempt, status, gateway_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'sending', 'run-other', ?, ?)",
    args: ["rsd-0000000000000021", runId, reportId, recipient.id, T0, T0],
  });
  // A database whose send-log statement fails: the sweep's own guard is what the hook must survive.
  const refusingDb = {
    execute: async (arg) => {
      if (String(arg?.sql ?? "").includes("report_sends")) throw new Error("no send log right now");
      return db.execute(arg);
    },
  };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const hook = registerReportsHook(db, hookDeps({
    lease: { now: () => clock, pid: 4242, isPidAlive: () => true, kernelBootId: () => BOOT, runId: RUN_ID },
  }));
  try {
    const swept = await hook.sweep(refusingDb);
    assert.equal(swept.marked, 1, "the run sweep did its own work");
  } finally {
    console.warn = original;
  }
  const { rows: runs } = await db.execute({
    sql: "SELECT status FROM report_runs WHERE id = ?", args: ["rrn-0000000000000021"],
  });
  assert.equal(runs[0].status, "failed", "the run was marked exactly as before");
  assert.ok(notes.some((note) => String(note.title).includes(RESTARTED_TEXT)), "and its notice went out");
  assert.equal((await rowOf(db, "rsd-0000000000000021")).status, "sending", "the sends were left as they were");
  assert.equal(warnings.filter((line) => line.includes("stale send sweep")).length, 1,
    "one warn line, and nothing else");
  await hook.stop();
});