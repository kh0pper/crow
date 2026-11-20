// Quote and citation existence check.
//
// The JavaScript twin of the Python reference (scripts/citecheck in the private
// engineering notes). Normalises the answer and the sources, pulls the quoted
// passages and the citation strings out of the answer, and reports whether each
// one exists in a source. Pure apart from one cached read of the shipped
// quote-check-patterns.json; no network, no model, no other I/O.
//
// check(answer, sources, opts) is the public surface; normalise and tokenise are
// exported for callers that need the same text handling.
//
// Known, accepted divergences from the Python twin:
//
// - NFKC, \p{L}, \p{Nd} and toLowerCase() follow the Node ICU Unicode version,
//   while Python 3.12 uses Unicode 15.0, so a few thousand newly assigned
//   letters (and the digits and casings that came with them) can differ.
// - lone surrogates: JS keeps them as separate UTF-16 units, Python as single
//   code points, so text carrying one can normalise or tokenise differently.
// - source ids are stringified best-effort: pass string ids (a non-string id
//   such as an object or a float can print differently from Python's str()).
// - custom opts.patterns are limited to the shipped regex subset: \s, \d and
//   \b are only translated outside [...] classes, and escapes the u flag
//   rejects (e.g. \- or a bare {) are not rewritten.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIMITS = [
  "A verified quote EXISTS in a source. It does not prove the source SUPPORTS the claim made with it.",
  "Paraphrases are not checked; only quoted passages and citation strings.",
  "The check is only as good as the source text extraction (PDF text layers, OCR).",
  "A citation that exists in a source can still be the wrong citation for the claim.",
];

const DEFAULT_THRESHOLD = 0.90;
const DEFAULT_MIN_QUOTE_WORDS = 6;

const PATTERNS_FILE = fileURLToPath(new URL("./quote-check-patterns.json", import.meta.url));

const SECTION = "\u00a7";

// Python's str.isspace() set, written as a character-class body. JS \s is not
// the same set: it includes U+FEFF (Python does not) and omits U+001C-001F.
const PY_SPACE_CLASS =
  "\\t\\n\\x0B\\f\\r\\x1C-\\x1F \\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
// the same set without the newline, for Python's [^\S\n]
const PY_SPACE_NOT_NL = PY_SPACE_CLASS.replace("\\n", "");

function isPySpaceCp(cp) {
  if (cp <= 0x20) return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || (cp >= 0x1c && cp <= 0x1f);
  if (cp >= 0x2000 && cp <= 0x200a) return true;
  return (
    cp === 0x85 || cp === 0xa0 || cp === 0x1680 || cp === 0x2028 || cp === 0x2029 ||
    cp === 0x202f || cp === 0x205f || cp === 0x3000
  );
}

function isPySpace(ch) {
  return isPySpaceCp(ch.codePointAt(0));
}

function isDecimalCp(cp) {
  return /\p{Nd}/u.test(String.fromCodePoint(cp));
}

// inclusive [start,end] code point ranges where unicodedata.combining() != 0
// (Python 3.12, Unicode 15.0)
const COMBINING_RANGES = [
  0x300, 0x34E, 0x350, 0x36F, 0x483, 0x487, 0x591, 0x5BD,
  0x5BF, 0x5BF, 0x5C1, 0x5C2, 0x5C4, 0x5C5, 0x5C7, 0x5C7,
  0x610, 0x61A, 0x64B, 0x65F, 0x670, 0x670, 0x6D6, 0x6DC,
  0x6DF, 0x6E4, 0x6E7, 0x6E8, 0x6EA, 0x6ED, 0x711, 0x711,
  0x730, 0x74A, 0x7EB, 0x7F3, 0x7FD, 0x7FD, 0x816, 0x819,
  0x81B, 0x823, 0x825, 0x827, 0x829, 0x82D, 0x859, 0x85B,
  0x898, 0x89F, 0x8CA, 0x8E1, 0x8E3, 0x8FF, 0x93C, 0x93C,
  0x94D, 0x94D, 0x951, 0x954, 0x9BC, 0x9BC, 0x9CD, 0x9CD,
  0x9FE, 0x9FE, 0xA3C, 0xA3C, 0xA4D, 0xA4D, 0xABC, 0xABC,
  0xACD, 0xACD, 0xB3C, 0xB3C, 0xB4D, 0xB4D, 0xBCD, 0xBCD,
  0xC3C, 0xC3C, 0xC4D, 0xC4D, 0xC55, 0xC56, 0xCBC, 0xCBC,
  0xCCD, 0xCCD, 0xD3B, 0xD3C, 0xD4D, 0xD4D, 0xDCA, 0xDCA,
  0xE38, 0xE3A, 0xE48, 0xE4B, 0xEB8, 0xEBA, 0xEC8, 0xECB,
  0xF18, 0xF19, 0xF35, 0xF35, 0xF37, 0xF37, 0xF39, 0xF39,
  0xF71, 0xF72, 0xF74, 0xF74, 0xF7A, 0xF7D, 0xF80, 0xF80,
  0xF82, 0xF84, 0xF86, 0xF87, 0xFC6, 0xFC6, 0x1037, 0x1037,
  0x1039, 0x103A, 0x108D, 0x108D, 0x135D, 0x135F, 0x1714, 0x1715,
  0x1734, 0x1734, 0x17D2, 0x17D2, 0x17DD, 0x17DD, 0x18A9, 0x18A9,
  0x1939, 0x193B, 0x1A17, 0x1A18, 0x1A60, 0x1A60, 0x1A75, 0x1A7C,
  0x1A7F, 0x1A7F, 0x1AB0, 0x1ABD, 0x1ABF, 0x1ACE, 0x1B34, 0x1B34,
  0x1B44, 0x1B44, 0x1B6B, 0x1B73, 0x1BAA, 0x1BAB, 0x1BE6, 0x1BE6,
  0x1BF2, 0x1BF3, 0x1C37, 0x1C37, 0x1CD0, 0x1CD2, 0x1CD4, 0x1CE0,
  0x1CE2, 0x1CE8, 0x1CED, 0x1CED, 0x1CF4, 0x1CF4, 0x1CF8, 0x1CF9,
  0x1DC0, 0x1DFF, 0x20D0, 0x20DC, 0x20E1, 0x20E1, 0x20E5, 0x20F0,
  0x2CEF, 0x2CF1, 0x2D7F, 0x2D7F, 0x2DE0, 0x2DFF, 0x302A, 0x302F,
  0x3099, 0x309A, 0xA66F, 0xA66F, 0xA674, 0xA67D, 0xA69E, 0xA69F,
  0xA6F0, 0xA6F1, 0xA806, 0xA806, 0xA82C, 0xA82C, 0xA8C4, 0xA8C4,
  0xA8E0, 0xA8F1, 0xA92B, 0xA92D, 0xA953, 0xA953, 0xA9B3, 0xA9B3,
  0xA9C0, 0xA9C0, 0xAAB0, 0xAAB0, 0xAAB2, 0xAAB4, 0xAAB7, 0xAAB8,
  0xAABE, 0xAABF, 0xAAC1, 0xAAC1, 0xAAF6, 0xAAF6, 0xABED, 0xABED,
  0xFB1E, 0xFB1E, 0xFE20, 0xFE2F, 0x101FD, 0x101FD, 0x102E0, 0x102E0,
  0x10376, 0x1037A, 0x10A0D, 0x10A0D, 0x10A0F, 0x10A0F, 0x10A38, 0x10A3A,
  0x10A3F, 0x10A3F, 0x10AE5, 0x10AE6, 0x10D24, 0x10D27, 0x10EAB, 0x10EAC,
  0x10EFD, 0x10EFF, 0x10F46, 0x10F50, 0x10F82, 0x10F85, 0x11046, 0x11046,
  0x11070, 0x11070, 0x1107F, 0x1107F, 0x110B9, 0x110BA, 0x11100, 0x11102,
  0x11133, 0x11134, 0x11173, 0x11173, 0x111C0, 0x111C0, 0x111CA, 0x111CA,
  0x11235, 0x11236, 0x112E9, 0x112EA, 0x1133B, 0x1133C, 0x1134D, 0x1134D,
  0x11366, 0x1136C, 0x11370, 0x11374, 0x11442, 0x11442, 0x11446, 0x11446,
  0x1145E, 0x1145E, 0x114C2, 0x114C3, 0x115BF, 0x115C0, 0x1163F, 0x1163F,
  0x116B6, 0x116B7, 0x1172B, 0x1172B, 0x11839, 0x1183A, 0x1193D, 0x1193E,
  0x11943, 0x11943, 0x119E0, 0x119E0, 0x11A34, 0x11A34, 0x11A47, 0x11A47,
  0x11A99, 0x11A99, 0x11C3F, 0x11C3F, 0x11D42, 0x11D42, 0x11D44, 0x11D45,
  0x11D97, 0x11D97, 0x11F41, 0x11F42, 0x16AF0, 0x16AF4, 0x16B30, 0x16B36,
  0x16FF0, 0x16FF1, 0x1BC9E, 0x1BC9E, 0x1D165, 0x1D169, 0x1D16D, 0x1D172,
  0x1D17B, 0x1D182, 0x1D185, 0x1D18B, 0x1D1AA, 0x1D1AD, 0x1D242, 0x1D244,
  0x1E000, 0x1E006, 0x1E008, 0x1E018, 0x1E01B, 0x1E021, 0x1E023, 0x1E024,
  0x1E026, 0x1E02A, 0x1E08F, 0x1E08F, 0x1E130, 0x1E136, 0x1E2AE, 0x1E2AE,
  0x1E2EC, 0x1E2EF, 0x1E4EC, 0x1E4EF, 0x1E8D0, 0x1E8D6, 0x1E944, 0x1E94A,
];

function isCombining(cp) {
  let lo = 0;
  let hi = (COMBINING_RANGES.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = COMBINING_RANGES[mid * 2];
    const end = COMBINING_RANGES[mid * 2 + 1];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

// step 3 of the normalisation order: quotes
const QUOTE_MAP = new Map([
  ["\u2018", "'"], ["\u2019", "'"], ["\u201a", "'"], ["\u201b", "'"], ["\u2032", "'"],
  ["\u201c", '"'], ["\u201d", '"'], ["\u201e", '"'], ["\u201f", '"'], ["\u2033", '"'],
]);

// step 4 of the normalisation order: dashes
const DASH_MAP = new Map([
  ["\u2010", "-"], ["\u2011", "-"], ["\u2012", "-"], ["\u2013", "-"],
  ["\u2014", "-"], ["\u2015", "-"], ["\u2212", "-"],
]);

// quote extraction from the answer. A candidate never crosses a blank line:
// Python's (?!\n[^\S\n]*\n), i.e. a newline followed only by whitespace other
// than a newline and then another newline.
const QUOTE_PATTERNS = [
  new RegExp(`"((?:(?!\\n[${PY_SPACE_NOT_NL}]*\\n)[\\s\\S])*?)"`, "gu"),
  new RegExp(`\u201c((?:(?!\\n[${PY_SPACE_NOT_NL}]*\\n)[\\s\\S])*?)\u201d`, "gu"),
];
// one answer line at a time; the newline split happens outside the regex because
// JS ^ and . treat \r, U+2028 and U+2029 as line ends and Python's do not
const BLOCKQUOTE_LINE = /^[ \t]*>[ \t]?([^\n]*)$/;

// citation helpers
const LABEL_PREFIX = new RegExp(`^[${PY_SPACE_CLASS}]*(?:question|q)\\.?[${PY_SPACE_CLASS}]*`, "iu");
// Python's \d in a str pattern is any decimal digit (Nd), not just ASCII
const NUMBER = /\p{Nd}+/u;
const SECTION_LABEL = /\p{Nd}+(?:\.\p{Nd}+)*/u;

let patternsCache = null;

function codePointLengthAt(text, at) {
  const unit = text.charCodeAt(at);
  return unit >= 0xd800 && unit <= 0xdbff ? 2 : 1;
}

// The code point ending at `at`, so a surrogate pair counts as one character.
function codePointBefore(text, at) {
  if (at <= 0) return -1;
  const unit = text.charCodeAt(at - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && at >= 2) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(at - 2);
  }
  return unit;
}

// Value of one Nd code point: Python's int() accepts any decimal digits, and a
// digit is its offset from the start of the contiguous run of Nd code points it
// belongs to.
function digitValue(cp) {
  let start = cp;
  while (start > 0 && isDecimalCp(start - 1)) start -= 1;
  return (cp - start) % 10;
}

function unicodeInt(digits) {
  let value = 0;
  for (const ch of digits) value = value * 10 + digitValue(ch.codePointAt(0));
  return value;
}

function countChar(text, ch) {
  let count = 0;
  let at = text.indexOf(ch);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(ch, at + 1);
  }
  return count;
}

// Python's str.strip()
function pyStrip(text) {
  const cps = Array.from(text);
  let i = 0;
  let j = cps.length;
  while (i < j && isPySpace(cps[i])) i += 1;
  while (j > i && isPySpace(cps[j - 1])) j -= 1;
  return cps.slice(i, j).join("");
}

// Python's " ".join(text.split())
function pySplitJoin(text) {
  const parts = [];
  let cur = "";
  for (const ch of text) {
    if (isPySpace(ch)) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts.join(" ");
}

// ---------------------------------------------------------------- normalisation

export function normalise(text) {
  const original = text == null ? "" : String(text);
  if (!original) return ["", []];

  // 1. NFKC, one base character (plus its combining marks) at a time, so every
  //    output character keeps the original offset of the cluster it came from.
  const cps = Array.from(original);
  const cpOffsets = new Array(cps.length);
  let at = 0;
  for (let k = 0; k < cps.length; k += 1) {
    cpOffsets[k] = at;
    at += cps[k].length;
  }

  let chars = [];
  let index = [];
  let i = 0;
  const n = cps.length;
  while (i < n) {
    let j = i + 1;
    while (j < n && isCombining(cps[j].codePointAt(0))) j += 1;
    const cluster = cps.slice(i, j).join("");
    for (const ch of cluster.normalize("NFKC")) {
      chars.push(ch);
      index.push(cpOffsets[i]);
    }
    i = j;
  }

  // 2. join words hyphenated across a line break
  {
    const outChars = [];
    const outIndex = [];
    const m = chars.length;
    let pos = 0;
    while (pos < m) {
      if (chars[pos] === "-") {
        let k = pos + 1;
        while (k < m && chars[k] !== "\n" && isPySpace(chars[k])) k += 1;
        if (k < m && chars[k] === "\n") {
          let q = k + 1;
          while (q < m && chars[q] !== "\n" && isPySpace(chars[q])) q += 1;
          if (q < m) {
            const letter = chars[q];
            if (letter.length === 1 && letter >= "a" && letter <= "z") {
              outChars.push(letter);
              outIndex.push(index[q]);
              pos = q + 1;
              continue;
            }
          }
        }
      }
      outChars.push(chars[pos]);
      outIndex.push(index[pos]);
      pos += 1;
    }
    chars = outChars;
    index = outIndex;
  }

  // 3. and 4. quotes and dashes
  const mapped = [];
  const mappedIndex = [];
  for (let k = 0; k < chars.length; k += 1) {
    const ch = chars[k];
    const quote = QUOTE_MAP.get(ch);
    mapped.push(quote !== undefined ? quote : DASH_MAP.get(ch) ?? ch);
    mappedIndex.push(index[k]);
  }

  // 5. one section sign, one space
  const secChars = [];
  const secIndex = [];
  i = 0;
  const mn = mapped.length;
  while (i < mn) {
    const ch = mapped[i];
    if (ch === SECTION) {
      secChars.push(SECTION);
      secIndex.push(mappedIndex[i]);
      i += 1;
      if (i < mn && mapped[i] === SECTION) i += 1;
      if (i < mn && mapped[i] === " ") {
        secChars.push(" ");
        secIndex.push(mappedIndex[i]);
        i += 1;
      } else {
        secChars.push(" ");
        secIndex.push(mappedIndex[i - 1]);
      }
      continue;
    }
    secChars.push(ch);
    secIndex.push(mappedIndex[i]);
    i += 1;
  }

  // 6. lowercase
  const lowChars = [];
  const lowIndex = [];
  for (let k = 0; k < secChars.length; k += 1) {
    for (const piece of secChars[k].toLowerCase()) {
      lowChars.push(piece);
      lowIndex.push(secIndex[k]);
    }
  }

  // 7. collapse whitespace, trim. The offset map is aligned to the UTF-16 units
  //    of the final string, so an astral character contributes two entries.
  const finalChars = [];
  const finalIndex = [];
  i = 0;
  const ln = lowChars.length;
  while (i < ln) {
    const ch = lowChars[i];
    if (isPySpace(ch)) {
      let j = i + 1;
      while (j < ln && isPySpace(lowChars[j])) j += 1;
      if (finalChars.length) {
        finalChars.push(" ");
        finalIndex.push(lowIndex[i]);
      }
      i = j;
      continue;
    }
    const from = lowIndex[i];
    finalChars.push(ch);
    if (ch.length === 2) finalIndex.push(from, from);
    else finalIndex.push(from);
    i += 1;
  }
  if (finalChars.length && finalChars[finalChars.length - 1] === " ") {
    finalChars.pop();
    finalIndex.pop();
  }

  return [finalChars.join(""), finalIndex];
}

function tokenSpans(norm) {
  const spans = [];
  if (!norm) return spans;
  const re = /[\p{L}\p{Nd}\u00a7]+/gu;
  let match = re.exec(norm);
  while (match !== null) {
    spans.push([match.index, match.index + match[0].length]);
    match = re.exec(norm);
  }
  return spans;
}

export function tokenise(norm) {
  const text = norm || "";
  return tokenSpans(text).map(([a, b]) => text.slice(a, b));
}

// ---------------------------------------------------------------------- sources

class Source {
  constructor(id, text) {
    this.id = id;
    this.text = text;
    const [norm, index] = normalise(text);
    this.norm = norm;
    this.index = index;
    this.spans = tokenSpans(norm);
    this.words = this.spans.map(([a, b]) => norm.slice(a, b));
    this.positions = new Map();
    for (let pos = 0; pos < this.words.length; pos += 1) {
      const word = this.words[pos];
      const list = this.positions.get(word);
      if (list) list.push(pos);
      else this.positions.set(word, [pos]);
    }
    this.pageCount = countChar(text, "\f") + 1;
  }
}

// [page, line, bestMatch] for the normalised span [start, end) of src
function describe(src, start, end) {
  let first;
  if (start < src.index.length) first = src.index[start];
  else first = src.text.length;
  let stop;
  if (end > start) {
    const last = end - 1;
    stop = last < src.index.length
      ? src.index[last] + codePointLengthAt(src.text, src.index[last])
      : src.text.length;
  } else {
    stop = first;
  }
  const before = src.text.slice(0, first);
  const page = countChar(before, "\f") + 1;
  const line = countChar(before, "\n") + 1;
  return [page, line, pySplitJoin(src.text.slice(first, stop))];
}

// --------------------------------------------------------------------- matching

// Token-level Levenshtein distance, or null when it cannot come out below limit.
function distance(a, b, limit) {
  const n = a.length;
  const m = b.length;
  if (limit != null && Math.abs(n - m) >= limit) return null;
  if (n === 0 || m === 0) {
    const d = n || m;
    if (limit != null && d >= limit) return null;
    return d;
  }
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;
  for (let i = 1; i <= n; i += 1) {
    const word = a[i - 1];
    cur[0] = i;
    let low = i;
    for (let j = 1; j <= m; j += 1) {
      let best = prev[j - 1] + (word === b[j - 1] ? 0 : 1);
      let step = prev[j] + 1;
      if (step < best) best = step;
      step = cur[j - 1] + 1;
      if (step < best) best = step;
      cur[j] = best;
      if (best < low) low = best;
    }
    if (limit != null && low >= limit) return null;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const d = prev[m];
  if (limit != null && d >= limit) return null;
  return d;
}

// Best match of one quote in one source, or null when the source cannot hold it.
function matchInSource(qnorm, qtokens, src) {
  if (qnorm) {
    const found = src.norm.indexOf(qnorm);
    if (found >= 0) {
      const [page, line, bestMatch] = describe(src, found, found + qnorm.length);
      return { score: 1.0, page, line, best_match: bestMatch };
    }
  }

  const n = qtokens.length;
  const total = src.words.length;
  if (n === 0 || total === 0) return null;

  const qcount = new Map();
  for (const word of qtokens) qcount.set(word, (qcount.get(word) ?? 0) + 1);
  const anchors = [];
  for (const word of qcount.keys()) {
    if (src.positions.has(word)) anchors.push(word);
  }
  if (anchors.length === 0) return null;

  // ceil(0.8n) .. floor(1.2n), in integers so no float rounding creeps in
  const lo = Math.max(1, Math.floor((4 * n + 4) / 5));
  const hi = Math.min(total, Math.max(lo, Math.floor((6 * n) / 5)));
  if (hi < lo) return null;

  // The most likely window length first, so a good score shows up early and
  // prunes the rest.
  const lengths = [];
  for (let length = lo; length <= hi; length += 1) lengths.push(length);
  lengths.sort((x, y) => Math.abs(x - n) - Math.abs(y - n) || x - y);

  // bestNum / bestDen is the best similarity so far as an exact fraction
  // (span - d) / span, so pruning and tie breaks never depend on float rounding.
  let best = null;
  let bestNum = -1;
  let bestDen = 1;

  for (const length of lengths) {
    const last = total - length;
    // windows that share no token with the quote always score 0, so they are skipped
    const diff = new Int32Array(last + 2);
    for (const word of anchors) {
      for (const pos of src.positions.get(word)) {
        let a = pos - length + 1;
        if (a < 0) a = 0;
        const b = pos < last ? pos : last;
        if (b < a) continue;
        diff[a] += 1;
        diff[b + 1] -= 1;
      }
    }

    const counts = new Map();
    for (let k = 0; k < length; k += 1) {
      const word = src.words[k];
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }

    let run = 0;
    for (let start = 0; start <= last; start += 1) {
      run += diff[start];
      if (start) {
        const leaving = src.words[start - 1];
        const remaining = counts.get(leaving) - 1;
        if (remaining) counts.set(leaving, remaining);
        else counts.delete(leaving);
        const entering = src.words[start + length - 1];
        counts.set(entering, (counts.get(entering) ?? 0) + 1);
      }
      if (run <= 0) continue;
      let overlap = 0;
      for (const [word, want] of qcount) {
        const have = counts.get(word);
        if (have) overlap += have < want ? have : want;
      }
      if (overlap === 0) continue;
      const span = n > length ? n : length;
      // overlap / span is an upper bound on the similarity of this window
      if (overlap * bestDen < bestNum * span) continue;
      let limit;
      if (best === null) limit = span + 1;
      else if (bestNum <= 0) limit = span;
      // the largest distance that can still tie the best score
      else limit = Math.floor((span * (bestDen - bestNum)) / bestDen) + 1;
      const d = distance(qtokens, src.words.slice(start, start + length), limit);
      if (d === null) continue;
      const num = span - d;
      const left = num * bestDen;
      const right = bestNum * span;
      if (
        left > right ||
        (left === right &&
          best !== null &&
          (start < best[1] || (start === best[1] && length < best[2])))
      ) {
        bestNum = num;
        bestDen = span;
        best = [1.0 - d / span, start, length];
      }
    }
  }

  if (best === null || bestNum <= 0) {
    // Every window scores zero: the tie rules pick the earliest start, then the
    // shortest window.
    best = [0.0, 0, lo];
  }

  const first = src.spans[best[1]][0];
  const stop = src.spans[best[1] + best[2] - 1][1];
  const [page, line, bestMatch] = describe(src, first, stop);
  return { score: best[0], page, line, best_match: bestMatch };
}

function matchQuote(qnorm, qtokens, sources) {
  let best = null;
  for (const src of sources) {
    const found = matchInSource(qnorm, qtokens, src);
    if (found === null) continue;
    if (best === null || found.score > best.score) {
      best = { ...found, source_id: src.id };
    }
  }
  if (best === null) {
    return { score: 0.0, source_id: null, page: null, line: null, best_match: null };
  }
  return best;
}

// ---------------------------------------------------------------- quote pulling

function extractQuotes(answer, minWords) {
  const found = [];
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of answer.matchAll(pattern)) {
      found.push([match.index + 1, match[1]]);
    }
  }

  let lineStart = 0;
  for (const line of answer.split("\n")) {
    const match = BLOCKQUOTE_LINE.exec(line);
    if (match !== null) {
      found.push([lineStart + (match[0].length - match[1].length), match[1]]);
    }
    lineStart += line.length + 1;
  }

  found.sort((a, b) => a[0] - b[0]);

  const quotes = [];
  for (const [, raw] of found) {
    const text = pyStrip(raw);
    const [norm] = normalise(text);
    if (!norm) continue;
    const tokens = tokenise(norm);
    if (tokens.length < minWords) continue;
    quotes.push({ text, norm, tokens });
  }
  return quotes;
}

// -------------------------------------------------------------------- citations

function loadPatterns(path) {
  if (path == null) {
    if (patternsCache === null) {
      patternsCache = JSON.parse(readFileSync(PATTERNS_FILE, "utf8"));
    }
    return patternsCache;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function patternsFrom(value) {
  if (value == null) return loadPatterns();
  // Only the shipped list is read; a path string is not opened.
  if (typeof value === "string") return loadPatterns();
  return value;
}

// Python's \w is str.isalnum() plus underscore, so its \b is a Unicode word
// boundary rather than JS's ASCII-only one.
const WORD_BOUNDARY =
  "(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))";

// Python's \s, \d and \b inside a pattern source mean the PySpace set, any
// decimal digit (Nd) and the Unicode word boundary. The shipped patterns use
// them only outside character classes, which is all this translation handles.
function pySpaceRegexSource(source) {
  return String(source)
    .replaceAll("\\s", `[${PY_SPACE_CLASS}]`)
    .replaceAll("\\d", "\\p{Nd}")
    .replaceAll("\\b", WORD_BOUNDARY);
}

// Known accepted divergence: custom opts.patterns are limited to the shipped
// regex subset — no \s, \d or \b inside a [...] class, and no escapes (\- or a
// bare {\) that the u flag rejects.
function extractCitations(answer, patterns) {
  const candidates = [];
  const list = patterns || [];
  for (let order = 0; order < list.length; order += 1) {
    const spec = list[order] || {};
    const flags = String(spec.flags || "").includes("i") ? "gui" : "gu";
    const re = new RegExp(pySpaceRegexSource(spec.regex), flags);
    for (const match of answer.matchAll(re)) {
      if (match[0].length === 0) continue;
      candidates.push([match.index, match.index + match[0].length, order, match[0]]);
    }
  }

  // overlapping matches: longest first, equal length keeps the earlier pattern
  candidates.sort((a, b) => {
    const byLength = (b[1] - b[0]) - (a[1] - a[0]);
    if (byLength !== 0) return byLength;
    if (a[2] !== b[2]) return a[2] - b[2];
    return a[0] - b[0];
  });
  const kept = [];
  for (const cand of candidates) {
    let clash = false;
    for (const other of kept) {
      if (cand[0] < other[1] && other[0] < cand[1]) {
        clash = true;
        break;
      }
    }
    if (!clash) kept.push(cand);
  }
  kept.sort((a, b) => a[0] - b[0]);
  return kept.map(([, , order, text]) => ({ kind: list[order]?.kind ?? null, text }));
}

function findLabel(haystack, label) {
  let at = haystack.indexOf(label);
  while (at >= 0) {
    const end = at + label.length;
    if (end < haystack.length) {
      const cp = haystack.codePointAt(end);
      if (cp === 0x2e || cp === 0x3a || isPySpaceCp(cp)) return at;
    }
    at = haystack.indexOf(label, at + 1);
  }
  return null;
}

// First occurrence of label with no digit or dot touching either side.
function findSectionLabel(haystack, label) {
  let at = haystack.indexOf(label);
  while (at >= 0) {
    const end = at + label.length;
    const before = codePointBefore(haystack, at);
    const after = end < haystack.length ? haystack.codePointAt(end) : -1;
    if (
      !(before === 0x2e || (before >= 0 && isDecimalCp(before)) ||
        after === 0x2e || (after >= 0 && isDecimalCp(after)))
    ) {
      return at;
    }
    at = haystack.indexOf(label, at + 1);
  }
  return null;
}

function locationOf(src, norm) {
  const at = norm ? src.norm.indexOf(norm) : -1;
  if (at < 0) return [null, null];
  const [page, line] = describe(src, at, at + norm.length);
  return [page, line];
}

function citationResult(status, sourceId = null, page = null, line = null) {
  return { status, source_id: sourceId, page, line };
}

function checkCitation(text, kind, sources) {
  const [norm] = normalise(text);

  if (kind === "page") {
    const number = NUMBER.exec(text);
    if (number !== null) {
      const pageNo = unicodeInt(number[0]);
      for (const src of sources) {
        if (pageNo >= 1 && pageNo <= src.pageCount) {
          const [page, line] = locationOf(src, norm);
          return citationResult("verified", src.id, page, line);
        }
      }
    }
    return citationResult("not_found");
  }

  if (kind === "question") {
    const [label] = normalise(text.replace(LABEL_PREFIX, ""));
    if (label) {
      for (const src of sources) {
        const at = findLabel(src.norm, label);
        if (at !== null) {
          const [page, line] = describe(src, at, at + label.length);
          return citationResult("verified", src.id, page, line);
        }
      }
    }
    return citationResult("not_found");
  }

  if (kind === "section") {
    const numbered = SECTION_LABEL.exec(text);
    if (numbered !== null) {
      const label = numbered[0];
      for (const src of sources) {
        const at = findSectionLabel(src.norm, label);
        if (at !== null) {
          const [page, line] = describe(src, at, at + label.length);
          return citationResult("verified", src.id, page, line);
        }
      }
    }
    return citationResult("not_found");
  }

  if (norm) {
    for (const src of sources) {
      const at = src.norm.indexOf(norm);
      if (at >= 0) {
        const [page, line] = describe(src, at, at + norm.length);
        return citationResult("verified", src.id, page, line);
      }
    }
  }
  return citationResult("not_found");
}

// A double whose decimal expansion is exactly 4 places followed by a tie digit 5
// and then only zeros: the only case where half-even and half-up differ.
const EXACT_TIE = /^-?\d+\.\d{4}50{25}$/;

// Python's round(x, 4): round half to even on the exact binary value. toFixed(4)
// rounds the exact binary value already, so it is right everywhere except an
// exact tie, where the 4th decimal has to go to the even digit.
export function round4(x) {
  const exact = x.toFixed(30);
  if (!EXACT_TIE.test(exact)) return Number(x.toFixed(4));
  const negative = exact.startsWith("-");
  const body = negative ? exact.slice(1) : exact;
  const dot = body.indexOf(".");
  let scaled = Number(body.slice(0, dot)) * 10000 + Number(body.slice(dot + 1, dot + 5));
  if (scaled % 2 !== 0) scaled += 1;
  const value = scaled / 10000;
  return negative ? -value : value;
}

function sourceId(value) {
  return value === undefined || value === null ? "None" : String(value);
}

// ------------------------------------------------------------------------ check

export function check(answer, sources, opts) {
  const options = opts || {};
  const threshold = Number(options.threshold ?? DEFAULT_THRESHOLD);
  const minWords = Math.trunc(Number(options.min_quote_words ?? DEFAULT_MIN_QUOTE_WORDS));
  const patterns = patternsFrom(options.patterns);

  const srcs = [];
  for (const source of sources || []) {
    const raw = source ? source.text : null;
    srcs.push(new Source(sourceId(source ? source.id : undefined), raw ? String(raw) : ""));
  }

  const answerText = answer ? String(answer) : "";

  const quotes = [];
  const seenQuotes = new Set();
  for (const cand of extractQuotes(answerText, minWords)) {
    if (seenQuotes.has(cand.norm)) continue;
    seenQuotes.add(cand.norm);
    const found = matchQuote(cand.norm, cand.tokens, srcs);
    quotes.push({
      text: cand.text,
      status: found.score >= threshold ? "verified" : "not_found",
      score: round4(found.score),
      source_id: found.source_id,
      page: found.page,
      line: found.line,
      best_match: found.best_match,
    });
  }

  const citations = [];
  const seenCitations = new Set();
  for (const cand of extractCitations(answerText, patterns)) {
    const [norm] = normalise(cand.text);
    if (seenCitations.has(norm)) continue;
    seenCitations.add(norm);
    const found = checkCitation(cand.text, cand.kind, srcs);
    citations.push({
      text: cand.text,
      kind: cand.kind,
      status: found.status,
      source_id: found.source_id,
      page: found.page,
      line: found.line,
    });
  }

  const both = [...quotes, ...citations];
  const summary = {
    quotes_total: quotes.length,
    quotes_verified: quotes.filter((item) => item.status === "verified").length,
    citations_total: citations.length,
    citations_verified: citations.filter((item) => item.status === "verified").length,
    not_found: both.filter((item) => item.status === "not_found").length,
  };

  return {
    quotes,
    citations,
    summary,
    limits: [...LIMITS],
  };
}