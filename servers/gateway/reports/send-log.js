/**
 * The report send log's two mail-free halves: the list a page reads, and the owner's "Send to the
 * rest" for one run.
 *
 * A row in `report_sends` is one attempt at mailing one recipient for one run (spec R3). This module
 * never sends anything and imports nothing under `mail/`: it writes `pending` rows, and the delivery
 * seam (a later PR) is what picks a pending row up. That is why "Send to the rest" can be an owner tap
 * on a page while the anti-goal (nothing sends without the owner's approval) still holds: an approved
 * recipient IS the owner's approval, and the run is the owner's own.
 *
 * `createSendToRest(db, deps, {reportId, runId, actor})`:
 *
 *   1. the owner and nobody else (`owner_only`), and the report and the run must exist and belong to
 *      each other (`not_found`);
 *   2. the run must be one that may send: its trigger is `schedule` or the owner's own `manual` run
 *      (never a preview, never a bot's manual run), and it has finished (`ok`, `empty` or `failed`, not
 *      `queued` or `running`). Anything else is `conflict`, and no row is written;
 *   3. for each recipient of the report whose approval still verifies (`verifyRecipient`: approved
 *      state AND a seal that matches the row's CURRENT address, tier and ids), the run must have no
 *      `sent`, no `unknown` and no `pending` or `sending` row. A `sent` row means it already went, an
 *      `unknown` row means nobody knows whether it went (it is never resent automatically), and a
 *      `pending` or `sending` row means it is already in hand. Each of those is a skip with its own
 *      reason; every row that is not (a recipient whose address was edited in place, a proposal
 *      nobody approved, a refused or revoked row) is a skip with `not_approved`;
 *   4. a row this tap adds is `pending` with `attempt = (that run's highest attempt for that
 *      recipient, or 0) + 1`, the account the report sends from, and one `now` for both timestamps.
 *      It is written with `INSERT OR IGNORE`, so the unique (run_id, recipient_id, attempt) index is
 *      what settles two overlapping taps: one of them writes the set and the other's inserts are no
 *      rows at all. A double tap therefore makes ONE set of rows, and the loser reports the same
 *      recipients as skips.
 *
 * `listSends(db, {reportId, runId})` answers the send log for one report (or one run of it), newest
 * first and bounded to 200 rows, without the claim token or the gateway run id: those are delivery's
 * own bookkeeping about a moment in one process, not something a page shows.
 *
 * `deps`: `approvals` (the approvals module's own deps, for the seal seed), `getRun(db, runId)`, and
 * `now()`. Each falls back to the real thing when it is absent, and the defaults fail closed: no seed
 * means no recipient verifies, so nothing is ever added.
 */
import { randomBytes } from "node:crypto";
import { verifyRecipient } from "./approvals.js";
import { getRun } from "./run.js";
import { getReport } from "./store.js";

/** How many rows the list answers at most: a report's log is a page, not an export. */
export const SEND_LIST_LIMIT = 200;

/** Why a recipient was not given a row by "Send to the rest". Short codes, never a sentence. */
export const SEND_SKIP_REASONS = Object.freeze([
  "sent",
  "unknown",
  "pending",
  "not_approved",
]);

/** The run statuses a send to the rest may start from: the run has finished, however it ended. */
export const SENDABLE_RUN_STATUSES = Object.freeze(["ok", "empty", "failed"]);

/** The recipient columns the seal check needs (the raw row, seal and nonce included). */
const RECIPIENT_COLUMNS = `id, report_id, address, display_name, comment_tier, state, proposed_by,
  approval_nonce, approval_seal, approved_at, created_at`;

/** What a row must not carry out of this module: delivery's claim bookkeeping. */
const SEND_COLUMNS = `id, run_id, report_id, recipient_id, attempt, account_id, status, reason,
  message_id, provider_message_id, created_at, updated_at`;

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function text(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

/** The actor rule: the same one every approving function in this tree applies. */
function requireOwner(actor) {
  if (!actor || typeof actor !== "object" || actor.kind !== "owner") throw fail("owner_only");
  return actor;
}

function resolveDeps(deps) {
  const given = deps == null ? {} : deps;
  const fn = (key, fallback) => (typeof given[key] === "function" ? given[key] : fallback);
  return {
    approvals: given.approvals == null ? {} : given.approvals,
    getRun: fn("getRun", getRun),
    now: fn("now", Date.now),
  };
}

function mapSend(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    reportId: row.report_id,
    recipientId: row.recipient_id,
    attempt: Number(row.attempt),
    accountId: row.account_id == null ? null : row.account_id,
    status: row.status,
    reason: row.reason == null ? null : row.reason,
    messageId: row.message_id == null ? null : row.message_id,
    providerMessageId: row.provider_message_id == null ? null : row.provider_message_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * One report's send log, or one run's, newest first and at most `SEND_LIST_LIMIT` rows.
 *
 * @param {object} db a libsql-shaped client
 * @param {{reportId: string, runId?: string|null, limit?: number}} [input]
 * @returns {Promise<object[]>}
 * @throws {Error} `bad_input` for a missing report id
 */
export async function listSends(db, { reportId, runId = null, limit = SEND_LIST_LIMIT } = {}) {
  if (typeof reportId !== "string" || !reportId) throw fail("bad_input", "reportId");
  const wanted = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEND_LIST_LIMIT) : SEND_LIST_LIMIT;
  const args = [reportId];
  let sql = `SELECT ${SEND_COLUMNS} FROM report_sends WHERE report_id = ?`;
  if (typeof runId === "string" && runId) {
    sql += " AND run_id = ?";
    args.push(runId);
  }
  sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
  args.push(wanted);
  const { rows } = await db.execute({ sql, args });
  return rows.map(mapSend);
}

/** The one reason this run's rows for this recipient stop a new attempt, or null. */
function blockedReason(existing) {
  let pending = false;
  for (const row of existing) {
    if (row.status === "sent") return "sent";
    if (row.status === "unknown") return "unknown";
    if (row.status === "pending" || row.status === "sending") pending = true;
  }
  return pending ? "pending" : null;
}

function nextAttempt(existing) {
  let max = 0;
  for (const row of existing) {
    const attempt = Number(row.attempt);
    if (Number.isFinite(attempt) && attempt > max) max = attempt;
  }
  return max + 1;
}

/**
 * The owner's "Send to the rest" for one run: a `pending` row for every approved recipient of the
 * report that this run has not already sent to, is not sending to, and does not already hold a row
 * for. It sends nothing.
 *
 * @param {object} db a libsql-shaped client
 * @param {object} [deps] `approvals`, `getRun`, `now`
 * @param {{reportId: string, runId: string, actor: {kind: "owner"}}} input
 * @returns {Promise<{created: string[], skipped: Array<{recipientId: string, reason: string}>}>}
 * @throws {Error} `owner_only`, `bad_input`, `not_found`, `conflict`
 */
export async function createSendToRest(db, deps, { reportId, runId, actor } = {}) {
  requireOwner(actor);
  const d = resolveDeps(deps);
  if (typeof reportId !== "string" || !reportId) throw fail("bad_input", "reportId");
  if (typeof runId !== "string" || !runId) throw fail("bad_input", "runId");

  const report = await getReport(db, reportId);
  if (!report) throw fail("not_found", "report");
  const run = await d.getRun(db, runId);
  if (!run) throw fail("not_found", "run");
  const runReportId = run.reportId !== undefined ? run.reportId : run.report_id;
  if (text(runReportId) !== report.id) throw fail("not_found", "run");

  // Only a run that may send: the run's own scheduled run or the owner's manual one (a preview and a
  // bot's manual run have no live set behind them), and one that has finished. A queued or running run
  // has no result to send to the rest of yet.
  const trigger = text(run.trigger) || text(run.kind);
  const ownerManual = trigger === "manual" && text(run.requestedBy) === "owner";
  if (trigger !== "schedule" && !ownerManual) throw fail("conflict", "run");
  if (!SENDABLE_RUN_STATUSES.includes(text(run.status))) throw fail("conflict", "run");

  const at = Number(d.now());
  // The account this run sends from: the report's own sender, never a caller's choice.
  const accountId = text(report.sender_account_id) || null;

  const { rows: recipients } = await db.execute({
    sql: `SELECT ${RECIPIENT_COLUMNS} FROM report_recipients
           WHERE report_id = ? ORDER BY created_at ASC, id ASC`,
    args: [report.id],
  });

  const created = [];
  const skipped = [];
  for (const recipient of recipients) {
    if (!(await verifyRecipient(db, d.approvals, recipient))) {
      skipped.push({ recipientId: recipient.id, reason: "not_approved" });
      continue;
    }
    const { rows: existing } = await db.execute({
      sql: "SELECT status, attempt FROM report_sends WHERE run_id = ? AND recipient_id = ?",
      args: [runId, recipient.id],
    });
    const blocked = blockedReason(existing);
    if (blocked) {
      skipped.push({ recipientId: recipient.id, reason: blocked });
      continue;
    }

    const id = `rsd-${randomBytes(8).toString("hex")}`;
    let wrote = false;
    try {
      // OR IGNORE is what makes a double tap one set of rows: the unique (run_id, recipient_id,
      // attempt) index refuses the losing call's insert, and that call reports a skip instead.
      const result = await db.execute({
        sql: `INSERT OR IGNORE INTO report_sends
                (id, run_id, report_id, recipient_id, attempt, account_id, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        args: [id, runId, report.id, recipient.id, nextAttempt(existing), accountId, at, at],
      });
      wrote = Number(result?.rowsAffected ?? 0) === 1;
    } catch {
      wrote = false;
    }
    if (wrote) created.push(id);
    else skipped.push({ recipientId: recipient.id, reason: "pending" });
  }
  return { created, skipped };
}