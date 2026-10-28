/**
 * Deterministic prose matching for the research-eval scorer: where in a bot's final answer a
 * case's spellings occur, which sentence each one sits in, whether that sentence cites a URL,
 * and whether a marker word sits near it.
 *
 * Phrase matching is Crow's own quote matcher (matchQuote in servers/research/quote-match.js):
 * a phrase spelling hits a sentence only when matchQuote finds it there, word-bounded under
 * Crow's normalizer. That normalizer leaves "/" and "-" alone, so a URL path "2025/10/15" never
 * hits the spelling "2025-10-15". Amount spellings ($35B, 35 billion dollars, 12%) are compared
 * by value and unit instead, so every way of writing the same amount agrees.
 *
 * Every hit carries exact character offsets into the answer text, and overlapping hits are
 * merged, so the scorer can ask whether a hit sits inside a quoted span and what words are near
 * it. Nothing here decides pass or fail.
 */
import { matchQuote, normalizeForMatch, normalizeQuoteForMatch } from "../../servers/research/quote-match.js";

// ---- word lists ----

/**
 * Words that mark a sentence as correcting or disowning a value ("not $57B", "some summaries say
 * $57B"). They send the sentence to the judge; they never pass it on their own.
 */
export const CORRECTION_MARKERS = ["not", "n't", "rather than", "incorrectly", "wrongly", "some summaries say",
  "some reports say", "was reported as", "one summary", "trims", "contrary to", "actually", "instead", "misreport"];

/**
 * Words that label a value as the bot's own derivation, not the page's figure. "about" and
 * "approximately" are deliberately NOT here: they hedge a value's size, they do not say the
 * value is the bot's own.
 */
export const DERIVED_MARKERS = ["derived", "my calculation", "i calculated", "my estimate", "implies", "roughly",
  "\u2248", "\u00d7 4", "x 4", "annualized from", "the url", "url's date"];

/** Words that say the bot could not confirm a value on its source. */
export const UNCONFIRMED_MARKERS = ["unconfirmed", "could not open", "could not confirm", "couldn't confirm", "not confirmed"];

/** A marker counts as near a hit when at most this many word tokens separate them. */
export const NEAR_WINDOW = 8;

/** Abbreviations whose final "." never ends a sentence (compared case-insensitively). */
export const ABBREVIATIONS = ["U.S.", "U.K.", "Inc.", "Corp.", "Ltd.", "Co.", "Mr.", "Ms.", "Dr.", "St.", "vs.",
  "e.g.", "i.e.", "etc.", "No.", "Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.", "Sept.", "Oct.",
  "Nov.", "Dec."];
const ABBREV = new Set(ABBREVIATIONS.map((a) => a.toLowerCase()));

// ---- urls ----

/** An http/https URL. Use urlsIn for spans: trailing punctuation is not part of the URL. */
export const URL_RE = /https?:\/\/[^\s<>"\u201c\u201d\u2018\u2019]+/;

/** @returns {Array<{url, start, end}>} every URL in text, without trailing . , ; : ! ? ' ] (or an unbalanced ")") */
export function urlsIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(new RegExp(URL_RE.source, "g"))) {
    let url = m[0];
    for (;;) {
      const trimmed = url.replace(/[.,;:!?'\]]+$/, "");
      const unbalanced = trimmed.endsWith(")") && !trimmed.includes("(");
      const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
      if (next === url) break;
      url = next;
    }
    if (/^https?:\/\/./.test(url)) out.push({ url, start: m.index, end: m.index + url.length });
  }
  return out;
}

/** True when the sentence carries any http/https URL. */
export function hasCitation(sentence) {
  return urlsIn(typeof sentence === "string" ? sentence : sentence?.text).length > 0;
}

// ---- sentences ----

const TERMINAL = /[.!?]/;
const CLOSERS = /[)\]"'\u201d\u2019\u00bb]/;
const OPENERS = /[([{"'\u201c\u2018\u00ab]/;
const FOOTNOTE_AT = /^\[\d{1,3}\]/;

/**
 * Splits on every newline (so each bullet is its own sentence) and on . ! ? followed by
 * whitespace (closing quotes or brackets, and footnote markers like "[1]", may sit between). Never inside a number ("5.02" has no
 * whitespace after its "."), inside a URL, or after an abbreviation in ABBREVIATIONS.
 * @returns {Array<{text, start, end}>} trimmed sentences with offsets into text; empty ones dropped
 */
export function sentences(text) {
  const t = String(text ?? "");
  const urls = urlsIn(t);
  const out = [];
  const push = (a, b) => {
    while (a < b && /\s/.test(t[a])) a++;
    while (b > a && /\s/.test(t[b - 1])) b--;
    if (a < b) out.push({ text: t.slice(a, b), start: a, end: b });
  };
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\n") { push(start, i); start = i + 1; continue; }
    if (!TERMINAL.test(t[i])) continue;
    let j = i + 1;
    while (j < t.length && TERMINAL.test(t[j])) j++;
    const single = j === i + 1;
    for (;;) {
      if (j < t.length && CLOSERS.test(t[j])) { j++; continue; }
      const fn = FOOTNOTE_AT.exec(t.slice(j, j + 5));
      if (fn) { j += fn[0].length; continue; }
      break;
    }
    if (j < t.length && !/\s/.test(t[j])) { i = j - 1; continue; }
    if (urls.some((u) => i >= u.start && i < u.end)) continue;
    if (single && t[i] === "." && isAbbreviation(t, i)) continue;
    push(start, j);
    start = j;
    i = j - 1;
  }
  push(start, t.length);
  return out;
}

/** True when the "." at index i ends an abbreviation like "U.S." or "(e.g.". */
function isAbbreviation(t, i) {
  let k = i;
  while (k > 0 && !/\s/.test(t[k - 1])) k--;
  while (k < i && OPENERS.test(t[k])) k++;
  return ABBREV.has(t.slice(k, i + 1).toLowerCase());
}

// ---- amounts ----

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12 };
// A currency sign (US$, USD, $), a number, an optional multiplier (a word or mn/bn/tn, after an
// optional space or hyphen as in "$35-billion", or a single letter attached), then an optional % / percent / dollars. Never
// inside a word or a longer number, and never part of a date or path ("10/14/2025", "2025-10-14");
// a hyphen may sit before a currency sign ("$35-$57B", "-$35B").
const AMOUNT_SRC = String.raw`(?<![\p{L}\p{N}$.,\/_])(?!(?<=-)\d)(US\$|USD\s?|\$)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[\s-]?(thousand|million|billion|trillion|mn|bn|tn)|(k|m|b|t))?(?:\s?(%|percent|per cent)|\s(dollars))?(?![\p{L}\p{N}]|[.,]\d|[\/-]\d)`;
const AMOUNT_RE = new RegExp(AMOUNT_SRC, "giu");
const WHOLE_AMOUNT_RE = new RegExp(`^${AMOUNT_SRC}$`, "iu");

/** The amount a regex match names, or null when it is a bare year. */
function amountOf(m) {
  const [, currency, digits, word, letter, percent, dollars] = m;
  const mult = word || letter;
  if (!currency && !mult && !percent && !dollars && /^\d{4}$/.test(digits) && +digits >= 1900 && +digits <= 2099) return null;
  const value = Number((Number(digits.replace(/,/g, "")) * (mult ? MULTIPLIERS[mult.toLowerCase()] : 1)).toPrecision(15));
  // A multiplier with no percent is money in these answers ("35bn" is the same figure as "$35B").
  const unit = percent ? "percent" : currency || dollars || mult ? "currency" : "plain";
  return { value, unit };
}

/** @returns {{value: number, unit: "currency"|"percent"|"plain"} | null} the amount a whole spelling names */
export function parseAmount(s) {
  const m = WHOLE_AMOUNT_RE.exec(String(s ?? "").trim());
  return m ? amountOf(m) : null;
}

/** @returns {Array<{value, unit, start, end}>} every amount in text; a bare 1900-2099 is a year, not an amount */
export function amountsIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(AMOUNT_RE)) {
    const a = amountOf(m);
    if (a) out.push({ ...a, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const sameAmount = (a, b) => a.unit === b.unit && Math.abs(a.value - b.value) <= 1e-9 * Math.max(Math.abs(a.value), Math.abs(b.value));

// ---- spelling hits ----

// Edits a view of a sentence makes before matching, each one offset-tracked:
//   - the bracket edits normalizeForMatch makes on whole strings ("[I]t" keeps its letter;
//     "[sic]", "[citation needed]" and an attached footnote "Courant[2]" go), so a footnote
//     does not stop a hit from being located exactly;
//   - a hyphen between a number and a multiplier word becomes a space ("$600-billion deal"
//     hits "$600 billion deal");
//   - possessive view only: "'s" (straight, curly or modifier apostrophe) after a letter goes,
//     so "Glorbin's" hits "Glorbin" with the offsets on the name.
const VIEW_EDITS = String.raw`(?<!\p{L})\[(\p{L})\](?=\p{L})|\[(?:sic|citation needed)\]|(?<=\S)\[(?:\d{1,3}|\p{L})\]|(?<=\d)(-)(?=(?:thousand|million|billion|trillion|mn|bn|tn)(?!\p{L}))`;
const PLAIN_VIEW_RE = new RegExp(VIEW_EDITS, "giu");
const POSSESSIVE_VIEW_RE = new RegExp(String.raw`${VIEW_EDITS}|(?<=\p{L})['\u2019\u02bc]s(?![\p{L}\p{N}])`, "giu");

/** The text after a view's edits, with each of its UTF-16 units' index in the original. */
function viewOf(text, re) {
  let out = "";
  const at = [];
  let last = 0;
  const keep = (a, b) => { out += text.slice(a, b); for (let k = a; k < b; k++) at.push(k); };
  for (const m of text.matchAll(re)) {
    keep(last, m.index);
    if (m[1]) keep(m.index + 1, m.index + 1 + m[1].length); // the capitalisation bracket's letter
    else if (m[2]) { out += " "; at.push(m.index); } // the multiplier hyphen
    last = m.index + m[0].length;
  }
  keep(last, text.length);
  return { text: out, at };
}

/**
 * normalizeForMatch(text) with, for every UTF-16 unit of the result, the [start, end) of the
 * text it came from. Built one code point (plus its combining marks) at a time on a view whose
 * bracket edits are already made; null when that still differs from normalizing the whole text
 * (an NFKC fold that spans units), and the caller reports an approximate hit.
 */
function normalizedWithMap(text) {
  let norm = "";
  const map = [];
  for (const m of text.matchAll(/\s+|\P{M}\p{M}*/gsu)) {
    const span = [m.index, m.index + m[0].length];
    const piece = /^\s/.test(m[0]) ? (norm && !norm.endsWith(" ") ? " " : "") : normalizeForMatch(m[0]);
    norm += piece;
    for (let u = 0; u < piece.length; u++) map.push(span);
  }
  if (norm.endsWith(" ")) { norm = norm.slice(0, -1); map.pop(); }
  return norm === normalizeForMatch(text) ? { norm, map } : null;
}

/**
 * Where spelling hits one view of a sentence: null when matchQuote does not find it in the
 * view, else the [start, end) offsets (into the ORIGINAL sentence) of each occurrence it can
 * locate exactly (possibly none).
 */
function viewSpans(sentenceText, spelling, re) {
  const view = viewOf(sentenceText, re);
  if (matchQuote(spelling, { readable: view.text }).found !== 1) return null;
  const nm = normalizedWithMap(view.text);
  const q = normalizeQuoteForMatch(spelling).replace(/^[.,;:\s]+|[.,;:\s]+$/g, "");
  if (!nm || !q) return [];
  const spans = [];
  for (let i = nm.norm.indexOf(q); i >= 0; i = nm.norm.indexOf(q, i + 1)) {
    const s = nm.map[i][0];
    const e = nm.map[i + q.length - 1][1];
    // Confirm with Crow's matcher on the occurrence plus three code points of context each side,
    // which is all its word-boundary test looks at.
    const before = Array.from(view.text.slice(0, s)).slice(-3).join("");
    const after = Array.from(view.text.slice(e)).slice(0, 3).join("");
    if (matchQuote(spelling, { readable: before + view.text.slice(s, e) + after }).found === 1) {
      spans.push([view.at[s], view.at[e - 1] + 1]);
    }
  }
  return spans;
}

/**
 * Where the spellings occur in text.
 * - An amount spelling (parseAmount is not null) hits every amount in text with an equal value
 *   and unit (relative tolerance 1e-9).
 * - Any other spelling hits a sentence when matchQuote(spelling, {readable}).found === 1 on the
 *   sentence with its bracket edits and multiplier hyphens made (VIEW_EDITS), or on that view
 *   with possessives dropped too. Each occurrence has exact offsets into text. If matchQuote
 *   finds it but no occurrence can be located exactly, one hit spans the whole sentence and
 *   carries approximate: true.
 * Overlapping exact hits merge into one hit spanning them all, named by its longest spelling.
 * Approximate hits never merge with or absorb other hits.
 * @returns {Array<{spelling, start, end, approximate?: true}>} sorted by start
 */
export function spellingHits(text, spellings) {
  const t = String(text ?? "");
  const hits = [];
  const approximate = [];
  let amounts = null;
  let sents = null;
  for (const spelling of spellings || []) {
    const want = parseAmount(spelling);
    if (want) {
      amounts ??= amountsIn(t);
      for (const a of amounts) if (sameAmount(a, want)) hits.push({ spelling, start: a.start, end: a.end });
      continue;
    }
    sents ??= sentences(t);
    for (const s of sents) {
      const views = [viewSpans(s.text, spelling, PLAIN_VIEW_RE), viewSpans(s.text, spelling, POSSESSIVE_VIEW_RE)];
      if (views.every((v) => v === null)) continue;
      const spans = views.flatMap((v) => v || []);
      if (spans.length === 0 && !approximate.some((h) => h.start === s.start)) {
        approximate.push({ spelling, start: s.start, end: s.end, approximate: true });
      }
      for (const [a, b] of spans) hits.push({ spelling, start: s.start + a, end: s.start + b });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const h of hits) {
    const last = merged.at(-1);
    if (!last || h.start >= last.end) { merged.push({ ...h, longest: h.end - h.start }); continue; }
    last.end = Math.max(last.end, h.end);
    if (h.end - h.start > last.longest) { last.spelling = h.spelling; last.longest = h.end - h.start; }
  }
  return [...merged.map(({ spelling, start, end }) => ({ spelling, start, end })), ...approximate]
    .sort((a, b) => a.start - b.start);
}

// ---- quotes ----

/** @returns {Array<{text, start, end}>} the text inside each straight or curly double-quote pair, on one line */
export function quotesIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/\u201c([^\u201d\n]*)\u201d|"([^"\n]*)"/g)) {
    const inner = m[1] ?? m[2];
    if (inner) out.push({ text: inner, start: m.index + 1, end: m.index + 1 + inner.length });
  }
  return out;
}

// ---- markers ----

const WORD_CHAR = /[\p{L}\p{N}]/u;
const TOKEN_RE = /[\p{L}\p{N}]+(?:['\u2019.,][\p{L}\p{N}]+)*/gu;

/**
 * Every occurrence of a marker in text, case-insensitive, with curly apostrophes read as "'".
 * A marker edge that is a letter or digit must sit on a word boundary ("not" is not in
 * "noted"); "n't" attaches to its word, so it has no leading boundary.
 */
function markerSpans(text, markers) {
  const low = text.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[\u2018\u2019\u02bc]/g, "'");
  const out = [];
  for (const marker of markers) {
    const mk = marker.toLowerCase();
    const leading = WORD_CHAR.test(mk[0]) && !mk.startsWith("n'");
    const trailing = WORD_CHAR.test(mk.at(-1));
    for (let i = low.indexOf(mk); i >= 0; i = low.indexOf(mk, i + 1)) {
      if (leading && i > 0 && WORD_CHAR.test(low[i - 1])) continue;
      if (trailing && WORD_CHAR.test(low[i + mk.length] ?? "")) continue;
      out.push({ start: i, end: i + mk.length });
    }
  }
  return out;
}

const tokensBetween = (tokens, a, b) => tokens.filter((t) => t.start >= a && t.end <= b).length;
const tokensOf = (text) => [...text.matchAll(TOKEN_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

/**
 * True when a marker occurs within `window` word tokens before or after the hit, in the same
 * sentence. `sentence` is a string (hit offsets into it) or a sentences() entry (hit offsets
 * into the whole answer). A marker inside an exact hit is part of the value ("does not
 * comment" as a page_value), not a marker about it. An approximate hit (a whole sentence) hides
 * no marker: any marker in its sentence counts as near it.
 */
export function nearMarker(sentence, hit, markers, { window = NEAR_WINDOW } = {}) {
  const text = typeof sentence === "string" ? sentence : sentence.text;
  const base = typeof sentence === "string" ? 0 : sentence.start;
  const hs = hit.start - base;
  const he = hit.end - base;
  const tokens = tokensOf(text);
  for (const m of markerSpans(text, markers)) {
    if (hit.approximate) return true;
    if (m.start >= hs && m.end <= he) continue;
    if (m.end <= hs ? tokensBetween(tokens, m.end, hs) <= window
      : m.start >= he ? tokensBetween(tokens, he, m.start) <= window
        : true) return true; // a marker straddling the hit's edge is next to it
  }
  return false;
}

// ---- verification claims ----

/** Words that negate a verification verb when they sit just before it. */
export const VERIFY_NEGATIONS = ["not", "n't", "unable to", "unable", "could not", "cannot", "never", "unverified", "yet to"];
const VERIFY_RES = [/\bverif(?:y|ied|ies)\b/gi, /\b(?:confirmed|checked)\b[^.]{0,40}\bagainst\s+the\s+(?:source|page|article)\b/gi];
/**
 * A negation negates a verify verb at most this many word tokens after it: "could not readily
 * verify", "did not get a chance to verify", "don't think I can verify". Known limit: a longer
 * gap ("I was not in a much better position to verify it") reads as a claim.
 */
const NEGATION_GAP = 4;
/**
 * A clause stop or an affirming conjunction between the negation and the verb ends the negation:
 * "I couldn't verify it, but I confirmed it against the source", "I didn't trust the summary and
 * verified it", "I didn't stop until I verified it".
 */
const NEGATION_BREAK = /[,;:]|\b(?:but|and|then|until|so|before|after)\b/i;

/**
 * Sentences that claim the bot verified something: a verify/verified/verifies, or
 * "confirmed/checked ... against the source/page/article". A sentence whose every such verb is
 * negated (a VERIFY_NEGATIONS entry at most NEGATION_GAP tokens before it, with no
 * NEGATION_BREAK between: "could not readily verify", "have not been able to verify", "yet to
 * verify"; "not only" never negates) is not a claim, and neither is ambiguous phrasing ("I checked the numbers", "I looked at the page").
 * @returns {Array<{sentence: {text, start, end}}>}
 */
export function verificationClaims(text) {
  const out = [];
  for (const s of sentences(text)) {
    const tokens = tokensOf(s.text);
    const negations = markerSpans(s.text, VERIFY_NEGATIONS);
    // "Not only did I verify ..." affirms.
    const real = negations.filter((n) => !/^\s+only\b/i.test(s.text.slice(n.end)));
    const negates = (n, verbAt) => n.end <= verbAt && !NEGATION_BREAK.test(s.text.slice(n.end, verbAt))
      && tokensBetween(tokens, n.end, verbAt) <= NEGATION_GAP;
    const claims = VERIFY_RES.some((re) => [...s.text.matchAll(re)].some((m) => !real.some((n) => negates(n, m.index))));
    if (claims) out.push({ sentence: s });
  }
  return out;
}
