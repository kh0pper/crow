/**
 * Quote matching for fetch-before-cite: does a quoted claim actually appear in a fetched page?
 *
 * Both a false "not found" (bots learn to ignore the warning) and a false "found" (the check is
 * pointless) are costly, so the rules are explicit:
 *
 * normalizeForMatch, in order:
 *   1. superscript digits (¹ ² ³ ⁰-⁹) are footnote markers: removed BEFORE NFKC, which would
 *      otherwise turn them into ordinary digits;
 *   2. NFKC: folds NBSP and other spaces, ligatures, and "…" into "...";
 *   3. soft hyphen and zero-width characters are removed;
 *   4. editorial markers [sic], [12], [a], [citation needed] are removed;
 *   5. curly/prime/backtick single quotes → ', curly/guillemet double quotes → ";
 *   6. hyphen, en/em dashes, horizontal bar and minus → -;
 *   7. whitespace runs → one space; lower-cased; trimmed.
 *
 * matchQuote(quote, {readable, body, truncated}):
 *   - candidate 1: the normalized quote; when it is `"…" - attribution` it is cut to the quoted
 *     part, otherwise outer matching "/' pairs are stripped;
 *   - candidate 2 (tried only when candidate 1 is not found): candidate 1 with a trailing
 *     ` - attribution` (up to 80 chars, no further dash) cut off;
 *   - a candidate splits into pieces on "..." and on bracketed insertions like "[the company]";
 *     sentence punctuation (. , ; : ! ?) at a piece's edges is trimmed, so a quote's closing
 *     period need not match the page's punctuation; pieces under MIN_PIECE_CHARS are dropped;
 *     no pieces left → null, "too short to check";
 *   - found when every piece occurs in order, each hit on word boundaries (the characters around
 *     it are not letters/digits); non-boundary hits are skipped and the search continues;
 *   - the Readability text is searched first, then the full body text;
 *   - not found: null when the stored text was truncated (the quote may be in the cut part) or
 *     there is no text at all; otherwise 0.
 */
export const MIN_PIECE_CHARS = 4;

export function normalizeForMatch(s) {
  return String(s ?? "")
    .replace(/[¹²³⁰-⁹]/g, "") // superscript footnotes (before NFKC turns them into digits)
    .normalize("NFKC") // also folds NBSP → space, "…" → "..."
    .replace(/[­​-‍⁠﻿]/g, "") // soft hyphen, zero-width
    .replace(/\[(?:sic|\d{1,3}|[a-z]|citation needed)\]/gi, "") // [sic], [12], [a], [citation needed]
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

const QUOTED_WITH_ATTRIBUTION = /^["'](.+)["']\s*-{1,2}\s*\S.{0,80}$/;
const TRAILING_ATTRIBUTION = /\s-{1,2}\s[^-]{1,80}$/;
const PIECE_SPLIT = /\s*(?:\.\.\.|\[[^\]]{1,40}\])\s*/;
const EDGE_PUNCT = /^[.,;:!?\s]+|[.,;:!?\s]+$/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function stripOuterQuotes(s) {
  let out = s.trim();
  while (out.length >= 2 && (out[0] === '"' || out[0] === "'") && out[out.length - 1] === out[0]) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function piecesOf(candidate) {
  return candidate
    .split(PIECE_SPLIT)
    .map((p) => p.replace(EDGE_PUNCT, ""))
    .filter((p) => p.length >= MIN_PIECE_CHARS);
}

function candidatesFor(quote) {
  const q = normalizeForMatch(quote);
  const m = q.match(QUOTED_WITH_ATTRIBUTION);
  const first = m ? m[1].trim() : stripOuterQuotes(q);
  const out = [first];
  const cut = stripOuterQuotes(first.replace(TRAILING_ATTRIBUTION, ""));
  if (cut && cut !== first) out.push(cut);
  return out;
}

const isWordAt = (text, i) => i >= 0 && i < text.length && WORD_CHAR.test(text[i]);

/** Index just past `piece` at a word-boundary hit at or after `from`, or -1. */
function findOnBoundary(text, piece, from) {
  let i = text.indexOf(piece, from);
  while (i >= 0) {
    const end = i + piece.length;
    if (!isWordAt(text, i - 1) && !isWordAt(text, end)) return end;
    i = text.indexOf(piece, i + 1);
  }
  return -1;
}

function piecesInOrder(text, pieces) {
  let cursor = 0;
  for (const piece of pieces) {
    const end = findOnBoundary(text, piece, cursor);
    if (end < 0) return false;
    cursor = end;
  }
  return true;
}

/**
 * @param {string} quote
 * @param {{readable?: string, body?: string, truncated?: boolean}} page
 * @returns {{found: 1|0|null, where: "readable"|"body"|null, reason: string|null}}
 */
export function matchQuote(quote, { readable = "", body = "", truncated = false } = {}) {
  const candidates = candidatesFor(quote).map(piecesOf).filter((p) => p.length > 0);
  if (candidates.length === 0) return { found: null, where: null, reason: "too short to check" };

  const r = normalizeForMatch(readable);
  const b = normalizeForMatch(body);
  if (!r && !b) return { found: null, where: null, reason: "no page text to check" };

  const texts = [["readable", r]];
  if (b && b !== r) texts.push(["body", b]);
  for (const pieces of candidates) {
    for (const [where, text] of texts) {
      if (text && piecesInOrder(text, pieces)) return { found: 1, where, reason: null };
    }
  }
  if (truncated) return { found: null, where: null, reason: "not found, but the page text was truncated" };
  return { found: 0, where: null, reason: "not found in the page text" };
}
