/**
 * The canonical form of a staged draft (spec §12.3 item 1): one snapshot shape, one hash, one
 * placeholder rule, shared by the recorder that stages a row, the route that edits it and the route
 * that sends it. If any of the three canonicalised differently, "the draft changed" would fire on an
 * unchanged draft (or miss a real change), so nothing else may normalise a draft.
 *
 * A snapshot is { to[], cc[], bcc[], subject, body }. Addresses are parsed out of the provider's
 * header strings ("Name <a@x>, b@y"), lower-cased, de-duplicated and sorted, so header order and
 * case cannot move the hash. The body's line endings and trailing whitespace are the only two
 * things Gmail is free to change under us; both are normalised away.
 *
 * The address parser is a real one (RFC 5322 address-list): quoted strings with backslash escapes,
 * nested comments, and groups. That matters for safety, not tidiness — what we hash is what we send,
 * so an address hidden in a display name or a comment ("Boss <boss@old.example.com>" <evil@example.com>)
 * must never be mistaken for the real recipient, and a comma inside a quoted name must never split one
 * entry into two. Only a clean addr-spec ever enters a snapshot; `parseAddressListDetailed` also
 * reports the entries it could not read cleanly, and the client refuses to send such a draft (fail
 * closed).
 *
 * RFC 2047 encoded words are decoded for the subject (the one header's text we keep) so that a
 * non-ASCII subject hashes the same before and after a round trip through the provider.
 *
 * The placeholder rule (`[Client Name]`) blocks Send until the operator fills it in. It must not
 * fire on a Markdown link (`[text](url)`) or on a subject tag (`[EXTERNAL SENDER] Re: [crow-dev]`),
 * so the pattern requires at least two characters and no following `(`, a short allowlist of tags is
 * skipped case-insensitively, and a subject's leading labels are stripped first (stripSubjectTags).
 */
import { createHash } from "node:crypto";

/** Subject tags that are not unfilled placeholders, lower-cased. */
export const PLACEHOLDER_ALLOWLIST = Object.freeze(["external", "ext", "fwd", "fw", "re", "sent", "draft"]);

/**
 * A bracketed run of letters, digits, spaces, apostrophes, underscores and hyphens, 2-40 characters,
 * not followed by "(" (a link). The wider class is what the review asked for: `[Client's Name]` and
 * `[CLIENT_NAME]` are placeholders, `[the docs](https://…)` is not.
 */
export const PLACEHOLDER_PATTERN = String.raw`\[([A-Za-z][A-Za-z0-9 '_\-]{1,39})\](?!\()`;

/** The reply/forward prefixes a subject inherits, lower-cased, without the colon. */
export const SUBJECT_PREFIXES = Object.freeze(["re", "fwd", "fw"]);
/** Whole subject tags that are labels, never placeholders, lower-cased. */
export const SUBJECT_TAG_ALLOW = Object.freeze(["external", "ext", "external sender", "external email", "external message"]);
/** RFC 5322's line limit: a longer subject is scanned only this far (and never by a backtracking regex). */
export const SUBJECT_SCAN_MAX = 998;

/**
 * The subject with its leading labels removed, by a linear scan (a regex here was a ReDoS).
 *
 * Leading `Re:`/`Fwd:`/`Fw:` prefixes are skipped. A leading bracketed tag is skipped when a prefix
 * came before it (an inherited list tag, `Re: [crow-dev] …`) or when it is a known label
 * (`[EXTERNAL SENDER]`). Anything else at the start stops the scan, so `[Client Name] proposal` and
 * `[Your Name] Re: hello` still show their placeholder. The cost: a placeholder right after a reply
 * prefix (`Re: [Client Name]`) reads as an inherited tag.
 */
export function stripSubjectTags(subject) {
  const s = String(subject ?? "").slice(0, SUBJECT_SCAN_MAX);
  let i = 0;
  let afterPrefix = false;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const rest = s.slice(i, i + 4).toLowerCase();
    const prefix = SUBJECT_PREFIXES.find((p) => rest.startsWith(p + ":"));
    if (prefix) { i += prefix.length + 1; afterPrefix = true; continue; }
    if (s[i] === "[") {
      const close = s.indexOf("]", i + 1);
      if (close < 0) break;
      const tag = s.slice(i + 1, close).trim().toLowerCase();
      if (afterPrefix || SUBJECT_TAG_ALLOW.includes(tag)) { i = close + 1; continue; }
    }
    break;
  }
  return s.slice(i);
}

/* ---------------------------------------------------------------- addresses */

/**
 * The addr-spec grammar a recipient must match: a dot-atom or quoted local part, then a domain of
 * dot-separated labels. A bare word, a display name on its own, an address with a space in it or a
 * non-ASCII domain is *not* an address here — it is a header we cannot represent faithfully, and the
 * card falls back to "Open in Gmail to send" instead of guessing.
 */
const ADDR_SPEC = /^(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * A clean addr-spec, stricter than ADDR_SPEC alone: no control characters anywhere (a newline inside a
 * quoted local part would be rewritten on send, so what went out would differ from what was hashed),
 * and a quoted local part may not carry < > @ ; ( : characters, which a mail parser could read as a
 * second address (a comma is fine: "john,doe"@x is one address to every parser we checked).
 */
function isCleanAddr(address) {
  const a = String(address);
  if (!ADDR_SPEC.test(a) || /[\u0000-\u001f\u007f]/.test(a)) return false;
  const quoted = /^"((?:[^"\\]|\\.)*)"@/.exec(a);
  return !(quoted && /[<>@;(:]/.test(quoted[1]));
}

/**
 * The index just past an RFC 2047 encoded word starting at `i`, or -1. Encoded words are treated as
 * opaque atoms everywhere below, exactly like quoted strings: their text can never contain a
 * delimiter, and — the reason this is a safety rule — decoding one first would let a display name
 * smuggle an addr-spec (`=?UTF-8?Q?Boss_=3Cboss@old.example.com=3E?= <evil@example.com>` must still
 * be evil@example.com).
 */
function encodedWordEnd(s, i) {
  if (s[i] !== "=" || s[i + 1] !== "?") return -1;
  const end = s.indexOf("?=", i + 2);
  return end < 0 ? -1 : end + 2;
}

/**
 * The list's entries (one per address), split on top-level commas and semicolons only: not inside a
 * quoted string, not inside a comment, not inside `<…>`, and not inside an encoded word. A group
 * (`Team: a@x, b@y;`) contributes its members and drops its name.
 */
function splitEntries(header) {
  const s = String(header ?? "");
  const out = [];
  let buf = "";
  let quoted = false;
  let comment = 0;
  let angle = 0;
  for (let i = 0; i < s.length; ) {
    const word = encodedWordEnd(s, i);
    if (word > 0) { buf += s.slice(i, word); i = word; continue; }
    const ch = s[i];
    if (comment > 0) {
      if (ch === "\\") { buf += s.slice(i, i + 2); i += 2; continue; }
      if (ch === "(") comment += 1;
      else if (ch === ")") comment -= 1;
      buf += ch;
      i += 1;
      continue;
    }
    if (quoted) {
      if (ch === "\\") { buf += s.slice(i, i + 2); i += 2; continue; }
      if (ch === '"') quoted = false;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '"') { quoted = true; buf += ch; i += 1; continue; }
    if (ch === "(") { comment = 1; buf += ch; i += 1; continue; }
    if (ch === "<") { angle += 1; buf += ch; i += 1; continue; }
    if (ch === ">") { angle = Math.max(0, angle - 1); buf += ch; i += 1; continue; }
    if (angle === 0) {
      if (ch === "," || ch === ";") { out.push(buf); buf = ""; i += 1; continue; }
      // A group's "name:" prefix is not an address: drop it and keep collecting the members.
      if (ch === ":") { buf = ""; i += 1; continue; }
    }
    buf += ch;
    i += 1;
  }
  out.push(buf);
  return out;
}

/** Comments blanked out (length preserved, nested, escapes honoured, quotes left alone). */
function stripComments(text) {
  const s = String(text ?? "");
  let out = "";
  let comment = 0;
  let quoted = false;
  for (let i = 0; i < s.length; ) {
    const word = encodedWordEnd(s, i);
    if (word > 0) { out += s.slice(i, word); i = word; continue; }
    const ch = s[i];
    if (quoted) {
      out += ch;
      if (ch === "\\") { out += s[i + 1] ?? ""; i += 2; continue; }
      if (ch === '"') quoted = false;
      i += 1;
      continue;
    }
    if (comment > 0) {
      if (ch === "\\" && i + 1 < s.length) { out += "  "; i += 2; continue; }
      if (ch === "(") comment += 1;
      else if (ch === ")") comment -= 1;
      out += " ";
      i += 1;
      continue;
    }
    if (ch === '"') { quoted = true; out += ch; i += 1; continue; }
    if (ch === "(") { comment = 1; out += " "; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every quoted string that is *not* immediately followed by `@` (so a display name, dropped), or the
 * quoted local part of an addr-spec (`"john,doe"@example.com`, kept whole).
 */
function stripQuotedNames(text) {
  const s = String(text ?? "");
  let out = "";
  for (let i = 0; i < s.length; ) {
    const word = encodedWordEnd(s, i);
    if (word > 0) { out += s.slice(i, word); i = word; continue; }
    if (s[i] !== '"') { out += s[i]; i += 1; continue; }
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    const after = s.slice(j + 1).replace(/^[ \t]+/, "");
    if (after.startsWith("@")) out += s.slice(i, Math.min(j + 1, s.length));
    i = j + 1;
  }
  return out;
}

/** The `<…>` groups at the top level of an entry: not inside quotes, comments or encoded words. */
function angleGroups(text) {
  const s = String(text ?? "");
  const out = [];
  let quoted = false;
  let comment = 0;
  for (let i = 0; i < s.length; ) {
    const word = encodedWordEnd(s, i);
    if (word > 0) { i = word; continue; }
    const ch = s[i];
    if (comment > 0) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "(") comment += 1;
      else if (ch === ")") comment -= 1;
      i += 1;
      continue;
    }
    if (quoted) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') quoted = false;
      i += 1;
      continue;
    }
    if (ch === "(") { comment = 1; i += 1; continue; }
    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === "<") {
      const close = s.indexOf(">", i + 1);
      if (close < 0) break; // an unclosed angle group: nothing after it can be trusted
      out.push({ start: i, end: close + 1, content: s.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * One entry: its addr-spec (or "") and whether it read cleanly. The angle-addr wins when there is
 * one — a display name is text, never an address — and an entry with two of them, or with another
 * address left over outside the brackets, is ambiguous and therefore not clean.
 */
function readEntry(entry) {
  const masked = stripComments(entry);
  const angles = angleGroups(masked);
  if (angles.length) {
    const last = angles[angles.length - 1];
    const address = stripComments(last.content).trim();
    const leftover = stripQuotedNames(masked.slice(0, last.start) + " " + masked.slice(last.end)).trim();
    const clean = angles.length === 1 && !/[@<>"]/.test(leftover) && isCleanAddr(address);
    return { address, clean };
  }
  const candidate = stripQuotedNames(masked).trim();
  return { address: candidate, clean: isCleanAddr(candidate) };
}

/**
 * `{ addresses, invalid }` over a header string (or an array of them). `addresses` is lower-cased,
 * de-duplicated and sorted; `invalid` holds every entry that was not a clean addr-spec, which is what
 * `faithful` uses to refuse a draft we cannot represent.
 */
export function parseAddressListDetailed(header) {
  const seen = new Set();
  const invalid = [];
  for (const chunk of Array.isArray(header) ? header : [header]) {
    if (chunk == null) continue;
    for (const entry of splitEntries(chunk)) {
      if (!stripComments(entry).trim()) continue; // a trailing comma, or a comment on its own
      const { address, clean } = readEntry(entry);
      if (isCleanAddr(address)) seen.add(address.toLowerCase());
      if (!clean) invalid.push(entry.trim());
    }
  }
  return { addresses: [...seen].sort(), invalid };
}

/**
 * `string[]` of lower-cased addresses: the "Name <a@x>" form yields a@x, header order is dropped,
 * duplicates collapse and anything that is not a clean addr-spec is left out.
 */
export function parseAddressList(header) {
  return parseAddressListDetailed(header).addresses;
}

/* ------------------------------------------------------------------- text */

/** `=XX` sequences (and the soft line break) as bytes; everything else is one byte per character. */
function quotedPrintableBytes(text) {
  const s = String(text ?? "").replace(/=\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/** Bytes in a named charset, falling back to UTF-8 when the label is unknown. */
function decodeCharset(bytes, charset) {
  const label = String(charset || "utf-8").trim().replace(/^["']|["']$/g, "").toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/** One encoded word's payload: base64 or Q-encoded, in its own charset. */
function decodeWord(charset, encoding, text) {
  const label = String(charset).split("*")[0]; // RFC 2231 language suffixes ("utf-8*en")
  const bytes = String(encoding).toLowerCase() === "b"
    ? Buffer.from(String(text).replace(/\s+/g, ""), "base64")
    : quotedPrintableBytes(String(text).replace(/_/g, " "));
  return decodeCharset(bytes, label);
}

/**
 * RFC 2047 encoded words decoded (`=?UTF-8?B?…?=`, `=?ISO-8859-1?Q?…?=`, any charset TextDecoder
 * knows). Whitespace between two adjacent encoded words is dropped, as the RFC requires — otherwise
 * a long subject split in two would gain a space that was never there. Text that is not an encoded
 * word, or a malformed one, is left exactly as it is.
 */
export function decodeEncodedWords(value) {
  const s = String(value ?? "");
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(ENCODED_WORD)) {
    const between = s.slice(last, m.index);
    // A single space between two encoded words belongs to the encoding, not to the text.
    if (between && !(parts.length && /^[ \t]+$/.test(between))) parts.push(between);
    parts.push(decodeWord(m[1], m[2], m[3]));
    last = m.index + m[0].length;
  }
  if (!last) return s;
  const tail = s.slice(last);
  if (tail) parts.push(tail);
  return parts.join("");
}

/** CRLF (and a lone CR) become LF; trailing spaces/tabs go from every line and from the end. */
function canonicalBody(body) {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  return text.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").trimEnd();
}

/** The stored/dispatched snapshot: the one shape contentHash, the card and the send all agree on. */
export function canonicalSnapshot({ to, cc, bcc, subject, body } = {}) {
  return {
    to: parseAddressList(to),
    cc: parseAddressList(cc),
    bcc: parseAddressList(bcc),
    subject: String(subject ?? "").replace(/\r\n?/g, "\n").trim(),
    body: canonicalBody(body),
  };
}

/**
 * SHA-256 (hex) over the canonical snapshot's stable JSON: fixed key order, sorted address lists,
 * so two rows describing the same draft always hash the same. The snapshot is canonicalised here as
 * well, so a caller that skipped canonicalSnapshot cannot produce a second hash for one draft.
 */
export function contentHash(snapshot) {
  const s = canonicalSnapshot(snapshot);
  const stable = JSON.stringify({ to: s.to, cc: s.cc, bcc: s.bcc, subject: s.subject, body: s.body });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * The unfilled `[brackets]` in the subject and the body, first-seen order, each once. Links, subject
 * tags and the Re:/Fwd: prefixes around them are not placeholders (see the header).
 */
export function findPlaceholders(snapshot) {
  const re = new RegExp(PLACEHOLDER_PATTERN, "g");
  const out = [];
  const seen = new Set();
  const scan = (text) => {
    for (const m of String(text ?? "").matchAll(re)) {
      const token = m[1].trim();
      if (!token || PLACEHOLDER_ALLOWLIST.includes(token.toLowerCase()) || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  };
  scan(stripSubjectTags(snapshot?.subject));
  scan(snapshot?.body);
  return out;
}

/**
 * The rule as data for the Perch client, which greps the draft's own text the same way (client JS
 * lives in template literals, so it cannot import this module). `allow` is lower-cased. The client
 * strips a subject's leading labels with the same linear scan as stripSubjectTags, from
 * `subjectPrefixes`, `subjectTagAllow` and `subjectScanMax`.
 */
export function placeholderSource() {
  return {
    pattern: PLACEHOLDER_PATTERN,
    flags: "gi",
    allow: [...PLACEHOLDER_ALLOWLIST],
    subjectPrefixes: [...SUBJECT_PREFIXES],
    subjectTagAllow: [...SUBJECT_TAG_ALLOW],
    subjectScanMax: SUBJECT_SCAN_MAX,
  };
}