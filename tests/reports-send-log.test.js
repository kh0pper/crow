// The report send log: the list a page reads and the owner's "Send to the rest".
//
// Harness: a real init-db'd scratch crow.db copied per test (CROW_DATA_DIR under a temp dir, so nothing
// can touch a real Crow data dir), a real report made live through the approvals module's own
// `approveGoLive`, real recipients through propose + approve, real run rows through `startRun`, and a
// fake adapter that must never be reached: this module writes rows and sends nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-send-log-"));
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
const { startRun } = await import("../servers/gateway/reports/run.js");
const {
  SEND_LIST_LIMIT, SEND_SKIP_REASONS, createSendToRest, listSends,
} = await import("../servers/gateway/reports/send-log.js");
const {
  createReport, saveRecipe, updateReportColumns,
} = await import("../servers/gateway/reports/store.js");

const OWNER = Object.freeze({ kind: "owner" });
const BOT_ACTOR = Object.freeze({ kind: "bot" });
const SEED = Buffer.alloc(32, 13);
const T0 = 1_700_000_000_000;

const REGISTRY = Object.freeze({ columns: { sourceBearing: false } });
const RECIPE = { blocks: [{ id: "b1", type: "columns", settings: { columns: ["subject"] } }] };

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

async function addSchedule(db) {
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', '0 7 * * 1', 'Europe/Berlin')",
    args: [],
  });
  const { rows } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  return Number(rows[0].id);
}

/** A live report, a sender account and a real run row to send to the rest of. */
async function world() {
  const db = await freshDb();
  const scheduleId = await addSchedule(db);
  const account = await createAccount(db, {
    address: "reports@example.com",
    label: "Reports",
    imap: { host: "imap.example.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.example.com", port: 465, security: "ssl" },
  });
  const { id } = await createReport(db, { projectId: 7, owner: "owner", botId: "bot-1", title: "Weekly listings" });
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
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId: id, trigger: "schedule", requestedBy: "schedule", scheduledFor: T0,
  });
  // A run that has finished: "Send to the rest" is a tap on a run whose result exists.
  await db.execute({
    sql: `UPDATE report_runs SET status = 'ok', ended_at = ? WHERE id = ?`,
    args: [T0, runId],
  });
  return { db, reportId: id, account, runId };
}

async function recipientFor(db, reportId, { address = "alex@example.com", approve = true } = {}) {
  const proposed = await proposeRecipient(db, approvalsDeps(), {
    reportId, address, displayName: "Alex", proposedBy: "owner",
  });
  if (!approve) return proposed;
  return approveRecipient(db, approvalsDeps(), { recipientId: proposed.id, actor: OWNER });
}

let sendSeq = 0;

/** One send row, the way PR 5's delivery will write them. */
async function sendRow(db, { runId, reportId, recipientId, attempt = 1, status = "pending" }) {
  const id = `rsd-${(++sendSeq).toString(16).padStart(16, "0")}`;
  await db.execute({
    sql: `INSERT INTO report_sends
            (id, run_id, report_id, recipient_id, attempt, account_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    args: [id, runId, reportId, recipientId, attempt, status, T0, T0],
  });
  return id;
}

const rowsFor = async (db, runId) => (await db.execute({
  sql: "SELECT * FROM report_sends WHERE run_id = ? ORDER BY recipient_id, attempt",
  args: [runId],
})).rows;

const sendIds = (out) => out.created.slice().sort();

/* ---------------------------------------------------------------------- the skips */

test("send to the rest skips a recipient this run already sent to or left unknown", async () => {
  const { db, reportId, runId } = await world();
  const sent = await recipientFor(db, reportId, { address: "sent@example.com" });
  const unknown = await recipientFor(db, reportId, { address: "unknown@example.com" });
  const fresh = await recipientFor(db, reportId, { address: "fresh@example.com" });
  await sendRow(db, { runId, reportId, recipientId: sent.id, status: "sent" });
  await sendRow(db, { runId, reportId, recipientId: unknown.id, status: "unknown" });

  const out = await createSendToRest(db, { approvals: approvalsDeps() }, {
    reportId, runId, actor: OWNER,
  });

  assert.equal(out.created.length, 1, "only the recipient with no row got one");
  const byRecipient = (a, b) => (a.recipientId < b.recipientId ? -1 : 1);
  assert.deepEqual(out.skipped.slice().sort(byRecipient), [
    { recipientId: sent.id, reason: "sent" },
    { recipientId: unknown.id, reason: "unknown" },
  ].sort(byRecipient));
  assert.ok(SEND_SKIP_REASONS.includes("sent"));
  assert.ok(SEND_SKIP_REASONS.includes("unknown"));
  const rows = await rowsFor(db, runId);
  assert.equal(rows.filter((row) => row.recipient_id === fresh.id).length, 1);
  assert.equal(rows.filter((row) => row.recipient_id === sent.id).length, 1, "no second row for a sent one");
  assert.equal(rows.filter((row) => row.recipient_id === unknown.id).length, 1, "nor for an unknown one");
});

test("send to the rest skips a recipient with a pending or a sending row", async () => {
  const { db, reportId, runId } = await world();
  const pending = await recipientFor(db, reportId, { address: "pending@example.com" });
  const sending = await recipientFor(db, reportId, { address: "sending@example.com" });
  await sendRow(db, { runId, reportId, recipientId: pending.id, status: "pending" });
  await sendRow(db, { runId, reportId, recipientId: sending.id, status: "sending" });

  const out = await createSendToRest(db, { approvals: approvalsDeps() }, {
    reportId, runId, actor: OWNER,
  });

  assert.deepEqual(out.created, [], "nothing was added");
  assert.deepEqual(out.skipped.map((skip) => skip.reason).sort(), ["pending", "pending"]);
  assert.equal((await rowsFor(db, runId)).length, 2, "and no row was written");
});

test("a new row is pending, attempt+1, the report's own sender, and stamped once", async () => {
  const { db, account, reportId, runId } = await world();
  const recipient = await recipientFor(db, reportId);
  // An earlier attempt that did not complete: its reason is the delivery seam's, its attempt is 3.
  await sendRow(db, { runId, reportId, recipientId: recipient.id, attempt: 3, status: "failed" });

  const out = await createSendToRest(db, { approvals: approvalsDeps(), now: () => T0 }, {
    reportId, runId, actor: OWNER,
  });

  assert.equal(out.created.length, 1);
  const rows = (await rowsFor(db, runId)).filter((row) => row.recipient_id === recipient.id);
  assert.equal(rows.length, 2);
  const added = rows.find((row) => row.status === "pending");
  assert.equal(added.id, out.created[0]);
  assert.equal(added.attempt, 4, "the highest attempt for that run and recipient, plus one");
  assert.equal(added.account_id, account.id, "the report's own sender account");
  assert.equal(added.report_id, reportId);
  assert.equal(Number(added.created_at), T0);
  assert.equal(Number(added.updated_at), T0);
  assert.equal(added.claim_token, null, "nothing claimed it: it is only a row");
  assert.equal(added.message_id, null);
  assert.equal(added.reason, null);
});

/* ------------------------------------------------------------------ the double tap */

test("two overlapping taps make one set of rows", async () => {
  const { db, reportId, runId } = await world();
  const one = await recipientFor(db, reportId, { address: "one@example.com" });
  const two = await recipientFor(db, reportId, { address: "two@example.com" });
  const three = await recipientFor(db, reportId, { address: "three@example.com" });

  const deps = { approvals: approvalsDeps() };
  const [a, b] = await Promise.all([
    createSendToRest(db, deps, { reportId, runId, actor: OWNER }),
    createSendToRest(db, deps, { reportId, runId, actor: OWNER }),
  ]);

  const rows = await rowsFor(db, runId);
  assert.equal(rows.length, 3, "one row per recipient, however many taps arrived");
  assert.deepEqual(rows.map((row) => row.attempt), [1, 1, 1]);
  assert.deepEqual(new Set(rows.map((row) => row.recipient_id)),
    new Set([one.id, two.id, three.id]));

  // Between them the two answers account for every recipient exactly once.
  const ids = sendIds(a);
  const created = new Set([...a.created, ...b.created]);
  assert.equal(created.size, 3, "the winning tap reported the rows it wrote");
  assert.deepEqual(ids, a.created.slice().sort());
  for (const recipient of [one, two, three]) {
    const inCreated = a.created.some((id) => rows.some((row) => row.id === id && row.recipient_id === recipient.id))
      || b.created.some((id) => rows.some((row) => row.id === id && row.recipient_id === recipient.id));
    assert.ok(inCreated, `${recipient.id} was created by one of the two taps`);
  }
});

/* ------------------------------------------------------------------------ the owner */

test("send to the rest is the owner's and nobody else's", async () => {
  const { db, reportId, runId } = await world();
  await recipientFor(db, reportId);
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, { reportId, runId, actor: BOT_ACTOR }),
    { code: "owner_only" },
  );
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, { reportId, runId }),
    { code: "owner_only" },
  );
  assert.equal((await rowsFor(db, runId)).length, 0, "no rows for a caller who is not the owner");
});

/* ------------------------------------------------------------------- approval state */

test("a proposal nobody approved and a seal that no longer matches are both skipped", async () => {
  const { db, reportId, runId } = await world();
  const proposed = await recipientFor(db, reportId, { address: "proposed@example.com", approve: false });
  const edited = await recipientFor(db, reportId, { address: "edited@example.com" });
  const kept = await recipientFor(db, reportId, { address: "kept@example.com" });
  // The address moved under the seal: the approval no longer covers this row.
  await db.execute({
    sql: "UPDATE report_recipients SET address = ? WHERE id = ?",
    args: ["elsewhere@example.com", edited.id],
  });

  const out = await createSendToRest(db, { approvals: approvalsDeps() }, {
    reportId, runId, actor: OWNER,
  });

  assert.equal(out.created.length, 1, "only the recipient whose approval still verifies");
  assert.deepEqual(out.skipped.map((skip) => skip.recipientId).sort(), [proposed.id, edited.id].sort());
  for (const skip of out.skipped) assert.equal(skip.reason, "not_approved");

  const rows = await rowsFor(db, runId);
  assert.deepEqual(rows.map((row) => row.recipient_id), [kept.id]);
});

/* -------------------------------------------------------------------- it sends nothing */

test("send to the rest sends nothing: the fake adapter is never reached", async () => {
  const { db, reportId, runId } = await world();
  await recipientFor(db, reportId);
  const calls = [];
  const deps = {
    approvals: approvalsDeps(),
    adapterFor: async (account, fn) => {
      calls.push(account.id);
      return fn({ send: async (message) => { calls.push(message); return { accepted: [{ address: message.to[0].address }] }; } });
    },
  };
  const out = await createSendToRest(db, deps, { reportId, runId, actor: OWNER });
  assert.equal(out.created.length, 1);
  assert.deepEqual(calls, [], "no adapter was built and no message was handed to one");
  const rows = await rowsFor(db, runId);
  assert.deepEqual(rows.map((row) => row.status), ["pending"], "the row is only waiting");
});

/* ----------------------------------------------------------------------- the lookup */

test("send to the rest refuses a run that may not send, and writes no row", async () => {
  const { db, reportId } = await world();
  await recipientFor(db, reportId);

  const preview = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "preview", requestedBy: "owner",
  });
  // A preview's own row is finished, so only its trigger stops it.
  await db.execute({
    sql: `UPDATE report_runs SET status = 'ok', ended_at = ? WHERE id = ?`, args: [T0, preview.runId],
  });
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, {
      reportId, runId: preview.runId, actor: OWNER,
    }),
    { code: "conflict" },
    "a preview run has no live set behind it",
  );

  const botRun = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "manual", requestedBy: "bot:bot-1",
  });
  await db.execute({
    sql: `UPDATE report_runs SET status = 'ok', ended_at = ? WHERE id = ?`, args: [T0, botRun.runId],
  });
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, {
      reportId, runId: botRun.runId, actor: OWNER,
    }),
    { code: "conflict" },
    "a bot's manual run is not the owner's own",
  );

  const queued = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "manual", requestedBy: "owner",
  });
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, {
      reportId, runId: queued.runId, actor: OWNER,
    }),
    { code: "conflict" },
    "a run still in hand has no result to send to the rest of",
  );

  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM report_sends", args: [] });
  assert.equal(Number(rows[0].n), 0, "no row was written by any of them");
});

test("send to the rest refuses a report or a run that does not exist, and a run of another report", async () => {
  const { db, reportId, runId } = await world();
  await recipientFor(db, reportId);
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, { reportId: "rpt-ffffffffffffffff", runId, actor: OWNER }),
    { code: "not_found" },
  );
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, { reportId, runId: "rrn-ffffffffffffffff", actor: OWNER }),
    { code: "not_found" },
  );
  // A live report with no run of its own: the run belongs to somebody else, so it is not found here.
  const other = await createReport(db, { projectId: 7, owner: "owner", botId: "bot-1", title: "Another" });
  await assert.rejects(
    () => createSendToRest(db, { approvals: approvalsDeps() }, { reportId: other.id, runId, actor: OWNER }),
    { code: "not_found" },
  );
});

/* ----------------------------------------------------------------------- the list */

test("the list answers one run's rows newest first, without the claim bookkeeping", async () => {
  const { db, reportId, runId } = await world();
  const recipient = await recipientFor(db, reportId);
  await sendRow(db, { runId, reportId, recipientId: recipient.id, attempt: 1, status: "sent" });
  await sendRow(db, { runId, reportId, recipientId: recipient.id, attempt: 2, status: "unknown" });

  const all = await listSends(db, { reportId });
  assert.equal(all.length, 2);
  for (const row of all) {
    assert.equal("claimToken" in row, false);
    assert.equal("claim_token" in row, false);
    assert.equal("gatewayRunId" in row, false);
    assert.equal("gateway_run_id" in row, false);
  }
  const oneRun = await listSends(db, { reportId, runId });
  assert.equal(oneRun.length, 2);
  assert.deepEqual(oneRun.map((row) => row.runId), [runId, runId]);

  const other = await listSends(db, { reportId, runId: "rrn-0000000000000000" });
  assert.deepEqual(other, [], "another run's rows are not this run's");
  await assert.rejects(() => listSends(db, {}), { code: "bad_input" });
  assert.equal(SEND_LIST_LIMIT, 200);
});