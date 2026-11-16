/**
 * Crow Mail's preflight: everything that has to hold before a draft can be tapped, checked once, in
 * one place, over one revision.
 *
 * The send and schedule services both call `preflight` before they claim anything, and `deliver` calls
 * it again after the claim, so the bytes and the size a person agreed to are the bytes and the size
 * that go out. It answers one of five refusals and never throws over a draft:
 *
 *  - `placeholders` — an unfilled `[bracket]` in the subject or the body;
 *  - `no_recipients` — nobody in To (a Cc alone is not a message);
 *  - `bad_address` — an address that is not exactly one clean addr-spec (a CR/LF, angle brackets, a
 *    second address);
 *  - `too_large` — the attachments together over `MAX_SEND_BYTES` (plan 2's effective ceiling);
 *  - `bad_input` — the draft does not belong to the account asked for, or the account's address is no
 *    longer the address the revision was written from.
 *
 * The From is the account's, always: its address and its display name, never the revision's. A revision
 * whose `from` names another address is refused rather than reinterpreted, because the account's
 * address is part of what a tap seals.
 *
 * Attachments are resolved to bytes here rather than at send time, so the digest a tap seals is a
 * digest of what the recipient would actually get. A thread attachment is the part at `index` of the
 * message `mid` names, read through `deps.readMessageRaw`; a storage attachment is
 * `deps.readStorageFile(fileId)`, which does the owner check. Neither source is reachable without its
 * reader, and an attachment this module cannot resolve refuses the draft instead of sending it short.
 *
 * `toOutgoing` is the one mapping to plan 1's `OutgoingMessage`: `body` becomes `text`, `html` is never
 * set, and the message id is the draft row's. The result always goes through `validateOutgoing`, so an
 * implementation builds its headers from that output and nothing else.
 */
import { createHash } from "node:crypto";
import { findPlaceholders, parseAddressListDetailed } from "../../staged/canonical.js";
import { MailError } from "../errors.js";
import { validateOutgoing } from "../adapter/interface.js";
import { getAccount } from "../store/accounts.js";
import { resolveMessageRef } from "../store/reader-queries.js";
import { extractAttachment, safeAttachmentName } from "../reader/attachments.js";
import { listRevisions } from "./store.js";
import { changedRecipients, deriveReply, newRecipients } from "./recipients.js";

/**
 * The largest total an outgoing message may carry, in the attachments' own bytes (base64 is not
 * counted): plan 2's effective ceiling, where an attachment above roughly 18 MB is already refused by
 * the raw-message rule before this one is reached.
 */
export const MAX_SEND_BYTES = 18 * 1024 * 1024;

/** C0 controls, DEL, C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;

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
 * One attachment as the message carries it, or null when it cannot be resolved: a ref with no usable
 * identity, no reader for its source, or a part the stored message no longer holds.
 */
async function resolveAttachment(db, accountId, ref, deps) {
  if (ref == null || typeof ref !== "object") return null;

  if (ref.source === "thread") {
    const mid = typeof ref.mid === "string" ? ref.mid.trim() : "";
    const index = Number(ref.index);
    if (!mid || !Number.isInteger(index) || index < 0) return null;
    const read = deps?.readMessageRaw;
    if (typeof read !== "function") return null;
    // The message is scoped to this account, so a ref naming another mailbox's Message-ID names nothing.
    const row = await resolveMessageRef(db, { accountId, mid });
    if (!row) return null;
    const raw = bytesOf(await read({ accountId, mid, row }));
    if (!raw) return null;
    const part = await extractAttachment(raw, index);
    if (!part) return null;
    const content = bytesOf(part.content);
    if (!content) return null;
    return { filename: safeAttachmentName(part.filename), contentType: mediaTypeOf(part.contentType), content };
  }

  if (ref.source === "storage") {
    const fileId = typeof ref.fileId === "string" ? ref.fileId.trim() : "";
    const read = deps?.readStorageFile;
    if (!fileId || typeof read !== "function") return null;
    // The reader owns the ownership check: a file the operator does not own comes back as nothing.
    const content = bytesOf(await read(fileId));
    if (!content) return null;
    return { filename: safeAttachmentName(ref.filename), contentType: DEFAULT_MEDIA_TYPE, content };
  }

  return null;
}

/** Every attachment's bytes, in the revision's order, or null when one of them cannot be resolved. */
async function resolveAttachments(db, accountId, refs, deps) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const resolved = await resolveAttachment(db, accountId, ref, deps);
    if (!resolved) return null;
    out.push(resolved);
  }
  return out;
}

/* ---------------------------------------------------------------- the message */

/**
 * One revision as plan 1's `OutgoingMessage`. The From is the account's address and display name —
 * a `from` on the revision is not read — `body` becomes `text`, `html` is never set, and `messageId`
 * is the draft row's when the caller passes one (a revision row has no message id of its own).
 *
 * @param {object} rev a revision row (listRevisions' shape)
 * @param {{address: string, displayName?: string|null}} account
 * @param {Array<{filename: string, contentType: string, content: Buffer|string}>} [attachments]
 * @param {{messageId?: string|null}} [options]
 * @returns {import("../adapter/interface.js").OutgoingMessage}
 */
export function toOutgoing(rev, account, attachments = [], options = {}) {
  return {
    from: {
      name: typeof account?.displayName === "string" && account.displayName !== "" ? account.displayName : null,
      address: String(account?.address ?? "").trim().toLowerCase(),
    },
    to: outgoingRecipients(rev?.to),
    cc: outgoingRecipients(rev?.cc),
    bcc: outgoingRecipients(rev?.bcc),
    subject: typeof rev?.subject === "string" ? rev.subject : "",
    text: typeof rev?.body === "string" ? rev.body : "",
    inReplyTo: typeof rev?.inReplyTo === "string" && rev.inReplyTo !== "" ? rev.inReplyTo : null,
    references: Array.isArray(rev?.references) ? [...rev.references] : [],
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
 *   | {ok: false, code: "placeholders"|"no_recipients"|"bad_address"|"too_large"|"bad_input",
 *      detail?: string[]}>}
 */
export async function preflight(db, draft, rev, options = {}) {
  if (draft == null || typeof draft !== "object" || rev == null || typeof rev !== "object") {
    throw new MailError("NOT_FOUND", "draft");
  }

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

  const attachments = await resolveAttachments(db, account.id, rev.attachments, options?.deps);
  if (!attachments) return refuse("bad_input");
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
  for (const attachment of attachments) digest.update(attachment.content);

  const flags = {
    newRecipients: await newRecipients(db, account.id, [...to, ...cc, ...bcc]),
    changedRecipients: changedRecipients(await previousRevision(db, draft, rev), rev),
    replyToDiffers: await replyToDiffers(db, draft, account),
  };

  return {
    ok: true,
    message,
    attachDigest: digest.digest("hex"),
    fromAddress: accountAddress,
    flags,
  };
}