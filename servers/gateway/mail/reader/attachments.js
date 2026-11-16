/**
 * Crow Mail's attachment extractor: the bytes of one attachment out of one raw message, and the two
 * header-safe spellings of its name that a download answer needs.
 *
 * The bytes come from plan 1's `parseRawMessageFull`, never from a second parser: that function
 * builds `parsed.attachments` and `attachmentContents` in one pass over postal-mime's list, so index
 * i of each is the same part by construction. The index the reader links (`GET /messages/:id` lists
 * `parsed.attachments`, stored in `attachments_json`) and the index the download route serves are
 * therefore the same index, and a message whose parts moved is a mismatch the route refuses rather
 * than an attachment it serves from the wrong part.
 *
 * `extractAttachmentFromParsed` is the extractor proper: it reads plan 1's parse answer, which holds
 * `parsed.attachments` and `attachmentContents`, so a caller that already parsed the raw message (the
 * download route parses it once, to compare what came back with the stored row) pays for one parse,
 * not two. `extractAttachment` is the thin wrapper for a caller holding only the raw bytes: it parses,
 * then asks the same function. Neither throws and neither refuses a call with an exception: a bad
 * index, a parse failure and a stored `parseError` are all null. Plan 3 imports this module to forward
 * an attachment, so it must not depend on a route, a database row or a response object.
 *
 * `MAX_ATTACHMENT_BYTES` is a defensive second check, not the limit a person meets. The effective
 * limit is plan 1's `MAX_RAW_BYTES` (25 MB): the adapter answers an empty Buffer for any message
 * above it, and an attachment near 20 MB is about 27 MB once base64-encoded, so in practice an
 * attachment above roughly 18 MB is refused by the raw-size rule before this check is reached.
 *
 * `safeAttachmentName` and `encodeRfc5987` are the only two names a download answer carries. A
 * filename is the sender's text (postal-mime's README says so): it may hold path separators, control
 * characters, quotes or right-to-left overrides, and a header is a line of a protocol, so the plain
 * form is stripped and capped and the extended form is percent-encoded the RFC 5987 way.
 */
import { parseRawMessageFull } from "../parse.js";

/** A defensive ceiling on one attachment: the raw-size rule is the one a person actually meets. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The longest filename a download answer carries. */
const NAME_MAX = 120;

/** What an attachment with no usable name is called. */
const FALLBACK_NAME = "attachment";

/** Every character of `value` except a surrogate that has no pair: it names no character. */
function withoutLoneSurrogates(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value[i];
  }
  return out;
}

/**
 * The invisible format characters a filename may hold and a header may not: the zero-width and bidi
 * marks (U+200B..U+200F), the bidi embeddings and overrides (U+202A..U+202E), the bidi isolates
 * (U+2066..U+2069), the Arabic letter mark (U+061C) and a byte-order mark (U+FEFF). They reorder or
 * hide the characters around them, so a name carrying one does not read as the characters it is made
 * of.
 */
function isInvisibleFormatCode(code) {
  return (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069)
    || code === 0xfeff
    || code === 0x061c;
}

/**
 * The characters of a filename that may not survive into a header: path separators (either spelling),
 * the double quote that would end the quoted form, the C0/C1 control characters a header cannot
 * carry, and the invisible format characters that reorder or hide their neighbours. A lone surrogate
 * is dropped too: it names no character and `encodeURIComponent` throws on it.
 */
function withoutUnsafeNameChars(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + value[i + 1];
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (ch === "/" || ch === "\\" || ch === "\"") continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (isInvisibleFormatCode(code)) continue;
    out += ch;
  }
  return out;
}

/**
 * One attachment's name as a download answer may carry it: path separators, control characters,
 * invisible format characters and double quotes gone, at most 120 characters, and an empty result
 * becomes "attachment". The quote is the only quote stripped: an apostrophe is an ordinary filename
 * character, and the extended form percent-encodes it instead (see `encodeRfc5987`).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function safeAttachmentName(name) {
  const cleaned = typeof name === "string" ? withoutUnsafeNameChars(name).trim() : "";
  const chars = Array.from(cleaned);
  const capped = chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join("") : cleaned;
  return capped === "" ? FALLBACK_NAME : capped;
}

/**
 * A string as an RFC 5987 `filename*` value (`UTF-8''<value>` carries the charset and the language).
 * `encodeURIComponent` leaves `'`, `(`, `)` and `*` unescaped, and RFC 5987 allows none of them in
 * the value, so they are percent-encoded here as well. A lone surrogate cannot be encoded at all and
 * is dropped rather than thrown over.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function encodeRfc5987(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return encodeURIComponent(withoutLoneSurrogates(text))
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/**
 * `index` as an attachment position: a non-negative integer, or the decimal digits of one, exactly
 * as the reader links it. Anything else (a null, a fraction, a word) names no attachment.
 *
 * @param {unknown} index
 * @returns {number|null}
 */
function attachmentIndex(index) {
  if (typeof index === "number") return Number.isInteger(index) && index >= 0 ? index : null;
  if (typeof index === "string" && /^[0-9]{1,6}$/.test(index)) return Number(index);
  return null;
}

/**
 * The bytes and metadata of one attachment out of an already-parsed message.
 *
 * `result` is what plan 1's `parseRawMessageFull` answered: `parsed` (which carries `attachments`)
 * together with `attachmentContents`, one pass over postal-mime's list having built both, so index i of
 * each is the same part by construction.
 *
 * Never throws: a bad index, a missing parse, a stored `parseError` and no attachment at that index are
 * all null.
 *
 * @param {{parsed?: object, attachmentContents?: ArrayLike<Uint8Array>}|null} result
 *   plan 1's parse answer
 * @param {number|string} index the attachment's position, the same index `parsed.attachments` uses
 * @returns {{filename: string, contentType: string, size: number, content: Buffer}|null}
 *   null for a bad index, a parse failure, a stored `parseError` or no attachment at that index
 */
export function extractAttachmentFromParsed(result, index) {
  const wanted = attachmentIndex(index);
  if (wanted === null || !result || typeof result !== "object") return null;
  try {
    const parsed = result.parsed && typeof result.parsed === "object" ? result.parsed : null;
    if (!parsed || parsed.parseError) return null;
    const part = Array.isArray(parsed.attachments) ? parsed.attachments[wanted] : null;
    const bytes = Array.isArray(result.attachmentContents) ? result.attachmentContents[wanted] : null;
    if (!part || !bytes) return null;
    const content = Buffer.from(bytes);
    return {
      filename: typeof part.filename === "string" ? part.filename : "",
      contentType: typeof part.contentType === "string" ? part.contentType : "",
      size: content.length,
      content,
    };
  } catch {
    // Nothing here is expected to throw; a caller handing over a mutated or foreign answer gets null,
    // never an exception on a download path.
    return null;
  }
}

/**
 * The bytes and metadata of one attachment of one raw message: the parse, then
 * `extractAttachmentFromParsed`. Plan 3 imports this to forward an attachment fetched by a caller that
 * holds only the bytes.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} raw the message as the adapter fetched it
 * @param {number} index the attachment's position, the same index `parsed.attachments` uses
 * @returns {Promise<{filename: string, contentType: string, size: number, content: Buffer}|null>}
 *   null for a bad index, a parse failure, a stored `parseError` or no attachment at that index
 */
export async function extractAttachment(raw, index) {
  return extractAttachmentFromParsed(await parseRawMessageFull(raw), index);
}

