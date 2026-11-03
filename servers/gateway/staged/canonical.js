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
 * The placeholder rule (`[Client Name]`) blocks Send until the operator fills it in. It must not
 * fire on a Markdown link (`[text](url)`) or on a subject tag (`[EXTERNAL]`, `[Fwd]`), so the
 * pattern requires at least two characters and no following `(`, and a short allowlist of tags is
 * skipped case-insensitively.
 */
import { createHash } from "node:crypto";

/** Subject tags that are not unfilled placeholders, lower-cased. */
export const PLACEHOLDER_ALLOWLIST = Object.freeze(["external", "ext", "fwd", "fw", "re", "sent", "draft"]);

/** A bracketed run of letters, spaces and hyphens, 2-40 characters, not followed by "(" (a link). */
export const PLACEHOLDER_PATTERN = String.raw`\[([A-Za-z][A-Za-z \-]{1,39})\](?!\()`;

const ANGLE_ADDRESS = /<\s*([^<>\s]+@[^<>\s]+)\s*>/;

/** Split a header on top-level commas/semicolons: not inside a quoted display name, not in <...>. */
function splitAddresses(header) {
  const out = [];
  let buf = "";
  let quoted = false;
  let angle = 0;
  for (const ch of String(header)) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === "<") angle += 1;
      else if (ch === ">") angle = Math.max(0, angle - 1);
      else if (angle === 0 && (ch === "," || ch === ";")) { out.push(buf); buf = ""; continue; }
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * `string[]` of lower-cased addresses: the "Name <a@x>" form yields a@x, header order is dropped
 * and duplicates collapse. Accepts a header string, an array of them, or null.
 */
export function parseAddressList(header) {
  const chunks = Array.isArray(header) ? header : [header];
  const seen = new Set();
  for (const chunk of chunks) {
    if (chunk == null) continue;
    for (const part of splitAddresses(chunk)) {
      const m = ANGLE_ADDRESS.exec(part);
      // An angle-less entry is the address itself; strip only the quotes/space around it.
      const addr = String(m ? m[1] : part).trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
      if (addr) seen.add(addr);
    }
  }
  return [...seen].sort();
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
 * The unfilled `[brackets]` in the subject and the body, first-seen order, each once. Links and
 * subject tags are not placeholders (see the header).
 */
export function findPlaceholders(snapshot) {
  const re = new RegExp(PLACEHOLDER_PATTERN, "g");
  const out = [];
  const seen = new Set();
  for (const text of [snapshot?.subject, snapshot?.body]) {
    for (const m of String(text ?? "").matchAll(re)) {
      const token = m[1].trim();
      if (!token || PLACEHOLDER_ALLOWLIST.includes(token.toLowerCase()) || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * The rule as data for the Perch client, which greps the draft's own text the same way (client JS
 * lives in template literals, so it cannot import this module). `allow` is lower-cased.
 */
export function placeholderSource() {
  return { pattern: PLACEHOLDER_PATTERN, flags: "gi", allow: [...PLACEHOLDER_ALLOWLIST] };
}