/**
 * Staged outbound sends (spec §12): one row per provider draft a bot made, from the draft call to the
 * operator's yes. The row holds what the operator was shown (the canonical snapshot and its hash)
 * and where it came from (session/thread/card/job, and the credential reference the draft was made
 * with). The table is local only (instance-sync LOCAL_ONLY_TABLES): it holds addresses and bodies.
 *
 * Claiming is the whole safety story. `claimSend` is one compare-and-set on (state, content_hash):
 * of two racing claims exactly one changes a row, so a double tap on two devices still produces one
 * send, and a snapshot the operator did not see can never be claimed. A `failed` row may be claimed
 * again (the operator's retry); a `sending` row may be settled back to `staged` when the provider
 * changed after the claim (`reconcileStale` finds the ones that got stuck); a `sent` row never leaves
 * `sent`.
 *
 * Only the dashboard route calls claimSend/settle. No MCP tool does — a bot must never move a row to
 * `sending` or `sent` (spec §12.3 item 3).
 *
 * `fail_reason` is an operator-facing sentence the route chooses. It must never carry the provider's
 * response body or an address; the store caps its length only.
 */
import { randomBytes } from "node:crypto";
import { canonicalSnapshot, contentHash, parseAddressList } from "./canonical.js";

/** Every state a row may hold. The table has no CHECK: this list is the validation. */
export const STAGED_STATES = Object.freeze(["staged", "sending", "sent", "replaced", "discarded", "failed"]);

/** What listStaged shows unless a caller names states: the card's open work, plus retryable failures. */
export const STAGED_OPEN = Object.freeze(["staged", "sending", "failed"]);

/** The states `settle` may leave, and the states it may leave them from. `failed` may also come from
 *  `staged`: the send route re-reads the provider before it claims, and a draft deleted in Gmail
 *  fails the card right there, with no claim ever taken. */
const SETTLE_FROM = Object.freeze({
  sent: ["sending"],
  failed: ["staged", "sending"],
  replaced: ["staged", "failed"],
  discarded: ["staged", "failed"],
  // Back to `staged`: the provider changed after the claim (or the claim timed out before anything
  // was sent), so the operator has to review it again. Nothing was sent by us in that case.
  staged: ["sending"],
});

const FAIL_REASON_MAX = 200;
const LIST_DEFAULT_LIMIT = 200;
const CRED_ROLES = Object.freeze(["primary", "personal"]);

function bad(message, code) {
  return Object.assign(new Error(message), { code });
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function credRefJson(credRef) {
  if (credRef == null) return null;
  const server = credRef.server == null ? "" : String(credRef.server);
  if (!server || !CRED_ROLES.includes(credRef.role)) return null;
  // `source` (which operator file named it) is kept when it is one of the known ones; the send
  // resolves the token in that file only (cred-ref.js).
  const source = credRef.source === "canonical" || credRef.source === "addons" ? credRef.source : null;
  return JSON.stringify(source ? { server, role: credRef.role, source } : { server, role: credRef.role });
}

function cap(value, max) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function requireText(value, field) {
  if (value == null || String(value).trim() === "") throw bad(`staged_sends: ${field} is required`, "missing_field");
  return String(value);
}

/** A row as the routes and the card read it: camelCase, with the JSON columns parsed. */
function toStaged(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    botId: row.bot_id == null ? null : String(row.bot_id),
    cardId: row.card_id == null ? null : Number(row.card_id),
    jobId: row.job_id == null ? null : String(row.job_id),
    channel: String(row.channel),
    credRef: parseJson(row.cred_ref),
    providerDraftId: String(row.provider_draft_id),
    providerThreadId: row.provider_thread_id == null ? null : String(row.provider_thread_id),
    snapshot: parseJson(row.snapshot, {}),
    contentHash: String(row.content_hash),
    state: String(row.state),
    failReason: row.fail_reason == null ? null : String(row.fail_reason),
    tainted: !!row.tainted,
    newRecipients: parseJson(row.new_recipients),
    sourceFlags: parseJson(row.source_flags),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
    providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const INSERT_COLUMNS = `(id, session_id, thread_id, bot_id, card_id, job_id, channel, cred_ref,
             provider_draft_id, provider_thread_id, snapshot, content_hash, state,
             tainted, new_recipients, source_flags, created_at, updated_at)`;
const INSERT_VALUES = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?)`;

/**
 * A new row's id and statement: the snapshot is canonicalised and hashed here so the two cannot
 * drift. With `guardId` the insert is conditional on that row still being replaceable, which is what
 * lets `replaceWith` do its compare-and-set and its insert in one transaction.
 */
function insertPlan(fields = {}, guardId = null) {
  const snapshot = canonicalSnapshot(fields.snapshot || {});
  const id = "ss-" + randomBytes(8).toString("hex");
  const t = Date.now();
  const args = [
    id,
    fields.sessionId == null ? null : String(fields.sessionId),
    fields.threadId == null ? null : String(fields.threadId),
    fields.botId == null ? null : String(fields.botId),
    fields.cardId == null ? null : Number(fields.cardId),
    fields.jobId == null ? null : String(fields.jobId),
    fields.channel == null ? "gmail" : String(fields.channel),
    credRefJson(fields.credRef),
    requireText(fields.providerDraftId, "providerDraftId"),
    fields.providerThreadId == null ? null : String(fields.providerThreadId),
    JSON.stringify(snapshot),
    contentHash(snapshot),
    fields.tainted ? 1 : 0,
    fields.newRecipients == null ? null : JSON.stringify(fields.newRecipients),
    fields.sourceFlags == null ? null : JSON.stringify(fields.sourceFlags),
    t,
    t,
  ];
  const sql = guardId == null
    ? `INSERT INTO staged_sends ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`
    // INSERT … SELECT … WHERE: the row only lands if the old one can still be replaced.
    : `INSERT INTO staged_sends ${INSERT_COLUMNS} SELECT ${INSERT_VALUES.slice(1, -1)}
         WHERE EXISTS (SELECT 1 FROM staged_sends WHERE id = ? AND state IN ('staged', 'failed'))`;
  return { id, sql, args: guardId == null ? args : [...args, String(guardId)] };
}

/** Insert one staged draft; `snapshot` is canonicalised and hashed here so the two cannot drift. */
export async function createStaged(db, fields = {}) {
  const plan = insertPlan(fields);
  await db.execute({ sql: plan.sql, args: plan.args });
  return plan.id;
}

export async function getStaged(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM staged_sends WHERE id = ?", args: [String(id)] });
  return toStaged(rows[0]);
}

/**
 * The row already recorded for this provider draft with this credential, or null — the recorder's
 * idempotency check. Every state counts: a draft the operator already sent or discarded must not
 * come back as a new card because a resumed turn replayed the same tool call. `cred_ref` NULL
 * ("Open in Gmail to send") matches NULL, so `IS` rather than `=`.
 */
export async function findStagedByDraftId(db, { providerDraftId, credRef = null, orUnreadable = false } = {}) {
  const draft = providerDraftId == null ? "" : String(providerDraftId);
  if (!draft) return null;
  // The same draft is the same server and role; a source is compared only when both rows have one
  // (a row recorded before sources existed matches either). orUnreadable: a row for this draft
  // recorded with NO credential is the same draft too, so a replay never adds a second, sendable
  // row next to it.
  const ref = credRefJson(credRef) ? JSON.parse(credRefJson(credRef)) : null;
  const match = ref
    ? "(json_extract(cred_ref,'$.server') = ? AND json_extract(cred_ref,'$.role') = ? AND (json_extract(cred_ref,'$.source') IS NULL OR ? IS NULL OR json_extract(cred_ref,'$.source') = ?))"
    : "cred_ref IS NULL";
  const args = ref ? [draft, ref.server, ref.role, ref.source ?? null, ref.source ?? null] : [draft];
  const { rows } = await db.execute({
    sql: `SELECT * FROM staged_sends WHERE provider_draft_id = ? AND (${match}${orUnreadable && ref ? " OR cred_ref IS NULL" : ""}) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    args,
  });
  return toStaged(rows[0]);
}

/**
 * Rows in the given scope, newest first. `states` defaults to STAGED_OPEN; `sessionId`, `cardId` and
 * `threadId` are ANDed, and naming none of them lists every row in those states (the Board's
 * needs-you prefetch).
 */
export async function listStaged(db, { sessionId, cardId, threadId, states, limit } = {}) {
  const wanted = Array.isArray(states) && states.length ? states : [...STAGED_OPEN];
  for (const s of wanted) {
    if (!STAGED_STATES.includes(s)) throw bad(`staged_sends: unknown state ${JSON.stringify(s)}`, "bad_state");
  }
  const where = [`state IN (${wanted.map(() => "?").join(",")})`];
  const args = [...wanted];
  if (sessionId != null) { where.push("session_id = ?"); args.push(String(sessionId)); }
  if (cardId != null) { where.push("card_id = ?"); args.push(Number(cardId)); }
  if (threadId != null) { where.push("thread_id = ?"); args.push(String(threadId)); }
  const n = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || LIST_DEFAULT_LIMIT));
  const { rows } = await db.execute({
    sql: `SELECT * FROM staged_sends WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [...args, n],
  });
  return rows.map(toStaged);
}

/**
 * Take the send slot: `staged`/`failed` -> `sending`, only for the snapshot whose hash the operator
 * saw. True for exactly one of any number of racing calls; false means "already sent/in flight, or
 * the stored snapshot is not this one" and the caller must not call the provider.
 */
export async function claimSend(db, id, hash) {
  if (hash == null || String(hash) === "") return false;
  const r = await db.execute({
    sql: `UPDATE staged_sends SET state = 'sending', fail_reason = NULL, updated_at = ?
           WHERE id = ? AND state IN ('staged', 'failed') AND content_hash = ?`,
    args: [Date.now(), String(id), String(hash)],
  });
  return r.rowsAffected === 1;
}

/**
 * The edit's short claim: bump `updated_at` on a row that is still `staged`/`failed` and hand back
 * the stamp, or null when the row has left those states (a send claimed it, it was discarded, it
 * was replaced). The state does not change — an edit is not a send — but every write the edit makes
 * afterwards is a CAS on this stamp, so an edit whose provider call failed can never reopen a row
 * that a send took over while it was away.
 */
export async function claimEdit(db, id) {
  const at = Date.now();
  const r = await db.execute({
    sql: "UPDATE staged_sends SET updated_at = ? WHERE id = ? AND state IN ('staged', 'failed')",
    args: [at, String(id)],
  });
  return r.rowsAffected === 1 ? at : null;
}

/**
 * Settle a FAILED edit: the provider refused the rewrite. Never `settle`'s `sending` -> `failed`
 * transition (that is the send's own failure, and using it here is how a live send got reopened):
 * this write only applies to a row still in `staged`/`failed` AND untouched since the edit took its
 * claim. False means the row moved on (a send is in flight, or it already ended) and nothing was
 * written — the caller answers "changed" and the card re-reads the row.
 */
export async function failEdit(db, id, { at, failReason = null } = {}) {
  if (at == null) return false;
  const r = await db.execute({
    sql: `UPDATE staged_sends SET state = 'failed', fail_reason = ?, updated_at = ?
           WHERE id = ? AND state IN ('staged', 'failed') AND updated_at = ?`,
    args: [cap(failReason, FAIL_REASON_MAX), Date.now(), String(id), Number(at)],
  });
  return r.rowsAffected === 1;
}

/**
 * Record where the send ended: `sent` (with the provider's message id, and sent_at) or `failed`
 * (with the operator-facing reason). `replaced`/`discarded` end a row without a send. All are
 * compare-and-sets, so a row already `sent` never changes; false means the row was not in the state
 * this settle starts from.
 *
 * `expectedUpdatedAt` narrows the CAS to the row a caller READ: the sweeper passes the `sending`
 * row's own stamp, so a row that was touched since (a claim settled, a retry claimed it again) is
 * left alone. Put back into `staged` it would read as "ready to send" and could go out twice.
 */
export async function settle(db, id, { state, providerMessageId = null, failReason = null, expectedUpdatedAt = null } = {}) {
  const from = SETTLE_FROM[state];
  if (!from) throw bad(`staged_sends: cannot settle to ${JSON.stringify(state)}`, "bad_state");
  const t = Date.now();
  const sets = ["state = ?", "updated_at = ?"];
  const args = [state, t];
  if (state === "sent") { sets.push("sent_at = ?"); args.push(t); }
  if (state !== "failed") sets.push("fail_reason = NULL");
  if (state === "failed") { sets.push("fail_reason = ?"); args.push(cap(failReason, FAIL_REASON_MAX)); }
  if (providerMessageId != null) { sets.push("provider_message_id = ?"); args.push(String(providerMessageId)); }
  const unchanged = expectedUpdatedAt == null ? "" : " AND updated_at = ?";
  const r = await db.execute({
    sql: `UPDATE staged_sends SET ${sets.join(", ")} WHERE id = ? AND state IN (${from.map(() => "?").join(",")})${unchanged}`,
    args: [
      ...args, String(id), ...from,
      ...(expectedUpdatedAt == null ? [] : [Number(expectedUpdatedAt)]),
    ],
  });
  return r.rowsAffected === 1;
}

/**
 * A new draft card for the same thread ("Ask for a change" answered with a fresh draft): the old row
 * becomes `replaced` and a new row is created. The new row inherits the thread/session/card/bot and
 * the credential reference, and takes the new provider draft id and snapshot.
 *
 * Both statements run in ONE transaction (db.batch) under the same predicate — the old row is still
 * `staged`/`failed` — so a send claim that wins the race either both stops the replacement or leaves
 * it whole: there is no window where the old card is replaced and the new one is missing, and no
 * window where a row claimed for send gets replaced under the claim. A CAS that changes nothing
 * throws `not_replaceable` and the insert never happens (it is guarded by the same predicate).
 */
export async function replaceWith(db, oldId, newFields = {}) {
  const old = await getStaged(db, oldId);
  if (!old) throw bad("staged_sends: no such row", "not_found");
  if (!SETTLE_FROM.replaced.includes(old.state)) {
    throw bad(`staged_sends: a ${old.state} row cannot be replaced`, "not_replaceable");
  }
  const plan = insertPlan({
    sessionId: old.sessionId,
    threadId: old.threadId,
    botId: old.botId,
    cardId: old.cardId,
    jobId: old.jobId,
    channel: old.channel,
    credRef: old.credRef,
    providerThreadId: old.providerThreadId,
    tainted: old.tainted,
    // Reserved for the "sensitive source" flag: an edit or a bot's change must never wash it off.
    sourceFlags: old.sourceFlags,
    ...newFields,
  }, oldId);
  const casAt = Date.now();
  const results = await db.batch([
    { sql: plan.sql, args: plan.args },
    {
      sql: `UPDATE staged_sends SET state = 'replaced', fail_reason = NULL, updated_at = ?
             WHERE id = ? AND state IN ('staged', 'failed')`,
      args: [casAt, String(oldId)],
    },
  ]);
  const [inserted, replaced] = results;
  if (!inserted || inserted.rowsAffected !== 1 || !replaced || replaced.rowsAffected !== 1) {
    throw bad(`staged_sends: a ${old.state} row cannot be replaced`, "not_replaceable");
  }
  return plan.id;
}

/** "Not now", after the send slot was never taken: staged/failed -> discarded. */
export async function discard(db, id) {
  return settle(db, id, { state: "discarded" });
}

/**
 * The `new_recipients` list (the addresses a reply adds, which the card calls out): canonicalised the
 * same way as the snapshot's lists, and replaced whole. `null` clears it back to "never asked" (the
 * hint is computed again on the next read); an empty ARRAY is a real answer — "none of these is
 * new" — and is stored as `"[]"` so it is read back as `[]` and never re-queried. True when the row
 * exists.
 */
export async function setNewRecipients(db, id, list) {
  const stored = list == null ? null : JSON.stringify(parseAddressList(list));
  const r = await db.execute({
    sql: "UPDATE staged_sends SET new_recipients = ?, updated_at = ? WHERE id = ?",
    args: [stored, Date.now(), String(id)],
  });
  return r.rowsAffected === 1;
}

/**
 * Ids of rows stuck in `sending` for longer than `olderThanMs` (the gateway or the provider died
 * between the claim and the settle). This changes NOTHING: the caller re-reads each draft and settles
 * it, and must settle it with `expectedUpdatedAt` = the stamp it read, so a row touched since is
 * never reopened. The default is ten minutes, far above a send's whole timeout budget (three 20 s
 * HTTP calls), because putting a LIVE send back to `staged` is a second send. A draft it can no
 * longer read (404) was either sent (Gmail deletes a draft once it is sent) or deleted by the
 * operator in Gmail, and there is no message id either way: the caller settles it with "sent or
 * deleted in Gmail" and leaves provider_message_id null. Retrying a send is never the answer: the
 * retry's read gets the 404, and a second `drafts.send` is never issued.
 */
export async function reconcileStale(db, { olderThanMs = 600_000, now = Date.now() } = {}) {
  const age = Math.max(0, Math.floor(Number(olderThanMs)) || 0);
  const cutoff = Math.floor(Number(now)) - age;
  const { rows } = await db.execute({
    sql: "SELECT id FROM staged_sends WHERE state = 'sending' AND updated_at <= ? ORDER BY updated_at ASC",
    args: [cutoff],
  });
  return rows.map((r) => String(r.id));
}