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
