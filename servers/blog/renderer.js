/**
 * Blog Renderer — Markdown to sanitized HTML
 *
 * Uses marked for Markdown parsing and sanitize-html for XSS prevention.
 */

import { marked, Marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Configure marked for GFM
marked.setOptions({ gfm: true, breaks: true });

/**
 * Render Markdown to sanitized HTML.
 * @param {string} markdown
 * @returns {string} Safe HTML
 */
export function renderMarkdown(markdown) {
  if (!markdown) return "";
  return sanitizeRendered(marked.parse(markdown));
}

// ---------------------------------------------------------------------------
// Bot output (Perch) — the same pipeline plus TeX math delimiters.
//
// Models write math as `$x$`, `$$…$$`, `\(…\)` and `\[…\]`. Plain marked
// treats that as prose: `\{` loses its backslash (a CommonMark escape),
// `a_1 … b_1` can become emphasis, and `\(x\)` reads as "(x)". There is no
// math renderer in the dashboard (no KaTeX/MathJax is shipped), so the
// decision is: SHOW THE SOURCE ONCE, untouched by markdown —
//   - inline math whose body is plain (digits, letters, spaces and ordinary
//     punctuation, no TeX syntax) renders as its text in <span class="math">,
//     so `$126$B` reads "126B";
//   - any other inline math renders as its TeX source in <code>;
//   - display math renders as a <pre class="math"><code> block.
// Delimiters are dropped; the body is HTML-escaped here and the result still
// goes through the same sanitizer as everything else, so no raw HTML can pass.
//
// A SEPARATE Marked instance, so the public blog's parser (and every other
// renderMarkdown caller) is untouched — a blog post about prices keeps its
// dollar signs exactly as before.
//
// Inline `$…$` follows pandoc's tex_math_dollars rule so currency is not
// eaten: the opening `$` must be followed by a non-space, the closing `$`
// preceded by a non-space and NOT followed by a digit ("$5 and $10" and
// "$5-$10" stay text). `\$` stays an escaped dollar.
// ---------------------------------------------------------------------------

function escapeMathHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** No TeX syntax at all — safe to show as ordinary text. */
const PLAIN_MATH = /^[A-Za-z0-9 .,:;%+\-=()/]+$/;
/** A bare number — the one body allowed to touch a following letter
 *  ("$126$B", LaTeXML's shape for "126B"). */
const NUMBER_MATH = /^[0-9][0-9.,]*$/;

// BOUNDED SCANS (review I1). Each tokenizer is tried at every candidate
// opener, so a body pattern allowed to run to the end of the input makes an
// unclosed run of `\[` or `\(` quadratic (measured: 13 s for 200 KB, on the
// gateway's event loop). So every scan here is bounded: a closer is looked
// for with indexOf inside a fixed window after the opener (inline math stays
// on one line within MAX_INLINE chars, display math within MAX_DISPLAY), and
// start() only looks a fixed window ahead. Cost is O(input x window) at worst.
//
// Separately, marked ITSELF has a cliff on long escape-dense input (measured
// on plain marked 17.0.4 with no extension: 120 KB of "\[ x\n" lexes in
// ~80 ms, 140 KB in ~1.1 s, 300 KB in ~5 s), so bot text over BOT_MD_MAX_INPUT
// is not markdown-rendered at all: renderBotMarkdown returns "" and both
// Perch paths fall back to textContent, the documented no-html path.
const MAX_INLINE = 500;
const MAX_DISPLAY = 2000;
const START_WINDOW = 4096;
export const BOT_MD_MAX_INPUT = 64 * 1024;

// Inline `$…$` (pandoc's rule, tightened by review I2): the opener is not
// followed by space, `$` or `{` (`${x}` is template/shell syntax, never TeX);
// the closer is not preceded by space or `\`, and not followed by a digit or
// `$`; a closer followed by a letter or `_` ($HOME/bin:$PATH, $AAPL/$MSFT) is
// rejected in the tokenizer unless the body is a bare number ("$126$B").
// Both character classes stop at `$` and newline, so a failed attempt costs
// at most the distance to the next one, and the head is capped anyway.
const INLINE_DOLLAR = /^\$(?![\s${])((?:\\.|[^\\$\n]){1,500}?)(?<![\s\\])\$(?![\d$])/;
const INLINE_DOUBLE = /^\$\$(?![\s\d])([^$\n]{1,500}?)\$\$/;

/** Body between `open` (at `at`) and the first `close` within `max` chars,
 *  never crossing a newline when `oneLine`. null when there is none. */
function delimited(src, at, open, close, max, oneLine) {
  const from = at + open.length;
  let end = Math.min(src.length, from + max + close.length);
  if (oneLine) {
    const nl = src.indexOf("\n", from);
    if (nl !== -1 && nl < end) end = nl;
  }
  const j = src.slice(0, end).indexOf(close, from);
  if (j === -1) return null;
  return { body: src.slice(from, j), end: j + close.length };
}

/** A display block: up to 3 spaces, an opener, a body within MAX_DISPLAY,
 *  the FIRST closer, then only spaces/tabs to the end of the line. */
function blockMath(src) {
  const lead = /^ {0,3}/.exec(src)[0].length;
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"]]) {
    if (!src.startsWith(open, lead)) continue;
    const d = delimited(src, lead, open, close, MAX_DISPLAY, false);
    if (!d || !d.body.trim()) return null;
    const tail = /^[ \t]*(?:\n+|$)/.exec(src.slice(d.end, d.end + MAX_DISPLAY));
    if (!tail || (tail[0].length === 0 && d.end !== src.length)) {
      // "$$x$$ more text" on one line is inline, not a block.
      if (!(tail && d.end + tail[0].length === src.length)) return null;
    }
    return { raw: src.slice(0, d.end + tail[0].length), text: d.body.trim() };
  }
  return null;
}

/** Anchored regex on a bounded head; a match ending exactly at the cut is
 *  discarded so the slice cannot fake an end-of-input. */
function boundedExec(re, src, cap) {
  const head = src.length > cap ? src.slice(0, cap) : src;
  const m = re.exec(head);
  if (!m) return null;
  if (head.length < src.length && m[0].length === head.length) return null;
  return m;
}

/** Inline start() hint, bounded and memoized. marked calls it on successive
 *  SUFFIXES of a paragraph (once per inline token), so a scan's answer — "the
 *  next opener is D chars from the end", or "none up to D chars from the
 *  end" — stays valid for every later, shorter suffix. Reset per
 *  renderBotMarkdown call and fingerprinted, so a different string misses
 *  rather than reusing a foreign answer. Past the window, the window's end is
 *  reported: marked cuts its inline text token there and merges the pieces
 *  back (no character is added), so a fake cut is harmless INLINE. It is NOT
 *  harmless at block level — a paragraph cut is re-joined with "\n", which
 *  `breaks` turns into <br> — so the block hint never fakes one. */
function makeStartMemo() { return { src: null, len: 0, hit: null, scanned: 0 }; }
let inlineMemo = makeStartMemo();
let blockMemo = makeStartMemo();
/** Block-opener validity, keyed by distance-from-end + a fingerprint. */
let blockValid = new Map();
const BLOCK_CHECKS_PER_CALL = 16;
const BLOCK_CANDIDATES_PER_CALL = 64;

function sameDoc(memo, src) {
  if (memo.src === null || src.length > memo.len) return false;
  const off = memo.src.length - src.length;
  return memo.src.slice(off, off + 32) === src.slice(0, 32);
}

function inlineStart(src) {
  const memo = inlineMemo;
  if (sameDoc(memo, src)) {
    if (memo.hit !== null && src.length >= memo.hit) return src.length - memo.hit;
    if (memo.hit === null && src.length > memo.scanned) return src.length - memo.scanned;
  }
  const head = src.length > START_WINDOW ? src.slice(0, START_WINDOW) : src;
  const m = head.match(/\$|\\\(/);
  memo.src = src; memo.len = src.length;
  if (m) { memo.hit = src.length - m.index; return m.index; }
  memo.hit = null;
  if (head.length < src.length) { memo.scanned = src.length - head.length; return head.length; }
  memo.scanned = 0;
  return undefined;
}

/** Block start() hint: the first opener in the window that will actually
 *  tokenize. An unclosed `\[` is never reported — marked would cut the
 *  paragraph there, and its setext-heading regex rescans the remaining input
 *  once per cut (that was most of the measured quadratic cost). At most
 *  BLOCK_CHECKS_PER_CALL new candidates are verified, and at most
 *  BLOCK_CANDIDATES_PER_CALL looked at, per call (each verdict is
 *  memoized); past that, or past the window, there is no hint, and a display
 *  block glued to the end of a very long paragraph renders as text. */
function blockStart(src) {
  const memo = blockMemo;
  if (sameDoc(memo, src)) {
    if (memo.hit !== null && src.length >= memo.hit) return cutBudget(src.length - memo.hit);
    if (memo.hit === null && src.length > memo.scanned) return undefined;
  }
  const head = src.length > START_WINDOW ? src.slice(0, START_WINDOW) : src;
  const re = /(?:^|\n) {0,3}(?:\$\$|\\\[)/g;
  let m, checks = 0, seen = 0, found;
  memo.src = src; memo.len = src.length;
  while ((m = re.exec(head))) {
    const i = m.index + (m[0].startsWith("\n") ? 1 : 0);
    if (++seen > BLOCK_CANDIDATES_PER_CALL) {
      memo.hit = null; memo.scanned = src.length - i;
      return undefined;
    }
    const key = (src.length - i) + ":" + src.slice(i, i + 32);
    let ok = blockValid.get(key);
    if (ok === undefined) {
      if (++checks > BLOCK_CHECKS_PER_CALL) {
        // Out of budget: no hint, and remember only what was proven clean.
        memo.hit = null; memo.scanned = src.length - i;
        return undefined;
      }
      ok = !!blockMath(src.slice(i));
      blockValid.set(key, ok);
    }
    if (ok) { found = i; break; }
    re.lastIndex = m.index + 1;
  }
  memo.hit = null; memo.scanned = src.length - head.length;
  if (found === undefined) return undefined;
  memo.hit = src.length - found;
  return cutBudget(found);
}

/** start() only matters when a display block INTERRUPTS a paragraph (at a
 *  block boundary the tokenizer is tried directly). Each such cut makes
 *  marked's setext-heading regex rescan the rest of the paragraph, so the
 *  number of interruptions is capped per render; past the cap a display
 *  block glued to paragraph text stays text (one after a blank line still
 *  renders). */
const MAX_PARAGRAPH_CUTS = 128;
let cutsLeft = MAX_PARAGRAPH_CUTS;
function cutBudget(i) {
  if (i === 0) return i;
  if (cutsLeft <= 0) return undefined;
  cutsLeft--;
  return i;
}

const mathExtensions = [
  {
    name: "mathBlock",
    level: "block",
    // Only an opener that will actually tokenize counts: reporting an
    // unclosed `\[` makes marked cut the paragraph there, and its setext
    // heading regex then rescans the rest of the input once per cut.
    start(src) { return blockStart(src); },
    tokenizer(src) {
      const b = blockMath(src);
      return b ? { type: "mathBlock", raw: b.raw, text: b.text } : undefined;
    },
    renderer(token) {
      return '<pre class="math"><code>' + escapeMathHtml(token.text) + "</code></pre>\n";
    },
  },
  {
    name: "mathInline",
    level: "inline",
    start(src) { return inlineStart(src); },
    tokenizer(src) {
      let raw = null, text = null;
      if (src.startsWith("\\(")) {
        const d = delimited(src, 0, "\\(", "\\)", MAX_INLINE, true);
        if (d) { raw = src.slice(0, d.end); text = d.body; }
      } else if (src[0] === "$") {
        const cap = MAX_INLINE + 8;
        let m = boundedExec(INLINE_DOUBLE, src, cap);
        if (!m) {
          m = boundedExec(INLINE_DOLLAR, src, cap);
          if (m && /^[A-Za-z_]/.test(src.slice(m[0].length, m[0].length + 1)) && !NUMBER_MATH.test(m[1])) m = null;
        }
        if (m) { raw = m[0]; text = m[1]; }
      }
      if (raw && text.trim()) return { type: "mathInline", raw, text: text.trim() };
      return undefined;
    },
    renderer(token) {
      return PLAIN_MATH.test(token.text)
        ? '<span class="math">' + escapeMathHtml(token.text) + "</span>"
        : "<code>" + escapeMathHtml(token.text) + "</code>";
    },
  },
];

const botMarked = new Marked({
  gfm: true,
  breaks: true,
  extensions: mathExtensions,
  // Review M7: an image's alt is rendered from its inline tokens, so a math
  // token there would put our <span> markup into the attribute as text.
  // Inside alt text, math is just its source. (A renderer override that
  // returns false falls through to marked's own image renderer; walkTokens
  // was measured far too slow on long input.)
  renderer: {
    image(token) {
      if (Array.isArray(token.tokens) && token.tokens.some((t) => t.type === "mathInline")) {
        token.tokens = token.tokens.map((t) => (t.type === "mathInline"
          ? { type: "text", raw: t.raw, text: escapeMathHtml(t.text), escaped: true }
          : t));
      }
      return false;
    },
  },
});

/**
 * Render a bot's markdown (Perch live frames and transcript history — both
 * paths call this, so they render identically) to sanitized HTML: everything
 * renderMarkdown does, plus math delimiters shown once as source. Over
 * BOT_MD_MAX_INPUT it returns "" (callers fall back to plain text): marked's
 * own lexer degrades sharply on long escape-dense input (see above).
 * @param {string} markdown untrusted model output
 * @returns {string} Safe HTML
 */
export function renderBotMarkdown(markdown) {
  if (!markdown) return "";
  const src = String(markdown);
  if (src.length > BOT_MD_MAX_INPUT) return "";
  inlineMemo = makeStartMemo();
  blockMemo = makeStartMemo();
  blockValid = new Map();
  cutsLeft = MAX_PARAGRAPH_CUTS;
  return sanitizeRendered(botMarked.parse(src));
}

/** The shared post-parse half: storage: rewrite, allow-list sanitize, tables. */
function sanitizeRendered(raw) {
  // Rewrite storage: URLs to public blog media route
  const processed = raw.replace(
    /(<img\s[^>]*src=")storage:([^"]+)(")/g,
    '$1/blog/media/$2$3'
  );
  const clean = sanitizeHtml(processed, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img", "h1", "h2", "h3", "h4", "h5", "h6",
      "details", "summary", "figure", "figcaption",
      "pre", "code", "span", "del", "ins", "sup", "sub",
      "table", "thead", "tbody", "tr", "th", "td",
      "input", // for checkboxes in GFM task lists
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title", "width", "height", "loading"],
      a: ["href", "title", "target", "rel"],
      code: ["class"],
      span: ["class"],
      pre: ["class"],
      input: ["type", "checked", "disabled"],
      th: ["align"],
      td: ["align"],
      // Phase 8: case-study figure wrappers carry class + data-* that
      // blog-hydrate.js reads to swap the static PNG for a live widget,
      // and schema.org microdata for SEO.
      figure: ["class", "data-section-id", "data-backend-id", "data-metric", "data-field"],
      article: ["class", "itemscope", "itemtype"],
      h1: ["itemprop"],
      h2: ["itemprop"],
      p: ["itemprop"],
    },
    allowedClasses: {
      code: ["language-*"],
      span: ["*"],
      pre: ["*"],
      figure: ["crow-chart", "crow-map", "crow-hydrated"],
      article: ["*"],
    },
    selfClosing: ["img", "br", "hr", "input"],
  });
  return wrapTables(clean);
}

/**
 * Put every table in the shared horizontal-scroll wrapper, so a wide
 * markdown table scrolls inside its column instead of widening the page on
 * a phone (public blog, blog preview, federated memory view, KB preview,
 * file viewer, Perch). Runs AFTER sanitizing: the sanitizer allows no
 * attributes on <table>, so the markup here is exactly "<table>", and the
 * wrapper is added by us, never taken from the author's markdown. Each
 * <table> opens one wrapper and each </table> closes one, so nested tables
 * stay balanced. The wrapper's CSS lives in the dashboard's componentsCss()
 * and, for pages without it, in each page's own stylesheet (blog-public
 * designCss, fileview).
 */
export function wrapTables(html) {
  return String(html)
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

/**
 * Generate a URL-safe slug from a title.
 * @param {string} title
 * @returns {string}
 */
// Slugs reserved for sub-routes (songbook index, etc.)
const RESERVED_SLUGS = new Set(["songbook"]);

export function generateSlug(title) {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (RESERVED_SLUGS.has(slug)) {
    slug = `${slug}-post`;
  }
  return slug;
}

/**
 * Generate a text excerpt from markdown content.
 * @param {string} markdown
 * @param {number} [maxLength=200]
 * @returns {string}
 */
export function generateExcerpt(markdown, maxLength = 200) {
  if (!markdown) return "";
  // Strip markdown syntax for plain text excerpt
  const plain = markdown
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/^[-*+]\s/gm, "")
    .replace(/^\d+\.\s/gm, "")
    .replace(/\n+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength).replace(/\s\S*$/, "") + "…";
}
