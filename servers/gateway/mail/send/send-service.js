/**
 * Crow Mail's send service: the ten-second hold, the one claim, the delivery and the settle.
 *
 * Nothing here is a route, and nothing here trusts one. A tap is a row in `holding` carrying a seal
 * (`drafts/seal.js`) over the head hash the person was looking at, the account, the From address, the
 * hold time and a per-tap id. Deliver is the only path from a tap to a socket, and it re-checks the
 * seal — and the hash, recomputed from the immutable revision row rather than read from a stored
 * column — before it claims the row with one guarded UPDATE. If either check fails, the row leaves
 * `holding`/`scheduled` through `transition()` (which nulls the seal) with a fixed `fail_reason`, and
 * no adapter is called.
 *
 * The row moves once: `deliver` claims `holding|scheduled` -> `sending` with a fresh `claim_token` and
 * a message id, and every write after that is guarded by that token. Two racing deliveries therefore
 * produce one claim and one SMTP call. A failure that provably did not complete (`AUTH_FAILED`, `TLS`,
 * `BAD_INPUT`, `TOO_LARGE`, `NOT_FOUND`, `CLAIMED_ELSEWHERE`) settles `failed`, which is sendable
 * again; a failure whose outcome is unknowable (`NETWORK`, `TIMEOUT`, `PROTOCOL`) settles `unknown`,
 * which is never retried automatically and is reconciled against the Sent folder with a bounded
 * backoff. The one case that is not retried at all is `unknown` without an explicit confirm after at
 * least one Sent-folder check.
 *
 * Every time is epoch ms from an injectable clock, every id and timer is injectable, and `deps` is the
 * whole seam: a test drives this module with a fake adapter and a fake clock, and Task 6's sweep and
 * Task 7's routes pass the running supervisor's `withAdapter`/`requestSync` and the two attachment
 * readers. Nothing here writes prose: a failure is a key into `SEND_FAIL_REASONS` (a short technical
 * phrase, no address, subject, body or adapter text), and the sentences the plan fixes are exported so
 * the card can show them.
 */
import { randomUUID } from "node:crypto";
import { MailError, toMailError } from "../errors.js";
import { getAccount } from "../store/accounts.js";
import { folderRole } from "../store/messages.js";
import { claimedElsewhereSentence, makeIsClaimedElsewhere } from "../claims.js";
import { composeRaw as composeRawMessage } from "../adapter/compose.js";
import { hashOf, getDraft, listRevisions, revisionToInput, transition } from "../drafts/store.js";
import { preflight, sealFromAddress } from "../drafts/preflight.js";
import { newTapId, sealFor, verifySeal } from "../drafts/seal.js";
import { loadKeychainKey } from "../../keychain/key.js";

/** The undo window: a tapped message waits this long before the provider sees it. */
export const HOLD_MS = 10_000;

/** How late a held or scheduled send may still go out; past it the row is `missed`, never sent. */
export const GRACE_MS = 10 * 60 * 1000;

/** A `sending` row older than this, outside this process's in-flight map, was interrupted. */
export const STALE_SENDING_MS = 10 * 60 * 1000;

/** How long an `unknown` row is looked for in the Sent folder, counted from its `attempt_at`. */
export const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The longest delay a platform timer holds; anything above it fires at once, so nothing asks for one. */
const MAX_TIMER_MS = 2_147_483_647;

/** The first three Sent-folder checks, from `attempt_at`; every later one is an hour on. */
const RECONCILE_STEPS_MS = Object.freeze([60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]);
const RECONCILE_HOURLY_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ fixed sentences */

/** The card's line when this Crow has no keychain key: no seal can be made, so nothing can be sent. */
export const KEYCHAIN_KEY_MISSING_SENTENCE =
  "This Crow is missing its key file, so mail cannot be sent. Restore the key file or sign in to the account again.";

/** The card's line for an `unknown` row. It never says "not sent", because nobody knows. */
export const UNKNOWN_STATE_SENTENCE =
  "We could not confirm this went out. Check your Sent folder, then press Send again only if it is not there.";

/** The undo's answer when the claim already left: the message is past the person's reach. */
export const ALREADY_WENT_OUT_SENTENCE = "It already went out.";

/** The answer when the head hash a person tapped is no longer the head. */
export const CHANGED_SENTENCE = "The draft just changed. Check it and press Send again.";

/**
 * The fixed technical phrase per failure, keyed by the short reason this module uses. A `fail_reason`
 * is one of these and nothing else: no address, no subject, no body and no adapter text, and each at
 * most 200 characters.
 */
export const SEND_FAIL_REASONS = Object.freeze({
  seal: "The tap seal no longer matches the draft, so nothing was sent.",
  attachment_changed: "An attachment changed after the draft was tapped, so nothing was sent.",
  keychain_key_missing: "This Crow has no keychain key, so no tap can be sealed and nothing is sent.",
  supervisor_missing: "This Crow is not running its mail connection, so nothing was sent.",
  account_removed: "The account this message was written from is no longer set up, so nothing was sent.",
  auth_failed: "The mail server did not accept the account's sign-in, so nothing was sent.",
  tls: "The mail server's certificate could not be trusted, so nothing was sent.",
  bad_input: "The message could not be built in a form the mail server accepts, so nothing was sent.",
  too_large: "The message is larger than the mail server accepts, so nothing was sent.",
  not_found: "The mailbox or a folder the send needs is not there any more, so nothing was sent.",
  claimed_elsewhere: "The account is connected on another Crow, so nothing was sent.",
  all_rejected: "The mail server refused every recipient, so nothing was sent.",
  changed: "The mailbox changed on the server before the message went out, so nothing was sent.",
  missed: "The send time passed while this Crow was not running, so nothing was sent.",
  network: "Crow lost the connection before the outcome was known.",
  timeout: "The mail server did not answer before the deadline, so the outcome is unknown.",
  protocol: "The mail server answered with something Crow could not use, so the outcome is unknown.",
  send_failed: "The send did not complete and its outcome is unknown.",
});

/** The states a tap may be taken from, besides `unknown` (which needs a confirm). */
const SENDABLE_STATES = Object.freeze(["draft", "failed", "missed"]);

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

/* ------------------------------------------------------------------------ the seam */

/**
 * The draft ids this process is delivering right now, with the token that claimed each one. Module
 * state on purpose: the map is per process, so a second gateway on the same `crow.db` (or a restored
 * copy) cannot see it — which is exactly why the adapter's deadline, the `reconcile_count >= 1` gate
 * on a resend and the one-account-one-instance claim row exist.
 */
export const inFlight = new Map();

/** Forget every in-flight delivery (a test's, or a restarted process's, starting point). */
export function _resetInFlightForTests() {
  inFlight.clear();
}

/** The running supervisor, set once by boot so the defaults below are the real thing. */
let supervisor = null;

/**
 * The supervisor whose `withAdapter`/`requestSync` the defaults use. Boot calls this beside the mail
 * sync start; `null` (or `clearMailSendSupervisor()`) leaves `withAdapter` refusing, like a stopped
 * supervisor, and `requestSync` doing nothing.
 */
export function setMailSendSupervisor(value) {
  supervisor = value && typeof value.withAdapter === "function" ? value : null;
  return supervisor;
}

/** Forget the supervisor: shutdown, and a test that must not inherit another test's. */
export function clearMailSendSupervisor() {
  supervisor = null;
}

function defaultWithAdapter(accountId, fn) {
  if (!supervisor) return Promise.reject(new MailError("NETWORK", "stopped"));
  return supervisor.withAdapter(accountId, fn);
}

/**
 * Whether this process has somewhere to send from: an adapter the caller injected, or the boot
 * supervisor. A gateway whose supervisor is stopped (or not started yet) has nowhere to send from, so
 * a tap is refused rather than claimed and recorded as an unknown outcome. Both taps ask this one
 * question — `requestSend`, `deliver` and `scheduleDraft` — so a send and a schedule refuse a Crow with
 * no connection in the same words (`not_sendable`, reason `supervisor_missing`).
 *
 * @param {{hasAdapter?: boolean}} [deps] a resolved `deps` (see `resolveDeps`)
 * @returns {boolean}
 */
export function sendRuntimeReady(deps) {
  const given = deps == null ? {} : deps;
  return given.hasAdapter === true || supervisor != null;
}

/** The refusal half of `sendRuntimeReady`: no injected adapter and no supervisor. */
function adapterMissing(d) {
  return !sendRuntimeReady(d);
}

async function defaultRequestSync(accountId) {
  if (!supervisor) return undefined;
  return supervisor.requestSync(accountId);
}

function defaultLoadKey() {
  const key = loadKeychainKey();
  return key?.seed ?? null;
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (timer != null && typeof timer.unref === "function") timer.unref();
  return timer;
}

/** The whole seam, with the real implementation behind every key a caller did not pass. */
function resolveDeps(db, deps) {
  const given = deps == null ? {} : deps;
  const fn = (key, fallback) => (typeof given[key] === "function" ? given[key] : fallback);
  const ownWithAdapter = typeof given.withAdapter === "function";
  return {
    withAdapter: ownWithAdapter ? given.withAdapter : defaultWithAdapter,
    hasAdapter: ownWithAdapter,
    isClaimedElsewhere: fn("isClaimedElsewhere", makeIsClaimedElsewhere(db)),
    requestSync: fn("requestSync", defaultRequestSync),
    composeRaw: fn("composeRaw", composeRawMessage),
    loadKey: fn("loadKey", defaultLoadKey),
    readMessageRaw: fn("readMessageRaw", null),
    readStorageFile: fn("readStorageFile", null),
    now: fn("now", Date.now),
    schedule: fn("schedule", defaultSchedule),
    newId: fn("newId", randomUUID),
    inFlight: given.inFlight instanceof Map ? given.inFlight : inFlight,
  };
}

/** The caller's clock: a number, or read off the injected clock. */
function nowOf(d, options) {
  const value = options?.now ?? (typeof d.now === "function" ? d.now() : d.now);
  const ms = Math.floor(Number(value));
  if (!Number.isFinite(ms) || ms < 0) throw new MailError("BAD_INPUT", "now");
  return ms;
}

/** The failure phrase for a reason key; an unlisted key still says something true and fixed. */
function phraseFor(reason) {
  return SEND_FAIL_REASONS[reason] ?? SEND_FAIL_REASONS.send_failed;
}

/** One log line: an event name and a MailError code. Never a message, an address or a subject. */
function logCode(event, code) {
  console.warn(`[mail-send] ${event} ${code}`);
}

function codeOf(err) {
  try {
    return toMailError(err).code;
  } catch {
    return "unknown";
  }
}

function domainOf(address) {
  const text = String(address ?? "");
  const at = text.indexOf("@");
  return at > -1 ? text.slice(at + 1).trim().toLowerCase() : "localhost";
}

/* -------------------------------------------------------------------- row helpers */

/** The revision the draft's head names; a revision row never changes once written. */
async function headRevision(db, draft) {
  const revisions = await listRevisions(db, draft.id);
  return revisions.find((entry) => entry.rev === draft.headRev) ?? null;
}

/** The reading options `deliver` and `preflight` share: the two attachment readers, passed through. */
function readerDeps(d) {
  return { readMessageRaw: d.readMessageRaw, readStorageFile: d.readStorageFile };
}

/** The instant a tap is due: the hold for a send, the due time for a schedule. */
function whenOf(row) {
  return row.state === "scheduled" ? row.dueAt : row.holdUntil;
}

/** The action word a tap state is entered under; `transition()` refuses any other pairing. */
function actionOf(row) {
  return row.state === "scheduled" ? "schedule" : "send";
}

/**
 * Leave `holding`/`scheduled` with a fixed reason, through `transition()` so the seal columns are
 * nulled in the same UPDATE. Answers the delivery outcome the caller passes on.
 */
async function failPending(db, draftId, now, reason, to = "failed") {
  const changed = await transition(db, draftId, ["holding", "scheduled"], to,
    { fail_reason: phraseFor(reason) }, { now });
  return { outcome: to, reason, changed };
}

/**
 * Settle a claimed row by its claim token. Allowed from `sending` or `unknown` — an `unknown` row may
 * still be settled by the send that outlived the stale cutoff — to `sent` or `failed`. The seal
 * columns are nulled in the same statement, so nothing ever settles into a state a tap could ride.
 *
 * @param {object} db
 * @param {string} draftId
 * @param {string} claimToken the token the claim wrote
 * @param {"sent"|"failed"} to
 * @param {{now?: number|Function, sentAt?: number, failReason?: string|null}} [options]
 * @returns {Promise<boolean>} whether this call settled the row
 */
export async function settle(db, draftId, claimToken, to, options = {}) {
  if (to !== "sent" && to !== "failed") throw new MailError("BAD_INPUT", "state");
  if (typeof draftId !== "string" || !draftId) throw new MailError("BAD_INPUT", "draft_id");
  if (typeof claimToken !== "string" || !claimToken) throw new MailError("BAD_INPUT", "claim_token");
  const now = nowOf({ now: Date.now }, options);
  const sentAt = to === "sent" ? Number(options.sentAt ?? now) : null;
  const result = await db.execute({
    sql: `UPDATE mail_drafts
             SET state = ?, sent_at = ?, fail_reason = ?, reconcile_count = 0, next_reconcile_at = NULL,
                 tap_seal = NULL, tap_id = NULL, tap_action = NULL, attach_digest = NULL, updated_at = ?
           WHERE id = ? AND state IN ('sending', 'unknown') AND claim_token = ?`,
    args: [to, sentAt, to === "sent" ? null : (options.failReason ?? phraseFor("send_failed")),
      now, draftId, claimToken],
  });
  return result.rowsAffected === 1;
}

/**
 * The next Sent-folder check for an `unknown` row, in ms from `attemptAt`: one minute, five, fifteen,
 * then an hour apart, `attempts` being how many checks have run already.
 */
export function nextReconcileAt(attemptAt, attempts) {
  const done = Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
  const offset = done < RECONCILE_STEPS_MS.length
    ? RECONCILE_STEPS_MS[done]
    : RECONCILE_HOURLY_MS * (done - RECONCILE_STEPS_MS.length + 1);
  return Number(attemptAt) + offset;
}

/**
 * Mark a claimed row `unknown`, keeping its claim token so a late success can still settle it, and
 * pointing the reconcile at its first check.
 */
async function markUnknown(db, draftId, claimToken, now, reason) {
  const result = await db.execute({
    sql: `UPDATE mail_drafts
             SET state = 'unknown', fail_reason = ?, reconcile_count = 0, next_reconcile_at = ?,
                 tap_seal = NULL, tap_id = NULL, tap_action = NULL, attach_digest = NULL, updated_at = ?
           WHERE id = ? AND state = 'sending' AND claim_token = ?`,
    args: [phraseFor(reason), nextReconcileAt(now, 0), now, draftId, claimToken],
  });
  return result.rowsAffected === 1;
}

/**
 * Mark an interrupted `sending` row `unknown`: the claim token it was written under is the guard, the
 * reconcile is pointed at its first check one minute after the attempt (`attempt_at`, or `claimed_at`
 * for a row that died between the claim and the first byte) and `reconcile_count` stays 0, because no
 * check has run yet. The seal columns are nulled in the same statement.
 *
 * This is what the stale sweep (Task 6) does to a row this process is not sending and has not sent for
 * longer than `STALE_SENDING_MS`; a row in the in-flight map is never handed to it.
 *
 * @param {object} db
 * @param {object} row a draft row (`getDraft`'s shape)
 * @param {number} now epoch ms
 * @returns {Promise<boolean>} whether this call moved the row
 */
export async function markStaleUnknown(db, row, now) {
  if (row == null || typeof row.id !== "string" || !row.id) return false;
  const since = row.attemptAt ?? row.claimedAt ?? now;
  const at = Math.floor(Number(now));
  const result = await db.execute({
    sql: `UPDATE mail_drafts
             SET state = 'unknown', fail_reason = ?, reconcile_count = 0, next_reconcile_at = ?,
                 tap_seal = NULL, tap_id = NULL, tap_action = NULL, attach_digest = NULL, updated_at = ?
           WHERE id = ? AND state = 'sending' AND claim_token = ?`,
    args: [phraseFor("send_failed"), nextReconcileAt(since, 0), at, row.id, row.claimToken ?? null],
  });
  return result.rowsAffected === 1;
}

/**
 * A `sending` row this process is not sending, and has not been sending for longer than
 * `STALE_SENDING_MS`, was interrupted. A row in the in-flight map is never stale: the map is what
 * separates "slow" from "gone", and the adapter's deadline is what keeps a slow send from needing more
 * than the cutoff. Uses `attempt_at`, and `claimed_at` for a row that died between the claim and the
 * first byte.
 *
 * @param {object} row a draft row (`getDraft`'s shape)
 * @param {number} now epoch ms
 * @param {Map} [map] the in-flight map (the module's own by default)
 * @returns {boolean}
 */
export function isStaleSending(row, now, map = inFlight) {
  if (row == null || row.state !== "sending") return false;
  if (map != null && typeof map.has === "function" && map.has(row.id)) return false;
  const since = row.attemptAt ?? row.claimedAt;
  if (since == null) return false;
  return Number(now) - Number(since) > STALE_SENDING_MS;
}

/* ------------------------------------------------------------------- the tap */

/**
 * Take the person's tap: check the draft, then claim `holding` with one guarded UPDATE carrying the
 * seal, the hold time and a fresh tap id.
 *
 * Answers `{ok: true, holdUntil}` or a refusal:
 *   `changed`            the hash is stale (or empty) — nothing was written;
 *   `frozen`             the row is in a state a tap cannot be taken from;
 *   `not_found`          no such draft, no such account, no head revision;
 *   `auth_failed`        the account's sign-in is failing;
 *   `claimed_elsewhere`  another instance connects this address (with the fixed sentence);
 *   `not_sendable`       no keychain key, so no seal (`reason: "keychain_key_missing"`), or no running
 *                        supervisor to send through (`reason: "supervisor_missing"`);
 *   `preflight`          the draft itself blocks a send (`preflight` carries the code);
 *   `confirm_needed`     from `unknown`: no confirm (`confirm_unknown`), or no Sent-folder check has
 *                        run yet (`reconcile_first`).
 *
 * The hash guard is `transition()`'s own `expectHash`: a tap whose hash is not the row's head hash
 * loses there and nothing else in the row changes.
 *
 * @param {object} db
 * @param {object} deps see the module note
 * @param {{draftId: string, hash: string, now?: number|Function, confirmUnknown?: boolean}} options
 */
export async function requestSend(db, deps, options = {}) {
  const d = resolveDeps(db, deps);
  const now = nowOf(d, options);
  const draftId = options?.draftId;
  const hash = options?.hash;
  // An absent hash is never a permission: it is the one thing the tap is, so it is refused first.
  if (typeof hash !== "string" || !hash) return { ok: false, code: "changed" };
  if (typeof draftId !== "string" || !draftId) return { ok: false, code: "not_found" };

  const row = await getDraft(db, draftId);
  if (!row) return { ok: false, code: "not_found" };
  if (!SENDABLE_STATES.includes(row.state) && row.state !== "unknown") {
    return { ok: false, code: "frozen", state: row.state };
  }

  // Nowhere to send from: refuse the tap before anything is claimed or written, so the row is not
  // left in a tap state a later tick would have to guess about.
  if (adapterMissing(d)) return { ok: false, code: "not_sendable", reason: "supervisor_missing" };

  const account = await getAccount(db, row.accountId);
  if (!account) return { ok: false, code: "not_found" };
  if (account.status === "auth_failed") return { ok: false, code: "auth_failed" };
  if (account.status === "claimed_elsewhere") {
    return { ok: false, code: "claimed_elsewhere", sentence: claimedElsewhereSentence(null) };
  }

  // No key, no seal: the tap cannot be written at all, so nothing is claimed and nothing is sent.
  const seed = await d.loadKey();
  if (!seed) {
    return {
      ok: false, code: "not_sendable", reason: "keychain_key_missing",
      sentence: KEYCHAIN_KEY_MISSING_SENTENCE,
    };
  }

  const rev = await headRevision(db, row);
  if (!rev) return { ok: false, code: "not_found" };
  let checked;
  try {
    checked = await preflight(db, row, rev, { accountId: row.accountId, deps: readerDeps(d) });
  } catch (err) {
    if (err instanceof MailError && err.code === "NOT_FOUND") return { ok: false, code: "not_found" };
    throw err;
  }
  if (!checked.ok) return { ok: false, code: "preflight", preflight: checked };

  // Is this instance the one connected to the address? Answered at tap time, so a doomed tap is
  // refused before anything is claimed.
  const claim = await d.isClaimedElsewhere(account);
  if (claim && claim.claimed) {
    return {
      ok: false, code: "claimed_elsewhere",
      instanceName: claim.instanceName ?? null,
      sentence: claimedElsewhereSentence(claim.instanceName),
    };
  }

  // A resend after an interrupted one needs two things: the person's own confirm, and at least one
  // Sent-folder check, so a late success was seen before the same message is offered again.
  if (row.state === "unknown") {
    if (options?.confirmUnknown !== true) return { ok: false, code: "confirm_needed", reason: "confirm_unknown" };
    if (row.reconcileCount < 1) return { ok: false, code: "confirm_needed", reason: "reconcile_first" };
  }

  const holdUntil = now + HOLD_MS;
  const tapId = newTapId();
  const seal = sealFor({
    draftId: row.id,
    headHash: hash,
    action: "send",
    when: holdUntil,
    attachDigest: checked.attachDigest,
    accountId: row.accountId,
    fromAddress: checked.fromAddress,
    tapId,
  }, seed);
  const from = row.state === "unknown" ? ["unknown"] : [row.state];
  const fields = {
    hold_until: holdUntil,
    tap_seal: seal,
    tap_id: tapId,
    tap_action: "send",
    attach_digest: checked.attachDigest,
  };
  const moved = await transition(db, row.id, from, "holding", fields, { now, expectHash: hash });
  if (!moved) return { ok: false, code: "changed" };

  // The hold's own timer: the tick sweep is the recovery path, not the primary one. A timer that fires
  // while a later tap's hold is still running answers `not_due` and re-arms itself for the rest of that
  // longer hold, so an undo followed by a second tap never sends on the first tap's clock. It re-arms
  // for a `holding` row only: a row that has since been scheduled, discarded or sent has no hold to
  // wait out — a schedule can be months away — and the tick is what delivers it.
  const fire = (delayMs) => {
    try {
      return d.schedule(() => deliver(db, deps, row.id, { now: nowOf(d, {}) })
        .then((outcome) => {
          if (outcome?.outcome === "not_due" && outcome.state === "holding") {
            const rest = Math.floor(Number(outcome.retryInMs));
            if (Number.isFinite(rest) && rest > 0) fire(Math.min(rest, HOLD_MS, MAX_TIMER_MS));
          }
          return outcome;
        })
        .catch((err) => {
          logCode("deliver_failed", codeOf(err));
          return null;
        }), delayMs);
    } catch (err) {
      logCode("schedule_failed", codeOf(err));
      return null;
    }
  };
  fire(HOLD_MS);
  return { ok: true, holdUntil };
}

/**
 * The undo: `holding -> draft` through `transition()`, so the seal is cleared in the same UPDATE. Too
 * late to undo (`sending`, `sent`, `unknown`) answers the fixed sentence and changes nothing.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{draftId: string, now?: number|Function}} options
 * @returns {Promise<{ok: true}|{ok: false, state: string|null, sentence?: string}>}
 */
export async function undoSend(db, deps, options = {}) {
  const d = resolveDeps(db, deps);
  const now = nowOf(d, options);
  const draftId = options?.draftId;
  if (typeof draftId !== "string" || !draftId) return { ok: false, state: null };
  if (await transition(db, draftId, ["holding"], "draft", {}, { now })) return { ok: true };
  const row = await getDraft(db, draftId);
  const state = row?.state ?? null;
  if (state === "sending" || state === "sent" || state === "unknown") {
    return { ok: false, state, sentence: ALREADY_WENT_OUT_SENTENCE };
  }
  return { ok: false, state };
}

/* ----------------------------------------------------------------- the delivery */

/**
 * Deliver the tap the row carries, exactly once.
 *
 * (0) Read the row and check the tap itself first: rebuild the head revision's hash with `hashOf` —
 * never from a stored hash column — and require it to equal the sealed head hash; load the account and
 * require it to still exist; recompute the sealed From text from that account; verify the seal. A bad
 * seal or hash, a missing account and a missing key each CAS `holding|scheduled` out of the tap state
 * with a fixed `fail_reason` and no adapter is called. Only a seal that verifies is then looked at for
 * its time: still in the future answers `{outcome: "not_due", state}` and writes nothing (the tap's own
 * timer re-arms for the rest of the hold when the row is still `holding`, and a `scheduled` row is left
 * to the tick), and past the grace window is `missed`.
 * (1) Claim with one guarded UPDATE from `holding|scheduled`, guarded by the seal, the tap id and the
 * head hash, writing a fresh `claim_token`, `claimed_at`, a fresh attempt (`attempt_at` cleared, the
 * reconcile reset, the old `fail_reason` gone) and — when the row has none — a message id.
 * Losing that UPDATE is `{outcome: "lost_claim"}` and nothing else happens.
 * (2) Put the draft in this process's in-flight map right after the claim wins, rebuild the message
 * through `preflight` (the attachment digest must be the sealed one) and stamp `attempt_at` with a
 * write guarded by the claim token: a row that moved under the claim is `{outcome: "lost_claim"}` and
 * no socket is opened.
 * (3) Send through `withAdapter`.
 * (4) Settle by `claim_token`, and only then — for an account whose Sent copy is appended — compose the
 * copy and append it, then ask for a sync. A failure there never changes the state.
 *
 * @param {object} db
 * @param {object} deps
 * @param {string} draftId
 * @param {{now?: number|Function}} [options]
 * @returns {Promise<{outcome: string, reason?: string, messageId?: string|null}>}
 */
export async function deliver(db, deps, draftId, options = {}) {
  const d = resolveDeps(db, deps);
  const now = nowOf(d, options);
  if (typeof draftId !== "string" || !draftId) return { outcome: "not_found" };

  const row = await getDraft(db, draftId);
  if (!row) return { outcome: "not_found" };
  if (row.state !== "holding" && row.state !== "scheduled") {
    return { outcome: "lost_claim", state: row.state };
  }

  // ---- (0) the tap itself, checked again in this process: the seal and the recomputed hash first.
  const action = actionOf(row);
  const when = whenOf(row);
  const rev = await headRevision(db, row);
  if (!rev) return failPending(db, draftId, now, "seal");
  const recomputed = hashOf(revisionToInput(rev), { mode: row.mode });
  if (recomputed !== row.headHash) return failPending(db, draftId, now, "seal");

  // The account the tap was taken for, before the seal: a mailbox that is gone says so, and the seal
  // is checked against the From that account has now.
  const account = await getAccount(db, row.accountId);
  if (!account) return failPending(db, draftId, now, "account_removed");

  const seed = await d.loadKey();
  if (!seed) return failPending(db, draftId, now, "keychain_key_missing");
  if (when == null || row.attachDigest == null || row.tapId == null || row.tapAction !== action) {
    return failPending(db, draftId, now, "seal");
  }
  const verified = verifySeal({
    draftId: row.id,
    headHash: row.headHash,
    action,
    when,
    attachDigest: row.attachDigest,
    accountId: row.accountId,
    fromAddress: sealFromAddress(account),
    tapId: row.tapId,
  }, row.tapSeal, seed);
  if (!verified) return failPending(db, draftId, now, "seal");

  // The seal is good, so the time it was taken for is the next question: a hold that is still running
  // is left exactly as it is, for the tap's own timer (or the tick) to come back to. The state travels
  // with the answer, so a timer knows whether there is a hold left to wait out at all.
  if (when > now) return { outcome: "not_due", state: row.state, when, retryInMs: when - now };
  if (now - when > GRACE_MS) return failPending(db, draftId, now, "missed", "missed");

  // No supervisor is no adapter: refuse before the claim, and leave the row where it is.
  if (adapterMissing(d)) {
    return { outcome: "not_sendable", reason: "supervisor_missing", state: row.state };
  }

  // ---- (1) the claim: one guarded UPDATE, and only this one may start the socket. The attempt is
  // fresh: the previous one (and any reconcile pointing at it) belonged to an earlier try.
  const claimToken = String(d.newId());
  const messageId = row.messageId ?? `<${d.newId()}@${domainOf(account.address)}>`;
  const claim = await db.execute({
    sql: `UPDATE mail_drafts
             SET state = 'sending', claim_token = ?, claimed_at = ?, attempt_at = NULL,
                 reconcile_count = 0, next_reconcile_at = NULL, fail_reason = NULL, message_id = ?,
                 tap_seal = NULL, tap_id = NULL, tap_action = NULL, attach_digest = NULL, updated_at = ?
           WHERE id = ? AND state IN ('holding', 'scheduled') AND tap_seal = ? AND tap_id = ?
             AND head_hash = ?`,
    args: [claimToken, now, messageId, now, row.id, row.tapSeal, row.tapId, row.headHash],
  });
  if (claim.rowsAffected !== 1) {
    return { outcome: "lost_claim", state: (await getDraft(db, draftId))?.state ?? null };
  }

  // The row is this process's from here on: in the map before the bytes are rebuilt, so a slow
  // attachment read is never mistaken for an interrupted send, and out of it in the finally below.
  d.inFlight.set(draftId, { claimToken, at: now });
  try {
    // ---- (2) the bytes a person agreed to, rebuilt after the claim.
    const claimed = { ...row, state: "sending", claimToken, messageId };
    let checked;
    try {
      checked = await preflight(db, claimed, rev, { accountId: row.accountId, deps: readerDeps(d) });
    } catch {
      await settle(db, draftId, claimToken, "failed", { now, failReason: phraseFor("bad_input") });
      return { outcome: "failed", reason: "bad_input" };
    }
    if (!checked.ok) {
      const reason = checked.code === "too_large" ? "too_large" : "bad_input";
      await settle(db, draftId, claimToken, "failed", { now, failReason: phraseFor(reason) });
      return { outcome: "failed", reason };
    }
    if (checked.attachDigest !== row.attachDigest) {
      await settle(db, draftId, claimToken, "failed", { now, failReason: phraseFor("attachment_changed") });
      return { outcome: "failed", reason: "attachment_changed" };
    }

    // ---- (3) stamp the attempt and send. The stamp is guarded by the claim token: a row that moved
    // under the claim is never handed to the adapter.
    const attempt = await db.execute({
      sql: `UPDATE mail_drafts SET attempt_at = ?, updated_at = ?
             WHERE id = ? AND state = 'sending' AND claim_token = ?`,
      args: [now, now, draftId, claimToken],
    });
    if (attempt.rowsAffected !== 1) {
      return { outcome: "lost_claim", state: (await getDraft(db, draftId))?.state ?? null };
    }
    const result = await d.withAdapter(row.accountId, (adapter) => adapter.send(checked.message));
    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];

    if (accepted.length === 0) {
      await settle(db, draftId, claimToken, "failed", { now, failReason: phraseFor("all_rejected") });
      return { outcome: "failed", reason: "all_rejected", rejectedCount: rejected.length };
    }

    const sentMessageId = typeof result?.messageId === "string" && result.messageId
      ? result.messageId
      : messageId;
    await settle(db, draftId, claimToken, "sent", { now, sentAt: now });
    await afterSent(db, d, account, checked.message);
    return {
      outcome: "sent",
      messageId: sentMessageId,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      // A partial refusal is a code and a count: the card owns the sentence.
      notes: rejected.length ? [{ code: "rejected_recipients", count: rejected.length }] : [],
    };
  } catch (err) {
    // Only the code: an adapter's message can quote a server reply, a username or an address.
    const code = codeOf(err);
    logCode("send_failed", code);
    const unknownReason = UNKNOWN_OUTCOMES[code];
    if (unknownReason) {
      const changed = await markUnknown(db, draftId, claimToken, now, unknownReason);
      return { outcome: "unknown", reason: unknownReason, changed };
    }
    const reason = FAILED_OUTCOMES[code] ?? "send_failed";
    await settle(db, draftId, claimToken, "failed", { now, failReason: phraseFor(reason) });
    return { outcome: "failed", reason };
  } finally {
    d.inFlight.delete(draftId);
  }
}

/**
 * The Sent copy, per the account's `sent_copy`: `provider` files it and needs nothing here, `append`
 * composes the message again with `keepBcc` and appends it through the same borrowed connection. Then
 * the sync is asked for, so Crow's own folder does not trail the provider. Neither failure changes the
 * send: the message left, and that is what the row says.
 */
async function afterSent(db, d, account, message) {
  if (account.sentCopy === "append") {
    try {
      const raw = await d.composeRaw(message, { keepBcc: true });
      await d.withAdapter(account.id, (adapter) => adapter.appendToSent(raw));
    } catch (err) {
      logCode("sent_copy_failed", codeOf(err));
    }
  }
  try {
    const pending = d.requestSync(account.id);
    if (pending != null && typeof pending.catch === "function") pending.catch(() => {});
  } catch (err) {
    logCode("sent_sync_failed", codeOf(err));
  }
}

/* --------------------------------------------------------------- the reconcile */

/** The first stored copy of `messageId` in one of this account's Sent-role folders, or null. */
async function sentCopyOf(db, accountId, messageId) {
  if (typeof messageId !== "string" || !messageId) return null;
  const { rows } = await db.execute({
    sql: `SELECT m.id AS id, f.path AS path, f.name AS name, f.special_use AS special_use,
                 f.delimiter AS delimiter
            FROM mail_messages AS m
            JOIN mail_folders AS f ON f.id = m.folder_id
           WHERE m.account_id = ? AND f.account_id = m.account_id AND m.message_id = ?
           LIMIT 20`,
    args: [accountId, messageId],
  });
  for (const row of rows) {
    if (folderRole({ path: row.path, name: row.name, specialUse: row.special_use, delimiter: row.delimiter }) === "sent") {
      return row;
    }
  }
  return null;
}

/**
 * One Sent-folder check for an `unknown` row: ask for a sync, look the message id up in the account's
 * Sent-role folders, and either settle `sent` or count the attempt and point the next check at +5 min,
 * +15 min, then an hour on — for at most 24 hours from `attempt_at`, after which the row stays
 * `unknown` and no further check is due.
 *
 * Answers `{outcome: "sent"|"unknown"|"stopped"|"not_due"|"not_unknown"|"not_found"|"lost"}`.
 *
 * @param {object} db
 * @param {object} deps
 * @param {string} draftId
 * @param {{now?: number|Function}} [options]
 */
export async function reconcileUnknown(db, deps, draftId, options = {}) {
  const d = resolveDeps(db, deps);
  const now = nowOf(d, options);
  if (typeof draftId !== "string" || !draftId) return { outcome: "not_found" };
  const row = await getDraft(db, draftId);
  if (!row) return { outcome: "not_found" };
  if (row.state !== "unknown") return { outcome: "not_unknown", state: row.state };

  const attemptAt = row.attemptAt ?? row.claimedAt;
  if (attemptAt == null) return { outcome: "unknown", reason: "no_attempt" };
  if (now - Number(attemptAt) > RECONCILE_WINDOW_MS) {
    // The window is over: the row stays `unknown` (never "not sent") and nothing more is due.
    await db.execute({
      sql: "UPDATE mail_drafts SET next_reconcile_at = NULL, updated_at = ? WHERE id = ? AND state = 'unknown'",
      args: [now, row.id],
    });
    return { outcome: "stopped", attempts: row.reconcileCount };
  }
  if (row.nextReconcileAt != null && now < row.nextReconcileAt) {
    return { outcome: "not_due", nextReconcileAt: row.nextReconcileAt };
  }

  // The sync is asked for and not awaited: a full account run can take minutes, and the lookup below
  // reads what this Crow already holds.
  try {
    const pending = d.requestSync(row.accountId);
    if (pending != null && typeof pending.catch === "function") pending.catch(() => {});
  } catch (err) {
    logCode("reconcile_sync_failed", codeOf(err));
  }

  if (await sentCopyOf(db, row.accountId, row.messageId)) {
    const settled = await settle(db, row.id, row.claimToken, "sent", { now, sentAt: now });
    return { outcome: settled ? "sent" : "lost", messageId: row.messageId };
  }

  const attempts = row.reconcileCount + 1;
  const next = nextReconcileAt(attemptAt, attempts);
  const result = await db.execute({
    sql: `UPDATE mail_drafts SET reconcile_count = ?, next_reconcile_at = ?, updated_at = ?
           WHERE id = ? AND state = 'unknown'`,
    args: [attempts, next, now, row.id],
  });
  return {
    outcome: result.rowsAffected === 1 ? "unknown" : "lost",
    attempts,
    nextReconcileAt: next,
  };
}