/**
 * Literal secret redaction, shared by the cloud door and any gateway code that
 * relays results from a third-party server. Pure functions, no I/O.
 */

export const REDACTED = "[redacted]";
/** Secrets shorter than this are ignored, so a short one cannot shred the text. */
export const MIN_SECRET_LENGTH = 4;

/** The usable secrets: strings of at least `minLen` characters. */
function usable(secrets, minLen) {
  return (Array.isArray(secrets) ? secrets : []).filter((s) => typeof s === "string" && s.length >= minLen);
}

/** Byte length of the longest usable secret (0 when there is none). */
export function maxSecretBytes(secrets, { minLen = MIN_SECRET_LENGTH } = {}) {
  return usable(secrets, minLen).reduce((m, s) => Math.max(m, Buffer.byteLength(s)), 0);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces every occurrence of every secret in `text` (coerced with String()),
 * in one pass, longest secret first: when one secret contains another, the
 * longer one is matched whole, so no remainder of it can survive.
 */
export function redactSecrets(text, secrets, { minLen = MIN_SECRET_LENGTH } = {}) {
  const list = [...new Set(usable(secrets, minLen))].sort((a, b) => b.length - a.length);
  const out = String(text);
  if (!list.length) return out;
  return out.replace(new RegExp(list.map(escapeRegExp).join("|"), "g"), REDACTED);
}

/** A header value (string or array of strings), redacted. */
export function redactHeaderValue(value, secrets, opts) {
  return Array.isArray(value) ? value.map((v) => redactSecrets(v, secrets, opts)) : redactSecrets(value, secrets, opts);
}

/**
 * Redact first, cut second: redacts over the first (cap + longest secret) bytes,
 * then truncates to `cap` bytes, so a secret straddling the cut is replaced whole
 * and no prefix of it can leak. Takes a Buffer or string; returns a Buffer.
 */
export function redactThenTruncate(input, secrets, cap, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const keep = cap + maxSecretBytes(secrets, opts);
  const whole = redactSecrets(buf.subarray(0, keep).toString("utf8"), secrets, opts);
  return Buffer.from(whole, "utf8").subarray(0, cap);
}

/**
 * Redacts a run of text pieces as ONE text (what a reader of the joined pieces
 * sees), so a secret split across two pieces is caught too, then hands back
 * one string per piece: a match is replaced by REDACTED in the piece where it
 * starts, and the rest of it is removed from the pieces it spills into.
 * Same matching as redactSecrets (longest secret first, one pass).
 * @param {string[]} pieces
 * @returns {string[]}
 */
export function redactAcross(pieces, secrets, { minLen = MIN_SECRET_LENGTH } = {}) {
  const parts = (Array.isArray(pieces) ? pieces : []).map((p) => String(p));
  const list = [...new Set(usable(secrets, minLen))].sort((a, b) => b.length - a.length);
  if (!list.length || !parts.length) return parts;
  const joined = parts.join("");
  const ranges = [];
  for (const m of joined.matchAll(new RegExp(list.map(escapeRegExp).join("|"), "g"))) ranges.push([m.index, m.index + m[0].length]);
  if (!ranges.length) return parts;
  const out = [];
  let o = 0;
  for (const p of parts) {
    const e = o + p.length;
    let pos = o;
    let s = "";
    for (const [r0, r1] of ranges) {
      if (r1 <= o || r0 >= e) continue;
      if (r0 >= pos) s += joined.slice(pos, r0);
      if (r0 >= o) s += REDACTED;
      pos = Math.max(pos, Math.min(r1, e));
    }
    s += joined.slice(pos, e);
    out.push(s);
    o = e;
  }
  return out;
}
