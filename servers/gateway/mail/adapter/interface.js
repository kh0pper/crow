/**
 * Crow Mail's provider-neutral adapter: the nine methods a mailbox implementation offers, the shape
 * of each answer, and `validateOutgoing` — the one rule an outgoing message passes before any
 * implementation touches it.
 *
 * The contract is small on purpose and free of provider policy. `list` reports UIDs, flags, internal
 * dates and sizes and never a parsed message; `get` hands back raw bytes and lets the normaliser
 * parse them; `watch` reports that something changed and nothing more, because reconnecting and
 * re-syncing are the supervisor's decisions, not the adapter's.
 *
 * `uidNext` is part of `list` because the sync engine advances `highest_uid` to `uidNext - 1` on a
 * first sync, so an empty window still moves forward. A server that omits it from a listing must not
 * leave the field missing: the adapter reads `STATUS (UIDNEXT)` and, failing that, answers with the
 * highest listed UID + 1. `afterUid` is filtered by the adapter rather than by the server, because a
 * UID search from a UID past the mailbox's own range still answers with the last message.
 *
 * `validateOutgoing` lives here rather than in an implementation because every implementation has to
 * refuse the same things: a caller-controlled `envelope` (nodemailer would use it instead of the
 * header addresses, which is a header-injection route), an unknown key, an address that is not
 * exactly one clean addr-spec, and a CR/LF anywhere a header is built from it. Address parsing is
 * `parseAddressListDetailed` — the same RFC 5322 reader the staged-draft hashing uses — so a display
 * name or a group in one field is refused, never re-read at send time. The returned value is the
 * message with nothing but the allowed fields, so an implementation builds its headers from that and
 * from nothing else.
 *
 * @typedef {{name: string|null, address: string}} AdapterAddress
 * @typedef {{path: string, name: string, specialUse: string|null, delimiter: string,
 *            selectable: boolean}} AdapterFolder
 * @typedef {{uid: number, flags: string[], internalDate: number, size: number}} AdapterItem
 * @typedef {{uidValidity: number, uidNext: number, items: AdapterItem[]}} AdapterListing
 * @typedef {{uid: number, flags: string[], internalDate: number, raw: Buffer}} AdapterMessage
 * @typedef {{folderPath: string, uid: number|null}} AdapterDraftRef
 * @typedef {{messageId: string, accepted: string[], rejected: string[]}} AdapterSendResult
 * @typedef {{from: AdapterAddress, to: AdapterAddress[], cc?: AdapterAddress[],
 *            bcc?: AdapterAddress[], subject: string, text: string, html?: string|null,
 *            inReplyTo?: string|null, references?: string[],
 *            attachments?: {filename: string, contentType: string,
 *                           content: Buffer|Uint8Array|string}[]}} OutgoingMessage
 */
import { MailError } from "../errors.js";
import { parseAddressListDetailed } from "../../staged/canonical.js";

/** Every method an adapter must provide, in the order a reader of an implementation meets them. */
export const ADAPTER_METHODS = Object.freeze([
  "connect",
  "close",
  "listFolders",
  "list",
  "get",
  "search",
  "saveDraft",
  "send",
  "watch",
]);

/** A field of an OutgoingMessage; anything else in the object is refused (see validateOutgoing). */
const OUTGOING_KEYS = new Set([
  "from", "to", "cc", "bcc", "subject", "text", "html", "inReplyTo", "references", "attachments",
]);
const ATTACHMENT_KEYS = new Set(["filename", "contentType", "content"]);
const RECIPIENT_KEYS = new Set(["name", "address"]);

/** A message id header entry: one angle-bracketed token, no whitespace and no second bracket. */
const MESSAGE_ID_RE = /^<[^<>\s]{1,250}>$/;

/** References past this many are dropped from the front: the tail is the part a sender controls. */
const MAX_REFERENCES = 50;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f]/g;
const CRLF_RUN = /[\r\n]+/g;
const DEFAULT_ATTACHMENT_TYPE = "application/octet-stream";

function fail(detail) {
  throw new MailError("BAD_INPUT", detail);
}

/* ---------------------------------------------------------------- the method list */

/**
 * Check that an object offers the whole contract before anything is connected or written.
 * @template T
 * @param {T} obj
 * @returns {T} the same object, so a factory can `return assertAdapter(built)`
 */
export function assertAdapter(obj) {
  if (obj == null || typeof obj !== "object") {
    throw new TypeError("a mail adapter must be an object");
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof obj[method] !== "function") {
      throw new TypeError(`a mail adapter is missing ${method}()`);
    }
  }
  return obj;
}

/* ------------------------------------------------------------ outgoing validation */

/**
 * One address field: exactly one clean addr-spec. Trimmed (a trailing newline is not part of an
 * address), but CR/LF or any other control character inside it is refused rather than repaired, and
 * so is anything the strict parser reads back differently — a display name (`Sam <sam@x>`), a group,
 * a second address, or a bare `>`.
 */
function oneAddress(value, detail) {
  if (typeof value !== "string") fail(detail);
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHARS.test(trimmed)) fail(detail);
  const { addresses, invalid } = parseAddressListDetailed(trimmed);
  if (invalid.length || addresses.length !== 1) fail(detail);
  if (addresses[0] !== trimmed.toLowerCase()) fail(detail);
  return addresses[0];
}

/** A display name with every control character removed: a CR/LF can never reach a header. */
function cleanName(value, detail) {
  if (value == null) return null;
  if (typeof value !== "string") fail(detail);
  const name = value.replace(CONTROL_CHARS_ALL, "");
  return name || null;
}

/** One recipient: `{name?, address}` (or a bare address string, which is the same thing unnamed). */
function oneRecipient(entry, detail) {
  if (typeof entry === "string") return { name: null, address: oneAddress(entry, detail) };
  if (entry == null || typeof entry !== "object") fail(detail);
  for (const key of Object.keys(entry)) {
    if (!RECIPIENT_KEYS.has(key)) fail(detail);
  }
  return { name: cleanName(entry.name, detail), address: oneAddress(entry.address, detail) };
}

function addressList(value, detail, { required = false } = {}) {
  if (value == null) {
    if (required) fail(detail);
    return [];
  }
  if (!Array.isArray(value)) fail(detail);
  if (required && value.length === 0) fail(detail);
  return value.map((entry) => oneRecipient(entry, detail));
}

/** One message id header value: `<...>`, nothing else. */
function oneMessageId(value, detail) {
  if (typeof value !== "string" || !MESSAGE_ID_RE.test(value)) fail(detail);
  return value;
}

function idList(value, detail, keep) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(detail);
  const ids = value.map((entry) => oneMessageId(entry, detail));
  return ids.length > keep ? ids.slice(-keep) : ids;
}

/** A subject's CR/LF runs become one space, exactly as `canonicalSnapshot` writes it. */
function normaliseSubject(value) {
  if (value == null) return "";
  if (typeof value !== "string") fail("subject");
  return value.replace(CRLF_RUN, " ").trim();
}

function bodyPart(value, detail) {
  if (typeof value !== "string") fail(detail);
  return value;
}

function attachmentList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("attachments");
  return value.map((entry) => {
    if (entry == null || typeof entry !== "object") fail("attachments");
    for (const key of Object.keys(entry)) {
      if (!ATTACHMENT_KEYS.has(key)) fail("attachments");
    }
    if (typeof entry.filename !== "string") fail("attachments");
    const filename = entry.filename.replace(CONTROL_CHARS_ALL, "");
    if (!filename) fail("attachments");
    const contentType = entry.contentType == null ? DEFAULT_ATTACHMENT_TYPE : entry.contentType;
    if (typeof contentType !== "string") fail("attachments");
    const content = entry.content;
    if (!(typeof content === "string" || content instanceof Uint8Array || content instanceof ArrayBuffer)) {
      fail("attachments");
    }
    return { filename, contentType, content };
  });
}

/**
 * The one rule an outgoing message passes: refuse it whole, or return it with only the allowed
 * fields and every header-safe normalisation applied. An `envelope` key gets its own detail because
 * it is the specific mistake the gate exists for; any other unknown key is a plain field refusal.
 *
 * @param {OutgoingMessage} message
 * @returns {OutgoingMessage}
 */
export function validateOutgoing(message) {
  if (message == null || typeof message !== "object" || Array.isArray(message)) fail("message");
  for (const key of Object.keys(message)) {
    if (!OUTGOING_KEYS.has(key)) fail(key === "envelope" ? "envelope" : "field");
  }

  const from = message.from;
  if (from == null || typeof from !== "object") fail("from");
  for (const key of Object.keys(from)) {
    if (!RECIPIENT_KEYS.has(key)) fail("from");
  }

  const validated = {
    from: { name: cleanName(from.name, "from"), address: oneAddress(from.address, "from") },
    to: addressList(message.to, "to", { required: true }),
    cc: addressList(message.cc, "cc"),
    bcc: addressList(message.bcc, "bcc"),
    subject: normaliseSubject(message.subject),
    text: message.text == null ? "" : bodyPart(message.text, "text"),
    html: message.html == null ? null : bodyPart(message.html, "html"),
    inReplyTo: message.inReplyTo == null ? null : oneMessageId(message.inReplyTo, "inReplyTo"),
    references: idList(message.references, "references", MAX_REFERENCES),
    attachments: attachmentList(message.attachments),
  };
  if (!validated.text && !validated.html) fail("body");
  return validated;
}