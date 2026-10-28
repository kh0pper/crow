/**
 * Quote matching for fetch-before-cite: does a quoted claim actually appear in a fetched page?
 *
 * Both a false "not found" (bots learn to ignore the warning) and a false "found" (the check is
 * pointless) are costly, so the rules are explicit. The source is ASCII-only: every special
 * character is written as a \u escape so invisible ones stay visible.
 *
 * normalizeForMatch, in order:
 *   1. superscript digits (U+00B9, U+00B2, U+00B3, U+2070-U+2079) are footnote markers: removed
 *      BEFORE NFKC, which would otherwise turn them into ordinary digits;
 *   2. NFKC: folds NBSP and other spaces, ligatures, and the ellipsis character into "...";
 *   3. soft hyphen (U+00AD) and zero-width characters (U+200B-U+200D, U+2060, U+FEFF) are removed;
 *   4. editorial markers [sic], [12], [a], [citation needed] are removed;
 *   5. curly/prime/backtick single quotes become ', curly/guillemet double quotes become ";
 *   6. hyphen, en/em dashes, horizontal bar and minus (U+2010-U+2015, U+2212) become -;
 *   7. whitespace runs become one space; lower-cased; trimmed.
 *
 * matchQuote(quote, {readable, body, truncated}):
 *   - the FULL normalized quote is tried first (outer matching "/' pairs stripped);
 *   - only when it is not found, a trailing tail after a dash or after a closing quote mark is
 *     cut, and only when the RAW tail looks like an attribution: it starts with a capital letter
 *     (after an optional dash or comma), its name part has 2 to 6 words that each start with an
 *     uppercase letter (or are one of the connectors of/de/van/von/al/the/and), its first word is
 *     not one of The/A/An/Never/Always/Nothing/No/Not/None/Every/All/It/We/They/This/That/Our/Its
 *     (as written, so the initial "A." still passes), optionally
 *     followed by ", <Title>" of at most 3 such words. "We ship weekly - and we never ship bugs"
 *     therefore keeps its fabricated clause and reads as not found;
 *   - if the cut quote is not found either, the result is the full quote's result;
 *   - a quote splits into pieces on "...", ". . ." and bracketed insertions like "[the company]";
 *     sentence punctuation (. , ; : ! ?) at a piece's edges is trimmed, so a quote's closing
 *     period need not match the page's punctuation; pieces under MIN_PIECE_CHARS are dropped;
 *     no pieces left: null, "too short to check";
 *   - editorial drops are an allowlist, removed by normalization on both sides: [sic], numeric
 *     footnotes like [3], [citation needed] (and single-letter footnotes like [a]); removing them
 *     only makes the neighbouring text adjacent, so it never loosens a match. ANY OTHER bracketed
 *     text is a placeholder for a short page span: the pieces on either side must be at most
 *     MAX_BRACKET_GAP (60) normalized page characters apart. Ellipsis pieces may be at most
 *     MAX_ELLIPSIS_GAP (400) apart. A dropped short piece widens the next gap by its length plus
 *     its own gap;
 *   - found when every piece occurs in order within those gaps, each hit on word boundaries: the
 *     code points around it are not letters, digits or combining marks; non-boundary hits are
 *     skipped and the search continues (memoized backtracking over occurrences);
 *   - the Readability text is searched first, then the full body text;
 *   - the pieces all occur in order but only with a wider gap: null, "couldn't check exactly: the
 *     quoted pieces are far apart on the page" (never 1, since the joining is unverifiable, and
 *     not 0, since the words are there). A quote could otherwise splice distant page text into a
 *     new meaning ("The CEO said [the company will] never ship bugs");
 *   - not found: null when the stored text was truncated (the quote may be in the cut part) or
 *     there is no text at all; otherwise 0.
 */

export const MIN_PIECE_CHARS = 4;

export function normalizeForMatch(s) {
  return String(s ?? "")
    .replace(/[\u00b9\u00b2\u00b3\u2070-\u2079]/g, "") // superscript footnotes (before NFKC turns them into digits)
    .normalize("NFKC") // also folds NBSP to a space and the ellipsis character to "..."
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "") // soft hyphen, zero-width
    .replace(/\[(?:sic|\d{1,3}|[a-z]|citation needed)\]/gi, "") // [sic], [12], [a], [citation needed]
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// Split points, captured so each piece knows what joined it to the previous one.
const PIECE_SPLIT = /\s*(\.\.\.|\. \. \.|\[[^\]]{1,40}\])\s*/;
// The most normalized page characters allowed between two pieces: a bracketed insertion stands
// in for a short page span, an ellipsis for a longer cut. A wider gap cannot be checked.
export const MAX_BRACKET_GAP = 60;
export const MAX_ELLIPSIS_GAP = 400;
const EDGE_PUNCT = /^[.,;:!?\s]+|[.,;:!?\s]+$/g;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

// Attribution tails, judged on the RAW quote.
const CONNECTORS = new Set(["of", "de", "van", "von", "al", "the", "and"]);
// A name never starts with one of these (case-sensitive): "We ship weekly - Never Shipped A Bug"
// is a fabricated clause, not an attribution. "A." (with its period) is an initial, not "A".
const NOT_A_NAME_START = new Set(["The", "A", "An", "Never", "Always", "Nothing", "No", "Not", "None",
  "Every", "All", "It", "We", "They", "This", "That", "Our", "Its"]);
// A dash used as a separator: em/en dash/bar with optional spaces, or a spaced hyphen / "--".
const DASH_SPLIT = /\s*[\u2014\u2013\u2015]\s*|\s-{1,2}\s/g;
const CLOSING_QUOTES = new Set(['"', "\u201d", "\u00bb", "'", "\u2019"]);
const OPENING_FOR = { "\u201d": ["\u201c", '"'], "\u00bb": ["\u00ab"], '"': ['"', "\u201c"], "'": ["'", "\u2018"], "\u2019": ["\u2018", "'"] };

function capitalizedWords(part, max) {
  const words = part.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > max) return false;
  return words.every((w) => /^\p{Lu}/u.test(w) || CONNECTORS.has(w.toLowerCase()) && /^\p{Ll}/u.test(w));
}

function looksLikeAttribution(rawTail) {
  const tail = rawTail.replace(/^[\s\u2014\u2013\u2015,-]+/, "").replace(/[.\s]+$/, "");
  if (!/^\p{Lu}/u.test(tail)) return false;
  const parts = tail.split(",");
  if (parts.length > 2) return false;
  if (!capitalizedWords(parts[0], 6)) return false;
  const name = parts[0].trim().split(/\s+/);
  if (name.length < 2) return false;
  if (NOT_A_NAME_START.has(name[0].replace(/[,;:!?]+$/, ""))) return false;
  return parts.length === 1 || capitalizedWords(parts[1], 3);
}

/** The quote without a trailing attribution, or null when the tail is not one. */
function withoutAttribution(raw) {
  const q = String(raw ?? "").trim();
  const cuts = [];
  for (const m of q.matchAll(DASH_SPLIT)) cuts.push([m.index, m.index + m[0].length]);
  const first = q[0];
  for (let i = 1; i < q.length - 1; i++) {
    if (CLOSING_QUOTES.has(q[i]) && (OPENING_FOR[q[i]] || []).includes(first)) cuts.push([i + 1, i + 1]);
  }
  cuts.sort((a, b) => b[0] - a[0]); // the shortest tail first
  for (const [headEnd, tailStart] of cuts) {
    const head = q.slice(0, headEnd).trim();
    if (head && looksLikeAttribution(q.slice(tailStart))) return head;
  }
  return null;
}

function stripOuterQuotes(s) {
  let out = s.trim();
  while (out.length >= 2 && (out[0] === '"' || out[0] === "'") && out[out.length - 1] === out[0]) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * The quote's pieces, each with `maxGap`: the most page characters allowed between the previous
 * kept piece and this one (null for the first). A dropped short piece widens the next gap by its
 * own length plus the gap it would have had.
 */
function piecesOf(quote) {
  const parts = stripOuterQuotes(normalizeForMatch(quote)).split(PIECE_SPLIT);
  const pieces = [];
  let pending = null; // gap accumulated since the last kept piece
  for (let k = 0; k < parts.length; k += 2) {
    const text = parts[k].replace(EDGE_PUNCT, "");
    if (k > 0) {
      const sep = parts[k - 1];
      const gap = sep.startsWith("[") ? MAX_BRACKET_GAP : MAX_ELLIPSIS_GAP;
      pending = pending === null ? gap : pending + gap;
    }
    if (text.length >= MIN_PIECE_CHARS) {
      pieces.push({ text, maxGap: pieces.length === 0 ? null : pending });
      pending = 0;
    } else if (pieces.length > 0) {
      pending = (pending ?? 0) + text.length;
    } else {
      pending = null; // nothing kept yet: a leading short piece or insertion constrains nothing
    }
  }
  return pieces;
}

/** True when the code point ending just before `i` (before=true) or starting at `i` is a word char. */
function isWordAt(text, i, before) {
  if (before) {
    if (i <= 0) return false;
    let cp = text.charCodeAt(i - 1);
    if (cp >= 0xdc00 && cp <= 0xdfff && i >= 2) cp = text.codePointAt(i - 2);
    return WORD_CHAR.test(String.fromCodePoint(cp));
  }
  if (i >= text.length) return false;
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(i)));
}

/** Index just past `piece` at a word-boundary hit at or after `from`, or -1. */
function findOnBoundary(text, piece, from) {
  let i = text.indexOf(piece, from);
  while (i >= 0) {
    const end = i + piece.length;
    if (!isWordAt(text, i, true) && !isWordAt(text, end, false)) return end;
    i = text.indexOf(piece, i + 1);
  }
  return -1;
}

/** Every piece in order, gaps ignored. */
function piecesInOrder(text, pieces) {
  let cursor = 0;
  for (const { text: piece } of pieces) {
    const end = findOnBoundary(text, piece, cursor);
    if (end < 0) return false;
    cursor = end;
  }
  return true;
}

/** Every piece in order with each gap within its maxGap. Memoized, so it stays linear-ish. */
function piecesWithinGaps(text, pieces) {
  const failed = new Set();
  const from = (k, prevEnd) => {
    if (k === pieces.length) return true;
    const key = k + ":" + prevEnd;
    if (failed.has(key)) return false;
    const { text: piece, maxGap } = pieces[k];
    let i = text.indexOf(piece, prevEnd);
    while (i >= 0) {
      if (maxGap !== null && i - prevEnd > maxGap) break;
      const end = i + piece.length;
      if (!isWordAt(text, i, true) && !isWordAt(text, end, false) && from(k + 1, end)) return true;
      i = text.indexOf(piece, i + 1);
    }
    failed.add(key);
    return false;
  };
  return from(0, 0);
}

const FAR_APART = "couldn't check exactly: the quoted pieces are far apart on the page";

/** 1 with where, or {loose: true} when only a gap-ignoring match exists, or null. */
function searchTexts(pieces, texts) {
  for (const [where, text] of texts) {
    if (piecesWithinGaps(text, pieces)) return { found: 1, where, reason: null };
  }
  return texts.some(([, text]) => piecesInOrder(text, pieces)) ? { loose: true } : null;
}

/**
 * @param {string} quote
 * @param {{readable?: string, body?: string, truncated?: boolean}} page
 * @returns {{found: 1|0|null, where: "readable"|"body"|null, reason: string|null}}
 */
export function matchQuote(quote, { readable = "", body = "", truncated = false } = {}) {
  const full = piecesOf(quote);
  if (full.length === 0) return { found: null, where: null, reason: "too short to check" };
  const r = normalizeForMatch(readable);
  const b = normalizeForMatch(body);
  if (!r && !b) return { found: null, where: null, reason: "no page text to check" };
  const texts = [["readable", r]];
  if (b && b !== r) texts.push(["body", b]);

  let loose = false;
  const candidates = [full];
  const head = withoutAttribution(quote);
  if (head) candidates.push(piecesOf(head)); // only after the full quote fails
  for (const pieces of candidates) {
    if (pieces.length === 0) continue;
    const hit = searchTexts(pieces, texts);
    if (hit?.found === 1) return hit;
    if (hit?.loose) loose = true;
  }
  if (loose) return { found: null, where: null, reason: FAR_APART };
  if (truncated) return { found: null, where: null, reason: "not found, but the page text was truncated" };
  return { found: 0, where: null, reason: "not found in the page text" };
}
