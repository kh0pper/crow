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
 * exactly one clean addr-spec, an attachment whose media type is not a `type/subtype` token, and a
 * control character anywhere a header is built from it. Address parsing is
 * `parseAddressListDetailed` — the same RFC 5322 reader the staged-draft hashing uses — so a display
 * name or a group in one field is refused, never re-read at send time. The returned value is the
 * message with nothing but the allowed fields, so an implementation builds its headers from that and
 * from nothing else.
 *
 * Control characters are treated by field, never by accident. An address and a message id are refused
 * (one with a trailing CR/LF is an injection attempt, not padding, and it is refused before any
 * trimming hides it), and so is a subject carrying a C0 control other than the three a header can hold.
 * A display name and a filename are stripped instead, because there the text is the caller's to keep
 * and only the control character has to go. A subject's CR, LF and TAB become one space, and C1
 * controls (U+0080-U+009F) and the Unicode line and paragraph separators (U+2028, U+2029) are stripped
 * from a subject, a display name and a filename — they are not header delimiters, only text no header
 * should carry — while an address or a message id carrying one is refused like any other control
 * character.
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

/** RFC 6838 restricted-name: one letter or digit, then up to 126 more name characters. */
const RESTRICTED_NAME = "[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}";
/**
 * A media type: `type/subtype`, plus optional `;` parameters holding no control character. The whole
 * value is handed to nodemailer, which re-encodes the parameters for the part header; nothing here is
 * written to a header as it stands.
 */
const CONTENT_TYPE_RE = new RegExp(
  `^${RESTRICTED_NAME}/${RESTRICTED_NAME}(?:;[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*)?$`,
);

/** References past this many are dropped from the front: the tail is the part a sender controls. */
const MAX_REFERENCES = 50;

/** C0 controls, DEL, C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;
const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g;
/**
 * A subject may carry CR, LF and TAB (they become one space); every other C0 control and DEL is
 * refused. C1 controls and U+2028/U+2029 are stripped instead — see SUBJECT_STRIPPED_CHARS.
 */
const SUBJECT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SUBJECT_STRIPPED_CHARS = /[\u0080-\u009f\u2028\u2029]/g;
/** A run of the whitespace a header line cannot hold: it becomes one space. */
const SUBJECT_WHITESPACE_RUN = /[\r\n\t]+/g;
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
 * One address field: exactly one clean addr-spec. Surrounding spaces go, but the control-character
 * test runs before that trim, so a trailing `\n` or a leading `\r` is refused instead of being
 * trimmed away and forgotten; anything the strict parser reads back differently — a display name
 * (`Sam <sam@x>`), a group, a second address, or a bare `>` — is refused too.
 */
function oneAddress(value, detail) {
  if (typeof value !== "string") fail(detail);
  if (CONTROL_CHARS.test(value)) fail(detail);
  const trimmed = value.trim();
  if (!trimmed) fail(detail);
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

/** One message id header value: `<...>`, nothing else, and no control character inside it. */
function oneMessageId(value, detail) {
  if (typeof value !== "string" || CONTROL_CHARS.test(value) || !MESSAGE_ID_RE.test(value)) fail(detail);
  return value;
}

function idList(value, detail, keep) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(detail);
  const ids = value.map((entry) => oneMessageId(entry, detail));
  return ids.length > keep ? ids.slice(-keep) : ids;
}

/**
 * A subject's CR/LF runs become one space, exactly as `canonicalSnapshot` writes it, and a TAB becomes
 * one too rather than reaching the header as it stands. A C1 control or a Unicode line separator is
 * dropped instead. A subject is not a place to repair beyond that: any C0 control left (NUL first
 * among them) refuses the message.
 */
function normaliseSubject(value) {
  if (value == null) return "";
  if (typeof value !== "string" || SUBJECT_CONTROL_CHARS.test(value)) fail("subject");
  return value.replace(SUBJECT_STRIPPED_CHARS, "").replace(SUBJECT_WHITESPACE_RUN, " ").trim();
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
    const declared = entry.contentType == null ? DEFAULT_ATTACHMENT_TYPE : entry.contentType;
    if (typeof declared !== "string" || CONTROL_CHARS.test(declared)) fail("attachments");
    const contentType = declared.trim();
    if (!CONTENT_TYPE_RE.test(contentType)) fail("attachments");
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