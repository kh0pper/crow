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
 * html itself is kept as parsed; sanitising it is a separate step, and this module does not treat
 * it as safe.
 *
 * `parseRawMessageFull` also returns the attachment bytes, in the same order as
 * `ParsedMessage.attachments`: one pass over postal-mime's attachment list builds both, so index i
 * of each list is the same part by construction. That is what plan 2's attachment download reads.
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

/** The text of an html body: script and style content and comments gone, then the tags, then the
 *  entities decoded. Browser-grade conversion is not the goal — a readable body and a snippet are. */
function htmlToText(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    // An unclosed <script or <style would otherwise keep its content as body text.
    .replace(/<(script|style)\b[\s\S]*$/i, " ")
    .replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(stripped));
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

/** `<...>` msg-ids in the order sent; a sender that left the brackets off gets its bare tokens. */
function messageIds(value) {
  if (typeof value !== "string") return [];
  const out = [];
  const re = /<[^<>\s]{1,998}>/g;
  for (let m = re.exec(value); m !== null; m = re.exec(value)) out.push(m[0]);
  if (out.length > 0) return out;
  return value.split(/[\s,]+/).filter((token) => token !== "");
}

function singleMessageId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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
  const html0 = typeof email.html === "string" ? email.html : null;
  const text0 = typeof email.text === "string" && email.text !== ""
    ? email.text
    : html0 === null ? "" : htmlToText(html0);

  const text = cut(text0, limit);
  const html = html0 === null ? null : cut(html0, limit);
  const truncated = text.length < text0.length || (html !== null && html.length < html0.length);

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