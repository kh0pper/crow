/**
 * Quote matching for fetch-before-cite: does a quoted claim actually appear in a fetched page?
 *
 * A false "found" makes the check pointless, so found:1 means one thing only: the quote's exact
 * wording, after normalization, occurs as one contiguous run of the page text, on word
 * boundaries. Edited quotes (cuts, bracketed insertions) are never reconstructed: every earlier
 * attempt to match pieces around a cut was beaten by a meaning-changing edit, so they read null.
 * The source is ASCII-only: every special character is written as a \u escape so invisible ones
 * stay visible.
 *
 * normalizeForMatch (page text) and normalizeQuoteForMatch (the quote), in order:
 *   1. superscript digits (U+00B9, U+00B2, U+00B3, U+2070-U+2079) are footnote markers: removed
 *      BEFORE NFKC, which would otherwise turn them into ordinary digits;
 *   2. NFKC: folds NBSP and other spaces, ligatures, and the ellipsis character into "...";
 *   3. soft hyphen (U+00AD) and zero-width characters (U+200B-U+200D, U+2060, U+FEFF) are removed;
 *   4. the allowed editorial marks, and nothing else:
 *        - a single-letter capitalisation bracket directly followed by a letter and not preceded
 *          by one keeps its letter ("[I]t" -> "It"; "can[t]" is not one);
 *        - [sic] and [citation needed] are removed wherever they are;
 *        - PAGE side only: a footnote marker, [N] with 1-3 digits or a single letter like [a], is
 *          removed when attached to the preceding non-space character ("word[3]", "end.[12]").
 *          In a quote every such bracket stays ("can[t]", "1[00]", "staff[3]", a spaced
 *          "[10]"), so it counts as a bracketed edit;
 *   5. apostrophe-like and single quote marks (U+2018, U+2019, U+201A, U+201B, U+02BC, U+2032,
 *      backtick, U+00B4) become ', curly/guillemet double quotes become ";
 *   6. hyphen, en/em dashes, horizontal bar and minus (U+2010-U+2015, U+2212) become -;
 *   7. whitespace runs become one space; lower-cased; trimmed.
 *
 * matchQuote(quote, {readable, body, truncated}) -> {found: 1|0|null, where, reason}:
 *   - the quote is normalized; outer matching "/' pairs and the punctuation . , ; : at its
 *     edges are stripped, so a quote's closing period need not match the page. "?" and "!" are
 *     kept: they change what the sentence says;
 *   - over MAX_QUOTE_CHARS (2,000) normalized chars: null, "too long to check";
 *   - ANY ellipsis ("...", ". . .", or the U+2026 character) or ANY square bracket left after
 *     step 4: null, CUT_OR_INSERTION. Never 1 and never 0: the words may well be there, but the
 *     joining is not checkable;
 *   - under MIN_PIECE_CHARS (4) normalized chars: null, "too short to check";
 *   - the FULL quote is tried first; only when it is not found, a trailing tail after a dash or
 *     after a closing quote mark is cut, and only when the RAW tail looks like an attribution:
 *     it starts with a capital letter (after an optional dash or comma), its name part has 2 to 6
 *     words that each start with an uppercase letter (or are one of the connectors
 *     of/de/van/von/al/the/and), its first word is not one of The/A/An/Never/Always/Nothing/No/
 *     Not/None/Every/All/It/We/They/This/That/Our/Its (as written, compared without a trailing
 *     "." unless the word is a one-letter initial, so "Not. Ever." is rejected and "A. Person"
 *     passes), optionally followed by ", <Title>" of at most 3 such words;
 *   - search: the Readability text first, then the full body text. One indexOf loop per text;
 *     a hit counts only when the code points around it are not letters, digits or combining
 *     marks, a hyphen or apostrophe with a letter beyond it does not end a word ("Non-toxic"),
 *     and a "." or "," between digits does not end a number ("2.5", "1,500"). At most MAX_CANDIDATES (20,000) hits are examined across all texts and both quote
 *     forms; past that: null, "couldn't check: too many possible placements";
 *   - not found: null when the stored text was truncated (the quote may be in the cut part) or
 *     there is no text at all; otherwise 0.
 */

export const MIN_PIECE_CHARS = 4;
export const MAX_QUOTE_CHARS = 2000;
export const MAX_CANDIDATES = 20000;

function normalize(s, page) {
  let out = String(s ?? "")
    .replace(/[\u00b9\u00b2\u00b3\u2070-\u2079]/g, "") // superscript footnotes (before NFKC turns them into digits)
    .normalize("NFKC") // also folds NBSP to a space and the ellipsis character to "..."
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "") // soft hyphen, zero-width
    .replace(/(?<!\p{L})\[(\p{L})\](?=\p{L})/gu, "$1") // [I]t: a capitalisation bracket keeps its letter
    .replace(/\[(?:sic|citation needed)\]/gi, ""); // editorial markers
  // footnote markers attached to the word before: page text only. In a quote "can[t]" or
  // "1[00]" is an edit, so the bracket stays and the quote reads couldn't-check.
  if (page) out = out.replace(/(?<=\S)\[(?:\d{1,3}|\p{L})\]/gu, "");
  return out
    .replace(/[\u2018\u2019\u201a\u201b\u02bc\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** Page-side normalization (also drops attached footnote markers like "word[3]"). */
export function normalizeForMatch(s) {
  return normalize(s, true);
}

/** Quote-side normalization: only [sic], [citation needed] and [I]t-style brackets are edits it undoes. */
export function normalizeQuoteForMatch(s) {
  return normalize(s, false);
}

// Only . , ; : are trimmed: "?" and "!" change what a sentence says.
const EDGE_PUNCT = /^[.,;:\s]+|[.,;:\s]+$/g;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
// After normalization "\u2026" is already "...".
const CUT_OR_BRACKET = /\.\.\.|\. \. \.|[[\]]/;

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
  // "Not." or "Never." is still the stopword; only a one-letter initial like "A." keeps its period
  let first = name[0].replace(/[,;:!?]+$/, "");
  if (!/^\p{L}\.$/u.test(first)) first = first.replace(/\.+$/, "");
  if (NOT_A_NAME_START.has(first)) return false;
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

/** The normalized text Crow looks for, or a reason it cannot look. */
function prepareQuote(raw) {
  const n = normalizeQuoteForMatch(raw);
  if (n.length > MAX_QUOTE_CHARS) return { reason: "too long to check" };
  // before the edge trim, whose "." would otherwise eat a leading or trailing ellipsis
  if (CUT_OR_BRACKET.test(n)) return { reason: CUT_OR_INSERTION };
  const q = stripOuterQuotes(n.replace(EDGE_PUNCT, "")).replace(EDGE_PUNCT, "");
  if (q.length < MIN_PIECE_CHARS) return { reason: "too short to check" };
  return { q };
}

const LETTER = /[\p{L}\p{M}]/u;
const DIGIT = /\p{N}/u;
const JOINERS = new Set(["-", "'"]);
const NUMBER_SEPARATORS = new Set([".", ","]);

/** The code point ending just before `i`, with its start index; null at the text start. */
function cpBefore(text, i) {
  if (i <= 0) return null;
  let start = i - 1;
  const lo = text.charCodeAt(start);
  if (lo >= 0xdc00 && lo <= 0xdfff && start >= 1) {
    const hi = text.charCodeAt(start - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) start--;
  }
  return { ch: String.fromCodePoint(text.codePointAt(start)), at: start };
}

/** The code point starting at `i`, with the index after it; null at the text end. */
function cpAt(text, i) {
  if (i >= text.length) return null;
  const ch = String.fromCodePoint(text.codePointAt(i));
  return { ch, next: i + ch.length };
}

/**
 * True when [start, end) of `text` is a whole run of words: the code points around it are not
 * letters, digits or combining marks; a hyphen or apostrophe with a letter beyond it joins that
 * word on ("Non-toxic", "o'lead", "toxic-waste"); a "." or "," between two digits joins the
 * number ("2.5", "1,500").
 */
function bounded(text, start, end) {
  const b = cpBefore(text, start);
  if (b) {
    if (WORD_CHAR.test(b.ch)) return false;
    const bb = cpBefore(text, b.at);
    if (bb && JOINERS.has(b.ch) && LETTER.test(bb.ch)) return false;
    const first = cpAt(text, start);
    if (bb && NUMBER_SEPARATORS.has(b.ch) && DIGIT.test(bb.ch) && first && DIGIT.test(first.ch)) return false;
  }
  const a = cpAt(text, end);
  if (a) {
    if (WORD_CHAR.test(a.ch)) return false;
    const aa = cpAt(text, a.next);
    if (aa && JOINERS.has(a.ch) && LETTER.test(aa.ch)) return false;
    const last = cpBefore(text, end);
    if (aa && NUMBER_SEPARATORS.has(a.ch) && DIGIT.test(aa.ch) && last && DIGIT.test(last.ch)) return false;
  }
  return true;
}

const OUT_OF_BUDGET = Symbol("quote-match budget");

/** A word-bounded exact occurrence of q in text; every hit examined spends from the budget. */
function occursIn(text, q, budget) {
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
    if (--budget.left < 0) throw OUT_OF_BUDGET;
    if (bounded(text, i, i + q.length)) return true;
  }
  return false;
}

const NOT_CHECKED = (reason) => ({ found: null, where: null, reason });
export const CUT_OR_INSERTION =
  "couldn't check exactly: Crow checks only exact wording; quote the passage without cuts, or verify by hand";
const TOO_MANY_PLACEMENTS = "couldn't check: too many possible placements";

/**
 * @param {string} quote
 * @param {{readable?: string, body?: string, truncated?: boolean}} page
 * @returns {{found: 1|0|null, where: "readable"|"body"|null, reason: string|null}}
 */
export function matchQuote(quote, { readable = "", body = "", truncated = false } = {}) {
  const full = prepareQuote(quote);
  if (full.reason) return NOT_CHECKED(full.reason);
  const r = normalizeForMatch(readable);
  const b = normalizeForMatch(body);
  if (!r && !b) return NOT_CHECKED("no page text to check");
  const texts = [["readable", r]];
  if (b && b !== r) texts.push(["body", b]);

  const forms = [full.q];
  const head = withoutAttribution(quote);
  if (head) {
    const cut = prepareQuote(head); // tried only after the full quote fails
    if (cut.q && cut.q !== full.q) forms.push(cut.q);
  }
  const budget = { left: MAX_CANDIDATES };
  try {
    for (const q of forms) {
      for (const [where, text] of texts) {
        if (text && occursIn(text, q, budget)) return { found: 1, where, reason: null };
      }
    }
  } catch (err) {
    if (err === OUT_OF_BUDGET) return NOT_CHECKED(TOO_MANY_PLACEMENTS);
    throw err;
  }
  if (truncated) return NOT_CHECKED("not found, but the page text was truncated");
  return { found: 0, where: null, reason: "not found in the page text" };
}
