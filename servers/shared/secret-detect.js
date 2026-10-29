/**
 * The shared secret detector (credential card, spec §10.2/§10.3): finds what looks like a
 * password or key in free text, so the composer can warn before sending and the send route can
 * replace it with "[secret removed]" before the bot sees it.
 *
 * Three rules:
 *   - known key prefixes: the public-hygiene guard's SECRET_PATTERNS, one source of truth;
 *   - "password: …" phrasing: the value after a password/secret/token/api key label;
 *   - high-entropy tokens: a run of 24+ key characters with ≥ 3.5 bits of entropy per
 *     character, at least one digit and one letter, and not hex-only (so a uuid or a git sha
 *     is never flagged; hex-only means [0-9a-f-] or [0-9A-F-], a dash counting as hex).
 *
 * Pure functions, no I/O. False negatives are expected (that is why the card exists); false
 * positives have the composer's "It's not a secret" escape. `detectorSource()` hands the same
 * rules to the client as { source, flags } pairs, since the hygiene module itself imports
 * node-only modules.
 */
import { SECRET_PATTERNS } from "../../scripts/check-public-hygiene.mjs";

export const SECRET_REMOVED = "[secret removed]";

const PHRASE = /\b(pass(word)?|pwd|passcode|secret|token|api[_ -]?key)\s*[:=]\s*(\S{6,})/gi;
const ENTROPY_RUN = /[A-Za-z0-9_\-+/=]{24,}/g;
const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_MIN_BITS = 3.5;
const HEX_ONLY = /^(?:[0-9a-f-]+|[0-9A-F-]+)$/;

/** A fresh copy of a pattern: the shared ones carry /g and therefore lastIndex state. */
const fresh = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

/** Shannon entropy of `s`, in bits per character. */
export function shannonBits(s) {
  if (!s) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksRandom(run) {
  return run.length >= ENTROPY_MIN_LENGTH
    && /[0-9]/.test(run) && /[A-Za-z]/.test(run)
    && !HEX_ONLY.test(run)
    && shannonBits(run) >= ENTROPY_MIN_BITS;
}

/**
 * Every secret-looking span in `text`, sorted and non-overlapping: [{ start, end, kind }], kind
 * "prefix" (with the pattern's `name`), "phrase" or "entropy". Overlapping hits merge into one
 * span that keeps the first rule's kind.
 */
export function findSecrets(text) {
  const s = text == null ? "" : String(text);
  if (!s) return [];
  const hits = [];
  for (const [name, re] of SECRET_PATTERNS) {
    const r = fresh(re);
    for (let m; (m = r.exec(s));) {
      if (!m[0]) { r.lastIndex++; continue; }
      hits.push({ start: m.index, end: m.index + m[0].length, kind: "prefix", name });
    }
  }
  const phrase = fresh(PHRASE);
  for (let m; (m = phrase.exec(s));) {
    // The value is the match's last group, so it ends where the match ends.
    const end = m.index + m[0].length;
    hits.push({ start: end - m[3].length, end, kind: "phrase" });
  }
  const run = fresh(ENTROPY_RUN);
  for (let m; (m = run.exec(s));) {
    if (looksRandom(m[0])) hits.push({ start: m.index, end: m.index + m[0].length, kind: "entropy" });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) { last.end = Math.max(last.end, h.end); continue; }
    out.push({ ...h });
  }
  return out;
}

/** `text` with every found span replaced by "[secret removed]", and how many were replaced. */
export function stripSecrets(text) {
  const s = text == null ? "" : String(text);
  const hits = findSecrets(s);
  if (!hits.length) return { text: s, removed: 0 };
  let out = "";
  let at = 0;
  for (const h of hits) {
    out += s.slice(at, h.start) + SECRET_REMOVED;
    at = h.end;
  }
  return { text: out + s.slice(at), removed: hits.length };
}

/**
 * The rules as plain data for the client (JSON-safe, no backticks, so it can sit inside the
 * hub's template-literal client): rebuild each with `new RegExp(source, flags)`.
 */
export function detectorSource() {
  return {
    prefixes: SECRET_PATTERNS.map(([name, re]) => ({ name, source: re.source, flags: re.flags })),
    phrase: { source: PHRASE.source, flags: PHRASE.flags, valueGroup: 3 },
    entropy: {
      run: { source: ENTROPY_RUN.source, flags: ENTROPY_RUN.flags },
      hexOnly: { source: HEX_ONLY.source, flags: HEX_ONLY.flags },
      minLength: ENTROPY_MIN_LENGTH,
      minBits: ENTROPY_MIN_BITS,
    },
    removed: SECRET_REMOVED,
  };
}
