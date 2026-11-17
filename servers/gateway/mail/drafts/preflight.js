/**
 * Crow Mail's preflight: everything that has to hold before a draft can be tapped, checked once, in
 * one place, over one revision.
 *
 * The send and schedule services both call `preflight` before they claim anything, and `deliver` calls
 * it again after the claim, so the bytes and the size a person agreed to are the bytes and the size
 * that go out. It answers one of six refusals and never throws over a draft:
 *
 *  - `placeholders` — an unfilled `[bracket]` in the subject or the body;
 *  - `no_recipients` — nobody in To (a Cc alone is not a message);
 *  - `bad_address` — an address that is not exactly one clean addr-spec (a CR/LF, angle brackets, a
 *    second address);
 *  - `too_large` — the attachments together over `MAX_SEND_BYTES` (plan 2's effective ceiling);
 *  - `bad_input` — the draft does not belong to the account asked for, the revision row belongs to
 *    another draft, the account's address is no longer the address the revision was written from, or
 *    an attachment cannot be resolved at all;
 *  - `attachment_unavailable` — an attachment's own reader failed with a mail error that says the
 *    server could not be reached or timed out, so the bytes a tap would seal cannot be read now.
 *
 * The From is the account's, always: its address and its display name, never the revision's. A revision
 * whose `from` names another address is refused rather than reinterpreted, because the account's
 * address is part of what a tap seals. `sealFromAddress` is the exact text a tap seals for From — the
 * address, a newline, the display name — so it is one value, resolved here and re-resolved the same way
 * when a tap is delivered: a send tapped under one display name and delivered under another is a
 * different From, and the seal says so.
 *
 * Attachments are resolved to bytes here rather than at send time, so the digest a tap seals is a
 * digest of what the recipient would actually get. A thread attachment is the part at `index` of the
 * message `mid` names, read through `deps.readMessageRaw`; a storage attachment is
 * `deps.readStorageFile(fileId)`, which does the owner check. Neither source is reachable without its
 * reader, and an attachment this module cannot resolve refuses the draft instead of sending it short.
 * A reader that throws is caught here: an unreachable server is a refusal a person can retry, never an
 * exception out of preflight.
 *
 * The digest a tap seals frames every attachment — the sanitized filename, its media type and its
 * bytes, each preceded by its own length, in the revision's order — so a byte moved from one
 * attachment's tail to the next one's head, or a name swapped between two attachments, is a different
 * digest.
 *
 * `toOutgoing` is the one mapping to plan 1's `OutgoingMessage`: `body` becomes `text`, `html` is never
 * set, and the message id is the draft row's. It builds its fields from `revisionToInput(rev)`, the same
 * normalised input `hashOf` covers, so the message a tap sealed is the message built here. The result
 * always goes through `validateOutgoing`, so an implementation builds its headers from that output and
 * nothing else.
 */
import { createHash } from "node:crypto";
import { findPlaceholders, parseAddressListDetailed } from "../../staged/canonical.js";
import { MailError } from "../errors.js";
import { validateOutgoing } from "../adapter/interface.js";
import { getAccount } from "../store/accounts.js";
import { resolveMessageRef } from "../store/reader-queries.js";
import { extractAttachment, safeAttachmentName } from "../reader/attachments.js";
import { listRevisions, revisionToInput } from "./store.js";
import { changedRecipients, deriveReply, newRecipients } from "./recipients.js";

/**
 * The largest total an outgoing message may carry, in the attachments' own bytes (base64 is not
 * counted): plan 2's effective ceiling, where an attachment above roughly 18 MB is already refused by
 * the raw-message rule before this one is reached.
 */
export const MAX_SEND_BYTES = 18 * 1024 * 1024;

/** C0 controls, DEL, C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;

/** The same characters, for stripping a display name instead of refusing it. */
const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g;

/** A media type as `validateOutgoing` reads one, without parameters: `type/subtype`. */
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/** One refusal, with the tokens the card (never a log) may show for it. */
function refuse(code, detail) {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

/* ------------------------------------------------------------------- addresses */

/** The address text of one entry, or null when the entry names no address at all. */
function addressText(entry) {
  if (typeof entry === "string") return entry;
  if (entry != null && typeof entry === "object" && typeof entry.address === "string") return entry.address;
  return null;
}

/**
 * Every entry that is not exactly one clean addr-spec, as the token the caller posted. The test is the
 * one the send applies — no control character anywhere, and the strict RFC 5322 read gives back the
 * same single address — run here so the card learns which address is wrong instead of a bare refusal.
 */
function badAddresses(list) {
  const bad = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const raw = addressText(entry);
    if (raw == null) continue;
    if (CONTROL_CHARS.test(raw)) {
      bad.push(raw);
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      bad.push(raw);
      continue;
    }
    const { addresses, invalid } = parseAddressListDetailed(trimmed);
    if (invalid.length || addresses.length !== 1 || addresses[0] !== trimmed.toLowerCase()) bad.push(raw);
  }
  return bad;
}

/** One address list as the outgoing message wants it: `{name, address}` without touching either. */
function outgoingRecipients(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const raw = addressText(entry);
    if (raw == null || !raw.trim()) continue;
    const name = typeof entry === "object" && typeof entry.name === "string" && entry.name !== "" ? entry.name : null;
    out.push({ name, address: raw });
  }
  return out;
}

/* ----------------------------------------------------------------- attachments */

/** Bytes as they were handed over (a Buffer, a typed array, an ArrayBuffer or a string), else null. */
function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

/** The declared media type when it is one Crow can write, else the neutral octet-stream. */
function mediaTypeOf(value) {
  const declared = typeof value === "string" ? value.trim() : "";
  return MEDIA_TYPE.test(declared) ? declared : DEFAULT_MEDIA_TYPE;
}

/**
 * One attachment as the message carries it, or a refusal: a ref with no usable identity, no reader for
 * its source, or a part the stored message no longer holds is `bad_input`; a reader that fails with a
 * `NETWORK` or `TIMEOUT` mail error is `attachment_unavailable` (the part exists, this Crow cannot
 * fetch it right now). Nothing a reader throws escapes this module.
 *
 * @returns {Promise<{attachment: {filename: string, contentType: string, content: Buffer}}
 *   | {refusal: "bad_input"|"attachment_unavailable"}>}
 */
async function resolveAttachment(db, accountId, ref, deps) {
  if (ref == null || typeof ref !== "object") return { refusal: "bad_input" };

  if (ref.source === "thread") {
    const mid = typeof ref.mid === "string" ? ref.mid.trim() : "";
    const index = Number(ref.index);
    if (!mid || !Number.isInteger(index) || index < 0) return { refusal: "bad_input" };
    const read = deps?.readMessageRaw;
    if (typeof read !== "function") return { refusal: "bad_input" };
    // The message is scoped to this account, so a ref naming another mailbox's Message-ID names nothing.
    const row = await resolveMessageRef(db, { accountId, mid });
    if (!row) return { refusal: "bad_input" };
    const reading = await readerOutcome(() => read({ accountId, mid, row }));
    if (reading.refusal) return reading;
    const raw = bytesOf(reading.value);
    if (!raw) return { refusal: "bad_input" };
    const part = await extractAttachment(raw, index);
    if (!part) return { refusal: "bad_input" };
    const content = bytesOf(part.content);
    if (!content) return { refusal: "bad_input" };
    return {
      attachment: {
        filename: safeAttachmentName(part.filename),
        contentType: mediaTypeOf(part.contentType),
        content,
      },
    };
  }

  if (ref.source === "storage") {
    const fileId = typeof ref.fileId === "string" ? ref.fileId.trim() : "";
    const read = deps?.readStorageFile;
    if (!fileId || typeof read !== "function") return { refusal: "bad_input" };
    // The reader owns the ownership check: a file the operator does not own comes back as nothing.
    const reading = await readerOutcome(() => read(fileId));
    if (reading.refusal) return reading;
    const content = bytesOf(reading.value);
    if (!content) return { refusal: "bad_input" };
    return {
      attachment: {
        filename: safeAttachmentName(ref.filename),
        contentType: DEFAULT_MEDIA_TYPE,
        content,
      },
    };
  }

  return { refusal: "bad_input" };
}

/**
 * One attachment read, caught. A mail error that says the server could not be reached or timed out is a
 * part this Crow cannot fetch yet; every other failure — a file that is gone, a reader that answered
 * nonsense — is the revision naming something that is not there.
 */
async function readerOutcome(read) {
  try {
    return { value: await read() };
  } catch (err) {
    const unreachable = err instanceof MailError && (err.code === "NETWORK" || err.code === "TIMEOUT");
    return { refusal: unreachable ? "attachment_unavailable" : "bad_input" };
  }
}

/** Every attachment's bytes, in the revision's order, or the first refusal a read answered with. */
async function resolveAttachments(db, accountId, refs, deps) {
  const attachments = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const resolved = await resolveAttachment(db, accountId, ref, deps);
    if (resolved.refusal) return resolved;
    attachments.push(resolved.attachment);
  }
  return { attachments };
}

/**
 * Fold one value into the digest behind its length in four big-endian bytes, so one attachment's
 * fields and the boundary between two attachments can never be read as other fields: the same bytes
 * split differently, or the same names in a different order, is a different digest.
 */
function frame(digest, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(Math.min(bytes.length, 0xffffffff));
  digest.update(length);
  digest.update(bytes);
}

/**
 * The From a tap seals: the account's address, a newline, its display name. `requestSend` and
 * `scheduleDraft` seal `fromAddress`, `deliver` recomputes it from the account row, so the one thing
 * both sides must agree on lives in one function — and an account renamed between the tap and the
 * delivery is a different From, which the seal refuses.
 *
 * @param {{address?: string, displayName?: string|null}|null} account
 * @returns {string}
 */
export function sealFromAddress(account) {
  const address = String(account?.address ?? "").trim().toLowerCase();
  const name = typeof account?.displayName === "string"
    ? account.displayName.replace(CONTROL_CHARS_ALL, " ").replace(/\s+/g, " ").trim()
    : "";
  return `${address}\n${name}`;
}

/* ---------------------------------------------------------------- the message */

/**
 * One revision as plan 1's `OutgoingMessage`. The From is the account's address and display name —
 * a `from` on the revision is not read — `body` becomes `text`, `html` is never set, and `messageId`
 * is the draft row's when the caller passes one (a revision row has no message id of its own). The
 * fields come from `revisionToInput(rev)`, the normalised input `hashOf` covers, so what goes out is
 * what the hash and the seal were made over.
 *
 * @param {object} rev a revision row (listRevisions' shape)
 * @param {{address: string, displayName?: string|null}} account
 * @param {Array<{filename: string, contentType: string, content: Buffer|string}>} [attachments]
 * @param {{messageId?: string|null}} [options]
 * @returns {import("../adapter/interface.js").OutgoingMessage}
 */
export function toOutgoing(rev, account, attachments = [], options = {}) {
  const input = revisionToInput(rev);
  return {
    from: {
      name: typeof account?.displayName === "string" && account.displayName !== "" ? account.displayName : null,
      address: String(account?.address ?? "").trim().toLowerCase(),
    },
    to: outgoingRecipients(input.to),
    cc: outgoingRecipients(input.cc),
    bcc: outgoingRecipients(input.bcc),
    subject: input.subject,
    text: input.body,
    inReplyTo: input.inReplyTo,
    references: [...input.references],
    messageId: options?.messageId ?? rev?.messageId ?? null,
    attachments: (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
    })),
  };
}

/* ----------------------------------------------------------------- the flags */

/** The revision before this one, or null for a first revision (every address in it is an addition). */
async function previousRevision(db, draft, rev) {
  if (typeof draft?.id !== "string" || !Number.isInteger(rev?.rev) || rev.rev < 2) return null;
  const revisions = await listRevisions(db, draft.id);
  return revisions.find((entry) => entry.rev === rev.rev - 1) ?? null;
}

/** The Reply-To address when the parent message steers its replies elsewhere, else null. */
async function replyToDiffers(db, draft, account) {
  const mid = typeof draft?.replyToMid === "string" ? draft.replyToMid : "";
  if (!mid) return null;
  const parent = await resolveMessageRef(db, { accountId: account.id, mid });
  if (!parent) return null;
  return deriveReply(parent, account, { all: draft.mode === "reply_all" }).replyToDiffers;
}

/* -------------------------------------------------------------------- preflight */

/**
 * Check one revision of one draft against the account it is about to be sent from.
 *
 * @param {object} db
 * @param {object} draft the draft row (getDraft's shape)
 * @param {object} rev the revision the person is looking at (listRevisions' shape)
 * @param {{accountId?: string, deps?: {readMessageRaw?: Function, readStorageFile?: Function}}} [options]
 *   `accountId` must be the draft's own account; `deps.readMessageRaw({accountId, mid, row})` answers
 *   the raw bytes of a stored message and `deps.readStorageFile(fileId)` the bytes of a Crow file
 * @returns {Promise<{ok: true, message: object, attachDigest: string, fromAddress: string,
 *   flags: {newRecipients: string[], changedRecipients: string[], replyToDiffers: string|null}}
 *   | {ok: false, code: "placeholders"|"no_recipients"|"bad_address"|"too_large"|"bad_input"
 *      |"attachment_unavailable", detail?: string[]}>}
 *   `fromAddress` is the From a tap seals (`sealFromAddress`): the account's address and display name.
 */
export async function preflight(db, draft, rev, options = {}) {
  if (draft == null || typeof draft !== "object" || rev == null || typeof rev !== "object") {
    throw new MailError("NOT_FOUND", "draft");
  }

  // The revision must be this draft's own row: another draft's revision carries a body, an audience and
  // a From that belong to a draft this caller is not asking about. The store reads `draft_id` back as
  // `draftId`; a stored row is accepted the same way.
  const revisionDraftId = typeof rev.draftId === "string"
    ? rev.draftId
    : (typeof rev.draft_id === "string" ? rev.draft_id : null);
  if (revisionDraftId !== draft.id) return refuse("bad_input");

  // The account is the draft's own, and only that one: a caller cannot point the send at another.
  const accountId = options?.accountId ?? draft.accountId;
  if (typeof accountId !== "string" || !accountId || accountId !== draft.accountId) return refuse("bad_input");
  const account = await getAccount(db, accountId);
  if (!account) return refuse("bad_input");

  // The revision was written from this account's address; if the account has moved on, the revision
  // names a sender this Crow no longer has.
  const accountAddress = String(account.address ?? "").trim().toLowerCase();
  const revisionAddress = typeof rev.from?.address === "string" ? rev.from.address.trim().toLowerCase() : "";
  if (!revisionAddress || revisionAddress !== accountAddress) return refuse("bad_input");

  const placeholders = findPlaceholders({ subject: rev.subject, body: rev.body });
  if (placeholders.length) return refuse("placeholders", placeholders.map((token) => `[${token}]`));

  const to = Array.isArray(rev.to) ? rev.to : [];
  const cc = Array.isArray(rev.cc) ? rev.cc : [];
  const bcc = Array.isArray(rev.bcc) ? rev.bcc : [];
  const bad = badAddresses([...to, ...cc, ...bcc]);
  if (bad.length) return refuse("bad_address", bad);
  if (to.length === 0) return refuse("no_recipients");

  const resolved = await resolveAttachments(db, account.id, rev.attachments, options?.deps);
  if (resolved.refusal) return refuse(resolved.refusal);
  const attachments = resolved.attachments;
  let total = 0;
  for (const attachment of attachments) total += attachment.content.length;
  if (total > MAX_SEND_BYTES) return refuse("too_large");

  let message;
  try {
    message = validateOutgoing(toOutgoing(rev, account, attachments, { messageId: draft.messageId ?? null }));
  } catch (err) {
    // The checks above are the ones that can say which field was wrong; anything validateOutgoing
    // still refuses (an attachment's media type, say) is a plain refusal with no detail.
    if (err instanceof MailError && err.code === "BAD_INPUT") return refuse("bad_input");
    throw err;
  }

  const digest = createHash("sha256");
  for (const attachment of attachments) {
    frame(digest, attachment.filename);
    frame(digest, attachment.contentType);
    frame(digest, attachment.content);
  }

  const flags = {
    newRecipients: await newRecipients(db, account.id, [...to, ...cc, ...bcc]),
    changedRecipients: changedRecipients(await previousRevision(db, draft, rev), rev),
    replyToDiffers: await replyToDiffers(db, draft, account),
  };

  return {
    ok: true,
    message,
    attachDigest: digest.digest("hex"),
    fromAddress: sealFromAddress(account),
    flags,
  };
}