// The reports-only send door: what it accepts, what it refuses, and the one claim that lets a send
// happen.
//
// Harness: a real init-db'd scratch crow.db, copied per test (CROW_DATA_DIR under a temp dir, so nothing
// can touch a real Crow data dir), a real report made live through the approvals module's own
// `approveGoLive`, a real mail account row, real run rows through `startRun`, and a fake adapter behind
// an injected `deps.adapterFor`. `report_sends` rows are inserted by this file's own helper: creating
// them is PR 5's delivery job, and the door only ever takes their ids.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-door-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const {
  approveGoLive, approveRecipient, listRecipients, pauseReport, proposeRecipient, refuseRecipient,
  revokeRecipient,
} = await import("../servers/gateway/reports/approvals.js");
const { createReport, getReport, saveRecipe, updateReportColumns } = await import(
  "../servers/gateway/reports/store.js"
);
const { startRun, getRun } = await import("../servers/gateway/reports/run.js");
const { SEND_REASONS, sendReportMail } = await import("../servers/gateway/mail/reports-door.js");
const { createAccount, updateAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { writeClaim } = await import("../servers/gateway/mail/claims.js");
const { MAIL_ERROR_CODES, MailError } = await import("../servers/gateway/mail/errors.js");

const OWNER = Object.freeze({ kind: "owner" });
const BOT_ACTOR = Object.freeze({ kind: "bot" });
const SEED = Buffer.alloc(32, 7);
const T0 = 1_700_000_000_000;
const SECRET = "hunter2-not-a-real-password";

/** A block registry stub: this PR ships no blocks, only the two kinds the recipes name. */
const REGISTRY = Object.freeze({
  columns: { sourceBearing: false },
  mail_list: { sourceBearing: true },
});

const RECIPE = {
  blocks: [{ id: "b1", type: "columns", settings: { columns: ["subject"] } }],
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
let sendSeq = 0;

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

async function addSchedule(db, { cron = "0 7 * * 1", tz = "Europe/Berlin" } = {}) {
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', ?, ?)",
    args: [cron, tz],
  });
  const { rows } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  return Number(rows[0].id);
}

/** The fake adapter: every message the door builds lands in `calls`. */
function fakeAdapter(calls, { result, throws } = {}) {
  return {
    send: async (message) => {
      calls.push(message);
      if (throws) throw throws;
      return typeof result === "function" ? result(message) : result;
    },
  };
}

function doorDeps({ calls, adapter, claimed, secrets = [], withAdapter = true, over = {} } = {}) {
  const deps = {
    approvals: approvalsDeps(),
    adapterFor: withAdapter
      ? async (account, fn) => {
        calls.accounts.push(account.id);
        return fn(adapter);
      }
      : undefined,
    getSecrets: () => secrets,
    now: () => T0,
  };
  // Nothing injected means the real check: makeIsClaimedElsewhere against this run's instance id.
  if (claimed != null) deps.isClaimedElsewhere = claimed;
  return { ...deps, ...over };
}

function harness({ fake = {}, ...options } = {}) {
  const calls = { messages: [], accounts: [] };
  const adapter = fakeAdapter(calls.messages, fake);
  return { calls, adapter, deps: doorDeps({ calls, adapter, ...options }) };
}

/** A live report with a scheduled row, an active sender account and an owner manual run. */
async function world({ address = "reports@example.com", title = "Weekly listings" } = {}) {
  const db = await freshDb();
  const scheduleId = await addSchedule(db);
  const account = await createAccount(db, {
    address,
    label: "Reports",
    imap: { host: "imap.example.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.example.com", port: 465, security: "ssl" },
  });
  const { id } = await createReport(db, {
    projectId: 7, owner: "owner", botId: "bot-1", title,
  });
  const saved = await saveRecipe(db, {
    reportId: id, recipe: RECIPE, authorKind: "owner", registry: REGISTRY,
  });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: account.id,
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: 0,
  });
  const preview = {
    id: "prv-1", reportId: id, kind: "preview", status: "ok", recipeRev: saved.rev,
  };
  await approveGoLive(db, approvalsDeps({
    getRun: async (_db, runId) => (runId === "prv-1" ? preview : null),
  }), { reportId: id, previewRunId: "prv-1", actor: OWNER });
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId: id, trigger: "manual", requestedBy: "owner",
  });
  return { db, reportId: id, account, runId, preview };
}

async function recipientFor(db, reportId, { address = "alex@example.com", approve = true } = {}) {
  const proposed = await proposeRecipient(db, approvalsDeps(), {
    reportId, address, displayName: "Alex", proposedBy: "owner",
  });
  if (!approve) return proposed;
  return approveRecipient(db, approvalsDeps(), { recipientId: proposed.id, actor: OWNER });
}

/** One `pending` send row, the way PR 5's delivery will insert them. */
async function sendRow(db, {
  runId, reportId, recipientId, accountId = null, attempt = 1, status = "pending", claimToken = null,
}) {
  const id = `rsd-${(++sendSeq).toString(16).padStart(16, "0")}`;
  await db.execute({
    sql: `INSERT INTO report_sends
            (id, run_id, report_id, recipient_id, attempt, account_id, status, claim_token,
             gateway_run_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, runId, reportId, recipientId, attempt, accountId, status, claimToken,
      status === "sending" ? "b".repeat(32) : null, T0, T0,
    ],
  });
  return id;
}

async function rowOf(db, sendId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM report_sends WHERE id = ?", args: [sendId] });
  return rows[0];
}

async function recipientRow(db, recipientId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM report_recipients WHERE id = ?", args: [recipientId],
  });
  return rows[0];
}

/** A whole send, wired: a live world, one approved recipient, one pending row, one fake adapter. */
async function ready(options = {}) {
  const w = await world(options.world);
  const recipient = await recipientFor(w.db, w.reportId, options.recipient);
  const sends = await sendRow(w.db, {
    runId: w.runId,
    reportId: w.reportId,
    recipientId: recipient.id,
    accountId: w.account.id,
  });
  const h = harness({
    ...options,
    fake: {
      result: {
        messageId: "<provider-1@example.com>",
        accepted: [{ address: recipient.address }],
        rejected: [],
      },
      ...(options.fake ?? {}),
    },
  });
  return { ...w, recipient, sends, ...h };
}

const body = Object.freeze({ subject: "Your weekly listings", text: "Here is your report" });

/* --------------------------------------------------------- the row id, never an address */

test("the door takes a send row id, and refuses any other key", async () => {
  const { db, sends, deps, calls } = await ready();
  for (const key of ["to", "address", "cc", "bcc", "from"]) {
    await assert.rejects(
      () => sendReportMail(db, deps, { ...body, sendId: sends, [key]: "someone@example.com" }),
      (err) => {
        assert.equal(err.code, "bad_input", key);
        return true;
      },
      key,
    );
  }
  await assert.rejects(
    () => sendReportMail(db, deps, { ...body, sendId: sends, headers: { replyTo: "<x@y>" } }),
    { code: "bad_input" },
    "only inReplyTo and references",
  );
  await assert.rejects(() => sendReportMail(db, {}, { ...body }), { code: "bad_input" });
  await assert.rejects(
    () => sendReportMail(db, deps, { ...body, sendId: "rsd-ffffffffffffffff" }),
    { code: "not_found" },
  );
  assert.equal(calls.messages.length, 0, "nothing was sent");
  assert.equal((await rowOf(db, sends)).status, "pending", "and no row was touched");
});

/* ------------------------------------------------- the recipient's approval is re-checked */

test("a changed address fails the seal, so nothing is sent", async () => {
  const { db, recipient, sends, deps, calls } = await ready();
  await db.execute({
    sql: "UPDATE report_recipients SET address = ? WHERE id = ?",
    args: ["someone.else@example.com", recipient.id],
  });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "recipient_not_approved" });
  assert.equal(calls.messages.length, 0);
  const row = await rowOf(db, sends);
  assert.equal(row.status, "refused");
  assert.equal(row.reason, "recipient_not_approved");
});

test("a revoke that lands between the check and the claim sends nothing", async () => {
  const { db, recipient, sends, deps, calls } = await ready();
  // The run read is the await between the recipient check and the claim, so the revoke lands there.
  const revokingDeps = {
    ...deps,
    getRun: async (db2, runId) => {
      await revokeRecipient(db, approvalsDeps(), { recipientId: recipient.id, actor: OWNER });
      return getRun(db2, runId);
    },
  };

  assert.deepEqual(await sendReportMail(db, revokingDeps, { ...body, sendId: sends }),
    { status: "refused", reason: "recipient_not_approved" });
  assert.equal(calls.messages.length, 0, "the claim's own approval check stopped it");
  assert.equal((await rowOf(db, sends)).status, "refused");
  assert.equal((await recipientRow(db, recipient.id)).state, "revoked");
});

test("a revoked recipient whose state was set back to approved still never sends", async () => {
  const { db, recipient, sends, deps, calls } = await ready();
  await revokeRecipient(db, approvalsDeps(), { recipientId: recipient.id, actor: OWNER });
  const stored = await recipientRow(db, recipient.id);
  assert.equal(stored.approval_seal, null);
  assert.equal(stored.approval_nonce, null);
  await db.execute({
    sql: "UPDATE report_recipients SET state = 'approved' WHERE id = ?", args: [recipient.id],
  });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "recipient_not_approved" });
  assert.equal(calls.messages.length, 0);
});

test("a proposed recipient is never sent to", async () => {
  const { db, reportId, runId, account } = await world();
  const proposed = await recipientFor(db, reportId, { approve: false });
  assert.equal(proposed.state, "proposed");
  const sends = await sendRow(db, {
    runId, reportId, recipientId: proposed.id, accountId: account.id,
  });
  const { calls, deps } = harness();
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "recipient_not_approved" });
  assert.equal(calls.messages.length, 0);
});

/* ------------------------------------------------------------------------ the live gate */

test("a paused report refuses not_live", async () => {
  const { db, reportId, sends, deps, calls } = await ready();
  await pauseReport(db, approvalsDeps(), { reportId, reason: "Paused by hand", actor: OWNER });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "not_live" });
  assert.equal(calls.messages.length, 0);
  assert.equal((await rowOf(db, sends)).status, "refused");
});

test("a preview run never sends", async () => {
  const { db, reportId, account } = await world();
  const recipient = await recipientFor(db, reportId);
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "preview", requestedBy: "owner",
  });
  const sends = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, accountId: account.id,
  });
  const { calls, deps } = harness();
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "not_live" });
  assert.equal(calls.messages.length, 0);
});

test("a bot-requested manual run never sends", async () => {
  const { db, reportId, account } = await world();
  const recipient = await recipientFor(db, reportId);
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "manual", requestedBy: "bot:bot-1",
  });
  const sends = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, accountId: account.id,
  });
  const { calls, deps } = harness();
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "not_live" });
  assert.equal(calls.messages.length, 0);
});

test("a scheduled run of a live report sends", async () => {
  const { db, reportId, account } = await world();
  const recipient = await recipientFor(db, reportId);
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId, trigger: "schedule", requestedBy: "schedule", scheduledFor: T0,
  });
  const sends = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, accountId: account.id,
  });
  const { calls, deps } = harness();
  const out = await sendReportMail(db, deps, { ...body, sendId: sends });
  assert.equal(out.status, "sent");
  assert.equal(calls.messages.length, 1);
});

/* ------------------------------------------------------------------- the sender account */

test("a sender in auth_failed is refused sender_unavailable", async () => {
  const { db, account, sends, deps, calls } = await ready();
  await updateAccount(db, account.id, { status: "auth_failed" });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "failed", reason: "sender_unavailable" });
  assert.equal(calls.messages.length, 0);
  assert.equal((await rowOf(db, sends)).status, "failed");
});

test("a sender already connected on another instance is refused claimed_elsewhere", async () => {
  const { db, account, sends } = await ready();
  await db.execute({
    sql: `INSERT INTO crow_instances (id, name, crow_id, status)
          VALUES ('other', 'second crow', 'crow-other', 'active')`,
    args: [],
  });
  await writeClaim(db, account.address, { localInstanceId: "other", instanceName: "second crow" });

  const { calls, deps } = harness({ over: { localInstanceId: "local-test" } });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "failed", reason: "claimed_elsewhere" });
  assert.equal(calls.messages.length, 0);
  assert.equal((await rowOf(db, sends)).status, "failed");
});

test("a send row naming another account is refused sender_unavailable", async () => {
  const { db, account, reportId, recipient, runId, deps, calls } = await ready();
  const other = await createAccount(db, {
    address: "other@example.com",
    label: "Other",
    imap: { host: "imap.example.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.example.com", port: 465, security: "ssl" },
  });
  assert.notEqual(other.id, account.id);
  const sends = await sendRow(db, {
    runId, reportId, recipientId: recipient.id, accountId: other.id, attempt: 2,
  });

  // Only the report's sealed sender may send: a row that names another account is not it.
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "failed", reason: "sender_unavailable" });
  assert.equal(calls.messages.length, 0);
  assert.equal((await rowOf(db, sends)).status, "failed");
  assert.deepEqual(calls.accounts, [], "no account was opened for a row that names its own sender");
});

test("a door with no adapter refuses no_adapter and claims nothing", async () => {
  const { db, sends, calls } = await ready();
  const deps = doorDeps({ calls, withAdapter: false });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "failed", reason: "no_adapter" });
  const row = await rowOf(db, sends);
  assert.equal(row.status, "failed");
  assert.equal(row.claim_token, null);
});

/* --------------------------------------------------------------------------- the cap */

test("the day's email cap refuses the send past it, and the claim is what counts", async () => {
  const { db, reportId, account, sends, recipient, deps, calls } = await ready();
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value)
          VALUES ('reports.max_emails_per_report_day', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [],
  });
  const first = await sendReportMail(db, deps, { ...body, sendId: sends });
  assert.equal(first.status, "sent");

  const second = await sendRow(db, {
    runId: (await rowOf(db, sends)).run_id,
    reportId,
    recipientId: recipient.id,
    accountId: account.id,
    attempt: 2,
  });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: second }),
    { status: "refused", reason: "cap_reached" });
  assert.equal(calls.messages.length, 1, "only the first send reached the adapter");
  const { rows } = await db.execute({
    sql: "SELECT emails FROM report_usage WHERE report_id = ?", args: [reportId],
  });
  assert.equal(Number(rows[0].emails), 1, "one counted send");
});

/* ------------------------------------------------------------------------ the claim */

test("two concurrent rows under a cap of one make one adapter call", async () => {
  const { db, reportId, account, sends, runId, deps, calls } = await ready();
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value)
          VALUES ('reports.max_emails_per_report_day', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [],
  });
  const second = await recipientFor(db, reportId, { address: "second@example.com" });
  const secondSend = await sendRow(db, {
    runId, reportId, recipientId: second.id, accountId: account.id,
  });

  const [a, b] = await Promise.all([
    sendReportMail(db, deps, { ...body, sendId: sends }),
    sendReportMail(db, deps, { ...body, sendId: secondSend }),
  ]);
  assert.equal(calls.messages.length, 1, "one adapter call: the cap is claimed atomically");
  assert.deepEqual([a.status, b.status].sort(), ["refused", "sent"]);
  const refused = a.status === "refused" ? a : b;
  assert.equal(refused.reason, "cap_reached");
  const { rows } = await db.execute({
    sql: "SELECT emails FROM report_usage WHERE report_id = ?", args: [reportId],
  });
  assert.equal(Number(rows[0].emails), 1, "one counted send, not two");
});

test("two concurrent sends of one row make one adapter call", async () => {
  const { db, sends, deps, calls } = await ready();
  const [a, b] = await Promise.all([
    sendReportMail(db, deps, { ...body, sendId: sends }),
    sendReportMail(db, deps, { ...body, sendId: sends }),
  ]);
  assert.equal(calls.messages.length, 1, "one adapter call");
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["refused", "sent"]);
  const loser = a.status === "refused" ? a : b;
  assert.equal(loser.reason, "not_pending");
  const row = await rowOf(db, sends);
  assert.equal(row.status, "sent");
  assert.ok(row.claim_token, "the winning claim token is on the row");
});

test("a row left sending is never re-claimed", async () => {
  const { db, sends, deps, calls } = await ready();
  await db.execute({
    sql: `UPDATE report_sends SET status = 'sending', claim_token = ? WHERE id = ?`,
    args: ["c".repeat(32), sends],
  });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "not_pending" });
  assert.equal(calls.messages.length, 0, "a sending row is never handed to an adapter again");
  const row = await rowOf(db, sends);
  assert.equal(row.status, "sending", "and it is left exactly as it was");
  assert.equal(row.claim_token, "c".repeat(32));
});

test("a row left unknown is never settled by a later call", async () => {
  const { db, sends, deps, calls } = await ready();
  await db.execute({ sql: "UPDATE report_sends SET status = 'unknown' WHERE id = ?", args: [sends] });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "refused", reason: "not_pending" });
  assert.equal(calls.messages.length, 0);
  assert.equal((await rowOf(db, sends)).status, "unknown");
});

/* ---------------------------------------------------------------------- the message */

test("one message per recipient: the row's address, no cc, no bcc, a fresh Message-ID", async () => {
  const { db, account, recipient, sends, deps, calls } = await ready();
  const out = await sendReportMail(db, deps, { ...body, sendId: sends });
  assert.equal(out.status, "sent");
  assert.equal(calls.messages.length, 1);

  const message = calls.messages[0];
  assert.equal(message.to.length, 1);
  assert.equal(message.to[0].address, recipient.address);
  assert.deepEqual(message.cc, []);
  assert.deepEqual(message.bcc, []);
  assert.equal(message.from.address, account.address);
  assert.equal(message.from.name, "Weekly listings");
  assert.deepEqual(calls.accounts, [account.id], "the sender's own account reached adapterFor");
  assert.equal(message.subject, body.subject);
  assert.equal(message.text, body.text);

  const row = await rowOf(db, sends);
  assert.equal(row.status, "sent");
  assert.match(row.message_id, /^<[0-9a-f]{32}@example\.com>$/);
  const local = row.message_id.slice(1, row.message_id.indexOf("@"));
  assert.ok(local.length * 4 >= 128, "at least 128 bits of Message-ID");
  assert.equal(row.provider_message_id, "<provider-1@example.com>");
  assert.equal(row.reason, null);
});

test("a title carrying a header line never reaches the From header", async () => {
  const { db, reportId, sends, deps, calls } = await ready();
  await db.execute({
    sql: "UPDATE reports SET title = ? WHERE id = ?",
    args: ["Weekly\r\nBcc: someone@example.com", reportId],
  });
  assert.equal((await sendReportMail(db, deps, { ...body, sendId: sends })).status, "sent");
  const name = calls.messages[0].from.name;
  assert.ok(!/[\r\n]/.test(name), "no CR or LF in the display name");
  assert.ok(name.length <= 80);
});

test("a long subject is bounded before it becomes a header", async () => {
  const { db, sends, deps, calls } = await ready();
  const subject = "S".repeat(400);
  assert.equal((await sendReportMail(db, deps, { ...body, subject, sendId: sends })).status, "sent");
  assert.equal(calls.messages[0].subject.length, 200);
});

/* ------------------------------------------------------------------ the outcome mapping */

test("every mail error code maps the way the send service maps it", async () => {
  const expected = {
    AUTH_FAILED: { status: "failed", reason: "auth_failed" },
    TLS: { status: "failed", reason: "tls" },
    BAD_INPUT: { status: "failed", reason: "bad_input" },
    TOO_LARGE: { status: "failed", reason: "too_large" },
    NOT_FOUND: { status: "failed", reason: "not_found" },
    CLAIMED_ELSEWHERE: { status: "failed", reason: "claimed_elsewhere" },
    CHANGED: { status: "failed", reason: "changed" },
    NETWORK: { status: "unknown", reason: "network" },
    TIMEOUT: { status: "unknown", reason: "timeout" },
    PROTOCOL: { status: "unknown", reason: "protocol" },
  };
  assert.deepEqual(Object.keys(expected).sort(), [...MAIL_ERROR_CODES].sort(),
    "every code in the vocabulary is mapped");

  const { db, reportId, account, recipient, sends } = await ready();
  const runId = (await rowOf(db, sends)).run_id;
  let attempt = 0;
  for (const code of MAIL_ERROR_CODES) {
    attempt += 1;
    const id = await sendRow(db, {
      runId, reportId, recipientId: recipient.id, accountId: account.id, attempt: attempt + 1,
    });
    const { calls, deps } = harness({ fake: { throws: new MailError(code) } });
    const out = await sendReportMail(db, deps, { ...body, sendId: id });
    assert.deepEqual({ status: out.status, reason: out.reason }, expected[code], code);
    assert.equal(calls.messages.length, 1, `${code}: one adapter call`);
    const row = await rowOf(db, id);
    assert.equal(row.status, expected[code].status, `${code}: the row`);
    assert.equal(row.reason, expected[code].reason, `${code}: the stored reason`);
  }
});

test("an adapter failure outside the vocabulary still settles unknown, never sent", async () => {
  const { db, sends, deps, calls } = await ready({
    fake: { throws: Object.assign(new Error("something odd"), { code: "EWEIRD" }) },
  });
  const out = await sendReportMail(db, deps, { ...body, sendId: sends });
  assert.equal(calls.messages.length, 1);
  assert.equal(out.status, "unknown");
  assert.equal(out.reason, "protocol", "an unclassifiable failure is not a completed send either way");
  assert.equal((await rowOf(db, sends)).status, "unknown");
});

test("an adapter that accepts nobody settles failed, not sent", async () => {
  const { db, sends, deps } = await ready({
    fake: { result: { messageId: "<prov-2@example.com>", accepted: [], rejected: ["x"] } },
  });
  const out = await sendReportMail(db, deps, { ...body, sendId: sends });
  assert.deepEqual(out, { status: "failed", reason: "all_rejected" });
  assert.equal((await rowOf(db, sends)).status, "failed");
});

test("an adapter error's own text never reaches the stored reason", async () => {
  const secretError = new MailError("AUTH_FAILED");
  secretError.message = `login refused for the account with ${SECRET}`;
  const { db, sends, deps, calls } = await ready({
    fake: { throws: secretError },
  });
  const out = await sendReportMail(db, deps, {
    ...body, sendId: sends,
  });
  assert.equal(calls.messages.length, 1);
  assert.equal(out.status, "failed");
  assert.ok(SEND_REASONS.includes(out.reason), `${out.reason} is one of the reason codes`);
  const row = await rowOf(db, sends);
  assert.ok(!String(row.reason).includes(SECRET), "no secret in the stored reason");
  assert.ok(!String(row.reason).includes("login refused"), "no adapter text in the stored reason");
});

/* ---------------------------------------------------------------------------- leftovers */

test("an account's own status is read, and a removed account sends nothing", async () => {
  const { db, sends, deps, calls } = await ready();
  await db.execute({ sql: "DELETE FROM mail_accounts WHERE id = (SELECT account_id FROM report_sends WHERE id = ?)", args: [sends] });
  assert.deepEqual(await sendReportMail(db, deps, { ...body, sendId: sends }),
    { status: "failed", reason: "sender_unavailable" });
  assert.equal(calls.messages.length, 0);
});

test("a refusal never counts toward the cap", async () => {
  const { db, reportId, sends, deps } = await ready();
  await refuseRecipient(db, approvalsDeps(), {
    recipientId: (await listRecipients(db, reportId))[0].id, actor: OWNER,
  });
  assert.equal((await sendReportMail(db, deps, { ...body, sendId: sends })).status, "refused");
  const { rows } = await db.execute({
    sql: "SELECT emails FROM report_usage WHERE report_id = ?", args: [reportId],
  });
  assert.equal(rows.length, 0, "no usage row for a refusal");
  assert.equal((await getReport(db, reportId)).status, "live", "the report is untouched");
  assert.ok(!("seal" in (await listRecipients(db, reportId))[0]), "the list never carries a seal");
});

test("a bot cannot approve, so an untouched proposal is never sent to", async () => {
  const { db, reportId } = await world();
  const proposed = await proposeRecipient(db, approvalsDeps(), {
    reportId, address: "alex@example.com", proposedBy: "bot:bot-1",
  });
  await assert.rejects(
    () => approveRecipient(db, approvalsDeps(), { recipientId: proposed.id, actor: BOT_ACTOR }),
    { code: "owner_only" },
  );
  const stored = await recipientRow(db, proposed.id);
  assert.equal(stored.state, "proposed");
  assert.equal(stored.approval_seal, null);
});