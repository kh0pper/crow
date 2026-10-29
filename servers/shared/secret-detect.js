/**
 * The shared secret detector (credential card, spec §10.2/§10.3): finds what looks like a
 * password or key in free text, so the composer can warn before sending and the send route can
 * replace it with "[secret removed]" before the bot sees it.
 *
 * Three rules:
 *   - known key prefixes: the public-hygiene guard's SECRET_PATTERNS, one source of truth;
 *   - "password: …" phrasing: the value after a password/secret/token/api key label and ":",
 *     "=" or " is " (the "is" form only when the value holds a digit);
 *   - high-entropy tokens: each "/"-separated segment of a key-character run, outside any URL
 *     or data: URI, that is 24+ characters with ≥ 3.5 bits of entropy per character, mixes
 *     upper case, lower case and digits, is not hex-only (so a uuid or a git sha is never
 *     flagged; hex-only means [0-9a-f-] or [0-9A-F-], a dash counting as hex), and has a
 *     token's structure, not a name's (see looksRandom). An all-lower-case key is left to the
 *     known-prefix list.
 *
 * Pure functions, no I/O. False negatives are expected (that is why the card exists); false
 * positives have the composer's "It's not a secret" escape. `detectorSource()` hands the same
 * rules to the client as { source, flags } pairs, since the hygiene module itself imports
 * node-only modules.
 */
import { SECRET_PATTERNS } from "../../scripts/check-public-hygiene.mjs";

export const SECRET_REMOVED = "[secret removed]";

// "label: value", "label=value", or "label is value". The "is" form needs a digit in the value,
// so plain prose ("the password is incorrect") is not flagged.
const PHRASE = /\b(pass(word)?|pwd|passcode|secret|token|api[_ -]?key)(?:\s*[:=]\s*|\s+is\s+(?=\S*\d))(\S{6,})/gi;
const ENTROPY_RUN = /[A-Za-z0-9_\-+/=]{24,}/g;
// Runs inside these tokens are never entropy hits: a URL's path and a data: URI are random-
// looking by nature (a key inside a URL is still caught by the known-prefix list).
const ENTROPY_SKIP = /\bhttps?:\/\/\S+|\bdata:\S+/gi;
const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_MIN_BITS = 3.5;
const HEX_ONLY = /^(?:[0-9a-f-]+|[0-9A-F-]+)$/;
// The structure signals (see looksRandom).
const MIN_LONGEST_PIECE = 10;
// A name splits into a few long pieces (words, acronyms, numbers); a random token into many
// short ones.
const PIECE = /[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[0-9]+|[A-Z]/g;
const MAX_MEAN_PIECE = 3.5;

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

/** The longest piece of `seg` between "-" or "_" separators. */
const longestPiece = (seg) => seg.split(/[-_]+/).reduce((m, p) => Math.max(m, p.length), 0);

/** The mean length of `seg`'s word pieces: camelCase words, upper-case acronyms, digit runs
 *  ("handle|O|Auth|2|Callback|For|Google|Drive" is 4.3; a random token is about 1.6). */
function meanPiece(seg) {
  const pieces = seg.match(PIECE) || [];
  if (!pieces.length) return 0;
  return pieces.reduce((n, p) => n + p.length, 0) / pieces.length;
}

/**
 * One "/"-separated segment of a key-character run. It is a secret when it is 24+ characters,
 * mixes upper case, lower case and digits, is not hex-only, has ≥ 3.5 bits of entropy per
 * character, AND has a token's structure rather than a name's:
 *   - its longest piece between "-"/"_" is 10+ characters (a GGUF or kebab/snake name is short
 *     words joined: "6-35B-A3B-Instruct-UD-Q4_K_XL" peaks at 8), and
 *   - its word pieces average under 3.5 characters (a name is a few words, 4 or more:
 *     "getUserProfileById2FactorAuthentication" averages 4.9; a random token about 1.6).
 */
function looksRandom(seg) {
  return seg.length >= ENTROPY_MIN_LENGTH
    && /[0-9]/.test(seg) && /[a-z]/.test(seg) && /[A-Z]/.test(seg)
    && !HEX_ONLY.test(seg)
    && shannonBits(seg) >= ENTROPY_MIN_BITS
    && longestPiece(seg) >= MIN_LONGEST_PIECE
    && meanPiece(seg) < MAX_MEAN_PIECE;
}

/** [start, end) spans of URL and data: URI tokens in `s`. */
function skipSpans(s) {
  const out = [];
  const re = fresh(ENTROPY_SKIP);
  for (let m; (m = re.exec(s));) out.push([m.index, m.index + m[0].length]);
  return out;
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
    // The value is the LAST group (group 3: `(word)` inside the label is group 2; the
    // separator alternation is non-capturing), and since `(\S{6,})` closes the pattern it ends
    // exactly where the match ends.
    const end = m.index + m[0].length;
    hits.push({ start: end - m[3].length, end, kind: "phrase" });
  }
  const skips = skipSpans(s);
  const run = fresh(ENTROPY_RUN);
  for (let m; (m = run.exec(s));) {
    const rs = m.index, re = m.index + m[0].length;
    if (skips.some(([a, b]) => rs < b && re > a)) continue;
    // Each "/"-separated segment on its own: a path is never one long token.
    let at = rs;
    for (const seg of m[0].split("/")) {
      if (looksRandom(seg)) hits.push({ start: at, end: at + seg.length, kind: "entropy" });
      at += seg.length + 1;
    }
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
      skip: { source: ENTROPY_SKIP.source, flags: ENTROPY_SKIP.flags },
      hexOnly: { source: HEX_ONLY.source, flags: HEX_ONLY.flags },
      piece: { source: PIECE.source, flags: PIECE.flags },
      segmentSeparator: "/",
      minLength: ENTROPY_MIN_LENGTH,
      minBits: ENTROPY_MIN_BITS,
      minLongestPiece: MIN_LONGEST_PIECE,
      maxMeanPiece: MAX_MEAN_PIECE,
    },
    removed: SECRET_REMOVED,
  };
}
