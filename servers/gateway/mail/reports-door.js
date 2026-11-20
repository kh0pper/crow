/**
 * The reports-only send door: the one path in Crow that mails a report, and the reason it takes a row
 * id instead of an address.
 *
 * Crow Mail's anti-goal is that nothing sends without a person's tap. A report is not a tap: it is a
 * thing the owner approved once and asked to be repeated, and PR 5's delivery inserts one
 * `report_sends` row per approved recipient before anything can happen. This module takes THAT row id
 * and never an address, so no caller can name its own recipient, its own From, a cc or a bcc. A key
 * other than `sendId`, `subject`, `html`, `text` or `headers` (a `to`, an `address`, a `cc`, a `bcc`,
 * a `from`) is `bad_input` before anything is read, and `headers` may carry only `inReplyTo` and
 * `references` — the two a reply needs, both validated by `validateOutgoing`.
 *
 * The checks, in order, each of which writes the row's own `status = 'refused'` (a short reason code
 * and nothing else) and answers `{status, reason}`:
 *
 *   1. the recipient row is approved and its seal still verifies over the row's CURRENT address, tier
 *      and ids (`recipient_not_approved`);
 *   2. the run may send: the report is live per the approvals module, the run is the report's own
 *      scheduled run or the owner's manual run, and never a preview run (`not_live`);
 *   3. the report's daily email cap (`cap_reached`);
 *   4. the sender account: always the report's own `sender_account_id`, never the send row's (a row that
 *      names a DIFFERENT non-null account is refused `sender_unavailable`, because the seal covers the
 *      report's sender and nothing else). The account must exist and not be `claimed_elsewhere` or
 *      `auth_failed` (`sender_unavailable`, which the owner reads as "reconnect it or pick another
 *      sender");
 *   5. the account is not held by another paired instance (`claimed_elsewhere`).
 *
 * Then the CLAIM: one guarded `UPDATE ... WHERE id = ? AND status = 'pending'` that ALSO re-checks the
 * recipient's approval at the moment of the write (`AND EXISTS (SELECT 1 FROM report_recipients WHERE
 * id = ? AND state = 'approved' AND approval_seal = ?)`, binding the seal verified above), so a
 * revocation that lands between the check and the claim cannot reach an adapter. Only the winner calls
 * an adapter, so two racing deliveries of one row make one send; a loser answers
 * `{status: "refused", reason: "not_pending"}`, or `recipient_not_approved` when the row is still
 * pending and it was the recipient that moved. The send is counted toward the daily cap at the claim
 * with `claimEmailSlot`: one conditional increment, so two claims that arrive at once cannot both pass
 * a cap of one, and a claim that loses there settles the row `refused` / `cap_reached`. After the
 * claim, every write is guarded by the claim token as well, so a row that moved under the claim is
 * never settled by it.
 *
 * The adapter comes from one injected `deps.adapterFor(account, fn)` and from nowhere else: this module
 * builds no connection, has no default supervisor, and answers `failed` / `no_adapter` when nobody
 * injected one. Boot's `mail-boot.js` builds it (a mail supervisor's `withAdapter` for an IMAP/SMTP
 * account, a short-lived adapter off the registry for a Gmail REST account), which is why the reports
 * code needs no mail connection of its own.
 *
 * Outcomes follow Crow Mail's send service, copied rather than imported so the mail module's own
 * anti-goal invariant keeps its watch over an unchanged file: `AUTH_FAILED`, `TLS`, `BAD_INPUT`,
 * `TOO_LARGE`, `NOT_FOUND`, `CLAIMED_ELSEWHERE` and `CHANGED` settle `failed` (the request provably did
 * not complete); `NETWORK`, `TIMEOUT`, `PROTOCOL` and anything unmapped settle `unknown` (nobody knows).
 * A `sending` or `unknown` row is NEVER resent automatically: only a `pending` row can be claimed, and
 * nothing here moves a row back to `pending`.
 *
 * One message per recipient: `to` is exactly the row's address, there is no cc and no bcc, the subject
 * is the caller's bounded to 200 characters and normalised by `validateOutgoing`, and the display name
 * is the report's title with control characters removed and bounded to 80 (the title is untrusted
 * text). A fresh Message-ID of 128 random bits under the sender's own domain is made here and stored,
 * so a later matching pass can look for either it or the id the provider reports.
 *
 * Nothing here writes prose a person reads: `reason` is one of `SEND_REASONS`, and it is redacted
 * before it is stored. Adapter error text (which can quote a server reply or a username) is never read.
 */
import { randomBytes } from "node:crypto";
import { MailError, toMailError } from "./errors.js";
import { getAccount } from "./store/accounts.js";
import { makeIsClaimedElsewhere } from "./claims.js";
import { validateOutgoing } from "./adapter/interface.js";
import { claimEmailSlot, dayInTz, getCaps, getUsage } from "../reports/caps.js";
import { isLive, verifyRecipient } from "../reports/approvals.js";
import { getReport } from "../reports/store.js";
import { getRun } from "../reports/run.js";
import { gatewayRunId } from "../run-id.js";
import { getSecretValues } from "../../shared/secret-values.js";
import { redactSecrets } from "../../shared/redact-secrets.js";

/** Every reason code this door stores. Short, technical, and never a sentence about a person. */
export const SEND_REASONS = Object.freeze([
  // before the claim
  "recipient_not_approved",
  "not_live",
  "cap_reached",
  "sender_unavailable",
  "claimed_elsewhere",
  "no_adapter",
  "not_pending",
  // after the claim: a failure that provably did not complete
  "auth_failed",
  "tls",
  "bad_input",
  "too_large",
  "not_found",
  "changed",
  "all_rejected",
  // after the claim: an outcome nobody knows
  "network",
  "timeout",
  "protocol",
  "send_failed",
]);

/** The only keys a caller may pass. Anything else is a caller trying to name its own message. */
const SEND_KEYS = new Set(["sendId", "subject", "html", "text", "headers"]);

/** The only headers a report mail may carry: the two a reply needs. */
const HEADER_KEYS = new Set(["inReplyTo", "references"]);

/** The failure-with-unknown-outcome codes: the request may or may not have reached the provider. */
const UNKNOWN_OUTCOMES = Object.freeze({ NETWORK: "network", TIMEOUT: "timeout", PROTOCOL: "protocol" });

/** The failure-that-did-not-complete codes: the request provably did not finish. */
const FAILED_OUTCOMES = Object.freeze({
  AUTH_FAILED: "auth_failed",
  TLS: "tls",
  BAD_INPUT: "bad_input",
  TOO_LARGE: "too_large",
  NOT_FOUND: "not_found",
  CLAIMED_ELSEWHERE: "claimed_elsewhere",
  CHANGED: "changed",
});

/** A subject is a header value, so it is bounded here and normalised (CR/LF/TAB) by validateOutgoing. */
const SUBJECT_MAX = 200;

/** The display name bound. The report's title is text the owner and a bot both write, so it is cut. */
const DISPLAY_NAME_MAX = 80;

/** C0 controls, DEL, C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g;

/** An account status that means its own credential cannot send right now. */
const UNUSABLE_ACCOUNT_STATUSES = Object.freeze(["claimed_elsewhere", "auth_failed"]);

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

/* ------------------------------------------------------------------------- the seam */

/**
 * An account was claimed by another instance: the same verdict Crow Mail's send service reads before
 * it opens a connection. This is the real check, and its local instance id is the caller's.
 */
function defaultIsClaimedElsewhere(db, deps) {
  return makeIsClaimedElsewhere(db, { localInstanceId: deps.localInstanceId });
}

function defaultGetSecrets() {
  try {
    return getSecretValues();
  } catch {
    return [];
  }
}

/**
 * The deps, with every member present. There is deliberately NO default `adapterFor`: building a
 * connection is boot's job, and a door with nowhere to send from answers `no_adapter` instead of
 * opening one of its own.
 */
function resolveDeps(db, deps) {
  const given = deps == null ? {} : deps;
  const fn = (key, fallback) => (typeof given[key] === "function" ? given[key] : fallback);
  const claimed = fn("isClaimedElsewhere", null);
  return {
    adapterFor: typeof given.adapterFor === "function" ? given.adapterFor : null,
    isClaimedElsewhere: claimed ?? defaultIsClaimedElsewhere(db, given),
    approvals: given.approvals == null ? {} : given.approvals,
    getRun: fn("getRun", getRun),
    getSecrets: fn("getSecrets", defaultGetSecrets),
    now: fn("now", Date.now),
    localInstanceId: given.localInstanceId,
  };
}

function redacted(reason, deps) {
  let secrets = [];
  try {
    secrets = deps.getSecrets() || [];
  } catch {
    secrets = [];
  }
  return redactSecrets(reason, secrets);
}

/* --------------------------------------------------------------------- row writes */

/** A row's refusal: only a `pending` row is ever moved, so a settled row can never be rewritten. */
async function refuseRow(db, sendId, reason, now) {
  await db.execute({
    sql: `UPDATE report_sends SET status = 'refused', reason = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
    args: [reason, now, sendId],
  });
}

/** A row's failure before the claim: only a `pending` row is moved. */
async function failRow(db, sendId, reason, now) {
  await db.execute({
    sql: `UPDATE report_sends SET status = 'failed', reason = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
    args: [reason, now, sendId],
  });
}

/** The settle after the claim: guarded by the claim token, so it can only move the row it claimed. */
async function settleRow(db, sendId, claimToken, fields) {
  const { status, now, reason = null, messageId = null, providerMessageId = null } = fields;
  await db.execute({
    sql: `UPDATE report_sends
             SET status = ?, reason = ?, message_id = COALESCE(?, message_id),
                 provider_message_id = ?, updated_at = ?
           WHERE id = ? AND claim_token = ?`,
    args: [status, reason, messageId, providerMessageId, now, sendId, claimToken],
  });
}

/** One send row as stored, or null. */
async function getSendRow(db, sendId) {
  if (typeof sendId !== "string" || !sendId) return null;
  const { rows } = await db.execute({
    sql: "SELECT * FROM report_sends WHERE id = ?",
    args: [sendId],
  });
  return rows[0] ?? null;
}

/** One recipient row as stored (the seal and nonce included), or null. */
async function getRecipientRow(db, recipientId) {
  if (typeof recipientId !== "string" || !recipientId) return null;
  const { rows } = await db.execute({
    sql: `SELECT id, report_id, address, display_name, comment_tier, state, proposed_by,
                 approval_nonce, approval_seal, approved_at, created_at
            FROM report_recipients WHERE id = ?`,
    args: [recipientId],
  });
  return rows[0] ?? null;
}

/**
 * The zone a report's day is counted in: its schedule's own tz, and UTC when there is no row or the
 * value is empty. An unreadable zone is UTC too (`dayInTz` falls back itself).
 */
async function timeZoneFor(db, report) {
  const raw = report?.schedule_id;
  if (raw == null || raw === "") return "UTC";
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) return "UTC";
  try {
    const { rows } = await db.execute({ sql: "SELECT tz FROM schedules WHERE id = ?", args: [id] });
    const tz = rows[0]?.tz;
    return typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
  } catch {
    return "UTC";
  }
}

/** The domain of a sender address, for the Message-ID. An account address always has one. */
function domainOf(address) {
  const value = text(address);
  const at = value.lastIndexOf("@");
  const domain = at >= 0 ? value.slice(at + 1).trim().toLowerCase() : "";
  return domain || "localhost";
}

/**
 * The From display name: the report's title, which is untrusted text. Control characters (a CR/LF in
 * a title would be a header line) go, the run is flattened, and the rest is bounded.
 */
function displayNameFor(report) {
  const flat = text(report?.title).replace(CONTROL_CHARS_ALL, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > DISPLAY_NAME_MAX ? flat.slice(0, DISPLAY_NAME_MAX) : flat;
}

/** The headers the caller passed, refused unless both keys and their shapes are the two allowed. */
function headersOf(input) {
  const headers = input == null ? null : input;
  if (headers == null) return { inReplyTo: null, references: null };
  if (typeof headers !== "object" || Array.isArray(headers)) throw fail("bad_input", "headers");
  for (const key of Object.keys(headers)) {
    if (!HEADER_KEYS.has(key)) throw fail("bad_input", key);
  }
  return { inReplyTo: headers.inReplyTo ?? null, references: headers.references ?? null };
}

/**
 * The one way a row's attempt reaches a mail server.
 *
 * @param {object} db a libsql-shaped client
 * @param {object} deps the seam: `adapterFor` (required), `approvals`, `isClaimedElsewhere`, `getRun`,
 *   `getSecrets`, `now`, `localInstanceId`
 * @param {{sendId: string, subject: string, html?: string|null, text?: string|null,
 *   headers?: {inReplyTo?: string|null, references?: string[]|null}}} input
 * @returns {Promise<{status: string, messageId?: string|null, reason?: string}>}
 * @throws {Error} `bad_input` for an unknown key, a bad `headers` shape or a missing `sendId`
 */
export async function sendReportMail(db, deps, input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw fail("bad_input", "input");
  }
  for (const key of Object.keys(input)) {
    if (!SEND_KEYS.has(key)) throw fail("bad_input", key);
  }
  if (typeof input.sendId !== "string" || !input.sendId) throw fail("bad_input", "sendId");
  const headers = headersOf(input.headers);

  const d = resolveDeps(db, deps);
  const now = Number(d.now());
  const send = await getSendRow(db, input.sendId);
  if (!send) throw fail("not_found", "send");

  /* ---- 1. the recipient's approval, against the row as it is now. */
  const recipient = await getRecipientRow(db, send.recipient_id);
  if (!recipient || recipient.report_id !== send.report_id) {
    await refuseRow(db, send.id, "recipient_not_approved", now);
    return { status: "refused", reason: "recipient_not_approved" };
  }
  if (!(await verifyRecipient(db, d.approvals, recipient))) {
    await refuseRow(db, send.id, "recipient_not_approved", now);
    return { status: "refused", reason: "recipient_not_approved" };
  }

  /* ---- 2. the run may send: a live report, its own run, and never a preview. */
  const report = await getReport(db, send.report_id);
  if (!report) {
    await refuseRow(db, send.id, "not_live", now);
    return { status: "refused", reason: "not_live" };
  }
  const run = await d.getRun(db, send.run_id);
  const trigger = text(run?.trigger) || text(run?.kind);
  const ownerManual = trigger === "manual" && text(run?.requestedBy) === "owner";
  if (!run || run.reportId !== report.id || (trigger !== "schedule" && !ownerManual)) {
    await refuseRow(db, send.id, "not_live", now);
    return { status: "refused", reason: "not_live" };
  }
  if (!(await isLive(db, d.approvals, report))) {
    await refuseRow(db, send.id, "not_live", now);
    return { status: "refused", reason: "not_live" };
  }

  /* ---- 3. the report's daily email cap. */
  const day = dayInTz(now, await timeZoneFor(db, report));
  const caps = await getCaps(db);
  const usage = await getUsage(db, report.id, day);
  if (usage.emails >= caps.maxEmailsPerReportDay) {
    await refuseRow(db, send.id, "cap_reached", now);
    return { status: "refused", reason: "cap_reached" };
  }

  /* ---- 4. the sender account: the report's own, never the row's. */
  const reportAccountId = text(report.sender_account_id);
  const rowAccountId = text(send.account_id);
  if (rowAccountId && rowAccountId !== reportAccountId) {
    // The seal covers the report's sender. A row that names another account was written by something
    // that could name its own From, so it never sends.
    await failRow(db, send.id, "sender_unavailable", now);
    return { status: "failed", reason: "sender_unavailable" };
  }
  const account = reportAccountId ? await getAccount(db, reportAccountId) : null;
  if (!account || UNUSABLE_ACCOUNT_STATUSES.includes(account.status)) {
    await failRow(db, send.id, "sender_unavailable", now);
    return { status: "failed", reason: "sender_unavailable" };
  }

  /* ---- 5. one instance holds the address. */
  const claimed = await d.isClaimedElsewhere(account);
  if (claimed && claimed.claimed === true) {
    await failRow(db, send.id, "claimed_elsewhere", now);
    return { status: "failed", reason: "claimed_elsewhere" };
  }

  /* ---- the door's other half: with nowhere to send from, nothing is claimed. */
  if (!d.adapterFor) {
    await failRow(db, send.id, "no_adapter", now);
    return { status: "failed", reason: "no_adapter" };
  }

  /* ---- the CLAIM: one guarded UPDATE, and only the winner sends. The recipient's approval is
     re-checked INSIDE it, against the seal verified above, so a revoke between the two cannot send. */
  const claimToken = randomBytes(16).toString("hex");
  const claim = await db.execute({
    sql: `UPDATE report_sends
             SET status = 'sending', claim_token = ?, gateway_run_id = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM report_recipients
                          WHERE id = ? AND state = 'approved' AND approval_seal = ?)`,
    args: [claimToken, gatewayRunId(), now, send.id, recipient.id, recipient.approval_seal],
  });
  if (claim.rowsAffected !== 1) {
    const current = await getSendRow(db, send.id);
    if (current && current.status === "pending") {
      // Still claimable, so it was the recipient that moved: refuse it by name, not as a lost race.
      await refuseRow(db, send.id, "recipient_not_approved", now);
      return { status: "refused", reason: "recipient_not_approved" };
    }
    return { status: "refused", reason: "not_pending" };
  }

  // The attempt counts against the day's cap from the moment it is claimed, whatever its outcome.
  // The claim is one conditional increment, so two claims that arrive at once cannot both pass it.
  if (!(await claimEmailSlot(db, { reportId: report.id, day, max: caps.maxEmailsPerReportDay }))) {
    await settleRow(db, send.id, claimToken, { status: "refused", reason: "cap_reached", now });
    return { status: "refused", reason: "cap_reached" };
  }

  /* ---- the message, built from the row and nothing a caller said about its addresses. */
  const messageId = `<${randomBytes(16).toString("hex")}@${domainOf(account.address)}>`;
  const subject = text(input.subject).slice(0, SUBJECT_MAX);
  let message;
  try {
    message = validateOutgoing({
      from: { name: displayNameFor(report), address: account.address },
      to: [{ address: recipient.address }],
      subject,
      text: input.text == null ? "" : input.text,
      html: input.html == null ? null : input.html,
      inReplyTo: headers.inReplyTo,
      references: headers.references,
      messageId,
    });
  } catch (err) {
    const mailError = toMailError(err);
    const reason = redacted(FAILED_OUTCOMES[mailError.code] ?? "bad_input", d);
    await settleRow(db, send.id, claimToken, { status: "failed", reason, now, messageId });
    return { status: "failed", reason };
  }

  /* ---- the one way to an adapter, and the outcome mapping copied from the send service. */
  try {
    const result = await d.adapterFor(account, (adapter) => adapter.send(message));
    const accepted = Array.isArray(result?.accepted) ? result.accepted : null;
    if (accepted !== null && accepted.length === 0) {
      const reason = redacted("all_rejected", d);
      await settleRow(db, send.id, claimToken, { status: "failed", reason, now, messageId });
      return { status: "failed", reason };
    }
    const providerMessageId = typeof result?.messageId === "string" && result.messageId
      ? result.messageId
      : null;
    await settleRow(db, send.id, claimToken, {
      status: "sent",
      reason: null,
      now,
      messageId,
      providerMessageId,
    });
    return { status: "sent", messageId };
  } catch (err) {
    // Only the code: an adapter's message can quote a server reply, a username or an address.
    let code = "PROTOCOL";
    try {
      code = err instanceof MailError ? err.code : toMailError(err).code;
    } catch {
      code = "PROTOCOL";
    }
    const unknown = UNKNOWN_OUTCOMES[code];
    const failed = FAILED_OUTCOMES[code];
    // Anything unmapped is `unknown`: the request may have reached the provider.
    const reason = redacted(unknown ?? failed ?? "send_failed", d);
    const status = failed ? "failed" : "unknown";
    await settleRow(db, send.id, claimToken, { status, reason, now, messageId });
    return { status, reason };
  }
}

export default sendReportMail;