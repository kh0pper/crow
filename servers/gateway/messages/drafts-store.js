/**
 * Crow Messages' draft store: one draft of a message to one conversation (a contact or a room), the
 * version an autosave compares against, and the audit trail of what happened to it. The two tables
 * are in servers/shared/message-drafts-schema.js (`MESSAGE_DRAFTS_DDL`); this module is their only
 * writer, and the only place their columns' meanings live.
 *
 * A bot's message is ALWAYS a draft in v1: the door a bot writes through lands a row here (origin
 * `bot`, its `bot_id` recorded) and the owner is the only one who can send it.
 *
 * Four rules carry the store:
 *
 *  - ONE OPEN DRAFT PER CONVERSATION. `createDraft` is an upsert: a conversation that already has an
 *    open draft gets that row's body (and recipient set) replaced and its version bumped, never a
 *    second row. The partial unique index in the DDL is the enforcement under it — an INSERT that
 *    races another writer collides, and the collision is retried as the update it should have been.
 *
 *  - EVERY EDIT IS A COMPARE-AND-SET. `updateBody` and `beginSend` take the version the person's
 *    screen was drawn from and write through `WHERE version = ? AND state = 'open'`; of two racing
 *    writers exactly one wins, and the loser is told `changed` WITH the row as it now is, so a card
 *    can redraw instead of guessing. `discardDraft` takes the same version when the caller has one.
 *
 *  - THE RECIPIENTS ARE SEALED. The caller derives the audience from the live conversation
 *    (servers/gateway/messages/conversations.js); the store writes it as canonical JSON — one entry
 *    per person, `{contact_id, crow_id, secp256k1_pubkey}`, the key being the snapshot taken now —
 *    and seals that audience together with the draft's own identity (id, origin, bot id and name,
 *    created_at, the conversation) in the same statement (drafts-seal.js). A row whose seal does not
 *    verify is never sent: the route checks it before anything leaves the box
 *    (servers/gateway/messages/drafts-send.js).
 *
 *  - THE AUDIT TRAIL CARRIES IDS AND HASHES, NEVER TEXT. Every create, edit, send and discard writes
 *    one `message_draft_audit` row with the draft id, the action, the actor (`owner`, or `bot` plus
 *    the bot's id), the resulting version, the body's SHA-256 and the recipient seal. The message's
 *    words are not in it: the audit table is the one place a reader with database access would look
 *    for what the operator was about to say. A failed delivery writes no audit row — it is not one
 *    of the four actions — it puts the draft back to `open` with a `fail_reason` code instead. A
 *    `sending` row that outlived its process is put back by `sweepStuckSends` (the boot pass), which
 *    writes one `reopened` row with `system` as the actor — or `parked` when the row could not be
 *    reopened because the conversation had moved on; and a delivery that landed after somebody else
 *    moved its row on is closed by `markSentLate`, whose `sent-late` row says why. Those are state
 *    changes a reader has to be able to explain.
 *
 * Every successful write pokes the gateway's own event bus with `message-drafts:changed`
 * (servers/shared/event-bus.js): ids only — the draft id, its conversation and the action word — so
 * a live panel can refresh and nothing about the message can travel on that channel. The emit is
 * wrapped: a misbehaving subscriber never breaks the write.
 *
 * Times are epoch ms from an injectable clock (`{ now }`, default `Date.now`); the seal seed comes
 * from an injectable `{ loadSeed }` (default: this instance's keychain key, `loadDraftSealSeed`). A
 * caller's refusal is a `DraftError` whose code is `BAD_INPUT` or `NOT_FOUND` and whose detail names
 * the field, never a value.
 */
import { createHash, randomBytes } from "node:crypto";
import bus from "../../shared/event-bus.js";
import { CONVERSATION_KINDS, canonicalRecipientEntries, canonicalRecipients } from "./conversations.js";
import { loadDraftSealSeed, sealRecipients } from "./drafts-seal.js";

/** The event name every write pokes. The panel's own SSE route listens for it (part 2). */
export const DRAFT_CHANGED_EVENT = "message-drafts:changed";

/** Who wrote the draft: the person by hand, or a bot (whose message is only ever a draft). */
export const DRAFT_ORIGINS = Object.freeze(["owner", "bot"]);

/** Every state a draft row may hold. The table has no CHECK: this list is the validation.
 *  `open` -> (`sending` -> `sent`, or back to `open` after a delivery that did not land) -> `discarded`.
 *  `failed` is the rare parking place of a delivery that failed while the conversation already had a
 *  NEWER open draft (the partial unique index allows one open row): the text is kept, the reason is
 *  kept, and the row is never sent — a card shows it as gone and the open draft is the one to use. */
export const DRAFT_STATES = Object.freeze(["open", "sending", "sent", "discarded", "failed"]);

/** The four things a person does to a draft, plus the three the store records for itself: the boot
 *  pass's reopen of an interrupted send (`reopened`), the parking of one it could not reopen
 *  (`parked`), and a delivery that landed after the row had been moved out from under it
 *  (`sent-late`). The last three are always `system`. */
export const AUDIT_ACTIONS = Object.freeze([
  "create", "edit", "send", "discard", "reopened", "parked", "sent-late",
]);

/** A draft id, exactly what `newDraftId` mints. Anything else is not a draft this store made. */
export const MESSAGE_DRAFT_ID_RE = /^msgd-[0-9a-f]{32}$/;

/** The most body one draft may hold. The route's own 64 KB parser is the limit above this one. */
export const MAX_BODY_CHARS = 60_000;

const ID_MAX = 120;
const FAIL_REASON_MAX = 200;
const BOT_NAME_MAX = 80;

/** How long a draft may sit in `sending` before the boot sweep decides its process is gone. */
export const STUCK_SEND_MS = 5 * 60 * 1000;

const COLUMNS = `id, conversation_kind, conversation_id, origin, bot_id, bot_name, project_id, state,
  version, body, body_hash, recipients_json, recipients_seal, sent_at, sent_message_id, fail_reason,
  created_at, updated_at`;

/** A caller's refusal: a field or a row name, never a value. */
export class DraftError extends Error {
  constructor(code, detail) {
    super(`${code}:${detail}`);
    this.name = "DraftError";
    this.code = code;
    this.detail = detail;
  }
}

const bad = (detail) => new DraftError("BAD_INPUT", detail);
const missing = (detail) => new DraftError("NOT_FOUND", detail);

/* ------------------------------------------------------------------- validation */

function requireKind(value) {
  if (!CONVERSATION_KINDS.includes(value)) throw bad("conversationKind");
  return value;
}

function requireConversationId(value) {
  if (!Number.isInteger(value) || value <= 0) throw bad("conversationId");
  return value;
}

function requireId(value, detail) {
  if (typeof value !== "string" || !value || value.length > ID_MAX) throw bad(detail);
  return value;
}

function requireBody(value) {
  if (typeof value !== "string") throw bad("body");
  if (value.length > MAX_BODY_CHARS) throw bad("body");
  return value;
}

/** The `expectVersion` of a write that already holds a row: the version it was drawn from. */
function requireVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw bad("expectVersion");
  return value;
}

/**
 * The `expectVersion` of a create: `0` means "create only, there is no draft here yet" — an open
 * draft already in the conversation is a refusal, never an overwrite — and a positive number is the
 * compare-and-set an upsert of a row the caller was looking at goes through.
 */
function requireCreateVersion(value) {
  if (!Number.isInteger(value) || value < 0) throw bad("expectVersion");
  return value;
}

/** A bot's display name as it is snapshotted on the row (under the seal). Null for an owner's draft. */
function requireBotName(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > BOT_NAME_MAX) throw bad("botName");
  return value;
}

/** The audience entries as written to `recipients_json`: `[{contact_id, crow_id, secp256k1_pubkey}]`. */
function recipientsJson(entries) {
  return JSON.stringify(entries.map((entry) => ({
    contact_id: entry.contactId,
    crow_id: entry.crowId,
    secp256k1_pubkey: entry.pubkey,
  })));
}

function clockOf(opts) {
  const now = opts?.now ?? Date.now;
  const raw = typeof now === "function" ? now() : now;
  const at = Math.floor(Number(raw));
  if (!Number.isFinite(at) || at < 0) throw bad("now");
  return at;
}

/** The seed this write seals under: the caller's injected one, else this instance's keychain key. */
async function seedOf(opts) {
  const loader = opts?.loadSeed;
  const seed = typeof loader === "function" ? await loader() : loadDraftSealSeed();
  if (!seed) throw new DraftError("SEAL_UNAVAILABLE", "seed");
  return seed;
}

/* ----------------------------------------------------------------------- values */

/** The body's hash: what the audit trail keeps instead of the text. */
export function bodyHash(body) {
  return createHash("sha256").update(String(body ?? ""), "utf8").digest("hex");
}

/** A fresh draft id: 16 random bytes as hex, under the store's own prefix. */
export function newDraftId() {
  return `msgd-${randomBytes(16).toString("hex")}`;
}

/** A stored row as the store's callers see it: the columns, camel-cased, recipients parsed. */
function mapRow(row) {
  if (!row) return null;
  const recipients = [];
  try {
    const parsed = JSON.parse(row.recipients_json || "[]");
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const contactId = Number(entry.contact_id);
        const crowId = String(entry.crow_id ?? "").trim();
        if (!Number.isInteger(contactId) || contactId <= 0 || !crowId) continue;
        recipients.push({ contactId, crowId, pubkey: String(entry.secp256k1_pubkey ?? "").trim() });
      }
    }
  } catch {
    // A row this store did not write: no recipients, which fails the seal check.
  }
  return {
    id: row.id,
    conversationKind: row.conversation_kind,
    conversationId: Number(row.conversation_id),
    origin: row.origin,
    botId: row.bot_id ?? null,
    botName: row.bot_name ?? null,
    projectId: row.project_id == null ? null : Number(row.project_id),
    state: row.state,
    version: Number(row.version),
    body: row.body ?? "",
    bodyHash: row.body_hash,
    recipients,
    recipientsSeal: row.recipients_seal,
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
    sentMessageId: row.sent_message_id ?? null,
    failReason: row.fail_reason ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * The fields a seal covers, from a draft and the audience it is being written for: the row's own
 * identity (id, origin, the bot that wrote it and the name a person will read, when it was created,
 * the conversation) and the canonical recipient keys — contact id, crow id and KEY SNAPSHOT.
 */
export function sealFieldsFor(draft, recipients = draft?.recipients) {
  return {
    draftId: draft.id,
    origin: draft.origin ?? "owner",
    botId: draft.botId ?? null,
    botName: draft.botName ?? null,
    conversationKind: draft.conversationKind,
    conversationId: draft.conversationId,
    createdAt: draft.createdAt,
    recipients: canonicalRecipients(recipients),
  };
}

/**
 * One audit row: the ids, the action, the actor and the two hashes. The body and the recipient
 * addresses themselves are not written — `body_hash` and the seal are.
 */
async function writeAudit(db, { draftId, action, actor, actorId, version, hash, seal, at }) {
  if (!AUDIT_ACTIONS.includes(action)) throw bad("action");
  await db.execute({
    sql: `INSERT INTO message_draft_audit
            (draft_id, action, actor, actor_id, version, body_hash, recipients_seal, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [draftId, action, actor, actorId ?? null, version, hash, seal, at],
  });
}

/** Poke the live panel: ids only, and a subscriber's failure is never the write's failure. */
function emitChanged(payload, opts) {
  const emit = typeof opts?.emit === "function" ? opts.emit : (p) => bus.emit(DRAFT_CHANGED_EVENT, p);
  try {
    emit(payload);
  } catch {
    // Subscriber isolation: the row is already written and stays written.
  }
}

/* ------------------------------------------------------------------------ reads */

/** One draft by id, or null. */
export async function getDraft(db, id) {
  if (typeof id !== "string" || !MESSAGE_DRAFT_ID_RE.test(id)) return null;
  const { rows } = await db.execute({
    sql: `SELECT ${COLUMNS} FROM message_drafts WHERE id = ?`,
    args: [id],
  });
  return mapRow(rows[0]);
}

/** The conversation's open draft, or null. At most one exists (the partial unique index). */
export async function getOpenDraft(db, conversationKind, conversationId) {
  const { rows } = await db.execute({
    sql: `SELECT ${COLUMNS} FROM message_drafts
           WHERE conversation_kind = ? AND conversation_id = ? AND state = 'open'`,
    args: [conversationKind, conversationId],
  });
  return mapRow(rows[0]);
}

/**
 * Drafts, newest first. Filters are optional: a conversation (`conversationKind` +
 * `conversationId`), a state (`open`, `sending`, `sent`, `discarded`), or neither (every draft).
 *
 * @param {object} db
 * @param {{conversationKind?: string, conversationId?: number, state?: string, limit?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listDrafts(db, filter = {}) {
  const where = [];
  const args = [];
  if (filter.conversationKind != null || filter.conversationId != null) {
    where.push("conversation_kind = ? AND conversation_id = ?");
    args.push(requireKind(filter.conversationKind), requireConversationId(filter.conversationId));
  }
  if (filter.state != null) {
    if (!DRAFT_STATES.includes(filter.state)) throw bad("state");
    where.push("state = ?");
    args.push(filter.state);
  }
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 200) : 50;
  const { rows } = await db.execute({
    sql: `SELECT ${COLUMNS} FROM message_drafts
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
    args: [...args, limit],
  });
  return rows.map(mapRow);
}

/** One draft's audit trail, oldest first: ids and hashes only, as it was written. */
export async function listAudit(db, draftId) {
  const { rows } = await db.execute({
    sql: `SELECT id, draft_id, action, actor, actor_id, version, body_hash, recipients_seal, at
            FROM message_draft_audit WHERE draft_id = ? ORDER BY at ASC, id ASC`,
    args: [draftId],
  });
  return rows.map((row) => ({
    id: Number(row.id),
    draftId: row.draft_id,
    action: row.action,
    actor: row.actor,
    actorId: row.actor_id ?? null,
    version: Number(row.version),
    bodyHash: row.body_hash,
    recipientsSeal: row.recipients_seal,
    at: Number(row.at),
  }));
}

/* ----------------------------------------------------------------------- writes */

/**
 * Create the conversation's open draft, or (when the caller holds the version of the one already
 * there) replace it.
 *
 * THREE WAYS IN, and the difference is what a blind overwrite cannot do:
 *
 *   - `expectVersion: 0` — CREATE ONLY. The composer's first keystroke asks for this: if the
 *     conversation already has an open draft (another tab, the Perch card, a bot's own draft) the
 *     answer is `{refused: "changed", draft: <the row already there>}`, which the client ADOPTS. The
 *     words somebody else saved are never replaced by words typed in ignorance of them.
 *   - `expectVersion: n` (n >= 1) — a compare-and-set against the row the caller was looking at; a
 *     stale n is the same `changed` refusal with the row as it now is.
 *   - no `expectVersion` — the store's own upsert (a bot revising its draft, part 2's door). It is
 *     only reachable from code that already holds the row or has decided an overwrite is the point.
 *
 * The audience comes from the caller — `resolveConversation` derived it from the LIVE conversation,
 * keys included — and is sealed here, together with the draft's identity: origin, bot id, the bot's
 * name, and its created_at. When the conversation already has an open draft, its body, its audience
 * and its seal are replaced and its version is bumped, which is one edit of one draft, not a second
 * draft.
 *
 * @param {object} db
 * @param {{conversationKind: string, conversationId: number, body?: string,
 *   recipients: Array<{contactId: number, crowId: string, pubkey: string}>, origin?: "owner"|"bot",
 *   botId?: string|null, botName?: string|null, projectId?: number|null, expectVersion?: number}} input
 * @param {{now?: Function|number, loadSeed?: Function, emit?: Function}} [opts]
 * @returns {Promise<{ok: true, draft: object, created: boolean}|{ok: false, refused: "changed",
 *   draft: object}>}
 */
export async function createDraft(db, input, opts = {}) {
  const conversationKind = requireKind(input?.conversationKind);
  const conversationId = requireConversationId(input?.conversationId);
  const body = requireBody(input?.body ?? "");
  const recipients = canonicalRecipientEntries(input?.recipients);
  if (!recipients.length) throw bad("recipients");
  const origin = input?.origin ?? "owner";
  if (!DRAFT_ORIGINS.includes(origin)) throw bad("origin");
  const botId = origin === "bot" ? requireId(input?.botId, "botId") : null;
  const botName = origin === "bot" ? requireBotName(input?.botName) : null;
  const projectId = input?.projectId == null ? null : input.projectId;
  if (projectId != null && !Number.isInteger(projectId)) throw bad("projectId");
  const expectVersion = input?.expectVersion == null ? null : requireCreateVersion(input.expectVersion);
  const createOnly = expectVersion === 0;
  const at = clockOf(opts);
  const seed = await seedOf(opts);
  const json = recipientsJson(recipients);

  const existing = await getOpenDraft(db, conversationKind, conversationId);
  if (existing) {
    // Create-only, or a stale compare-and-set: the caller is told what is there, never given an
    // overwrite of words it never read.
    if (createOnly) return { ok: false, refused: "changed", draft: existing };
    if (expectVersion != null && existing.version !== expectVersion) {
      return { ok: false, refused: "changed", draft: existing };
    }
    const seal = sealRecipients(
      sealFieldsFor({ ...existing, origin, botId, botName }, recipients),
      seed,
    );
    const res = await db.execute({
      sql: `UPDATE message_drafts
               SET body = ?, body_hash = ?, recipients_json = ?, recipients_seal = ?,
                   origin = ?, bot_id = ?, bot_name = ?, project_id = COALESCE(?, project_id),
                   fail_reason = NULL, version = version + 1, updated_at = ?
             WHERE id = ? AND state = 'open'`,
      args: [
        body, bodyHash(body), json, seal,
        origin, botId, botName, projectId, at, existing.id,
      ],
    });
    if (!res.rowsAffected) {
      // The row left `open` between the read and the write (a send started): ask again.
      const after = await getDraft(db, existing.id);
      return { ok: false, refused: "changed", draft: after ?? existing };
    }
    const draft = await getDraft(db, existing.id);
    await writeAudit(db, {
      draftId: draft.id,
      action: "edit",
      actor: origin,
      actorId: botId,
      version: draft.version,
      hash: draft.bodyHash,
      seal: draft.recipientsSeal,
      at,
    });
    emitChanged(changedPayload(draft, "edit"), opts);
    return { ok: true, draft, created: false };
  }

  const id = newDraftId();
  const seal = sealRecipients(
    sealFieldsFor({ id, origin, botId, botName, conversationKind, conversationId, createdAt: at }, recipients),
    seed,
  );
  try {
    await db.execute({
      sql: `INSERT INTO message_drafts
              (id, conversation_kind, conversation_id, origin, bot_id, bot_name, project_id, state,
               version, body, body_hash, recipients_json, recipients_seal, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, conversationKind, conversationId, origin, botId, botName, projectId,
        body, bodyHash(body), json, seal, at, at,
      ],
    });
  } catch (err) {
    // Another writer opened a draft for this conversation between the read and the INSERT: the
    // partial unique index is the real rule. A create-only caller is told what landed; an upsert
    // becomes the edit it should have been.
    const raced = await getOpenDraft(db, conversationKind, conversationId);
    if (!raced) throw err;
    if (createOnly) return { ok: false, refused: "changed", draft: raced };
    return createDraft(db, { ...input, expectVersion: null }, opts);
  }
  const draft = await getDraft(db, id);
  await writeAudit(db, {
    draftId: id,
    action: "create",
    actor: origin,
    actorId: botId,
    version: draft.version,
    hash: draft.bodyHash,
    seal: draft.recipientsSeal,
    at,
  });
  emitChanged(changedPayload(draft, "create"), opts);
  return { ok: true, draft, created: true };
}

/**
 * Replace an open draft's body (the autosave). The compare-and-set is `expectVersion`: the version
 * the caller's screen was drawn from. A caller that lost the race is answered `changed` with the row
 * as it now is — including its current `version`, which is what the card needs to redraw.
 *
 * @returns {Promise<{ok: true, draft: object}|{ok: false, refused: "changed"|"not_open", draft: object}>}
 */
export async function updateBody(db, id, { body, expectVersion } = {}, opts = {}) {
  const draftId = requireId(id, "id");
  const nextBody = requireBody(body);
  const version = requireVersion(expectVersion);
  const at = clockOf(opts);

  const res = await db.execute({
    sql: `UPDATE message_drafts
             SET body = ?, body_hash = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'open' AND version = ?`,
    args: [nextBody, bodyHash(nextBody), at, draftId, version],
  });
  if (!res.rowsAffected) return refusedWrite(db, draftId);
  const draft = await getDraft(db, draftId);
  await writeAudit(db, {
    draftId,
    action: "edit",
    actor: "owner",
    actorId: null,
    version: draft.version,
    hash: draft.bodyHash,
    seal: draft.recipientsSeal,
    at,
  });
  emitChanged(changedPayload(draft, "edit"), opts);
  return { ok: true, draft };
}

/**
 * Take the draft out of `open` and into `sending`, writing the text that is about to go out (the
 * posted body, which is what is sent — never a re-read of the row) in the same compare-and-set.
 * This is the write that makes a send exclusive: a second tap on an older version loses here.
 *
 * @returns {Promise<{ok: true, draft: object}|{ok: false, refused: "changed"|"not_open", draft: object}>}
 */
export async function beginSend(db, id, { body, expectVersion } = {}, opts = {}) {
  const draftId = requireId(id, "id");
  const nextBody = requireBody(body);
  const version = requireVersion(expectVersion);
  const at = clockOf(opts);

  const res = await db.execute({
    sql: `UPDATE message_drafts
             SET body = ?, body_hash = ?, state = 'sending', fail_reason = NULL,
                 version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'open' AND version = ?`,
    args: [nextBody, bodyHash(nextBody), at, draftId, version],
  });
  if (!res.rowsAffected) return refusedWrite(db, draftId);
  const draft = await getDraft(db, draftId);
  await writeAudit(db, {
    draftId,
    action: "send",
    actor: "owner",
    actorId: null,
    version: draft.version,
    hash: draft.bodyHash,
    seal: draft.recipientsSeal,
    at,
  });
  emitChanged(changedPayload(draft, "send"), opts);
  return { ok: true, draft };
}

/**
 * The delivery landed: `sending` -> `sent`, with the transport's own id when it has one. Answers
 * false when the row was no longer `sending` — the boot pass reopened (or parked) it while this send
 * was in flight, or another writer got there first. That `false` is about the ROW, not about the
 * delivery: a caller whose message did go out closes the row with `markSentLate` instead.
 */
export async function markSent(db, id, { messageId = null } = {}, opts = {}) {
  const draftId = requireId(id, "id");
  const at = clockOf(opts);
  const res = await db.execute({
    sql: `UPDATE message_drafts
             SET state = 'sent', sent_at = ?, sent_message_id = ?, fail_reason = NULL, updated_at = ?
           WHERE id = ? AND state = 'sending'`,
    args: [at, messageId == null ? null : String(messageId), at, draftId],
  });
  if (!res.rowsAffected) return false;
  const draft = await getDraft(db, draftId);
  emitChanged(changedPayload(draft, "send"), opts);
  return true;
}

/**
 * A delivery that DID land, on a row that had already been moved on.
 *
 * Only a send's own completion moves a row out of `sending` (and out of this process's hands), so a
 * successful delivery that finds the row elsewhere means somebody moved it out from under the send:
 * the boot pass reopened it (`open`, the sender looked gone), or parked it as `failed` because the
 * conversation had gained a newer open draft. The message went out either way — and a row left `open`
 * holding the text that just left is a double send waiting for the next tap.
 *
 * So this is the one write that does not care what state the row holds: it becomes `sent` with the
 * transport's id, and one `sent-late` audit row (actor `system`) says a row nobody tapped is closed.
 * The words a person may have typed into the reopened row since are NOT sent again — the message that
 * went out was this send's text.
 *
 * Answers false when there was nothing to change (the row is already `sent`), so a caller can tell a
 * real transition from a no-op.
 */
export async function markSentLate(db, id, { messageId = null } = {}, opts = {}) {
  const draftId = requireId(id, "id");
  const at = clockOf(opts);
  const res = await db.execute({
    sql: `UPDATE message_drafts
             SET state = 'sent', sent_at = ?, sent_message_id = ?, fail_reason = NULL, updated_at = ?
           WHERE id = ? AND state <> 'sent'`,
    args: [at, messageId == null ? null : String(messageId), at, draftId],
  });
  if (!res.rowsAffected) return false;
  const draft = await getDraft(db, draftId);
  if (!draft) return false;
  await writeAudit(db, {
    draftId,
    action: "sent-late",
    actor: "system",
    actorId: null,
    version: draft.version,
    hash: draft.bodyHash,
    seal: draft.recipientsSeal,
    at,
  });
  emitChanged(changedPayload(draft, "sent-late"), opts);
  return true;
}

/**
 * The delivery did not land: `sending` -> back to `open`, so the text is still there to fix and try
 * again, with a short reason code on the row. No audit row: the four audited actions are create,
 * edit, send and discard, and a failed attempt never became a send.
 *
 * One exception: when the conversation already has a NEWER open draft (the index allows exactly one
 * open row per conversation, so the owner may have started another while this one was in flight), the
 * row cannot go back to `open`. It is parked as `failed` instead — same reason code, same text, never
 * sent — rather than throwing a constraint error back into the send route.
 */
export async function markSendFailed(db, id, { reason = "delivery_failed" } = {}, opts = {}) {
  const draftId = requireId(id, "id");
  const code = String(reason ?? "").slice(0, FAIL_REASON_MAX) || "delivery_failed";
  const at = clockOf(opts);
  let res;
  try {
    res = await db.execute({
      sql: `UPDATE message_drafts
               SET state = 'open', fail_reason = ?, updated_at = ?
             WHERE id = ? AND state = 'sending'`,
      args: [code, at, draftId],
    });
  } catch (err) {
    if (!/UNIQUE/i.test(String(err?.message || ""))) throw err;
    res = await db.execute({
      sql: `UPDATE message_drafts
               SET state = 'failed', fail_reason = ?, updated_at = ?
             WHERE id = ? AND state = 'sending'`,
      args: [code, at, draftId],
    });
  }
  if (!res.rowsAffected) return false;
  const draft = await getDraft(db, draftId);
  emitChanged(changedPayload(draft, "send"), opts);
  return true;
}

/**
 * A `sending` row that outlived its process goes back to `open`.
 *
 * A send takes a draft from `open` to `sending` and then hands the text to a transport. If the
 * gateway dies in between — a crash, a systemd restart, a power cut — nobody ever moves the row on,
 * and the person is left with a draft that can never be sent or edited again (the composer's writes
 * are all compare-and-sets on `open`). This is the sweep that puts it back: every row left in
 * `sending` longer than `olderThanMs` (default five minutes — far longer than any delivery this Crow
 * makes, and short enough that the next boot fixes the visible symptom) returns to `open` with
 * `fail_reason: "send_interrupted"`, and one audit row (`action: "reopened"`, actor `system`) says a
 * state change nobody tapped happened. The text is untouched, so it is still there to try again.
 *
 * The one case it cannot return: the conversation gained a NEWER open draft while the send was in
 * flight. The partial unique index allows exactly one open row, so that row is parked as `failed`,
 * the same way `markSendFailed` parks one — with its own audit action, `parked`, because it is not a
 * draft anybody can pick up again.
 *
 * IT RUNS AT BOOT AND NOWHERE ELSE (servers/gateway/boot/message-drafts-sweep.js). A pass in the
 * middle of a running process cannot tell a dead sender from a slow one — here or in another gateway
 * sharing this crow.db — and reopening a send that is still in flight leaves the draft open holding
 * text that then goes out: the next tap sends it twice.
 *
 * Never throws for one bad row: the others are still swept (the failure is reported through
 * `opts.log`), and a row that moved on under us is simply skipped. Answers how many rows it reopened
 * and how many it parked.
 *
 * @param {object} db
 * @param {{olderThanMs?: number, now?: Function|number, emit?: Function, log?: Function}} [opts]
 * @returns {Promise<{reopened: number, parked: number}>}
 */
export async function sweepStuckSends(db, opts = {}) {
  const at = clockOf(opts);
  const olderThanMs = Number.isFinite(Number(opts?.olderThanMs)) && Number(opts.olderThanMs) >= 0
    ? Number(opts.olderThanMs)
    : STUCK_SEND_MS;
  const log = typeof opts?.log === "function" ? opts.log : () => {};
  const { rows } = await db.execute({
    sql: `SELECT id FROM message_drafts WHERE state = 'sending' AND updated_at < ?`,
    args: [at - olderThanMs],
  });
  let reopened = 0;
  let parked = 0;
  for (const row of rows || []) {
    const draftId = String(row.id);
    try {
      const state = await reopenOrParkStuckSend(db, draftId, at);
      if (!state) continue;
      const draft = await getDraft(db, draftId);
      if (!draft) continue;
      // The action word says what actually happened to the row: `reopened` for a draft the person
      // can send again, `parked` for one the index would not let back into `open`.
      const action = state === "open" ? "reopened" : "parked";
      await writeAudit(db, {
        draftId,
        action,
        actor: "system",
        actorId: null,
        version: draft.version,
        hash: draft.bodyHash,
        seal: draft.recipientsSeal,
        at,
      });
      emitChanged(changedPayload(draft, action), opts);
      if (state === "open") reopened += 1;
      else parked += 1;
    } catch (err) {
      // One row's fault is one row's (a busy table, a row a writer is holding). The rest of the pass
      // still runs — that is the promise this function's doc makes — and the next boot tries again.
      log(`[message-drafts] stuck send ${draftId} not swept: ${err?.message || err}`);
    }
  }
  return { reopened, parked };
}

/**
 * One stuck row: `sending` -> `open`, or -> `failed` when the conversation already has a NEWER open
 * draft (the partial unique index allows exactly one open row, so the reopen is what collides).
 * Answers the state it wrote, or null when the row moved on under us. Throws for anything a caller
 * should see per row — `sweepStuckSends` logs it and carries on with the others.
 */
async function reopenOrParkStuckSend(db, draftId, at) {
  try {
    const res = await db.execute({
      sql: `UPDATE message_drafts
               SET state = 'open', fail_reason = ?, updated_at = ?
             WHERE id = ? AND state = 'sending'`,
      args: ["send_interrupted", at, draftId],
    });
    return res.rowsAffected ? "open" : null;
  } catch (err) {
    if (!/UNIQUE/i.test(String(err?.message || ""))) throw err;
    const res = await db.execute({
      sql: `UPDATE message_drafts
               SET state = 'failed', fail_reason = ?, updated_at = ?
             WHERE id = ? AND state = 'sending'`,
      args: ["send_interrupted", at, draftId],
    });
    return res.rowsAffected ? "failed" : null;
  }
}

/**
 * Throw the draft away: `open` -> `discarded`. The row is kept (an audit trail that points at a
 * vanished draft would be no trail at all), and the conversation is free for a new open draft the
 * moment this lands. An `expectVersion`, when given, is the same compare-and-set as an edit's.
 *
 * @returns {Promise<{ok: true, draft: object}|{ok: false, refused: "changed"|"not_open", draft: object}>}
 */
export async function discardDraft(db, id, { expectVersion = null } = {}, opts = {}) {
  const draftId = requireId(id, "id");
  if (expectVersion != null) requireVersion(expectVersion);
  const at = clockOf(opts);

  const res = await db.execute({
    sql: `UPDATE message_drafts
             SET state = 'discarded', updated_at = ?
           WHERE id = ? AND state = 'open'${expectVersion != null ? " AND version = ?" : ""}`,
    args: expectVersion != null ? [at, draftId, expectVersion] : [at, draftId],
  });
  if (!res.rowsAffected) return refusedWrite(db, draftId);
  const draft = await getDraft(db, draftId);
  await writeAudit(db, {
    draftId,
    action: "discard",
    actor: "owner",
    actorId: null,
    version: draft.version,
    hash: draft.bodyHash,
    seal: draft.recipientsSeal,
    at,
  });
  emitChanged(changedPayload(draft, "discard"), opts);
  return { ok: true, draft };
}

/**
 * A compare-and-set that matched nothing: the row is gone (`NOT_FOUND`), it is no longer `open`
 * (`not_open`, with the row), or it moved on (`changed`, with the row and its current version).
 * Every write route answers from this one shape.
 */
async function refusedWrite(db, draftId) {
  const draft = await getDraft(db, draftId);
  if (!draft) throw missing("draft");
  if (draft.state !== "open") return { ok: false, refused: "not_open", draft };
  return { ok: false, refused: "changed", draft };
}

/** The bus payload on every write: the draft id, its conversation and the action word. Nothing else. */
function changedPayload(draft, action) {
  return {
    draftId: draft.id,
    conversationKind: draft.conversationKind,
    conversationId: draft.conversationId,
    action,
  };
}