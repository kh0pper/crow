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
 *   4. a single-letter capitalisation bracket followed by a letter keeps its letter ("[I]t" ->
 *      "It"); editorial markers [sic], [12], [a], [citation needed] are removed;
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
 *     period need not match the page's punctuation. A piece under MIN_PIECE_CHARS is NOT
 *     ignored: it must occur word-bounded inside its gap like any other piece (so "We will ...
 *     not ... raise prices" reads 0 on "We will raise prices"); only a quote whose pieces are ALL
 *     short is null, "too short to check". More than MAX_PIECES (32) segments after splitting
 *     (empty ones between separators included): null, "too long to check";
 *   - editorial drops are an allowlist, removed by normalization on both sides: [sic], numeric
 *     footnotes like [3], [citation needed] (and single-letter footnotes like [a]); removing them
 *     only makes the neighbouring text adjacent, so it never loosens a match. ANY OTHER bracketed
 *     text is a placeholder for a short page span: the pieces on either side must be at most
 *     MAX_BRACKET_GAP (60) normalized page characters apart. Ellipsis pieces may be at most
 *     MAX_ELLIPSIS_GAP (400) apart. Consecutive separators with nothing between them add up.
 *     A leading/trailing short piece must lie within that limit of its long neighbour;
 *   - a placeholder or an omission must not add or remove a negation (not, no, never, none,
 *     nobody, nothing, neither, nor, without, cannot, any word ending in n't): the page span under
 *     each gap must hold as many negation words as the quote's brackets there, and a bracket at
 *     the quote's edge may not hold one. A match that only exists by changing a negation: null,
 *     "couldn't check exactly: a negation was added or left out";
 *   - found when every piece occurs in order within those gaps, each hit on word boundaries: the
 *     code points around it are not letters, digits or combining marks; non-boundary hits are
 *     skipped. Search is memoized backtracking over occurrences precomputed once per text, with
 *     a shared STEP_BUDGET (20000) of steps; running out is null, "couldn't check: too many
 *     possible placements" (a crafted quote cannot hold the event loop);
 *   - the Readability text is searched first, then the full body text;
 *   - the pieces all occur in order (short pieces still within their gaps) but only with a wider
 *     long-to-long gap: null, "couldn't check exactly: the
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
    .replace(/\[([a-z])\](?=\p{L})/giu, "$1") // [I]t, [A]ll: a capitalisation bracket keeps its letter
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

// Negation words. A placeholder or an omission must not add or remove one.
const NEGATIONS = new Set(["not", "no", "never", "none", "nobody", "nothing", "neither", "nor", "without", "cannot"]);
function negationCount(s) {
  let n = 0;
  for (const w of String(s).split(/[^\p{L}\p{N}\p{M}']+/u)) {
    if (NEGATIONS.has(w) || /n't$/.test(w)) n++;
  }
  return n;
}

export const MAX_PIECES = 32;
export const STEP_BUDGET = 20000;

/**
 * The quote's plan: its pieces in order (short ones included; they must occur too), each with
 * `gap` = {limit, neg, bothLong} describing the separator(s) before it (null for the first), and
 * the negation counts of any leading/trailing bracket. Empty pieces merge their neighbouring
 * separators (limits and negation counts add up).
 */
function piecesOf(quote) {
  const parts = stripOuterQuotes(normalizeForMatch(quote)).split(PIECE_SPLIT);
  const pieces = [];
  let pending = null;
  let leadNeg = 0;
  for (let k = 0; k < parts.length; k += 2) {
    if (k > 0) {
      const sep = parts[k - 1];
      const bracket = sep.startsWith("[");
      pending = pending || { limit: 0, neg: 0 };
      pending.limit += bracket ? MAX_BRACKET_GAP : MAX_ELLIPSIS_GAP;
      if (bracket) pending.neg += negationCount(sep.slice(1, -1));
    }
    const text = parts[k].replace(EDGE_PUNCT, "");
    if (!text) continue;
    if (pieces.length === 0) {
      leadNeg = pending ? pending.neg : 0;
      pieces.push({ text, long: text.length >= MIN_PIECE_CHARS, gap: null });
    } else {
      const long = text.length >= MIN_PIECE_CHARS;
      pieces.push({ text, long, gap: { ...pending, bothLong: long && pieces[pieces.length - 1].long } });
    }
    pending = null;
  }
  return { pieces, segments: (parts.length + 1) / 2, leadNeg, trailNeg: pending ? pending.neg : 0 };
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

const OUT_OF_BUDGET = Symbol("quote-match budget");

/** First index in the sorted array `arr` whose value is >= x. */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * One page text prepared for searching: word-bounded occurrence starts per piece (computed once,
 * linear in the text) and the start/end of every negation word, so a span's negation count is two
 * binary searches instead of a rescan.
 */
function prepare(text) {
  const negStarts = [];
  const negEnds = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}']+/gu)) {
    if (negationCount(m[0])) { negStarts.push(m.index); negEnds.push(m.index + m[0].length); }
  }
  const occ = new Map();
  return {
    text,
    occurrences(piece) {
      let list = occ.get(piece);
      if (!list) {
        list = [];
        for (let i = text.indexOf(piece); i >= 0; i = text.indexOf(piece, i + 1)) {
          if (!isWordAt(text, i, true) && !isWordAt(text, i + piece.length, false)) list.push(i);
        }
        occ.set(piece, list);
      }
      return list;
    },
    /** Negation words lying wholly inside [from, to). */
    negationsIn(from, to) {
      const first = lowerBound(negStarts, from);
      let n = 0;
      for (let j = first; j < negStarts.length && negEnds[j] <= to; j++) n++;
      return n;
    },
  };
}

/**
 * Every piece in order, word-bounded. mode.gaps: "all" enforces every gap limit; "short" only the
 * gaps next to a short piece (long-to-long gaps unbounded: the far-apart probe). mode.negation:
 * the page span under each gap must hold as many negation words as the quote's brackets there.
 * Memoized backtracking over precomputed occurrences; recursion depth is at most MAX_PIECES.
 * Every step and every occurrence tried spends from the shared budget; running out throws
 * OUT_OF_BUDGET.
 */
function search(page, pieces, mode, budget) {
  const lists = pieces.map((p) => page.occurrences(p.text));
  if (lists.some((l) => l.length === 0)) return false;
  const failed = new Set();
  const spend = () => { if (--budget.left < 0) throw OUT_OF_BUDGET; };
  const from = (k, prevEnd) => {
    if (k === pieces.length) return true;
    spend();
    const key = k * (page.text.length + 1) + prevEnd;
    if (failed.has(key)) return false;
    const { text: piece, gap } = pieces[k];
    const limit = gap && (mode.gaps === "all" || !gap.bothLong) ? gap.limit : Infinity;
    const list = lists[k];
    for (let j = lowerBound(list, prevEnd); j < list.length; j++) {
      spend();
      const i = list[j];
      if (k > 0 && i - prevEnd > limit) break;
      if (mode.negation && k > 0 && page.negationsIn(prevEnd, i) !== gap.neg) continue;
      if (from(k + 1, i + piece.length)) return true;
    }
    failed.add(key);
    return false;
  };
  return from(0, 0);
}

const NOT_CHECKED = (reason) => ({ found: null, where: null, reason });
const FAR_APART = "couldn't check exactly: the quoted pieces are far apart on the page";
const NEGATION_CHANGED = "couldn't check exactly: a negation was added or left out";
const TOO_MANY_PLACEMENTS = "couldn't check: too many possible placements";

/**
 * @param {string} quote
 * @param {{readable?: string, body?: string, truncated?: boolean}} page
 * @returns {{found: 1|0|null, where: "readable"|"body"|null, reason: string|null}}
 */
export function matchQuote(quote, { readable = "", body = "", truncated = false } = {}) {
  const full = piecesOf(quote);
  if (full.segments > MAX_PIECES) return NOT_CHECKED("too long to check");
  if (!full.pieces.some((p) => p.long)) return NOT_CHECKED("too short to check");
  const r = normalizeForMatch(readable);
  const b = normalizeForMatch(body);
  if (!r && !b) return NOT_CHECKED("no page text to check");
  const texts = [["readable", prepare(r)]];
  if (b && b !== r) texts.push(["body", prepare(b)]);

  const plans = [full];
  const head = withoutAttribution(quote);
  if (head) {
    const cut = piecesOf(head); // tried only after the full quote fails
    if (cut.segments <= MAX_PIECES && cut.pieces.some((p) => p.long)) plans.push(cut);
  }
  const budget = { left: STEP_BUDGET };
  const any = (mode, plan) => texts.find(([, pg]) => pg.text && search(pg, plan.pieces, mode, budget));
  try {
    for (const plan of plans) {
      if (plan.leadNeg || plan.trailNeg) continue; // a bracket at the edge adds a negation
      const hit = any({ gaps: "all", negation: true }, plan);
      if (hit) return { found: 1, where: hit[0], reason: null };
    }
    if (plans.some((plan) => any({ gaps: "all", negation: false }, plan))) return NOT_CHECKED(NEGATION_CHANGED);
    if (plans.some((plan) => any({ gaps: "short", negation: false }, plan))) return NOT_CHECKED(FAR_APART);
  } catch (err) {
    if (err === OUT_OF_BUDGET) return NOT_CHECKED(TOO_MANY_PLACEMENTS);
    throw err;
  }
  if (truncated) return NOT_CHECKED("not found, but the page text was truncated");
  return { found: 0, where: null, reason: "not found in the page text" };
}
