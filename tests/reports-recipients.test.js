// Crow Recurring Reports' recipients: propose, approve, refuse, revoke, list, and the seal check.
//
// Harness: a real init-db'd scratch crow.db, copied per test (CROW_DATA_DIR under a temp dir, so
// nothing can touch a real Crow data dir), real report rows, and a fixed keychain seed injected through
// `deps.loadSeed`. The rows are read back raw where the test is about what a column holds (a NULL seal,
// a stored nonce) and through the module's own reader where it is about what a page sees.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-recipients-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const {
  RECIPIENT_STATES, approveGoLive, approveRecipient, isLive, listRecipients, proposeRecipient,
  refuseRecipient, revokeRecipient, verifyRecipient,
} = await import("../servers/gateway/reports/approvals.js");
const { createReport, getReport, saveRecipe, updateReportColumns } = await import(
  "../servers/gateway/reports/store.js"
);

const OWNER = Object.freeze({ kind: "owner" });
const BOT_ACTOR = Object.freeze({ kind: "bot" });
const SEED = Buffer.alloc(32, 11);
const T0 = 1_700_000_000_000;

const REGISTRY = Object.freeze({ columns: { sourceBearing: false } });
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

async function freshDb() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  const db = createDbClient(crow);
  open.push(db);
  return db;
}

function deps(over = {}) {
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

/** One report, saved once at rev 1. With `live` it is also approved through the real go-live. */
async function makeReport(db, { live = false, title = "Weekly listings" } = {}) {
  const scheduleId = await addSchedule(db);
  const { id } = await createReport(db, {
    projectId: 7, owner: "owner", botId: "bot-1", title,
  });
  const saved = await saveRecipe(db, {
    reportId: id, recipe: RECIPE, authorKind: "owner", registry: REGISTRY,
  });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: "ma-0011223344556677",
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: 0,
  });
  if (live) {
    const preview = { id: "prv-1", reportId: id, kind: "preview", status: "ok", recipeRev: saved.rev };
    await approveGoLive(db, deps({
      getRun: async (_db, runId) => (runId === "prv-1" ? preview : null),
    }), { reportId: id, previewRunId: "prv-1", actor: OWNER });
  }
  return { id, rev: saved.rev };
}

async function storedRow(db, recipientId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM report_recipients WHERE id = ?", args: [recipientId],
  });
  return rows[0];
}

async function auditRows(db, reportId) {
  const { rows } = await db.execute({
    sql: `SELECT kind, subject, actor, decided FROM report_approvals_audit
           WHERE report_id = ? ORDER BY id`,
    args: [reportId],
  });
  return rows;
}

async function propose(db, reportId, over = {}) {
  return proposeRecipient(db, deps(), {
    reportId, address: "alex@example.com", displayName: "Alex", proposedBy: "owner", ...over,
  });
}

async function approved(db, reportId, over = {}) {
  const row = await propose(db, reportId, over);
  return approveRecipient(db, deps(), { recipientId: row.id, actor: OWNER });
}

/* --------------------------------------------------------------- the state machine */

test("propose then approve: the row is approved, sealed, and verifies", async () => {
  const db = await freshDb();
  const report = await makeReport(db);

  const proposed = await propose(db, report.id);
  assert.match(proposed.id, /^rrc-[0-9a-f]{16}$/);
  assert.equal(proposed.reportId, report.id);
  assert.equal(proposed.address, "alex@example.com");
  assert.equal(proposed.state, "proposed");
  assert.equal(proposed.proposedBy, "owner");
  assert.equal(proposed.approvedAt, null);
  assert.equal(proposed.createdAt, T0);
  assert.ok(!("seal" in proposed) && !("approvalSeal" in proposed), "the seal is not in the answer");
  assert.equal(await verifyRecipient(db, deps(), await storedRow(db, proposed.id)), false,
    "a proposal is not an approval");

  const approvedRow = await approveRecipient(db, deps(), { recipientId: proposed.id, actor: OWNER });
  assert.equal(approvedRow.state, "approved");
  assert.equal(approvedRow.approvedAt, T0);
  const stored = await storedRow(db, proposed.id);
  assert.match(stored.approval_nonce, /^[0-9a-f]{32}$/);
  assert.match(stored.approval_seal, /^[0-9a-f]{64}$/);
  assert.equal(await verifyRecipient(db, deps(), stored), true);

  assert.deepEqual(await auditRows(db, report.id), [
    { kind: "recipient", subject: proposed.id, actor: "owner", decided: "approved" },
  ]);
});

test("refuse and revoke both NULL the seal and the nonce, and write their own audit word", async () => {
  const db = await freshDb();
  const report = await makeReport(db);

  const refusedRow = await approved(db, report.id);
  assert.ok((await storedRow(db, refusedRow.id)).approval_seal, "approved first");
  const refused = await refuseRecipient(db, deps(), { recipientId: refusedRow.id, actor: OWNER });
  assert.equal(refused.state, "refused");
  assert.equal(refused.approvedAt, null);
  const afterRefuse = await storedRow(db, refusedRow.id);
  assert.equal(afterRefuse.approval_seal, null);
  assert.equal(afterRefuse.approval_nonce, null);
  assert.equal(await verifyRecipient(db, deps(), afterRefuse), false);

  const revokedRow = await approved(db, report.id, { address: "second@example.com" });
  const revoked = await revokeRecipient(db, deps(), { recipientId: revokedRow.id, actor: OWNER });
  assert.equal(revoked.state, "revoked");
  const afterRevoke = await storedRow(db, revokedRow.id);
  assert.equal(afterRevoke.approval_seal, null);
  assert.equal(afterRevoke.approval_nonce, null);
  assert.equal(await verifyRecipient(db, deps(), afterRevoke), false);

  assert.deepEqual((await auditRows(db, report.id)).filter((r) => r.decided !== "approved"
    || r.kind === "recipient"), [
    { kind: "recipient", subject: refusedRow.id, actor: "owner", decided: "approved" },
    { kind: "recipient", subject: refusedRow.id, actor: "owner", decided: "refused" },
    { kind: "recipient", subject: revokedRow.id, actor: "owner", decided: "approved" },
    { kind: "recipient", subject: revokedRow.id, actor: "owner", decided: "revoked" },
  ]);
});

test("approve, refuse and revoke are owner-only", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const proposed = await propose(db, report.id);

  for (const actor of [BOT_ACTOR, undefined, null, { kind: "system" }, "owner"]) {
    await assert.rejects(
      () => approveRecipient(db, deps(), { recipientId: proposed.id, actor }),
      { code: "owner_only" },
      String(actor),
    );
    await assert.rejects(
      () => refuseRecipient(db, deps(), { recipientId: proposed.id, actor }),
      { code: "owner_only" },
    );
    await assert.rejects(
      () => revokeRecipient(db, deps(), { recipientId: proposed.id, actor }),
      { code: "owner_only" },
    );
  }
  const stored = await storedRow(db, proposed.id);
  assert.equal(stored.state, "proposed", "nothing was written");
  assert.deepEqual(await auditRows(db, report.id), []);
});

test("a re-propose after a refusal goes back to proposed and needs a fresh approval", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const first = await approved(db, report.id);
  const firstSeal = (await storedRow(db, first.id)).approval_seal;

  await refuseRecipient(db, deps(), { recipientId: first.id, actor: OWNER });
  const again = await propose(db, report.id, { displayName: "Alex again" });
  assert.equal(again.id, first.id, "the same person is the same row");
  assert.equal(again.state, "proposed");
  assert.equal(again.displayName, "Alex again");
  const afterRepropose = await storedRow(db, first.id);
  assert.equal(afterRepropose.approval_seal, null);
  assert.equal(afterRepropose.approval_nonce, null);
  assert.equal(await verifyRecipient(db, deps(), afterRepropose), false);

  const reapproved = await approveRecipient(db, deps(), { recipientId: first.id, actor: OWNER });
  assert.equal(reapproved.state, "approved");
  const fresh = await storedRow(db, first.id);
  assert.ok(fresh.approval_seal, "a fresh seal");
  assert.notEqual(fresh.approval_seal, firstSeal, "never the refused one");
  assert.equal(await verifyRecipient(db, deps(), fresh), true);
});

test("a revoked row proposed again loses its approval the same way", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const first = await approved(db, report.id);
  await revokeRecipient(db, deps(), { recipientId: first.id, actor: OWNER });
  const again = await propose(db, report.id);
  assert.equal(again.state, "proposed");
  assert.equal(again.id, first.id);
  assert.equal(await verifyRecipient(db, deps(), await storedRow(db, first.id)), false);
});

test("a bot-proposed recipient is not approved until the owner approves it", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const proposed = await propose(db, report.id, { proposedBy: "bot:bot-1" });
  assert.equal(proposed.proposedBy, "bot:bot-1");
  assert.equal(proposed.state, "proposed");
  assert.equal(await verifyRecipient(db, deps(), await storedRow(db, proposed.id)), false);

  const approvedRow = await approveRecipient(db, deps(), { recipientId: proposed.id, actor: OWNER });
  assert.equal(approvedRow.state, "approved");
  assert.equal(approvedRow.proposedBy, "bot:bot-1", "the approval does not rewrite who proposed it");
  assert.equal(await verifyRecipient(db, deps(), await storedRow(db, proposed.id)), true);
});

test("a second approve of an already-approved row is not a second approval", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const first = await approved(db, report.id);
  const seal = (await storedRow(db, first.id)).approval_seal;
  const second = await approveRecipient(db, deps(), { recipientId: first.id, actor: OWNER });
  assert.equal(second.state, "approved");
  assert.equal((await storedRow(db, first.id)).approval_seal, seal, "the seal is untouched");
  assert.equal((await auditRows(db, report.id)).length, 1, "one audit row, one approval");
});

/* --------------------------------------------------------- the owner's add over a bot's proposal */

test("an owner add over a bot's proposal takes the owner's name and tier, and the seal covers them", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const botProposal = await propose(db, report.id, {
    proposedBy: "bot:bot-1", commentTier: "a", displayName: "Bot's name",
  });
  assert.equal(botProposal.state, "proposed");

  // The owner route's exact pair: propose as the owner, then approve.
  const ownerProposal = await propose(db, report.id, {
    proposedBy: "owner", commentTier: "c", displayName: "Owner's name",
  });
  assert.equal(ownerProposal.id, botProposal.id, "the same person is the same row");
  assert.equal(ownerProposal.commentTier, "c", "the owner's tier replaced the bot's");
  assert.equal(ownerProposal.displayName, "Owner's name");
  assert.equal(ownerProposal.proposedBy, "owner");
  assert.equal(ownerProposal.state, "proposed");

  const approvedRow = await approveRecipient(db, deps(), { recipientId: ownerProposal.id, actor: OWNER });
  assert.equal(approvedRow.commentTier, "c");
  const stored = await storedRow(db, ownerProposal.id);
  assert.equal(stored.comment_tier, "c");
  assert.equal(stored.display_name, "Owner's name");
  assert.equal(stored.proposed_by, "owner");
  assert.equal(await verifyRecipient(db, deps(), stored), true);

  // The seal is over the owner's tier: putting the bot's tier back breaks it.
  await db.execute({
    sql: "UPDATE report_recipients SET comment_tier = 'a' WHERE id = ?", args: [stored.id],
  });
  assert.equal(await verifyRecipient(db, deps(), await storedRow(db, stored.id)), false);
});

test("an owner add of an approved address with a new tier or name re-seals it over the owner's values", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const first = await approved(db, report.id, { commentTier: "a", displayName: "Alex" });
  const before = await storedRow(db, first.id);

  const again = await propose(db, report.id, { commentTier: "c", displayName: "Alex again" });
  assert.equal(again.id, first.id);
  assert.equal(again.state, "approved", "still the owner's approval");
  assert.equal(again.commentTier, "c");
  assert.equal(again.displayName, "Alex again");

  const after = await storedRow(db, first.id);
  assert.notEqual(after.approval_seal, before.approval_seal, "a fresh seal over the new values");
  assert.notEqual(after.approval_nonce, before.approval_nonce, "and a fresh nonce");
  assert.equal(after.comment_tier, "c");
  assert.equal(after.display_name, "Alex again");
  assert.equal(await verifyRecipient(db, deps(), after), true);

  const decisions = (await auditRows(db, report.id))
    .filter((row) => row.kind === "recipient")
    .map((row) => row.decided);
  assert.deepEqual(decisions, ["approved", "approved"], "the re-seal is audited as an approval");

  // The same values again change nothing: one seal, one more step.
  const same = await propose(db, report.id, { commentTier: "c", displayName: "Alex again" });
  assert.equal(same.state, "approved");
  assert.equal((await storedRow(db, first.id)).approval_seal, after.approval_seal);
});

test("a bot's proposal never rewrites an owner-proposed row and never moves an approved one", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const ownerProposal = await propose(db, report.id, { commentTier: "c", displayName: "Alex" });

  const botAgain = await propose(db, report.id, {
    proposedBy: "bot:bot-1", commentTier: "a", displayName: "Bot's pick",
  });
  assert.equal(botAgain.id, ownerProposal.id);
  assert.equal(botAgain.state, "proposed");
  assert.equal(botAgain.commentTier, "c", "the owner's tier stands");
  assert.equal(botAgain.displayName, "Alex");
  assert.equal(botAgain.proposedBy, "owner", "the owner's proposal is not relabelled");

  const approvedRow = await approveRecipient(db, deps(), { recipientId: ownerProposal.id, actor: OWNER });
  const seal = (await storedRow(db, approvedRow.id)).approval_seal;
  const botOnApproved = await propose(db, report.id, {
    proposedBy: "bot:bot-1", commentTier: "a", displayName: "Bot's pick",
  });
  assert.equal(botOnApproved.state, "approved", "a bot never un-approves a row");
  assert.equal(botOnApproved.commentTier, "c");
  assert.equal(botOnApproved.displayName, "Alex");
  const stored = await storedRow(db, approvedRow.id);
  assert.equal(stored.approval_seal, seal, "and never re-seals it");
  assert.equal(await verifyRecipient(db, deps(), stored), true);
});

/* ------------------------------------------------------ a decision that lands under another one */

/** A db whose read of the report row runs `during` first: the interleave point between read and write. */
function dbThatActsOnReportRead(db, during) {
  let fired = false;
  return {
    async execute(arg) {
      const sql = String(arg?.sql ?? "");
      if (!fired && /\bFROM reports\b/.test(sql)) {
        fired = true;
        await during();
      }
      return db.execute(arg);
    },
  };
}

test("an approve whose row was revoked mid-call is recipient_changed, not an approval", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const proposed = await propose(db, report.id);
  let revoked = false;

  await assert.rejects(
    () => approveRecipient(db, deps({
      // The seed read is the await between the row read and the guarded write.
      loadSeed: async () => {
        if (!revoked) {
          revoked = true;
          await revokeRecipient(db, deps(), { recipientId: proposed.id, actor: OWNER });
        }
        return { seed: SEED };
      },
    }), { recipientId: proposed.id, actor: OWNER }),
    { code: "recipient_changed" },
  );

  const stored = await storedRow(db, proposed.id);
  assert.equal(stored.state, "revoked", "the other decision stands");
  assert.equal(stored.approval_seal, null);
  assert.deepEqual((await auditRows(db, report.id)).map((row) => row.decided), ["revoked"],
    "no approval was audited");
});

test("a refuse whose row was revoked mid-call is recipient_changed, not a refusal", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const approvedRow = await approved(db, report.id);
  const interleaved = dbThatActsOnReportRead(db, async () => {
    await revokeRecipient(db, deps(), { recipientId: approvedRow.id, actor: OWNER });
  });

  await assert.rejects(
    () => refuseRecipient(interleaved, deps(), { recipientId: approvedRow.id, actor: OWNER }),
    { code: "recipient_changed" },
  );
  const stored = await storedRow(db, approvedRow.id);
  assert.equal(stored.state, "revoked");
  assert.deepEqual((await auditRows(db, report.id)).map((row) => row.decided), ["approved", "revoked"]);
});

/* ----------------------------------------------------------- addresses and the unique row */

test("addresses are lower-cased and trimmed, and one person is one row per report", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const other = await makeReport(db);

  const first = await propose(db, report.id, { address: "  Alex@Example.COM " });
  assert.equal(first.address, "alex@example.com");
  assert.equal(first.displayName, "Alex");

  const again = await propose(db, report.id, { address: "ALEX@example.com" });
  assert.equal(again.id, first.id, "the same row");
  const { rows } = await db.execute({
    sql: "SELECT count(*) AS n FROM report_recipients WHERE report_id = ?", args: [report.id],
  });
  assert.equal(Number(rows[0].n), 1, "one row per person per report");

  const elsewhere = await propose(db, other.id, { address: "alex@example.com" });
  assert.notEqual(elsewhere.id, first.id, "another report has its own row");
  assert.equal(elsewhere.address, "alex@example.com");
});

test("a malformed address, tier or proposer is bad_input and writes nothing", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const bad = [
    "not-an-address", "a@b", "@example.com", "alex@", "a b@example.com", "alex@exa mple.com",
    "Alex <alex@example.com>", "alex@example.com, other@example.com", "a@b@example.com",
    "alex@example.com\r\nBcc: x@example.com", "", 7, null,
  ];
  for (const address of bad) {
    await assert.rejects(
      () => propose(db, report.id, { address }),
      { code: "bad_input" },
      String(address),
    );
  }
  for (const commentTier of ["d", "A", 1, true]) {
    await assert.rejects(
      () => propose(db, report.id, { commentTier }),
      { code: "bad_input" },
      String(commentTier),
    );
  }
  for (const proposedBy of ["bot1", "bot:", "", "owner ", 3]) {
    await assert.rejects(
      () => propose(db, report.id, { proposedBy }),
      { code: "bad_input" },
      String(proposedBy),
    );
  }
  await assert.rejects(
    () => propose(db, "rpt-ffffffffffffffff"),
    { code: "not_found" },
  );
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM report_recipients", args: [] });
  assert.equal(Number(rows[0].n), 0, "nothing was written");
});

test("a null tier and an empty tier both mean the report's default, and the seal covers the tier", async () => {
  const db = await freshDb();
  const report = await makeReport(db);

  const withNull = await approved(db, report.id, { commentTier: null });
  assert.equal(withNull.commentTier, null);
  const blank = await approved(db, report.id, { address: "blank@example.com", commentTier: "" });
  assert.equal(blank.commentTier, null);
  const tiered = await approved(db, report.id, { address: "tiered@example.com", commentTier: "a" });
  assert.equal(tiered.commentTier, "a");

  for (const row of [withNull, blank, tiered]) {
    assert.equal(await verifyRecipient(db, deps(), await storedRow(db, row.id)), true);
  }
  // A direct UPDATE of the tier is not the tier the owner approved.
  await db.execute({
    sql: "UPDATE report_recipients SET comment_tier = 'b' WHERE id = ?", args: [tiered.id],
  });
  assert.equal(await verifyRecipient(db, deps(), await storedRow(db, tiered.id)), false);
});

test("a display name loses its control characters and is bounded", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const named = await propose(db, report.id, {
    displayName: "Alex\r\nBcc: someone@example.com\t\r\n",
  });
  assert.ok(!/[\r\n\t]/.test(named.displayName), named.displayName);
  const long = await propose(db, report.id, { address: "long@example.com", displayName: "x".repeat(400) });
  assert.equal(long.displayName.length, 120);
});

/* ------------------------------------------------------------------------- the reader */

test("listRecipients is oldest first and never carries a seal or a nonce", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  // A clock that moves once per call, so "oldest first" has something to order by.
  let t = T0;
  const tick = () => { t += 1; return t; };
  const dp = () => deps({ now: tick });
  const firstProposed = await proposeRecipient(db, dp(), {
    reportId: report.id, address: "alex@example.com", proposedBy: "owner",
  });
  const first = await approveRecipient(db, dp(), { recipientId: firstProposed.id, actor: OWNER });
  const secondProposed = await proposeRecipient(db, dp(), {
    reportId: report.id, address: "b@example.com", proposedBy: "owner",
  });
  await refuseRecipient(db, dp(), { recipientId: secondProposed.id, actor: OWNER });
  const thirdProposed = await proposeRecipient(db, dp(), {
    reportId: report.id, address: "c@example.com", proposedBy: "owner",
  });
  const third = await approveRecipient(db, dp(), { recipientId: thirdProposed.id, actor: OWNER });

  const list = await listRecipients(db, report.id, deps());
  assert.deepEqual(list.map((r) => r.id), [first.id, secondProposed.id, third.id]);
  assert.deepEqual(list.map((r) => r.state), ["approved", "refused", "approved"]);
  assert.deepEqual(list.map((r) => r.verified), [true, false, true],
    "verified is the seal check, never the state word alone");
  for (const row of list) {
    assert.ok(!Object.hasOwn(row, "approval_seal"));
    assert.ok(!Object.hasOwn(row, "approval_nonce"));
    assert.ok(!Object.hasOwn(row, "approvalSeal"));
  }
  assert.deepEqual(RECIPIENT_STATES, ["proposed", "approved", "refused", "revoked"]);
  await assert.rejects(() => listRecipients(db, ""), { code: "bad_input" });
  await assert.rejects(
    () => approveRecipient(db, deps(), { recipientId: "rrc-ffffffffffffffff", actor: OWNER }),
    { code: "not_found" },
  );
  await assert.rejects(
    () => refuseRecipient(db, deps(), { recipientId: "", actor: OWNER }),
    { code: "bad_input" },
  );
});

test("adding, approving, refusing and revoking never change the report", async () => {
  const db = await freshDb();
  const report = await makeReport(db, { live: true });
  const before = await getReport(db, report.id);
  assert.equal(before.status, "live");
  assert.equal(await isLive(db, deps(), before), true);

  const row = await approved(db, report.id);
  assert.equal(await isLive(db, deps(), await getReport(db, report.id)), true);
  await refuseRecipient(db, deps(), { recipientId: row.id, actor: OWNER });
  const after = await getReport(db, report.id);
  assert.equal(after.status, "live");
  assert.equal(after.live_seal, before.live_seal, "the live seal is untouched");
  assert.equal(after.live_nonce, before.live_nonce);
  assert.equal(await isLive(db, deps(), after), true);
});

test("a seal from another seed, or another kind, never verifies a recipient", async () => {
  const db = await freshDb();
  const report = await makeReport(db);
  const row = await approved(db, report.id);
  const stored = await storedRow(db, row.id);
  assert.equal(await verifyRecipient(db, deps(), stored), true);
  assert.equal(await verifyRecipient(db, deps({ loadSeed: () => ({ seed: Buffer.alloc(32, 12) }) }), stored), false);
  assert.equal(await verifyRecipient(db, deps({ loadSeed: () => null }), stored), false);
  assert.equal(await verifyRecipient(db, deps(), { ...stored, id: "rrc-ffffffffffffffff" }), false);
  assert.equal(await verifyRecipient(db, deps(), { ...stored, state: "proposed" }), false);
  assert.equal(await verifyRecipient(db, deps(), null), false);
});