/**
 * Crow Mail's draft store: one draft card, the revisions a bot and the person wrote, the person's
 * comments and the voice note for a revision. The four tables are in
 * servers/shared/mail-schema.js (`MAIL_DRAFTS_DDL`); this module is their only writer.
 *
 * Two rules carry the card:
 *
 *  - `transition()` is the one place a draft's state changes, and it nulls the tap seal
 *    (`tap_seal`, `tap_id`, `tap_action`, `attach_digest`) in the SAME UPDATE for every move that
 *    does not end in `holding` or `scheduled`. A seal is bound to one tap (its `tap_id`) over one
 *    head hash, so a row that has left the state a tap put it in keeps nothing a later send could
 *    use. Entering those two states is the only way to set the four columns, and only the send and
 *    schedule services do that.
 *  - `hashOf()` gives a revision exactly one hash: the canonical snapshot's content hash extended
 *    with what the snapshot does not keep (display names, `inReplyTo`, `references`, mode, From and
 *    the attachment references). It is a pure function of a revision's fields, so a caller that
 *    needs "the hash of the revision I just read" rebuilds the input from the row
 *    (`revisionToInput`) and recomputes it, instead of trusting a stored hash column.
 *
 * A revision row is written once and never changes, which is what makes it the thing the person
 * read before pressing anything. Every write that may move the head is a compare-and-set on the
 * hash its author was looking at, so of two racing writers exactly one wins and an edit made
 * against a screen nobody else saw is refused rather than applied.
 *
 * Times are epoch ms from an injectable clock (`{ now }`, default `Date.now`). Modes, states, tap
 * actions, authors and comment states are validated here — the tables carry no CHECK — and a value
 * outside its list is a MailError BAD_INPUT whose detail names the field, never the value.
 */
import { createHash, randomBytes } from "node:crypto";
import { canonicalSnapshot, contentHash } from "../../staged/canonical.js";
import { MailError } from "../errors.js";
import { getAccount } from "../store/accounts.js";

/** How a draft was started. */
export const DRAFT_MODES = Object.freeze(["new", "reply", "reply_all", "forward"]);

/** Every state a draft row may hold. The table has no CHECK: this list is the validation. */
export const DRAFT_STATES = Object.freeze([
  "draft", "holding", "scheduled", "sending", "sent", "failed", "unknown", "missed", "discarded",
]);

/** The two words a tap can be sealed under. */
export const TAP_ACTIONS = Object.freeze(["send", "schedule"]);

/** Who wrote a revision: the bot, the person by hand, or the store itself. */
export const REVISION_AUTHORS = Object.freeze(["bot", "user", "system"]);

/** A comment's life: waiting for the next revision, folded into one, or dropped. */
export const COMMENT_STATES = Object.freeze(["queued", "applied", "dropped"]);

/** Where an attachment's bytes come from: the thread being answered, or Crow's own storage. */
export const ATTACHMENT_SOURCES = Object.freeze(["thread", "storage"]);

/** The states a bot or a person may add a revision to. Everything else is frozen or finished. */
const EDITABLE_STATES = Object.freeze(["draft", "failed", "missed"]);
/** The states a draft may be thrown away from. `holding`/`sending`/`scheduled`/`sent` are not. */
const DISCARDABLE_STATES = Object.freeze(["draft", "failed", "missed", "unknown"]);
/** The two states that carry a tap seal. */
const TAP_STATES = Object.freeze(["holding", "scheduled"]);
/** The four columns a tap writes and every other transition nulls. */
const SEAL_COLUMNS = Object.freeze(["tap_seal", "tap_id", "tap_action", "attach_digest"]);

/** The columns `transition()` may set, and nothing else. */
const TRANSITION_FIELDS = Object.freeze([
  "due_at", "hold_until", "message_id", "claim_token", "claimed_at", "attempt_at",
  "tap_seal", "tap_id", "tap_action", "attach_digest", "reconcile_count", "next_reconcile_at",
  "sent_at", "fail_reason", "notified_at",
]);
const TIME_FIELDS = new Set([
  "due_at", "hold_until", "claimed_at", "attempt_at", "next_reconcile_at", "sent_at", "notified_at",
]);
const TEXT_FIELDS = new Set(["message_id", "claim_token", "tap_seal", "tap_id", "attach_digest"]);

const FAIL_REASON_MAX = 200;
const ID_MAX = 120;

const DRAFT_COLUMNS = `id, account_id, mode, reply_to_mid, thread_key, project_id, bot_id,
  chat_thread_id, audience, state, head_rev, head_hash, due_at, hold_until, message_id,
  claim_token, claimed_at, attempt_at, tap_seal, tap_id, tap_action, attach_digest,
  reconcile_count, next_reconcile_at, sent_at, fail_reason, notified_at, created_at, updated_at`;

const REVISION_COLUMNS = `draft_id, rev, author, to_json, cc_json, bcc_json, subject, body,
  in_reply_to, references_json, attachments_json, from_json, mode, content_hash, note, created_at`;

/**
 * A refusal that has to undo work already done inside a transaction: thrown so SQLite rolls the
 * transaction back, caught by the caller that opened it, which returns `result`.
 */
class Rollback extends Error {
  constructor(result) {
    super("rollback");
    this.name = "Rollback";
    this.result = result;
  }
}

/* ------------------------------------------------------------------- validation */

function bad(detail) {
  return new MailError("BAD_INPUT", detail);
}

function missing(detail) {
  return new MailError("NOT_FOUND", detail);
}

function requireMember(value, list, detail) {
  if (!list.includes(value)) throw bad(detail);
  return value;
}

function requireId(value, detail) {
  if (typeof value !== "string" || !value || value.length > ID_MAX) throw bad(detail);
  return value;
}

function optionalId(value, detail) {
  if (value == null) return null;
  if (typeof value !== "string") throw bad(detail);
  const text = value.trim();
  return text || null;
}

function optionalInt(value, detail) {
  if (value == null) return null;
  if (!Number.isInteger(value)) throw bad(detail);
  return value;
}

function clockOf(options) {
  const now = options?.now ?? Date.now;
  return typeof now === "function" ? now : () => Number(now);
}

function stamp(clock) {
  const t = Math.floor(Number(clock()));
  if (!Number.isFinite(t) || t < 0) throw bad("time");
  return t;
}

/* ------------------------------------------------------------------------ values */

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A display name is header text: control characters become spaces, runs collapse, empty is null. */
function nameOrNull(value) {
  if (value == null) return null;
  const name = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/**
 * One recipient, exactly one addr-spec per entry: an entry that carries a whole header, angle
 * brackets, a display name inside the address string or whitespace is refused rather than parsed,
 * so what the hash covers is what the card showed.
 */
function normalizeAddr(entry) {
  if (entry == null) return null;
  const raw = typeof entry === "string" ? { address: entry } : entry;
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad("address");
  if (typeof raw.address !== "string") throw bad("address");
  const address = raw.address.trim().toLowerCase();
  if (!address) return null;
  if (/[\s<>]/.test(address)) throw bad("address");
  return { name: nameOrNull(raw.name), address };
}

function addrList(value, detail = "address") {
  if (value == null) return [];
  if (!Array.isArray(value)) throw bad(detail);
  const out = [];
  for (const entry of value) {
    const addr = normalizeAddr(entry);
    if (addr) out.push(addr);
  }
  return out;
}

function textList(value, detail) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw bad(detail);
  const out = [];
  for (const entry of value) {
    if (entry == null) continue;
    if (typeof entry !== "string") throw bad(detail);
    const text = entry.trim();
    if (text) out.push(text);
  }
  return out;
}

function attachmentRef(entry) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) throw bad("attachment");
  const source = entry.source == null ? "" : String(entry.source);
  requireMember(source, ATTACHMENT_SOURCES, "attachment");
  return {
    source,
    accountId: entry.accountId == null ? null : String(entry.accountId),
    mid: entry.mid == null ? null : String(entry.mid),
    index: Number.isInteger(entry.index) ? entry.index : null,
    fileId: entry.fileId == null ? null : String(entry.fileId),
    filename: entry.filename == null ? "" : String(entry.filename),
    size: Number.isInteger(entry.size) ? entry.size : null,
  };
}

function attachmentList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw bad("attachment");
  return value.map(attachmentRef).sort(compareAttachments);
}

/** The attachment's own identity: the stored file, else the message it was taken from. */
function attachmentId(ref) {
  return ref.fileId ?? ref.mid ?? "";
}

/** The one order attachments are hashed in: source, identity, index, then the rest of the tuple. */
function compareAttachments(a, b) {
  return cmp(a.source, b.source)
    || cmp(attachmentId(a), attachmentId(b))
    || cmp(a.index ?? -1, b.index ?? -1)
    || cmp(a.filename, b.filename)
    || cmp(a.size ?? -1, b.size ?? -1)
    || cmp(a.accountId ?? "", b.accountId ?? "");
}

/** Every field a revision is made of, normalised but not yet canonicalised against the snapshot. */
function normalizeInput(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) throw bad("input");
  const inReplyTo = input.inReplyTo == null ? "" : String(input.inReplyTo).trim();
  return {
    to: addrList(input.to),
    cc: addrList(input.cc),
    bcc: addrList(input.bcc),
    subject: input.subject == null ? "" : String(input.subject),
    body: input.body == null ? "" : String(input.body),
    inReplyTo: inReplyTo || null,
    references: textList(input.references, "references"),
    from: normalizeAddr(input.from),
    attachments: attachmentList(input.attachments),
    note: optionalId(input.note, "note"),
  };
}

/**
 * The addresses the canonical snapshot keeps, with the display names the snapshot drops: one entry
 * per address, in the snapshot's order (lower-cased, de-duplicated, sorted), so header order and
 * duplicate entries cannot move the stored list or the hash.
 */
function canonicalAddressList(list) {
  const addresses = canonicalSnapshot({ to: list.map((entry) => entry.address) }).to;
  const names = new Map();
  for (const entry of list) {
    if (entry.name && !names.has(entry.address)) names.set(entry.address, entry.name);
  }
  return addresses.map((address) => ({ name: names.get(address) ?? null, address }));
}

/**
 * A revision's stored fields: recipients and attachments canonicalised the way the snapshot and the
 * hash see them, subject and body taken from the snapshot itself (CR/LF collapsed, trailing
 * whitespace gone), and `from` supplied by this module from the account — never by the caller.
 */
function canonicalRevisionInput(input, from) {
  const normalised = normalizeInput(input);
  const snapshot = canonicalSnapshot({
    to: normalised.to.map((entry) => entry.address),
    cc: normalised.cc.map((entry) => entry.address),
    bcc: normalised.bcc.map((entry) => entry.address),
    subject: normalised.subject,
    body: normalised.body,
  });
  return {
    to: canonicalAddressList(normalised.to),
    cc: canonicalAddressList(normalised.cc),
    bcc: canonicalAddressList(normalised.bcc),
    subject: snapshot.subject,
    body: snapshot.body,
    inReplyTo: normalised.inReplyTo,
    references: normalised.references,
    from,
    attachments: normalised.attachments,
    note: normalised.note,
  };
}

/** The From an account puts on a revision: its address and the name the operator gave it. */
function fromOfAccount(account) {
  return { name: nameOrNull(account.displayName), address: String(account.address).trim().toLowerCase() };
}

/* -------------------------------------------------------------------------- hash */

/**
 * The hash of one revision: `contentHash` of the canonical snapshot (recipients, subject, body),
 * extended with a SHA-256 over the fields the snapshot does not keep — display names,
 * `inReplyTo`, `references`, mode, From and the attachment references (sorted by source, id and
 * index). The extension is one JSON object with a fixed key order, so the result depends on the
 * revision's values only: not on the order the caller wrote the keys, and not on the order the
 * recipients or the attachments arrived in.
 *
 * Pure: no database, no clock, no stored column. A caller holding a revision row recomputes the
 * hash with `hashOf(revisionToInput(row), { mode: row.mode })`.
 */
export function hashOf(input = {}, options = {}) {
  const normalised = normalizeInput(input);
  const mode = options?.mode ?? input?.mode ?? null;
  requireMember(mode, DRAFT_MODES, "mode");
  const base = contentHash({
    to: normalised.to.map((entry) => entry.address),
    cc: normalised.cc.map((entry) => entry.address),
    bcc: normalised.bcc.map((entry) => entry.address),
    subject: normalised.subject,
    body: normalised.body,
  });
  const names = [];
  for (const list of ["to", "cc", "bcc"]) {
    for (const entry of normalised[list]) {
      if (entry.name) names.push([list, entry.address, entry.name]);
    }
  }
  names.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]));
  const payload = {
    v: 1,
    base,
    names,
    inReplyTo: normalised.inReplyTo,
    references: normalised.references,
    mode,
    from: normalised.from,
    attachments: normalised.attachments.map((ref) => ({
      source: ref.source,
      accountId: ref.accountId,
      mid: ref.mid,
      index: ref.index,
      fileId: ref.fileId,
      filename: ref.filename,
      size: ref.size,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/* ------------------------------------------------------------------------- rows */

function num(value) {
  return value == null ? null : Number(value);
}

function jsonArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonObject(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function toDraft(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    mode: String(row.mode),
    replyToMid: row.reply_to_mid ?? null,
    threadKey: row.thread_key ?? null,
    projectId: num(row.project_id),
    botId: row.bot_id ?? null,
    chatThreadId: row.chat_thread_id ?? null,
    audience: row.audience ?? null,
    state: String(row.state),
    headRev: Number(row.head_rev),
    headHash: String(row.head_hash),
    dueAt: num(row.due_at),
    holdUntil: num(row.hold_until),
    messageId: row.message_id ?? null,
    claimToken: row.claim_token ?? null,
    claimedAt: num(row.claimed_at),
    attemptAt: num(row.attempt_at),
    tapSeal: row.tap_seal ?? null,
    tapId: row.tap_id ?? null,
    tapAction: row.tap_action ?? null,
    attachDigest: row.attach_digest ?? null,
    reconcileCount: Number(row.reconcile_count ?? 0),
    nextReconcileAt: num(row.next_reconcile_at),
    sentAt: num(row.sent_at),
    failReason: row.fail_reason ?? null,
    notifiedAt: num(row.notified_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * A revision row back into the input it was written from (and its mode and note), so a caller can
 * recompute the hash with `hashOf` without re-reading the body out of the card. Takes either the
 * stored row (snake_case) or the object `listRevisions` returns.
 */
export function revisionToInput(row) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) throw bad("revision");
  const pick = (column, field) => (row[column] !== undefined ? row[column] : row[field]);
  const normalised = normalizeInput({
    to: jsonArray(pick("to_json", "to")),
    cc: jsonArray(pick("cc_json", "cc")),
    bcc: jsonArray(pick("bcc_json", "bcc")),
    subject: pick("subject", "subject"),
    body: pick("body", "body"),
    inReplyTo: pick("in_reply_to", "inReplyTo"),
    references: jsonArray(pick("references_json", "references")),
    from: jsonObject(pick("from_json", "from")),
    attachments: jsonArray(pick("attachments_json", "attachments")),
    note: pick("note", "note"),
  });
  return {
    ...normalised,
    mode: pick("mode", "mode") ?? null,
    note: pick("note", "note") ?? normalised.note,
  };
}

function toRevision(row) {
  if (!row) return null;
  const input = revisionToInput(row);
  return {
    draftId: String(row.draft_id ?? row.draftId),
    rev: Number(row.rev),
    author: String(row.author),
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments,
    from: input.from,
    mode: input.mode,
    contentHash: String(row.content_hash ?? row.contentHash),
    note: input.note ?? null,
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

function toComment(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    rev: Number(row.rev),
    lineIndex: num(row.line_index),
    quote: row.quote ?? null,
    text: String(row.text),
    state: String(row.state),
    createdAt: Number(row.created_at),
  };
}

function revisionInsert(draftId, rev, author, input, mode, hash, createdAt) {
  return {
    sql: `INSERT INTO mail_draft_revisions
            (draft_id, rev, author, to_json, cc_json, bcc_json, subject, body, in_reply_to,
             references_json, attachments_json, from_json, mode, content_hash, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      draftId, rev, author,
      JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
      input.subject, input.body, input.inReplyTo,
      JSON.stringify(input.references), JSON.stringify(input.attachments), JSON.stringify(input.from),
      mode, hash, input.note ?? null, createdAt,
    ],
  };
}

/* -------------------------------------------------------------------- transitions */

/**
 * The value a whitelisted transition column is stored as. A times column is epoch ms (or null), the
 * text columns are strings (or null), `tap_action` one of the two tap words, `reconcile_count` a
 * counter and `fail_reason` a capped sentence. Anything else is BAD_INPUT.
 */
function fieldValue(key, value) {
  if (TIME_FIELDS.has(key)) {
    const t = optionalInt(value, "field");
    if (t != null && t < 0) throw bad("field");
    return t;
  }
  if (key === "reconcile_count") {
    if (!Number.isInteger(value) || value < 0) throw bad("field");
    return value;
  }
  if (key === "tap_action") return requireMember(value, TAP_ACTIONS, "tap_action");
  if (key === "fail_reason") {
    if (value == null) return null;
    if (typeof value !== "string") throw bad("fail_reason");
    return value.slice(0, FAIL_REASON_MAX);
  }
  if (TEXT_FIELDS.has(key)) {
    if (value == null) return null;
    if (typeof value !== "string") throw bad("field");
    return value;
  }
  throw bad("field");
}

/**
 * The one UPDATE behind `transition()`: `state` names the rows it may take (a compare-and-set on
 * `state IN (…)`, plus `head_hash = ?` when the caller passes `expectHash`), `fields` may set only
 * the whitelisted columns, and a move that does not END in `holding`/`scheduled` nulls the four
 * seal columns in the same statement — so no caller can forget to clear a tap.
 */
function transitionPlan(id, from, to, fields, options) {
  const clock = clockOf(options);
  const expectHash = options?.expectHash ?? null;
  requireId(id, "draft_id");
  requireMember(to, DRAFT_STATES, "state");
  if (!Array.isArray(from) || from.length === 0) throw bad("state");
  for (const state of from) requireMember(state, DRAFT_STATES, "state");
  if (fields != null && (typeof fields !== "object" || Array.isArray(fields))) throw bad("field");
  const carriesTap = TAP_STATES.includes(to);
  for (const key of Object.keys(fields ?? {})) {
    if (!TRANSITION_FIELDS.includes(key)) throw bad("field");
    if (SEAL_COLUMNS.includes(key) && !carriesTap) throw bad("field");
  }
  const sets = ["state = ?"];
  const args = [to];
  for (const key of TRANSITION_FIELDS) {
    if (!Object.hasOwn(fields ?? {}, key)) continue;
    sets.push(`${key} = ?`);
    args.push(fieldValue(key, fields[key]));
  }
  if (!carriesTap) for (const column of SEAL_COLUMNS) sets.push(`${column} = NULL`);
  sets.push("updated_at = ?");
  args.push(stamp(clock));
  const hashGuard = expectHash == null ? "" : " AND head_hash = ?";
  const sql = `UPDATE mail_drafts SET ${sets.join(", ")}
                WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})${hashGuard}`;
  args.push(id, ...from);
  if (expectHash != null) args.push(String(expectHash));
  return { sql, args };
}

/**
 * Move one draft from any of `from` to `to`, returning whether this call changed the row
 * (`rowsAffected === 1`). The single guarded UPDATE every later task uses; a state outside
 * `DRAFT_STATES`, a field outside the whitelist or a seal column on a move that is not into
 * `holding`/`scheduled` is BAD_INPUT and writes nothing. `expectHash` narrows the guard to the head
 * the caller read.
 *
 * @param {object} db
 * @param {string} id
 * @param {string[]} from the states the row may be in
 * @param {string} to the state to write
 * @param {object} [fields] whitelisted columns to set (seal columns only into holding/scheduled)
 * @param {{now?: (() => number)|number, expectHash?: string|null}} [options]
 * @returns {Promise<boolean>}
 */
export async function transition(db, id, from, to, fields = {}, options = {}) {
  const plan = transitionPlan(id, from, to, fields, options);
  const result = await db.execute(plan);
  return result.rowsAffected === 1;
}

/* ------------------------------------------------------------------------- drafts */

/**
 * Create a draft and its first revision in one atomic write (`db.batch` is one transaction), and
 * read the draft row back out of it. The revision's From is the account's address and display name —
 * an input that carries a `from` of its own is overwritten, never stored.
 *
 * @param {object} db
 * @param {{accountId: string, mode: string, replyToMid?: string, threadKey?: string,
 *   projectId?: number, botId?: string, chatThreadId?: string, audience?: string,
 *   first: object, author: string}} fields
 * @param {{now?: (() => number)|number}} [options]
 */
export async function createDraft(db, fields = {}, options = {}) {
  const clock = clockOf(options);
  const accountId = requireId(fields.accountId, "account_id");
  const mode = requireMember(fields.mode, DRAFT_MODES, "mode");
  const author = requireMember(fields.author, REVISION_AUTHORS, "author");
  const account = await getAccount(db, accountId);
  if (!account) throw missing("account");
  const input = canonicalRevisionInput(fields.first, fromOfAccount(account));
  const hash = hashOf(input, { mode });
  const id = "md-" + randomBytes(8).toString("hex");
  const t = stamp(clock);
  const [, , readBack] = await db.batch([
    {
      sql: `INSERT INTO mail_drafts
              (id, account_id, mode, reply_to_mid, thread_key, project_id, bot_id, chat_thread_id,
               audience, state, head_rev, head_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
      args: [
        id, accountId, mode, optionalId(fields.replyToMid, "reply_to_mid"),
        optionalId(fields.threadKey, "thread_key"), optionalInt(fields.projectId, "project_id"),
        optionalId(fields.botId, "bot_id"), optionalId(fields.chatThreadId, "chat_thread_id"),
        optionalId(fields.audience, "audience"), hash, t, t,
      ],
    },
    revisionInsert(id, 1, author, input, mode, hash, t),
    { sql: `SELECT ${DRAFT_COLUMNS} FROM mail_drafts WHERE id = ?`, args: [id] },
  ]);
  return toDraft(readBack.rows[0]);
}

/** One draft, or null when there is no such row. */
export async function getDraft(db, id) {
  if (typeof id !== "string" || !id) return null;
  const { rows } = await db.execute({
    sql: `SELECT ${DRAFT_COLUMNS} FROM mail_drafts WHERE id = ?`,
    args: [id],
  });
  return toDraft(rows[0]);
}

/** Every draft made from one chat thread, newest first — the chat card's lookup. */
export async function listDraftsForChat(db, chatThreadId) {
  const key = requireId(chatThreadId, "chat_thread_id");
  const { rows } = await db.execute({
    sql: `SELECT ${DRAFT_COLUMNS} FROM mail_drafts WHERE chat_thread_id = ?
           ORDER BY created_at DESC, id DESC`,
    args: [key],
  });
  return rows.map(toDraft);
}

/** A draft's revisions, oldest first: the "Draft history" view. */
export async function listRevisions(db, draftId) {
  const id = requireId(draftId, "draft_id");
  const { rows } = await db.execute({
    sql: `SELECT ${REVISION_COLUMNS} FROM mail_draft_revisions WHERE draft_id = ? ORDER BY rev ASC`,
    args: [id],
  });
  return rows.map(toRevision);
}

/* ---------------------------------------------------------------------- revisions */

/**
 * Every listener registered with `onRevisionAdded`. Module state, like the account removal hooks: a
 * listener is registered once at boot by the code that wants to know a draft grew a revision.
 */
const revisionAddedHooks = [];

/**
 * Register `fn(payload)`, called after a successful `addRevision` with
 * `{draftId, rev, hash, author}`. A listener that throws (or rejects) never fails the write it was
 * told about. Answers an unsubscribe function.
 *
 * @param {(payload: {draftId: string, rev: number, hash: string, author: string}) => unknown} fn
 * @returns {() => void}
 */
export function onRevisionAdded(fn) {
  if (typeof fn !== "function") throw new TypeError("onRevisionAdded needs a function");
  revisionAddedHooks.push(fn);
  return () => {
    const at = revisionAddedHooks.indexOf(fn);
    if (at >= 0) revisionAddedHooks.splice(at, 1);
  };
}

async function notifyRevisionAdded(payload) {
  for (const hook of [...revisionAddedHooks]) {
    try {
      await hook(payload);
    } catch {
      // A listener is a bystander: its failure is not the write's.
    }
  }
}

/**
 * Write the next revision of a draft and move its head, in ONE transaction (`db.runTransaction`): a
 * read of the row, the guarded head move, and the revision insert, with no await between them.
 *
 * The head move is the compare-and-set — `state IN ('draft','failed','missed') AND head_hash =
 * expectHash` — and it runs first; the revision is inserted only if it won, inside the same
 * transaction. A user edit of a `scheduled` draft with `cancelSchedule: true` first returns it to
 * `draft` through `transition()`, seal cleared, under the same hash guard, in the same transaction.
 * A bot on a `scheduled`, `holding` or `sending` draft (or any writer on a `sent`, `discarded` or
 * `unknown` one) is refused `{refused:'frozen'}`; a stale `expectHash` is refused
 * `{refused:'changed'}` and nothing is written.
 *
 * @param {object} db
 * @param {string} draftId
 * @param {object} input `RevisionInput`; a `from` in it is ignored (the store fills it from the account)
 * @param {{author: string, expectHash: string, cancelSchedule?: boolean,
 *   now?: (() => number)|number}} options
 * @returns {Promise<{rev: number, hash: string}|{refused: "changed"|"frozen"}>}
 */
export async function addRevision(db, draftId, input, options = {}) {
  const clock = clockOf(options);
  const id = requireId(draftId, "draft_id");
  const author = requireMember(options.author, REVISION_AUTHORS, "author");
  const expectHash = options.expectHash;
  if (typeof expectHash !== "string" || !expectHash) throw bad("expect_hash");
  const cancelSchedule = options.cancelSchedule === true;

  const head = await getDraft(db, id);
  if (!head) throw missing("draft");
  const account = await getAccount(db, head.accountId);
  if (!account) throw missing("account");
  const from = fromOfAccount(account);

  let outcome;
  try {
    outcome = await db.runTransaction((run) => {
      const row = run({ sql: `SELECT ${DRAFT_COLUMNS} FROM mail_drafts WHERE id = ?`, args: [id] }).rows[0];
      if (!row) throw new Rollback({ refused: "missing" });
      const state = String(row.state);
      const t = stamp(clock);
      if (!EDITABLE_STATES.includes(state)) {
        if (!(state === "scheduled" && author === "user" && cancelSchedule)) {
          throw new Rollback({ refused: "frozen" });
        }
        const moved = run(transitionPlan(id, ["scheduled"], "draft", {}, { now: () => t, expectHash }));
        if (moved.rowsAffected !== 1) throw new Rollback({ refused: "changed" });
      }
      const mode = String(row.mode);
      const revision = canonicalRevisionInput(input, from);
      const hash = hashOf(revision, { mode });
      const rev = Number(row.head_rev) + 1;
      const bumped = run({
        sql: `UPDATE mail_drafts SET head_rev = ?, head_hash = ?, updated_at = ?
               WHERE id = ? AND state IN ('draft', 'failed', 'missed') AND head_hash = ?`,
        args: [rev, hash, t, id, expectHash],
      });
      if (bumped.rowsAffected !== 1) {
        // Thrown, not returned, so a schedule cancel already applied is rolled back with the refusal
        // and the row is exactly as the caller left it.
        throw new Rollback({ refused: "changed" });
      }
      run(revisionInsert(id, rev, author, revision, mode, hash, t));
      return { rev, hash };
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    outcome = err.result;
  }
  if (outcome.refused === "missing") throw missing("draft");
  if (outcome.refused) return outcome;
  await notifyRevisionAdded({ draftId: id, rev: outcome.rev, hash: outcome.hash, author });
  return outcome;
}

/**
 * Throw a draft away: `discarded` from `draft`, `failed`, `missed` or `unknown`, else a refusal.
 * `holding`, `scheduled` and `sending` are left alone — the send service owns those.
 *
 * @returns {Promise<{ok: true}|{refused: true, state: string|null}>}
 */
export async function discardDraft(db, id, options = {}) {
  const clock = clockOf(options);
  const draft = await getDraft(db, id);
  if (!draft) throw missing("draft");
  if (!DISCARDABLE_STATES.includes(draft.state)) return { refused: true, state: draft.state };
  const ok = await transition(db, draft.id, DISCARDABLE_STATES, "discarded", {}, { now: clock });
  if (!ok) return { refused: true, state: (await getDraft(db, draft.id))?.state ?? null };
  return { ok: true };
}

/* ------------------------------------------------------------------------ comments */

/**
 * Queue one comment on a revision (the line it quotes, and what the person said about it).
 *
 * @returns {Promise<object>} the stored comment
 */
export async function addComment(db, draftId, fields = {}, options = {}) {
  const clock = clockOf(options);
  const id = requireId(draftId, "draft_id");
  if (!Number.isInteger(fields.rev) || fields.rev < 1) throw bad("rev");
  const text = typeof fields.text === "string" ? fields.text.trim() : "";
  if (!text) throw bad("text");
  const lineIndex = optionalInt(fields.lineIndex, "line_index");
  if (lineIndex != null && lineIndex < 0) throw bad("line_index");
  const quote = fields.quote == null ? null : String(fields.quote);
  const draft = await getDraft(db, id);
  if (!draft) throw missing("draft");
  const comment = {
    id: "mdc-" + randomBytes(8).toString("hex"),
    draftId: id,
    rev: fields.rev,
    lineIndex,
    quote,
    text,
    state: "queued",
    createdAt: stamp(clock),
  };
  await db.execute({
    sql: `INSERT INTO mail_draft_comments
            (id, draft_id, rev, line_index, quote, text, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [comment.id, comment.draftId, comment.rev, comment.lineIndex, comment.quote, comment.text,
      comment.state, comment.createdAt],
  });
  return comment;
}

/** A draft's comments, oldest first, optionally only those in one state. */
export async function listComments(db, draftId, options = {}) {
  const id = requireId(draftId, "draft_id");
  const state = options.state ?? null;
  if (state != null) requireMember(state, COMMENT_STATES, "comment_state");
  const args = [id];
  let filter = "";
  if (state != null) {
    filter = " AND state = ?";
    args.push(state);
  }
  const { rows } = await db.execute({
    sql: `SELECT id, draft_id, rev, line_index, quote, text, state, created_at
            FROM mail_draft_comments WHERE draft_id = ?${filter} ORDER BY created_at ASC, id ASC`,
    args,
  });
  return rows.map(toComment);
}

/**
 * Mark comments `applied` once a revision has folded them in. Only `queued` comments change, so a
 * replay of the same turn changes nothing. `newRev` is the revision they were applied to; the
 * comments table has no column for it, so it is validated here and not stored.
 *
 * @returns {Promise<number>} how many comments this call moved
 */
export async function markCommentsApplied(db, ids, newRev) {
  if (!Array.isArray(ids)) throw bad("ids");
  if (!Number.isInteger(newRev) || newRev < 1) throw bad("rev");
  const commentIds = [];
  for (const id of ids) if (typeof id === "string" && id) commentIds.push(id);
  if (!commentIds.length) return 0;
  const result = await db.execute({
    sql: `UPDATE mail_draft_comments SET state = 'applied'
           WHERE state = 'queued' AND id IN (${commentIds.map(() => "?").join(", ")})`,
    args: commentIds,
  });
  return result.rowsAffected;
}

/* --------------------------------------------------------------------------- voice */

/** The voice note for one revision, or null. */
export async function getVoice(db, draftId, rev) {
  const id = requireId(draftId, "draft_id");
  if (!Number.isInteger(rev) || rev < 1) throw bad("rev");
  const { rows } = await db.execute({
    sql: "SELECT draft_id, rev, voice_json, created_at FROM mail_draft_voice WHERE draft_id = ? AND rev = ?",
    args: [id, rev],
  });
  const row = rows[0];
  if (!row) return null;
  return { draftId: String(row.draft_id), rev: Number(row.rev), voice: jsonObject(row.voice_json), createdAt: Number(row.created_at) };
}

/**
 * Store the voice note for one revision. A revision's note is written once: a second call for the
 * same revision keeps the first and answers false.
 *
 * @returns {Promise<boolean>} whether a row was written
 */
export async function setVoice(db, draftId, rev, voice, options = {}) {
  const clock = clockOf(options);
  const id = requireId(draftId, "draft_id");
  if (!Number.isInteger(rev) || rev < 1) throw bad("rev");
  if (voice == null) throw bad("voice");
  let json;
  try {
    json = JSON.stringify(voice);
  } catch {
    throw bad("voice");
  }
  if (typeof json !== "string") throw bad("voice");
  const draft = await getDraft(db, id);
  if (!draft) throw missing("draft");
  const result = await db.execute({
    sql: `INSERT INTO mail_draft_voice (draft_id, rev, voice_json, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(draft_id, rev) DO NOTHING`,
    args: [id, rev, json, stamp(clock)],
  });
  return result.rowsAffected === 1;
}