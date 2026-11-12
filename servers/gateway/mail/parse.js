/**
 * Crow Mail's MIME normaliser: one raw RFC 822 message in, one ParsedMessage out. postal-mime does
 * the MIME work (charsets, transfer encodings, RFC 2047 words, address parsing, attachments);
 * this module decides what the rest of Crow Mail sees, and it never refuses to answer.
 *
 * Every path returns a ParsedMessage: a message over MAX_RAW_BYTES comes back as parseError
 * "too_large" before the parser is handed anything, and any failure of the parser (a resource
 * limit, an unsupported input type, an exception of any kind) comes back as the placeholder with
 * parseError "unparseable". The error itself is never copied into the result, a log line or a
 * stored row: a library message can quote the sender's headers.
 *
 * `text` is the plain part. An HTML-only message has no plain part at all — postal-mime renders
 * textTypes it saw, so only html comes back — and then text is derived from the html: script and
 * style content and comments dropped, tags stripped, entities decoded, whitespace collapsed. The
 * html is cut to the body limit before that derivation, so the work done on a message is bounded
 * by the cap and never by what the sender wrote. The html itself is kept as parsed (cut to the
 * same cap); sanitising it is a separate step, and this module does not treat it as safe.
 *
 * `parseRawMessageFull` also returns the attachment bytes, in the same order as
 * `ParsedMessage.attachments`: one pass over postal-mime's attachment list builds both, so index i
 * of each list is the same part by construction. That is what plan 2's attachment download reads.
 *
 * The id fields are narrowed here too: an id header names its first `<...>` token only (a trailing
 * comment or a second id on In-Reply-To is not part of it), and References keeps its LAST 50 ids,
 * because the tail is the part a sender can grow without bound.
 */
import PostalMime from "postal-mime";

/** A message bigger than this is refused unparsed. */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** Each body is cut at this many characters unless opts.maxBodyChars says otherwise. */
export const MAX_BODY_CHARS = 1_000_000;

/** Per address list (to, cc, replyTo); a wider header is cut at this count. */
export const MAX_RECIPIENTS = 200;

const SNIPPET_CHARS = 200;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * postal-mime's own limits, by the option names its README documents: `maxNestingDepth` bounds
 * MIME part nesting, `maxHeadersSize` the total header bytes, `maxPartCount` the number of parts,
 * `maxRfc822NestingDepth` how deep inline message/rfc822 sub-messages are parsed and
 * `maxForwardedAddresses` the addresses those sub-messages render into the body. Exceeding one
 * rejects the parse, which parseRawMessageFull turns into parseError "unparseable" — so a multipart
 * bomb or a header bomb ends as a stored placeholder instead of a stack overflow or a busy loop.
 * `attachmentEncoding: "arraybuffer"` keeps each attachment's content as the bytes themselves.
 * Every value is fixed here: the options are never built from the message.
 */
const PARSE_OPTIONS = Object.freeze({
  attachmentEncoding: "arraybuffer",
  maxNestingDepth: 100,
  maxHeadersSize: 1024 * 1024,
  maxPartCount: 5000,
  maxRfc822NestingDepth: 5,
  maxForwardedAddresses: 5000,
});

/** Raw length in bytes, for the MAX_RAW_BYTES gate; anything unmeasurable is let through to the
 *  parser, which then answers with parseError "unparseable". */
function rawSize(raw) {
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return 0;
}

/** The result every failure path returns: nothing but the code, and fresh objects each call so a
 *  caller can never mutate a shared placeholder. */
function placeholder(parseError) {
  return {
    parsed: {
      messageId: null,
      inReplyTo: null,
      references: [],
      subject: "",
      from: null,
      to: [],
      cc: [],
      replyTo: [],
      date: null,
      text: "",
      html: null,
      snippet: "",
      attachments: [],
      truncated: false,
      parseError,
    },
    attachmentContents: [],
  };
}

/**
 * The placeholder ParsedMessage for one failure code, without its attachment bytes: what the sync engine
 * stores for a message it never parsed at all (one the server reported as larger than MAX_RAW_BYTES,
 * or one whose bytes the adapter reported as empty). A fresh object each call, so a caller can never
 * mutate a shared placeholder.
 *
 * @param {"too_large"|"unparseable"} parseError
 * @returns {object} a ParsedMessage with parseError set
 */
export function placeholderMessage(parseError) {
  return placeholder(parseError).parsed;
}

function bodyLimit(opts) {
  const wanted = opts && typeof opts === "object" ? opts.maxBodyChars : undefined;
  if (typeof wanted === "number" && Number.isFinite(wanted) && wanted >= 0) return Math.floor(wanted);
  return MAX_BODY_CHARS;
}

/** Cut `value` to at most `limit` characters, never through a surrogate pair. */
function cut(value, limit) {
  if (value.length <= limit) return value;
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** HTML named entities worth decoding in a derived text body. Unknown names stay as written. */
const NAMED_ENTITIES = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  thinsp: " ", shy: "",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
  frac12: "½", frac14: "¼", frac34: "¾", minus: "−",
  hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  dagger: "†", Dagger: "‡", sect: "§", para: "¶",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
  szlig: "ß", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ntilde: "ñ",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
});

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** Decode character references once, left to right: `&amp;lt;` is "&lt;", never "<". */
function decodeEntities(value) {
  return value.replace(ENTITY_RE, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match; // a lone surrogate names no character
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

const collapse = (value) => value.replace(/\s+/g, " ").trim();

/** ASCII lower case of one char code. Html tag names are ASCII, and String.prototype.toLowerCase
 *  is not used here because it can change a string's length (a dotted capital I becomes two
 *  characters), which would move every index the scan below relies on. */
function lowerCode(code) {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/** Characters that continue a tag name, so `<script-x>` and `<script>` are different names and
 *  `<scriptx` is not a script tag. Anything else (whitespace, `/`, `>`, `<`) ends the name. */
function isTagNameCode(code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f || code === 0x3a;
}

/** The lower-cased tag name starting at `lt` (the position of "<"), or "" when the character
 *  after the "<" is not a name character (`<!doctype`, `</p`, `< a`). */
function tagNameAt(html, lt) {
  let i = lt + 1;
  const start = i;
  while (i < html.length && isTagNameCode(html.charCodeAt(i))) i++;
  if (i === start) return "";
  let name = "";
  for (let k = start; k < i; k++) name += String.fromCharCode(lowerCode(html.charCodeAt(k)));
  return name;
}

/** What may follow a closing tag name: the end of the tag or whitespace before the `>`. */
function endsTagName(code) {
  return code === 0x3e || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/** The position of "</name" at or after `from`, matched case-insensitively and only when the name
 *  ends there, or -1. The caller consumes everything up to what this found, so no stretch of the
 *  html is ever scanned twice. */
function closingTagAt(html, name, from) {
  const length = html.length;
  let i = from;
  for (let lt = html.indexOf("</", i); lt !== -1; lt = html.indexOf("</", i)) {
    const after = lt + 2 + name.length;
    if (after <= length) {
      let matches = true;
      for (let k = 0; k < name.length; k++) {
        if (lowerCode(html.charCodeAt(lt + 2 + k)) !== name.charCodeAt(k)) {
          matches = false;
          break;
        }
      }
      if (matches && (after === length || endsTagName(html.charCodeAt(after)))) return lt;
    }
    i = lt + 2;
  }
  return -1;
}

/** Everything htmlToText drops, in one forward pass with no regular expression over the input:
 *  comments and script/style blocks (with their content), then any other tag. A block or comment
 *  that never closes takes the rest of the body with it, so a sender cannot smuggle markup or
 *  script text into the derived body by leaving an end marker off.
 *
 * Each removal becomes a space, which is what the whitespace collapse downstream expects between
 * what used to be two adjacent pieces of text (`a<br>b` is "a b", not "ab"). Every search starts
 * where the previous one ended and only ever moves forward, so the pass is linear in the length
 * of `html` — including on nothing but `<`, on a megabyte of unclosed comments, and on a script
 * block whose end tag is missing. */
function stripMarkup(html) {
  const length = html.length;
  const parts = [];
  let pos = 0;

  while (pos < length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      if (lt > pos) parts.push(html.slice(pos, lt));
      parts.push(" ");
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) return parts.join("");
      pos = close + 3;
      continue;
    }

    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      // A "<" with no ">" after it ends the body's text: the remainder is not text.
      if (lt > pos) parts.push(html.slice(pos, lt));
      parts.push(" ");
      return parts.join("");
    }

    const name = tagNameAt(html, lt);
    if (name === "script" || name === "style") {
      if (lt > pos) parts.push(html.slice(pos, lt));
      parts.push(" ");
      const closeLt = closingTagAt(html, name, gt + 1);
      if (closeLt === -1) return parts.join("");
      const closeGt = html.indexOf(">", closeLt + 1);
      if (closeGt === -1) return parts.join("");
      pos = closeGt + 1;
      continue;
    }

    if (lt > pos) parts.push(html.slice(pos, lt));
    parts.push(" ");
    pos = gt + 1;
  }

  if (pos < length) parts.push(html.slice(pos, length));
  return parts.join("");
}

/** The text of an html body: script and style content and comments gone, then the tags, then the
 *  entities decoded. Browser-grade conversion is not the goal — a readable body and a snippet are. */
function htmlToText(html) {
  return collapse(decodeEntities(stripMarkup(String(html))));
}

/** postal-mime's address entries as `{name, address}`: groups flattened to their members, entries
 *  without an address dropped, addresses lower-cased, and a stop at MAX_RECIPIENTS. */
function addressList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const members = Array.isArray(entry.group) ? entry.group : [entry];
    for (const member of members) {
      if (!member || typeof member !== "object") continue;
      const address = typeof member.address === "string" ? member.address.trim().toLowerCase() : "";
      if (!address) continue;
      out.push({ name: typeof member.name === "string" ? member.name : "", address });
      if (out.length >= MAX_RECIPIENTS) return out;
    }
  }
  return out;
}

/** One address (the From header): a group gives its first member, and an entry with no mailbox is
 *  kept with an empty address rather than dropped, so a sender can never look like no sender. */
function singleAddress(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name : "";
  if (Array.isArray(entry.group)) {
    const first = entry.group.find((m) => m && typeof m.address === "string" && m.address);
    return {
      name: first && typeof first.name === "string" && first.name ? first.name : name,
      address: first ? first.address.trim().toLowerCase() : "",
    };
  }
  const address = typeof entry.address === "string" ? entry.address.trim().toLowerCase() : "";
  return { name, address };
}

/** `<...>` msg-ids in the order sent; a sender that left the brackets off gets its bare tokens.
 *  Only the LAST MAX_REFERENCES of them are kept: a thread's nearest ancestors are the ones that
 *  matter, and the tail is the part a sender can grow without bound. */
const REFERENCE_TOKEN_RE = /<[^<>\s]{1,998}>/g;

/** How many references header ids are kept. */
const MAX_REFERENCES = 50;

function messageIds(value) {
  if (typeof value !== "string") return [];
  const out = [];
  REFERENCE_TOKEN_RE.lastIndex = 0;
  for (let m = REFERENCE_TOKEN_RE.exec(value); m !== null; m = REFERENCE_TOKEN_RE.exec(value)) out.push(m[0]);
  const ids = out.length > 0 ? out : value.split(/[\s,]+/).filter((token) => token !== "");
  return ids.length > MAX_REFERENCES ? ids.slice(-MAX_REFERENCES) : ids;
}

/** The id a Message-ID or In-Reply-To header names: its first `<...>` token with the brackets kept,
 *  so a trailing comment (`<m@x> (c)`) or a second id on an In-Reply-To is not part of it. A header
 *  with no brackets at all names its first whitespace-separated token; an empty one names nothing. */
const FIRST_ID_RE = /<[^<>\s]{1,998}>/;

function singleMessageId(value) {
  if (typeof value !== "string") return null;
  const bracketed = FIRST_ID_RE.exec(value);
  if (bracketed) return bracketed[0];
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.split(/\s+/)[0];
}

function dateMs(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function contentId(value) {
  if (typeof value !== "string") return null;
  const unwrapped = value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  return unwrapped === "" ? null : unwrapped;
}

/** An attachment's bytes as a Uint8Array. Calendar parts arrive as a Uint8Array already, other
 *  parts as an ArrayBuffer. */
function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
  }
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(0);
}

/** One pass over postal-mime's attachment list builds the metadata and the bytes together. */
function attachmentsOf(list) {
  const attachments = [];
  const attachmentContents = [];
  for (const attachment of Array.isArray(list) ? list : []) {
    const part = attachment && typeof attachment === "object" ? attachment : {};
    const bytes = toBytes(part.content);
    attachmentContents.push(bytes);
    attachments.push({
      filename: typeof part.filename === "string" ? part.filename : "",
      contentType: typeof part.mimeType === "string" && part.mimeType
        ? part.mimeType.toLowerCase()
        : DEFAULT_CONTENT_TYPE,
      size: bytes.byteLength,
      contentId: contentId(part.contentId),
      // postal-mime reports the disposition token as sent, or null when the part carried none.
      // A part it listed as an attachment is one either way.
      disposition: typeof part.disposition === "string" && part.disposition
        ? part.disposition.toLowerCase()
        : "attachment",
    });
  }
  return { attachments, attachmentContents };
}

function normalise(email, opts) {
  const limit = bodyLimit(opts);
  const htmlSource = typeof email.html === "string" ? email.html : null;
  // The html is cut before anything walks it, so the derivation below reads at most `limit`
  // characters however large the part postal-mime decoded was.
  const html = htmlSource === null ? null : cut(htmlSource, limit);
  const htmlCut = html !== null && html.length < htmlSource.length;

  const text0 = typeof email.text === "string" && email.text !== ""
    ? email.text
    : html === null ? "" : htmlToText(html);

  const text = cut(text0, limit);
  const truncated = text.length < text0.length || htmlCut;

  const { attachments, attachmentContents } = attachmentsOf(email.attachments);

  return {
    parsed: {
      messageId: singleMessageId(email.messageId),
      inReplyTo: singleMessageId(email.inReplyTo),
      references: messageIds(email.references),
      subject: typeof email.subject === "string" ? email.subject.trim() : "",
      from: singleAddress(email.from),
      to: addressList(email.to),
      cc: addressList(email.cc),
      replyTo: addressList(email.replyTo),
      date: dateMs(email.date),
      text,
      html,
      snippet: collapse(text).slice(0, SNIPPET_CHARS),
      attachments,
      truncated,
      parseError: null,
    },
    attachmentContents,
  };
}

/**
 * Parse one raw message, returning the normalised message together with the bytes of each of its
 * attachments (index i of `attachmentContents` is index i of `parsed.attachments`). Never rejects:
 * every failure, foreseen or not, is the placeholder with parseError set and empty contents.
 */
export async function parseRawMessageFull(raw, opts) {
  try {
    if (rawSize(raw) > MAX_RAW_BYTES) return placeholder("too_large");
    const email = await PostalMime.parse(raw, PARSE_OPTIONS);
    return normalise(email, opts);
  } catch {
    // Deliberately no message, no cause and no log: the text belongs to the sender.
    return placeholder("unparseable");
  }
}

/** Parse one raw message without the attachment bytes. Never rejects. */
export async function parseRawMessage(raw, opts) {
  const full = await parseRawMessageFull(raw, opts);
  return full.parsed;
}