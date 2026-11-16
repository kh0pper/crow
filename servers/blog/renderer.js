/**
 * Blog Renderer — Markdown to sanitized HTML
 *
 * Uses marked for Markdown parsing and sanitize-html for XSS prevention.
 */

import { marked, Marked, Lexer } from "marked";
import sanitizeHtml from "sanitize-html";

// Configure marked for GFM. This is the module-level instance only
// markdownBlocks (Crow Artifacts) parses with; renderMarkdown has its own
// instance (ownerMarked, below) so the owner path can carry the image rule.
marked.setOptions({ gfm: true, breaks: true });

/**
 * Render Markdown to sanitized HTML — the OWNER's renderer (blog post and
 * preview, memory panel, knowledge base, file view, meta-glasses notes).
 *
 * A bot can write every one of those surfaces, so the owner path carries the
 * same image rule a bot reply does (see `isAllowedImageSrc`), with five owner
 * exceptions: a URL on the instance's storage origin (presigned object URLs),
 * an inline `data:image/…;base64,`, a published case-study figure under
 * `/blog/figures/` in the one filename shape its read-only route serves (see
 * OWNER_FIGURE_PREFIX), a knowledge-base media file under `/kb/media/` (see
 * OWNER_KB_MEDIA_PREFIX), and a meta-glasses note photo on disk under
 * `/api/meta-glasses/photo/` (see OWNER_PHOTO_PREFIX). None of the five can hit
 * a state-changing route: an object store, no request at all, and three GETs
 * that only ever return a stored file. A refused image leaves its escaped alt
 * text, exactly like the bot path.
 *
 * Links keep Turbo Drive (they are the owner's own navigation) but never get
 * prefetched: Turbo 8 fires a same-origin GET on hover, with the viewer's
 * cookies.
 *
 * Like the bot path, this is the SAME guarded pipeline (guardAndParse, driven
 * with ownerMarked's own defaults, image renderer and link opt-out): container
 * nesting is bounded INSIDE marked's block lexer (boundedLexer + MD_MAX_NEST,
 * see "THE BLOCK-NESTING CLIFF" below), and the inline-lexer cliff is guarded
 * by the same linear pre-pass the bot path uses (see "THE INLINE-LEXER CLIFF").
 * Both matter to the OWNER path: /blog and /kb are PUBLIC and uncached, so any
 * reader can hand this function a document — which is exactly how the owner
 * path's quadratic render went from an operator-only annoyance to an
 * unauthenticated one (measured before that guard: 1.8 s for 64 KB of `_a`).
 * And a bot can write a blog post, a memory, a KB article, a workspace .md or a
 * meta-glasses note, and this function runs synchronously in a route — uncaught,
 * the stack overflow a deeply nested document used to cause was a 500 on the
 * page (measured: 1356 ms and a RangeError for 64 KB of `1) `), while an
 * unbounded 4 MB document is an OOM in the gateway process.
 *
 * THE LONG-DOCUMENT SPLIT. marked's block lexer is still quadratic on a few
 * shapes the depth and byte guard below do not cover (`"    x\n>     y\n"`
 * repeated cost 11 s at 256 KB and ~200 s at 1 MiB), and the owner path is
 * reachable from public /blog, the file viewer and federated memories. So the
 * cap is 128 KB, and a document over it is NOT refused: a head of at most
 * OWNER_MD_MAX_INPUT characters is rendered as markdown exactly as before and
 * the WHOLE remainder follows as escaped plain text under a short notice (see
 * ownerMarkdownCut for where the cut lands, and tailHtml for the tail). Nothing
 * is dropped — the head's source plus the tail's text is the entire document.
 * Real content is far below the cap (every stored blog post, KB article and
 * memory is < 60 KB); the file viewer's larger documents are what the tail is
 * for. The head — everything handed to marked — still goes through the same
 * guarded pipeline, and a guard that refuses it (or a parse that throws) answers
 * the escaped text of the document — never "": a public page renders what was
 * written.
 * @param {string} markdown
 * @param {{ storageOrigin?: string|null }} [options] `storageOrigin` overrides
 *   the module-wide storage origin for this call only. The gateway sets that
 *   module-wide value once, with the same origin its CSP `img-src` names
 *   (see setRendererStorageOrigin).
 * @returns {string} Safe HTML
 */
export function renderMarkdown(markdown, options) {
  if (!markdown) return "";
  const opts = options && typeof options === "object" ? options : {};
  const storageOrigin = Object.prototype.hasOwnProperty.call(opts, "storageOrigin")
    ? normalizeOrigin(opts.storageOrigin)
    : rendererStorageOrigin;
  // Normalise line endings FIRST, exactly as marked's Lexer#lex does. marked
  // treats a bare `\r` as a line break, so "x\r" + "1) " x N is N container
  // lines to marked — and must be to the cap below too, not one long line.
  const src = String(markdown).replace(/\r\n?/g, "\n");
  return withImageContext({ policy: "owner", storageOrigin }, () => {
    if (src.length <= OWNER_MD_MAX_INPUT) {
      return sanitizeRendered(renderOwnerHead(src), { imagePolicy: "owner", storageOrigin });
    }
    // Over the cap: the head is the same guarded render, the tail is the plain
    // text this page cannot afford to lex. Both halves meet exactly at `cut`.
    const cut = ownerMarkdownCut(src);
    return sanitizeRendered(renderOwnerHead(src.slice(0, cut)), { imagePolicy: "owner", storageOrigin })
      + tailHtml(src.slice(cut));
  });
}

/**
 * The owner path's markdown half: one guarded parse, or — if the parse still
 * throws — the document as escaped text (see escapedTextHtml). Never more than
 * OWNER_MD_MAX_INPUT characters is handed to it.
 * @param {string} src
 * @returns {string} unsanitized HTML
 */
function renderOwnerHead(src) {
  try {
    // The same guarded pipeline as the bot path — marked's own two lexing
    // phases with the inline guard between them, plus the depth-bounded block
    // lexer — driven with ownerMarked, so the defaults are the owner's (the
    // image renderer leaves a refused image as its escaped alt text) and there
    // is no math extension. ownerMarked carries no hooks, extensions or
    // walkTokens; if one is ever added to it, guardAndParse has to be told
    // (parse's opt.hooks branch is the code that would otherwise run it).
    return guardAndParse(src, ownerMarked);
  } catch {
    // Fail safe, never a 500 and never an empty page: the document as escaped
    // text (see escapedTextHtml — it drops what the author hid, an HTML
    // comment). The caller's sanitizer still runs, so the fallback cannot carry
    // markup either.
    return escapedTextHtml(src);
  }
}

/**
 * The owner path's largest markdown-parsed span, in characters (128 KB).
 *
 * It used to be 1 MiB, which was safe only against memory: marked's block lexer
 * is QUADRATIC on some cheap-looking shapes (`"    x\n>     y\n"` repeated:
 * 11 s at 256 KB, ~200 s at 1 MiB) and this function runs synchronously in a
 * route reachable from public /blog, the file viewer and federated memories.
 * 128 KB bounds that to ~2.8 s on that worst measured shape, and every stored blog
 * post, KB article and memory is under 60 KB, so nothing real is cut. A document
 * over it is not refused — see renderMarkdown: the head is rendered, the rest
 * follows as plain text. Exported so the tests share the number.
 */
export const OWNER_MD_MAX_INPUT = 128 * 1024;

/** The notice that introduces the plain-text tail of a long document. */
const TAIL_NOTICE = '<p class="md-tail-notice">Long document: the rest is shown as plain text.</p>';

/**
 * The plain-text half of a long document: a short notice, then the WHOLE tail in
 * one <pre>, escaped.
 *
 * Appended AFTER sanitizeRendered, which is why it is built here rather than
 * passed through it: nothing in it comes from the author except the text, and
 * that text is escaped by escapeText, so no markup — and no attribute — can
 * survive. Deliberately NOT stripped of HTML comments the way escapedTextHtml
 * is: this is plain text on screen, so what the author wrote is what the reader
 * sees, exactly as in an editor.
 * @param {string} tail
 * @returns {string}
 */
function tailHtml(tail) {
  return TAIL_NOTICE + '<pre class="md-tail">' + escapeText(tail) + "</pre>";
}

/**
 * Where renderMarkdown splits a document longer than OWNER_MD_MAX_INPUT: the end
 * of the last blank line at or before the cap that is NOT inside a fenced code
 * block, else the last newline before the cap, else the cap itself.
 *
 * "\n\n" is a block boundary to marked, so the head usually parses cleanly
 * instead of starting (or ending) mid-paragraph, and a fence is skipped as a cut
 * point so a code block is never split in half by the notice. One linear pass
 * (`indexOf` per line, a fence state machine over 4 characters of each line's
 * start), which is what keeps the split cheap on a 1 MB document.
 *
 * A fence is opened by ``` or ~~~ with at most three spaces of indentation
 * (four would be indented code) and closed by a line of the same character, at
 * least as long, with nothing but spaces after it — CommonMark's rule, which is
 * what marked applies. A BACKTICK opener's info string may not itself contain a
 * backtick, so "```inline``` is how you write it" is a paragraph with inline
 * code, not a fence: read as one it never closes, every later blank line is
 * skipped and the cut collapses to a few characters (the head of a 200 KB
 * document became 7).
 *
 * That state machine is an approximation of marked, so a cut is never allowed to
 * cost the head more than half the cap: when the last usable blank line sits
 * below that (the signature of a misjudged fence) the cut falls on the last
 * LINE BREAK before the cap instead.
 *
 * The cut is never past the cap — renderOwnerHead's promise — and never inside a
 * UTF-16 surrogate pair: a blank line only counts when it ENDS at or before the
 * cap (a run of 7 MB of spaces that starts just under the cap is not a cut
 * point), and the final index steps back one unit when it would split a pair (a
 * single-line document of emoji has no line break at all, and half a pair is
 * not a character).
 * @param {string} src line-ending-normalised document
 * @param {number} [cap]
 * @returns {number} the cut index: head is `src.slice(0, cut)`, tail `src.slice(cut)`
 */
export function ownerMarkdownCut(src, cap = OWNER_MD_MAX_INPUT) {
  const length = String(src).length;
  const limit = Math.min(cap, length);
  let lastBlank = -1;
  /** The open fence: its character and its run length, or null. */
  let fence = null;
  for (let start = 0; start < limit;) {
    const nl = src.indexOf("\n", start);
    const end = nl === -1 ? length : nl;
    const line = src.slice(start, end);
    if (fence) {
      // A closing fence: same character, at least as long, then spaces only.
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
    } else if (/^[ \t]*$/.test(line)) {
      // A blank line: the cut is its end, so the head keeps the "\n\n" that
      // tells marked the block is over. Only one that ENDS at or before the cap
      // is a cut point — a whitespace line that starts just under the cap and
      // runs on for megabytes ends megabytes past it, and the head would then be
      // far over OWNER_MD_MAX_INPUT.
      if (end + 1 <= limit) lastBlank = end + 1;
    } else {
      // A backtick fence's info string may not contain a backtick (CommonMark),
      // so "```inline```" opens nothing. The lookahead is what keeps a
      // misjudged opener from swallowing the document (see above).
      const open = /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})/.exec(line);
      if (open) fence = { char: open[1][0], length: open[1].length };
    }
    if (nl === -1) break;
    start = end + 1;
  }
  // The last line break before the cap; a blank line counted above always has
  // one at lastBlank - 1, so this is never before the blank line's newline.
  const lineBreak = src.lastIndexOf("\n", limit - 1);
  let cut;
  if (lastBlank > 0 && (lastBlank * 2 >= limit || lineBreak + 1 <= lastBlank)) {
    cut = lastBlank;
  } else if (lineBreak >= 0) {
    // No blank line before the cap at all, or only one in the first half of it
    // (a fence that was not a fence): cut on a plain line break, so the head is
    // never collapsed to a few characters.
    cut = lineBreak + 1;
  } else {
    cut = lastBlank > 0 ? lastBlank : limit;
  }
  // The cap is a hard bound (renderOwnerHead hands marked nothing longer), and a
  // cut inside a UTF-16 surrogate pair would cut one character in half: the head
  // would end with a lone high surrogate and the tail begin with its low half
  // (each renders as U+FFFD, and the split is no longer the characters the
  // author wrote). Step back one unit instead, so the halves stay at most one
  // character shorter and still meet on a character boundary.
  const safe = Math.min(cut, limit);
  return safe > 0 && isHighSurrogate(src.charCodeAt(safe - 1)) ? safe - 1 : safe;
}

/** True for the first half of a UTF-16 surrogate pair (U+D800–U+DBFF). */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Drop the author's HTML comments before text is escaped for display: the
 * fallback SHOWS what it is given, so an escaped `<!-- note -->` would put a
 * hidden remark on screen. One linear scan (`indexOf` → `indexOf`, resuming
 * past each match — no regex backtracking on input full of `<!--`), non-greedy
 * like the comment rule, and an unclosed `<!--` is left alone.
 * @param {string} s
 * @returns {string}
 */
function stripHtmlComments(s) {
  if (!s.includes("<!--")) return s;
  const pieces = [];
  let i = 0;
  for (;;) {
    const open = s.indexOf("<!--", i);
    if (open === -1) break;
    const close = s.indexOf("-->", open + 4);
    if (close === -1) break;
    pieces.push(s.slice(i, open));
    i = close + 3;
  }
  pieces.push(s.slice(i));
  return pieces.join("");
}

/**
 * The owner path's fail-safe rendering: the document as escaped text, one <br>
 * per line (what `breaks: true` draws for a plain paragraph), with the author's
 * HTML comments removed first. Everything else — markdown syntax, raw HTML, a
 * link definition's URL — stays visible as the text it literally is.
 * @param {string} src
 * @returns {string}
 */
function escapedTextHtml(src) {
  return "<p>" + escapeText(stripHtmlComments(src)).replace(/\n/g, "<br>") + "</p>";
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
// A SEPARATE Marked instance, so the owner's parser (ownerMarked, and every
// renderMarkdown caller) keeps its dollar signs exactly as before.
//
// Inline `$…$` follows pandoc's tex_math_dollars rule so currency is not
// eaten: the opening `$` must be followed by a non-space, the closing `$`
// preceded by a non-space and NOT followed by a digit ("$5 and $10" and
// "$5-$10" stay text). `\$` stays an escaped dollar.
// ---------------------------------------------------------------------------

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Math bodies are text too — same escaping, under the name the readers below use. */
const escapeMathHtml = escapeText;

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
//
// The inline-lexer cliff (mixed emphasis delimiters, QUADRATIC, ~21 s at the
// cap) is a THIRD, separate cost; it is measured and guarded in
// "THE INLINE-LEXER CLIFF" below, by a linear pre-pass over the same blocks
// that this pipeline already splits.
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
  //
  // An image only survives the shared rule (renderImageToken /
  // isAllowedImageSrc): a bot's markdown is untrusted model output rendered in
  // the OWNER's browser, so any other `<img src>` — `/dashboard/logout`, a
  // `/api/…`, a protocol-relative `//evil.example/x.png` — is a same-origin
  // GET (or a third-party beacon) fired with the viewer's cookies just by
  // reading the reply. A refused image becomes its alt text and nothing else:
  // never a link, so it cannot become a click target either.
  renderer: {
    image(token) {
      if (Array.isArray(token.tokens) && token.tokens.some((t) => t.type === "mathInline")) {
        token.tokens = token.tokens.map((t) => (t.type === "mathInline"
          ? { type: "text", raw: t.raw, text: escapeMathHtml(t.text), escaped: true }
          : t));
      }
      return renderImageToken(token);
    },
  },
});

// ---------------------------------------------------------------------------
// IMAGE RULES — the `<img src>` values the renderer keeps, for both paths.
//
// Both paths render HTML in a BROWSER, so every `<img src>` in the output is a
// request the VIEWER makes, same-origin and carrying the viewer's cookies. A
// reply — or a note, a memory, a blog post, a workspace .md, a KB article —
// containing `![x](/dashboard/logout)` therefore signed the owner out on read;
// `/api/…` and `/dashboard/…` were the same trick against other routes, and
// `//evil.example/x.png` / `https://evil.example/x.png` pinged a third party.
// Bots can write every surface the OWNER renderer draws, so both paths need
// the rule.
//
// ONE predicate, two policies (isAllowedImageSrc):
//   "bot"   `/blog/media/` and nothing else.
//   "owner" `/blog/media/`; a published case-study figure under `/blog/figures/`,
//           a knowledge-base media file under `/kb/media/` and a meta-glasses
//           note photo under `/api/meta-glasses/photo/`, each in the exact shape
//           its read-only route serves (see OWNER_FIGURE_PREFIX,
//           OWNER_KB_MEDIA_PREFIX, OWNER_PHOTO_PREFIX); an absolute http(s) URL
//           whose PATHNAME is one of those same paths (own host written out in
//           full — another host is blocked by the page CSP anyway); a URL on
//           the storage origin (presigned object URLs); and an inline
//           `data:image/(png|jpeg|gif|webp)` (never svg — and a data: URL makes
//           no request at all).
//
// The rule is checked twice, deliberately: at parse time (so a refused image
// leaves its ALT TEXT behind — marked's image renderer) and again in the
// sanitize call's exclusiveFilter, which is what actually decides: a raw HTML
// `<img>` in the markdown never goes through marked's renderer at all.
//
// Crow Artifacts' document blocks (markdownBlocks) keep the unrestricted
// behaviour: their HTML renders inside the sandboxed artifact frame, whose own
// CSP rules images, and their figures are relative paths (`__render/b2.svg`)
// by design.
// ---------------------------------------------------------------------------

/** The only image path a bot reply may use — the public blog media route. */
const BOT_IMAGE_PREFIX = "/blog/media/";
/**
 * A published case-study figure — one of the OWNER path's read-only
 * same-origin paths, and NEVER one a bot reply may use.
 *
 * `bundles/data-dashboard` writes `<img src="/blog/figures/<section>-<hash>.png">`
 * into a post's markdown (buildFigureHtml, server.js), and the read-only route
 * that serves it (servers/gateway/routes/blog-embed-api.js,
 * `GET /blog/figures/:filename`) accepts exactly ONE filename shape:
 * `<digits>-<8..64 lowercase hex>.png`. This is that same regex, so a src that
 * passes here can never 400 there — and nothing else under `/blog/figures/`
 * passes: the character class admits no `/`, `?`, `#`, `%` or `\`, so there is
 * no second segment, no query string and no encoded character.
 */
const OWNER_FIGURE_PREFIX = "/blog/figures/";
const OWNER_FIGURE_NAME = /^\d+-[0-9a-f]{8,64}\.png$/;
/**
 * Knowledge-base media — the images extracted from a guide, which a KB
 * article's markdown refers to as `<img src="/kb/media/<sha1>.jpg" alt="…">`.
 *
 * Served read-only by bundles/knowledge-base/routes/kb-public.js
 * (`GET /kb/media/:filename`): it strips every character outside
 * `[a-zA-Z0-9._-]` from the name and streams the file out of
 * `<CROW_DATA_DIR>/kb-media`, so a GET there can only ever return a stored
 * file — never a state change.
 *
 * The name pattern is deliberately narrower than the route's: one segment with
 * a raster extension the route names a mime for (never svg — an svg is a
 * document, the same reason INLINE_IMAGE refuses it), and no `.` of its own, so
 * `..`, a query string, a fragment and a second segment can never match.
 */
const OWNER_KB_MEDIA_PREFIX = "/kb/media/";
const OWNER_KB_MEDIA_NAME = /^[A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/;
/**
 * A meta-glasses note photo on disk — the src remintPhotoRefs writes in place
 * of a `photo://<id>` sentinel when the object-store upload is unavailable
 * (bundles/meta-glasses/panel/routes.js).
 *
 * Served read-only by `GET /api/meta-glasses/photo/:name`, which sanitizes the
 * name to `[\w.-]` and `sendFile`s it from the bundle's photo directory (404
 * when absent). This is that same character class — the ONE thing the route
 * does not strip is `..`, which `join(_photoDir, "..")` resolves out of the
 * directory, so a `..` is refused here explicitly.
 */
const OWNER_PHOTO_PREFIX = "/api/meta-glasses/photo/";
const OWNER_PHOTO_NAME = /^[\w.-]+$/;
/** The Turbo opt-outs every bot link carries (see sanitizeRendered). */
const BOT_LINK_ATTRS = ["data-turbo-prefetch", "data-turbo"];
/** The owner's links opt out of Turbo's prefetch only — Drive stays on. */
const OWNER_LINK_ATTRS = ["data-turbo-prefetch"];
/** Every bot image src is resolved against this fixed origin (never the request's). */
const BOT_IMAGE_ORIGIN = "http://crow.invalid";
/** An inline image: no request at all, and the page CSP allows data:. Never svg. */
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

/**
 * The instance's storage origin (where presigned object URLs point), or null.
 * Set by the gateway when it first resolves the origin its CSP `img-src` names
 * (servers/gateway/index.js, resolveCspStorageOrigin), so the two cannot drift.
 *
 * Module state rather than an import: servers/storage/s3-client.js pulls the
 * MinIO SDK and the sealed-secret opener into every importer (bundles, panels,
 * CLI) and only learns its config at boot — not a dependency a markdown
 * renderer should carry.
 */
let rendererStorageOrigin = null;

/**
 * The policy in force for the render happening NOW. marked's image renderer
 * runs inside the parse call, so it reads the policy from here; a render is
 * synchronous, so nesting cannot interleave.
 */
let imageContext = { policy: "none", storageOrigin: null };

/** `http://host:port` / `https://host:port` as the URL parser normalizes it, or null. */
function normalizeOrigin(origin) {
  if (typeof origin !== "string" || !origin) return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
}

/**
 * Point the owner renderer at the instance's storage origin, so a presigned
 * object URL survives. Called by the gateway with the value it resolves for the
 * CSP; null (or an unparseable value) clears it.
 * @param {string|null} origin
 */
export function setRendererStorageOrigin(origin) {
  rendererStorageOrigin = normalizeOrigin(origin);
}

/** Run a synchronous render with `context` in force for its image decisions. */
function withImageContext(context, fn) {
  const previous = imageContext;
  imageContext = context;
  try { return fn(); } finally { imageContext = previous; }
}

/**
 * True when `path` is a same-origin absolute path under `/blog/media/` and
 * nothing else: no backslash (a browser may read it as a slash), no `//` after
 * the leading slash (protocol-relative), and nothing that resolves out of the
 * prefix.
 *
 * A raw `..` is NOT refused as such. `/blog/media/a/../b` is allowed: the URL
 * parser's dot-segment walk normalizes it to `/blog/media/b` before `pathname`
 * is read, and that normalized path is exactly what the browser will request.
 * What is refused is a `..` that RESOLVES out of the prefix
 * (`/blog/media/../dashboard/logout` → `/dashboard/logout`) or one that
 * survives normalization. Absolute URLs (`http(s)://…`, `//host/…`),
 * `javascript:`, `data:` and bare relative paths all fail the prefix test at
 * once.
 *
 * Percent-encoded separators/dots are refused outright, case-insensitively:
 * `%2e` (a dot the URL parser decodes before its own dot-segment walk —
 * `/blog/media/%2e%2e/dashboard/logout` resolves to `/dashboard/logout`),
 * `%2f` and `%5c` (slashes a downstream layer may decode after our check).
 * Refusing them by raw source text keeps the verdict independent of the order
 * in which any later parser normalizes or decodes.
 *
 * Used for a same-origin path AND for the pathname of an absolute URL, so both
 * spellings of the media route get exactly the same verdict.
 * @param {string} path
 * @returns {boolean}
 */
function isMediaPath(path) {
  if (typeof path !== "string" || !path.startsWith(BOT_IMAGE_PREFIX)) return false;
  if (path.includes("\\") || path.slice(1).includes("//")) return false;
  if (/%2e|%2f|%5c/i.test(path)) return false;
  let url;
  try { url = new URL(path, BOT_IMAGE_ORIGIN); } catch { return false; }
  if (url.origin !== BOT_IMAGE_ORIGIN) return false;
  return url.pathname.startsWith(BOT_IMAGE_PREFIX) && !url.pathname.includes("..");
}

/**
 * True when `src` is a same-origin absolute path under `/blog/media/` (see
 * isMediaPath for the exact rule). The bot path keeps nothing else.
 * @param {string} src
 * @returns {boolean}
 */
export function isAllowedBotImageSrc(src) {
  return isMediaPath(src);
}

/**
 * True when `path` is a same-origin absolute path to a published case-study
 * figure and nothing else — `/blog/figures/` plus one filename matching the
 * route's own regex (OWNER_FIGURE_NAME).
 * @param {string} path
 * @returns {boolean}
 */
function isOwnerFigurePath(path) {
  if (typeof path !== "string" || !path.startsWith(OWNER_FIGURE_PREFIX)) return false;
  return OWNER_FIGURE_NAME.test(path.slice(OWNER_FIGURE_PREFIX.length));
}

/**
 * True when `path` is a knowledge-base media file and nothing else —
 * `/kb/media/` plus one filename matching OWNER_KB_MEDIA_NAME.
 * @param {string} path
 * @returns {boolean}
 */
function isOwnerKbMediaPath(path) {
  if (typeof path !== "string" || !path.startsWith(OWNER_KB_MEDIA_PREFIX)) return false;
  return OWNER_KB_MEDIA_NAME.test(path.slice(OWNER_KB_MEDIA_PREFIX.length));
}

/**
 * True when `path` is a meta-glasses note photo on disk and nothing else —
 * `/api/meta-glasses/photo/` plus one name matching OWNER_PHOTO_NAME, with no
 * `..` anywhere in it (a dot segment the read-only route would resolve out of
 * the photo directory) and no leading `.` (`.` is the directory itself, and a
 * dotfile is nothing the upload route ever makes — the route refuses both).
 * @param {string} path
 * @returns {boolean}
 */
function isOwnerPhotoPath(path) {
  if (typeof path !== "string" || !path.startsWith(OWNER_PHOTO_PREFIX)) return false;
  const name = path.slice(OWNER_PHOTO_PREFIX.length);
  if (name.includes("..") || name.startsWith(".")) return false;
  return OWNER_PHOTO_NAME.test(name);
}

/**
 * The one image predicate. `src` is judged AFTER the `storage:` rewrite, i.e.
 * it is exactly the string the browser would request.
 * @param {string} src
 * @param {"none"|"bot"|"owner"} policy
 * @param {string|null} storageOrigin
 * @returns {boolean}
 */
function isAllowedImageSrc(src, policy, storageOrigin) {
  if (typeof src !== "string" || !src) return false;
  // (a) `/blog/media/…` — the only src a bot reply may use, and the owner's own
  // media route.
  if (isAllowedBotImageSrc(src)) return true;
  if (policy !== "owner") return false;
  // (a2) a read-only owner route, as a same-origin path: a published case-study
  // figure, a KB media file, a meta-glasses note photo on disk.
  if (isOwnerFigurePath(src) || isOwnerKbMediaPath(src) || isOwnerPhotoPath(src)) return true;
  // (d) an inline data: image — no request is made at all.
  if (INLINE_IMAGE.test(src)) return true;
  let url;
  try { url = new URL(src); } catch { return false; } // relative srcs were judged by (a)/(a2)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // (c) the storage origin (presigned object URLs): exact scheme, host and port.
  if (storageOrigin && url.origin === storageOrigin) return true;
  // (b) the same routes written out in full: only the PATHNAME is judged, by the
  // same rules as (a) — a `..` that resolves out of the prefix, an encoded
  // separator or a second `//` is refused exactly as it is there. The pathname
  // of an owner-only path (a2) must ALSO be the whole URL:
  // `/blog/figures/x.png?a=1` is not the shape the route serves, so it keeps
  // its alt text — and the same for `/kb/media/x.jpg?…` and
  // `/api/meta-glasses/photo/x.jpg?…`, whose routes ignore a query too but
  // whose name shapes are matched exactly. (The media route has no such rule —
  // a cache-busting query is allowed there, isMediaPath judges the pathname.)
  // Another host reaching this point is a third-party request the page CSP
  // blocks anyway (`img-src 'self' data: blob: <storage>`).
  if (isOwnerFigurePath(url.pathname) || isOwnerKbMediaPath(url.pathname) || isOwnerPhotoPath(url.pathname)) {
    return !url.search && !url.hash;
  }
  return isMediaPath(url.pathname);
}

/**
 * True when an `<input>` is a GFM task-list checkbox — the ONLY `<input>` the
 * shared sanitizer keeps on either rendered path.
 *
 * An `<input>` is never markdown: it is the owner's or a bot's raw HTML, and
 * `type="image" src="…"` is a GET in the viewer's browser (the same trick the
 * image rule above stops), while a text/submit input is a form control in the
 * middle of the owner's page. The type test matches a browser's: ASCII
 * case-insensitive, and an absent or invalid type reads as `text` — dropped.
 * @param {Record<string,string>|undefined} attribs
 * @returns {boolean}
 */
function isCheckboxInput(attribs) {
  const type = attribs && attribs.type;
  return typeof type === "string" && type.toLowerCase() === "checkbox";
}

// ---------------------------------------------------------------------------
// THE BLOCK-NESTING CLIFF — a depth counter inside marked's block lexer
//
// marked's BLOCK lexer recurses once per container nesting level, and one line
// can open tens of thousands of levels by itself: `>>>>…`, `- - - …`,
// `1) 1) 1) …`, and the mixed `- > 1. - > 1. …` are all nested containers, so
// 64 KB of a two-character run is ~32,000 levels and every level is paid with
// the rest of the input in hand. Measured on this tree (marked 17.0.4 + the math
// extension below; CPU ms for one 64 KB - 1 line, with NOTHING guarding it):
//
//   unit (one 64 KB - 1 line)   renderBotMarkdown   renderMarkdown (owner)
//   "1) "                        964†               1356†
//   "1. "                       1332†               1325†
//   "- 1) "                      814†               1374†
//   "> 1) "                      722†                779†
//   ">"                          158†                164†
//   "+ "                        1294†               1321†
//   "- " / "* "                    2                0
//   "- > 1. "                    994†                975†
//   indentation staircase,
//   each line 2 columns deeper     40                 30
//   indentation only, no markers    2                  2
//
//   † ended in "RangeError: Maximum call stack size exceeded". The bot path's
//     try/catch already turned that into "" — the callers' plain-text path — but
//     only AFTER 0.7-1.4 s of blocked event loop; the owner path had no catch at
//     all, so a RangeError escaped renderMarkdown into a route. "- " and "* "
//     never nested in the first place: a `- - -` / `* * *` run is a thematic
//     break under marked's hr rule (hence the 2 ms), which is why only "+ " of
//     the three bullet characters was a cliff.
//
// The bound is enforced WHERE THE RECURSION HAPPENS, not by rewriting the
// document. marked's block lexer recurses through exactly one method —
// `blockTokens(src, tokens, lastParagraphClipped)` — which every container
// tokenizer calls for its own content: the blockquote tokenizer calls
// `this.lexer.blockTokens(content, tokens, true)` and the list tokenizer
// `this.lexer.blockTokens(item.text, [])` (verified in node_modules/marked,
// v17.0.4), so one nesting level is exactly one nested call. boundedLexer
// (below) wraps that method on the single Lexer one parse creates, with a
// counter that lives for the duration of that parse: while a container level is
// open the counter is up; if it is already at MD_MAX_NEST the content is not
// lexed as blocks at all — it becomes ONE paragraph token holding the whole
// remainder as plain text, which marked renders (escaped) as text — and the
// counter comes back down in a `finally`, so even a throwing tokenizer cannot
// leak a level.
//
// There is a SECOND way down, and blockTokens alone does not see it: marked
// 17.0.4's blockquote tokenizer, when the last token inside a quote is itself a
// blockquote or a list and lazy continuation lines remain, re-lexes by calling
// `this.blockquote(f)` / `this.list(f)` straight on the TOKENIZER (never
// through the lexer). On that path `"> ".repeat(40) + "x\nlazy"` opened 40
// levels instead of 16, and 64 KB of `">"` + `"x\nlazy"` cost ~6 s on both
// paths (26 s at 256 KB on the owner path) because each step re-read the rest
// of the source at the SAME depth value. boundedLexer therefore also wraps
// those two tokenizer methods, and ONE container token is ONE level no matter
// which way it was reached.
//
// Nothing rewrites the source, which is what keeps CODE intact: a fence, an
// indented code block, a raw <pre>, a `$$` math block and a deeply indented YAML
// block are bytes the tokenizers READ, never a document this module rebuilds,
// so no backslash can appear inside them (`- name:` at 32 spaces stays
// `- name:`, not `\- name`). Line endings cannot bypass the bound either: the
// counter sits inside the lexer marked has already normalised (`\r\n` and a
// bare `\r` → `\n` in Lexer#lex), and renderMarkdown normalises the same way
// before it looks at the input at all.
//
// MD_MAX_NEST = 16 counts container LEVELS around a block: ordinary content
// sits at 2-4 (a list in a quote in a list), 8-10 is about as deep as
// hand-written Markdown stays readable, and a 64 KB marker run wants ~32,000.
// Past the limit the remainder is still SHOWN — as its own escaped text, so
// nothing is dropped. The digests in tests/bot-markdown-quadratic.test.js
// (ordinary content) and the pinned digests in tests/md-nesting-depth.test.js
// (lists in quotes in lists, code in lists, 8 levels deep) prove that content at
// or under the limit is byte-identical to plain marked.parse. Measured with the
// counter in place: the worst single 64 KB marker shape is 70 ms (`> 1) `) and
// the worst of 30 seeded 64 KB marker mixes is 128 ms across both paths, and
// nothing throws. With a LAZY continuation line appended (the re-lex path — the
// comment on boundedLexer spells it out) the worst 64 KB shape is 38 ms (`> - `
// followed by lazy chunks) and 256 KB of `> ` on the owner path is 120 ms, where
// both used to be seconds.
// ---------------------------------------------------------------------------

/**
 * Deepest container nesting (blockquotes + list levels) a document may open
 * before the remainder of that content is shown as plain text instead of being
 * lexed into more containers (see boundedLexer). 16 is far above real content
 * (2-4 levels; ~8-10 is the practical ceiling for readable Markdown) and far
 * below the ~32,000 levels a 64 KB marker run otherwise opens. Exported so the
 * tests can pin the bound they exercise.
 */
export const MD_MAX_NEST = 16;

/**
 * The floor of the re-lex path's budget of RE-READ CHARACTERS (see
 * boundedLexer): 1 MiB, or 8 × the document's length, whichever is larger.
 * The floor is what keeps ordinary content out of the budget — a quote whose
 * list carries a lazy continuation line re-reads a few KB per item, and a
 * document under 128 KB is judged on the floor alone, never on its own length.
 */
const RELEX_BUDGET_FLOOR = 1024 * 1024;

/** The document-length factor of that budget: ~8 full re-reads of the input. */
const RELEX_BUDGET_FACTOR = 8;

/**
 * The token a container becomes once the nesting limit is reached: ONE
 * paragraph whose inline tokens are already filled in with a single text token,
 * so marked neither splits it into blocks nor inline-lexes it (a token that
 * already has `tokens` is rendered as they are). `raw` is the whole source the
 * caller was lexing, which is what makes the lexer ADVANCE (blockTokens does
 * `src.substring(token.raw.length)`) and what keeps the tokenizer re-lex path
 * (below) from re-parsing a tail it thinks was left over). A text token's
 * `text` is character data — marked escapes it in parseInline — so no markup,
 * and no backslash, is ever added to the author's words.
 * @param {string} src
 * @returns {{type: string, raw: string, text: string, tokens: object[]}}
 */
function flatTextToken(src) {
  return {
    type: "paragraph",
    raw: src,
    text: src,
    tokens: [{ type: "text", raw: src, text: src }],
  };
}

/**
 * The container tokenizers that can be re-entered directly (see 2. below):
 * marked 17.0.4 has no other `this.<tokenizer>(` call in the block phase.
 */
const RELEX_TOKENIZERS = ["blockquote", "list"];

/**
 * A `Lexer` that refuses to lex block content more than MD_MAX_NEST container
 * levels deep (see "THE BLOCK-NESTING CLIFF" above).
 *
 * ONLY the Lexer one parse creates is wrapped — never marked's prototype, so
 * every other user of marked (markdownBlocks for Crow Artifacts, a test's own
 * instance, anything else in the gateway) keeps the unguarded behavior it had.
 * There are TWO ways down, and both are counted, sharing ONE counter (one
 * container token = one level, whichever way it was reached):
 *
 *  1. `blockTokens(src, tokens, lastParagraphClipped)` — what every container
 *     tokenizer calls for its own content (`this.lexer.blockTokens`), and what
 *     marked's own `lex()` calls (`this.blockTokens`). Both look the method up
 *     on the INSTANCE, so the own property installed here shadows the
 *     prototype method for exactly this lexer, and every recursive call goes
 *     through the counter.
 *
 *  2. `lexer.tokenizer.blockquote` / `lexer.tokenizer.list` — marked 17.0.4's
 *     blockquote tokenizer has a SECOND way down that never passes through the
 *     lexer: when the LAST token inside a quote is itself a blockquote (or a
 *     list) and lazy continuation lines remain, it re-lexes by calling
 *     `this.blockquote(f)` / `this.list(f)` on the TOKENIZER, with the last
 *     token's raw plus those lines as the source. Counted only on blockTokens,
 *     every step of that chain ran at the depth it started from, so a chain of
 *     them was unbounded and O(n) steps of O(n) work: `"> ".repeat(40) + "x"`
 *     stopped at 16 levels, `"> ".repeat(40) + "x\nlazy"` opened 40, and 64 KB
 *     of `">"` + `"x\nlazy"` spent ~6 s on either path. Own properties on the
 *     Tokenizer INSTANCE, never its prototype.
 *
 * DEPTH is not the whole story on that second path: each re-lex step re-reads
 * everything it has left, so the blockquote tokenizer's chunk loop (which
 * re-lexes the growing last token once per chunk, all at ONE level) is O(n²):
 * `"> - x\nlazy\n"` repeated to 64 KB is ~5,300 steps and 1.2 s with only the
 * depth counter in place. So the re-lex path also carries a per-PARSE budget of
 * RE-READ CHARACTERS, `max(1 MiB, 8 × the document length)` (computed here from
 * the length the caller passes in): while the sum of the `src` lengths handed to
 * this path stays under it nothing changes; past it, the rest of that frame is
 * shown as text. A per-parse BYTE budget, not a per-frame step count, because a
 * step count cannot tell a flood from ordinary content: one quote whose list has
 * 17 items with a lazy continuation line each is ~17 steps of perfectly normal
 * Markdown, and a step cap turned the tail of that list into literal text.
 * Bytes measure the work that actually hurt (every step re-reads the rest of the
 * source), and the 8× factor plus the 1 MiB floor leave a real document several
 * orders of magnitude of room.
 *
 * Over the limit neither wrapper lexes anything: it hands back the source as
 * ONE flat text token (flatTextToken above). The tokenizer wrappers must return
 * a real token, not `undefined` — the re-lex path reads `.raw` to splice the
 * parent and to work out what is left to process — and a token whose raw is the
 * whole source it was given is what keeps that path advancing instead of
 * looping.
 *
 * The options are COPIED: marked's Lexer constructor caches a Tokenizer on the
 * options object it is given (`options.tokenizer = new Tokenizer()`) and rebinds
 * `tokenizer.lexer`, so passing an instance's shared defaults would let two
 * parses fight over one tokenizer. That per-lexer Tokenizer is also what makes
 * the own properties below safe: neither Marked instance in this module sets
 * `defaults.tokenizer`, so `new Tokenizer()` runs once per Lexer. A future
 * `use({ tokenizer })` on either instance would make ONE Tokenizer shared by
 * every parse and carry these wrappers (and this parse's counters) into them.
 * @param {object} options a Marked instance's defaults
 * @param {number} inputLength the document's length, which sizes the re-lex
 *   path's byte budget (see above)
 * @returns {Lexer}
 */
function boundedLexer(options, inputLength = 0) {
  const lexer = new Lexer({ ...options });
  /** Container levels open right now (blockquotes + list levels). */
  let depth = 0;
  /** `blockTokens` frames on the stack — used to tell the two kinds of
   *  tokenizer call apart (see the wrapper below). */
  let lexFrames = 0;
  /** One entry per open container tokenizer frame: the `lexFrames` count when it
   *  was entered (`mark`), so a call made straight from that frame's tokenizer
   *  body can be told apart from the block lexer's. */
  const frames = [];
  /** The characters this parse may re-read through the re-lex path: 8 × the
   *  document, never less than 1 MiB (see the comment above). */
  const relexBudget = Math.max(RELEX_BUDGET_FLOOR, RELEX_BUDGET_FACTOR * inputLength);
  /** Characters re-read through that path so far in this parse. */
  let relexBytes = 0;

  // 2. The re-lex path: counted here, because a container token opened by a
  //    direct `this.blockquote(f)` / `this.list(f)` never reaches blockTokens.
  const tokenizer = lexer.tokenizer;
  for (const name of RELEX_TOKENIZERS) {
    const original = tokenizer[name];
    tokenizer[name] = function (src) {
      // Is this the block lexer calling (the ordinary path) or another
      // tokenizer re-lexing (marked's `this.blockquote(f)` / `this.list(f)`)?
      // Only a `blockTokens` frame started AFTER the innermost tokenizer frame
      // means the block lexer is the caller — and the level that call opens is
      // already counted by the frame that blockTokens belongs to. A call made
      // straight from a tokenizer body is the re-lex, and IT needs counting.
      const frame = frames.length ? frames[frames.length - 1] : null;
      // Only the re-lex path is charged against the budget: the block lexer's
      // own calls re-read their source too, and charging those would spend it
      // on ordinary lexing instead of on the O(n²) chunk loop it guards.
      if (frame && lexFrames === frame.mark
        && (relexBytes += src.length) > relexBudget) {
        return flatTextToken(src);
      }
      if (depth >= MD_MAX_NEST) return flatTextToken(src);
      depth++;
      frames.push({ mark: lexFrames });
      try {
        return original.call(this, src);
      } finally {
        frames.pop();
        depth--;
      }
    };
  }

  // 1. The lexer path. This one only REFUSES: the level its container opens is
  //    counted by the wrapper above, so incrementing here as well would charge
  //    every blockquote and list twice.
  const blockTokens = lexer.blockTokens;
  lexer.blockTokens = function (src, tokens, lastParagraphClipped) {
    if (depth >= MD_MAX_NEST) {
      const out = tokens || [];
      out.push(flatTextToken(src));
      return out;
    }
    // `lastParagraphClipped` is forwarded as given: marked's own default
    // (`false`) applies when it is undefined, and its blockquote tokenizer
    // passes `true`.
    lexFrames++;
    try {
      return blockTokens.call(this, src, tokens || [], lastParagraphClipped);
    } finally {
      lexFrames--;
    }
  };
  return lexer;
}

// ---------------------------------------------------------------------------
// THE INLINE-LEXER CLIFF — a linear pre-pass guard
//
// marked's inline lexer is QUADRATIC on mixed emphasis delimiters inside ONE
// inline block (a paragraph, a list item, a heading, a table cell). Measured
// on this tree (marked 17.0.4 + the math extension above; CPU ms, one
// paragraph, before this guard existed):
//
//   one paragraph of…     4 KB    8 KB     (~4x per doubling, so ≈21 s of
//   "*a_"                 169     349     blocked event loop at 64 KB: the
//   "_*a"                 130     376     measured cliff in the report)
//   "**a_"                117     418
//   "**_a"                 64     213
//
// …while prose, "~a", "[a](", backtick runs, "<a" and fenced code stay linear
// (5-25 ms at 8 KB) — with one exception, a run of `http`-like words, which is
// the SECOND cliff in this lexer and is covered below.
//
// The cost lives in ONE inline block because marked retries its emphasis and
// link tokenizers at every delimiter position and an attempt can scan the
// rest of that block: cost ≈ c·d² for d delimiters, with c ≈ 12–15 ns per
// pair off the numbers above (349 ms at 5461 delimiters → 11.7 ns;
// 418 ms at 5461 → 14.0 ns); the worst shapes measured since — a block of
// ~1,000 `_` separated by `$&/!{` filler — cost 55–67 ns per pair. Delimiter
// COUNT per block is therefore the quantity to bound, and it can be counted
// in one linear pass.
//
// So EVERY render — the bot path (renderBotMarkdown) and the owner path
// (renderMarkdown, i.e. every /blog, /kb, memory, file-view and meta-glasses
// page) — runs marked's own two phases (block tokens, then inline tokens — the
// same split Lexer#lex does) with a linear scan between them: an inline block
// that is over budget keeps its place and its container (a <p> stays a <p>, a
// <td> a <td>) but its text is escaped instead of inline-lexed. The pre-pass is
// linear, so there is no fast path to preserve: the digest tests pin the
// guarded path byte-identical to plain marked.parse for ordinary content (a
// normal ~19 KB reply, a delimiter-dense but legitimate document, a ~24 KB
// blog post with figures and tables), and routing everything through ONE path
// is what puts a CRLF reply, a definition flood and a delimiter flood on the
// same, guarded, code.
//
// The guard is shared but the PARSER is not: guardAndParse is handed the Marked
// instance to drive (botMarked: math extensions + the bot image renderer;
// ownerMarked: no math, the owner's image rule and link opt-out), so each path
// keeps its own defaults and its own renderer. The budgets below are per
// DOCUMENT and shared, because the thing they bound — marked's inline lexer —
// is the same code in both. That is what lets a 128 KB owner document (the
// OWNER_MD_MAX_INPUT cap, 2x the bot cap) take the same bound: see "AT THE
// OWNER CAP" below.
//
// Three budgets, so neither one huge block, nor many medium ones, nor a flood
// of link definitions can add up:
//   - BOT_MD_BLOCK_DELIMS, one inline block: past it that block is shown as
//     escaped text. Lexed instead, that block alone would cost c·d² —
//     ~1024²·15 ns ≈ 16 ms on the shapes at the top of this comment, ~4x
//     that on the 55–67 ns/pair shapes found since, and a single block
//     anywhere near the 64 KB input cap is minutes of blocked event loop (the
//     cliff in the report).
//   - BOT_MD_SQ_BUDGET, Σd² over the blocks still formatted: the worst a
//     document can spend inside marked's inline lexer. 4e6 ÷ 1000² = 4 blocks
//     of ~1,000 delimiters each, ~220–270 ms at the 55–67 ns per pair measured
//     on exactly that shape (8 blocks of ~1,000 `_` with `$&/!{` filler, i.e.
//     the old 8e6 budget, took 539 ms — which is why it was halved; the old
//     comment's "32 blocks" was arithmetic, not a measurement). A legit
//     document is orders of magnitude below it — a 200-delimiter paragraph
//     costs 4e4 of it, and a 19 KB reply with a few dozen emphasis spans costs
//     1e5 — so only delimiter-dense input, i.e. the attack, ever runs out.
//     The url email scan (the second cliff, below) is paid from this SAME pool,
//     so a document cannot spend 4e6 on delimiters and another 4e6 on scans —
//     and so is the email autolink's run scan (the third, emailRunScan), for
//     the same reason.
//   - BOT_MD_MAX_LINK_DEFS, link definitions in one document: marked's
//     inlineTokens rebuilds `Object.keys(this.tokens.links)` and scans it on
//     EVERY inline block, so thousands of `[N]:x` definitions make every
//     paragraph O(definitions) — measured 2.2 s for ~39 KB of definitions plus
//     5,000 tiny `*a*` paragraphs. Past this many the extra definitions are
//     dropped (insertion order kept; a link to a dropped one renders as its
//     own text).
//
// …plus the email autolink's run scan (emailRunScan, below), whose cost is paid
// from that same pool, and a run-length cap on email-local-part characters that
// FLATTENS a block outright — it can only flatten, never admit one.
//
// AT THE OWNER CAP: 1 MiB THEN, 128 KB NOW. The budgets are per document, so
// they bound marked's inline lexer at the owner cap exactly as they do at
// 64 KB — that is the point of the shape, and it is why the same thresholds
// were kept for the owner path instead of being scaled down for it.
// OWNER_MD_MAX_INPUT is 128 KB now (the long-document split: the head is
// parsed, the remainder is plain text), so only that much of any document ever
// reaches the inline lexer. The numbers below are HISTORICAL — they were
// measured at the EARLIER 1 MiB cap, on the owner path at 1 MiB - 1 chars,
// whole renderMarkdown call, sanitizer included, CPU ms (worst single render
// per shape; the "before" column is the same input through the pre-guard owner
// path). They are kept because they are the evidence for the thresholds above;
// the parsed span is 128 KB now and the same shapes cost a fraction of them:
//
//   input shape                        before            with the guard
//   `_a` repeated                      ~460 s†               31
//   `[a](` repeated                    ~184 s†               18
//   `*a` repeated                      ~136 s†               25
//   `*a_` / `**a_` repeated            minutes†            12–15
//   `HTTP` repeated (url email scan)     330 s               28
//   `1) ` / `> 1) ` marker run          341 / 368          448 / 464
//   ref-definition flood, ~800 KB
//   of definitions + 50k paragraphs    >10 min‡             728
//   long normal blog post (2k blocks)     341                371
//   ~500k one-word paragraphs             890               1036§
//
//   † extrapolated from the 64 KB measurements at the top of this section (a
//     quadratic shape at 16x the input is ~256x the time); not run to
//     completion.
//   ‡ the 1 MiB flood never finished: marked's inlineTokens scans every link
//     definition once per inline block, and there was no cap on the owner path.
//   § NOT a cliff and not something these budgets govern: a document made of
//     half a million blocks costs marked's per-block overhead plus sanitizing a
//     3 MB output, linearly. The pre-change renderer measured 890 ms on the
//     same input, so the guard's linear pre-pass adds ~15%; the bound in the
//     test for this shape is a regression tripwire, not the 1 s the cliffs are
//     held to.
//
// Worst measured after the guard, across the shapes above plus 30 seeded
// 256 KB delimiter soups: 123 ms at 64 KB, 728 ms at 1 MiB - 1 (both the
// definition flood, and 1 MiB was the owner cap then), 114 ms for the soups.
// tests/owner-markdown-guard.test.js asserts < 1000 ms for every shape at both
// sizes and records the worst render of each test as its diagnostic.
//
// A second quadratic in this lexer, on the SAME input, is marked's GFM url
// EMAIL alternative — reached once per "protocol word" the text rule stops at,
// scanning the rest of the word run and failing. It is measured in the same
// currency, paid from the same document budget and covered by the same
// pre-pass (see urlScanCost below): 543 ms at the bot cap, 330 s at the owner
// cap unguarded, ~30 ms guarded at either. The old footnote here called this
// "bounded but NOT covered by these budgets (0.5 s at the cap), recorded and
// left unguarded" — 0.5 s was the bot path's cap; the owner path could then
// parse 1 MiB, which is what made it worth closing.
//
// A THIRD quadratic in the same lexer, on the SAME input: marked's text rule
// also ends a token at EVERY position of a run of
// `[A-Za-z0-9.!#$%&'*+/=?_`{|}~-]` that `@` follows, and at each of those stops
// the url tokenizer retries its email alternative — `^[A-Za-z0-9._+-]+@…`,
// which consumes the rest of the run looking for the `@` and then walks the
// domain — so the work is Σ(run length) per run, quadratic in it. No protocol
// word is involved, so urlScanCost (which charges protocol-word stops only)
// sees NOTHING while marked does all of it: `a…@a…` measured 1.8 s for 64 KB on
// this tree (and would be minutes at the owner cap), and `a` runs with an `@`
// every 4,096 characters measured 415 ms at 64 KB.
//
// So it is CHARGED, like the other two: emailRunScan (below) returns what it
// observes — Σ(run²) over EVERY run that precedes an `@`, plus run × domain per
// `@` (each stop in that run walks the domain), in the same "attempts"
// currency as d² and urlScanCost — and guardAndParse bills it to the same
// per-document pool (cost = d² + urlScanCost + emailRunCost). A per-run
// length cap alone was not enough: a run JUST UNDER the cap is admitted, and
// its (cap-1)²-ish scan at EVERY `@` is quadratic a whole document long while
// no single run ever trips the cap — an `@` every 128 or every 256 characters
// adds up across a large document. With the cost billed, those shapes run the budget out (and flatten
// like any other dense block) at both caps; one huge run is caught either way,
// since its own cost alone is far over the budget.
//
// The per-run caps stay, as an EXTRA flatten trigger (and as the thing that
// keeps the cost arithmetic small): a block with an `@` preceded by a run
// longer than MD_EMAIL_RUN_MAX (256) characters, a domain run longer than the
// same, or ANY single run of those characters longer than
// MD_EMAIL_RUN_HARD_MAX (4,096 — the `HTTP` shape, where every fourth character
// is a protocol-word stop) is flattened exactly like a delimiter-dense block
// (see emailRunScan). All three numbers sit far above anything prose contains —
// one address is two runs of a few characters (a few dozen attempts of cost),
// and the 405-address contacts document below costs ~2e4 of the 4e6 budget, so
// it keeps its digest and its 405 autolinks — and the scan is one linear pass
// per block. Guarded, the four shapes above measure 2–21 ms at 64 KB and
// 28–37 ms at 1 MiB - 1 on the owner path (9 ms worst on the bot path); the
// under-the-cap run shapes now flatten at both caps instead of adding up —
// measured 1 ms at the bot cap and 15–17 ms at 1 MiB - 1 on the owner path,
// against ~790 / ~585 ms with the cost charged nowhere. Every one of them is held
// to the 500 ms bounds in tests/owner-markdown-guard.test.js and
// tests/bot-markdown-quadratic.test.js. The hard cap is the one trigger
// ordinary content can hit: an unbroken token of 4,096+ characters — a base64
// `data:` payload, a very long hash — is shown as escaped text instead of being
// parsed. That is the cost of not re-deriving marked's stop positions, and a
// markdown IMAGE normally names a URL.
//
// With the budgets in place, every adversarial unit x container shape at the
// cap, the medium-block case, the `_`+filler worst shape, the definitions
// flood and 50 random 64 KB delimiter soups all measured about 300 ms of CPU
// worst case (304 ms measured on 8 blocks of ~1,000 `*` each followed by
// fourteen `a\n` lines; 253 ms for the `_`+filler shape, 133 ms for a unit x
// shape, 116 ms for the definitions flood; tests/bot-markdown-quadratic.test.js
// pins the bounds and records the worst render in a diagnostic).
//
// One shape was still slow BEFORE any of these budgets could apply: deeply nested
// list/quote markers (e.g. `1) ` repeated) cost ~1.5 s inside marked's BLOCK
// lexer, which runs first. That is the block-nesting cliff, and it is guarded
// separately — by a depth counter INSIDE that lexer, applied to both renderers
// and running before any of this — see "THE BLOCK-NESTING CLIFF" above.
// ---------------------------------------------------------------------------

/** The characters marked's inline lexer reacts to: emphasis (`*`, `_`),
 *  strikethrough (`~`), links and images (`[`, `]`, `(`), code spans
 *  (backtick) and raw HTML (`<`). Counting a superset is the point — this is
 *  a cheap linear proxy for inline-lexer work, not a markdown parser. */
function countDelims(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    switch (s.charCodeAt(i)) {
      case 42: case 40: case 60: case 91: case 93: case 95: case 96: case 126: // * ( < [ ] _ ` ~
        n++;
    }
  }
  return n;
}

/**
 * The SECOND quadratic cost inside marked's inline lexer, and its proxy: the
 * GFM url tokenizer's EMAIL alternative.
 *
 * marked's inline text rule stops at a protocol word — a bug in marked 17.0.4's
 * `_caseInsensitiveProtocol` (an ungrouped alternation, so the breaks-mode text
 * rule reads `…|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|…` and `http`/`https`
 * alone ends the text token) — and at `www.`. At EVERY such stop the main
 * inline loop retries `url()`, whose email alternative
 * (`^[A-Za-z0-9._+-]+(@)…`) greedily consumes the run of word characters that
 * follows and then needs an `@`. On a run of letters with no `@` that scan walks
 * to the end of the block and fails, once per stop: cost ≈ Σ (rest of the run),
 * i.e. QUADRATIC in the block, while the text an author wrote there is ordinary
 * prose. A protocol word followed by `://` is a real URL and is consumed (the
 * scan is then linear in the URL), so only the FAILING stops are counted.
 *
 * Measured on the owner path (CPU ms, one paragraph, this tree; the 1 MiB
 * column predates the 128 KB owner cap):
 *
 *   input           8 KB   16 KB   32 KB   64 KB    1 MiB
 *   `HTTP` repeated   30      66     253     543     330 s
 *   `http` / `Http`   ~same                          (same shape)
 *   `AAAA` / `HHHH`     0       1       1       2    24
 *   `word ` prose       0       1       1       2    27
 *
 * …i.e. ~4x per doubling, ~2.4 ns per character scanned, and the gap between
 * `HTTP` and `AAAA` is exactly "the text rule stops here". This is the cost the
 * old comment recorded as "bounded but NOT covered by these budgets (0.5 s at
 * the cap), recorded and left unguarded"; at the owner path's then-1 MiB cap
 * it was five and a half MINUTES of blocked event loop on a public,
 * unauthenticated page, so it is covered now: the scan is paid from the SAME
 * whole-document budget as d² (one pool, so neither cost can hide behind the
 * other), and a block whose scan alone exceeds the budget is flattened exactly
 * like a delimiter-dense one — its text stays on screen, escaped.
 *
 * The proxy is computed in one linear pass: split the block into maximal runs of
 * `[A-Za-z0-9._+-]` (the email local-part class, the characters the scan
 * consumes), and for each stop inside a run add the distance from the stop to
 * the end of that run. The result is an upper bound on the characters marked
 * will scan in that block (each stop really scans exactly that far), and it is
 * cheap to compute because the inner loop walks each run once.
 * @param {string} s
 * @returns {number} characters marked's email alternative would scan in `s`
 */
function urlScanCost(s) {
  const n = s.length;
  let cost = 0;
  let i = 0;
  while (i < n) {
    if (!isUrlRunChar(s.charCodeAt(i))) { i++; continue; }
    let end = i + 1;
    while (end < n && isUrlRunChar(s.charCodeAt(end))) end++;
    for (let j = i; j < end; j++) {
      if (isUrlScannedStop(s, j)) cost += end - j;
    }
    i = end;
  }
  return cost;
}

/** `[A-Za-z0-9._+-]` — the email local-part class marked's url rule scans. */
function isUrlRunChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 /* . */ || c === 95 /* _ */ || c === 43 /* + */ || c === 45 /* - */;
}

/**
 * True when marked's inline text rule ends a text token at `at`, and the url
 * tokenizer therefore runs there and fails (so its email alternative scans the
 * rest of the run). Case-insensitive, exactly like the rules: the protocol words
 * `http`, `https`, `ftp` NOT followed by `://`, and `www.` NOT followed by a
 * hostname character (`[a-zA-Z0-9-]`, the first thing `url`'s www branch needs).
 * @param {string} s
 * @param {number} at index inside a `[A-Za-z0-9._+-]` run
 * @returns {boolean}
 */
function isUrlScannedStop(s, at) {
  const c = s.charCodeAt(at) | 0x20; // ASCII lowercase
  if (c === 104 /* h */) {
    if ((s.charCodeAt(at + 1) | 0x20) !== 116 || (s.charCodeAt(at + 2) | 0x20) !== 116
      || (s.charCodeAt(at + 3) | 0x20) !== 112) return false;
    let k = at + 4;
    if ((s.charCodeAt(k) | 0x20) === 115 /* s */) k++;
    return !isSchemeSeparator(s, k);
  }
  if (c === 102 /* f */) {
    if ((s.charCodeAt(at + 1) | 0x20) !== 116 || (s.charCodeAt(at + 2) | 0x20) !== 112) return false;
    return !isSchemeSeparator(s, at + 3);
  }
  if (c === 119 /* w */) {
    if ((s.charCodeAt(at + 1) | 0x20) !== 119 || (s.charCodeAt(at + 2) | 0x20) !== 119
      || s.charCodeAt(at + 3) !== 46 /* . */) return false;
    const next = s.charCodeAt(at + 4) | 0x20;
    // A hostname character means `url()` matches "www.…" and consumes it; any
    // other character makes the www branch fail and the email scan run instead.
    return !((next >= 48 && next <= 57) || (next >= 97 && next <= 122) || s.charCodeAt(at + 4) === 45);
  }
  return false;
}

/** `://` at `k` — what makes a protocol word a real URL `url()` consumes. */
function isSchemeSeparator(s, k) {
  return s.charCodeAt(k) === 58 /* : */ && s.charCodeAt(k + 1) === 47 /* / */ && s.charCodeAt(k + 2) === 47;
}

/** The longest run, in characters, of email-local-part characters around an `@`
 *  that a block may keep before that block is flattened (see emailRunScan).
 *  One address is two runs of a few characters; the longest real local part or
 *  domain label is ~64. Exported so the tests can pin the bound they exercise. */
export const MD_EMAIL_RUN_MAX = 256;
/** The longest run of those characters a block may contain ANYWHERE (no `@`
 *  needed). Every fourth character of `HTTP` is a protocol-word stop, so this
 *  is what keeps a long protocol-word run's email retries — and any other
 *  long unbroken token — bounded without flattening ordinary prose. */
export const MD_EMAIL_RUN_HARD_MAX = 4096;

/**
 * The characters marked's inline TEXT rule stops inside a run of:
 * `[A-Za-z0-9.!#$%&'*+/=?_`{|}~-]` (v17.0.4's own class, copied exactly). Its
 * lookahead `(?=[…]+@)` ends a text token at EVERY position of a run that `@`
 * follows, which is what puts url()'s email alternative — and its scan to the
 * end of the run — on every one of those positions. Newlines, spaces, commas
 * and `@` itself are not members, so runs break there.
 * @param {number} c char code
 * @returns {boolean}
 */
function isEmailRunChar(c) {
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  switch (c) {
    case 33: /* ! */ case 35: /* # */ case 36: /* $ */ case 37: /* % */
    case 38: /* & */ case 39: /* ' */ case 42: /* * */ case 43: /* + */
    case 45: /* - */ case 46: /* . */ case 47: /* / */ case 61: /* = */
    case 63: /* ? */ case 95: /* _ */ case 96: /* ` */ case 123: /* { */
    case 124: /* | */ case 125: /* } */ case 126: /* ~ */
      return true;
    default:
      return false;
  }
}

/**
 * What marked's email autolink retry will spend on `s` — the cost urlScanCost
 * CANNOT see, because no protocol word is involved (see "A THIRD quadratic"
 * above) — and whether a per-run cap makes the block flatten anyway.
 *
 * Charging only the caps was the hole: a run JUST UNDER MD_EMAIL_RUN_MAX is
 * admitted, and marked then pays its (cap-1)²-ish scan at EVERY `@` in the
 * block, so `@` every 256 — or every 128 — characters is quadratic for a whole
 * document while no single run ever trips a cap, and none of it reached the
 * document budget. So this returns the cost it OBSERVES, in the same
 * "attempts" currency as d² and urlScanCost: Σ(run²) over EVERY run that
 * precedes an `@`, PLUS run × domain per `@`. run² is the number of characters
 * the retry walks in the run (Σ over the run's stops — the exact work is
 * run²/2, rounded up here) plus its own per-stop overhead; the domain run is
 * walked once per stop, so that `@` pays run × domain for it. The scan resumes
 * at the character AFTER the `@`, not past the domain: the run it just measured
 * as a domain can be the NEXT `@`'s local part, and jumping over it would bill
 * every other run of an `@`-separated chain at `domain` instead of run².
 * guardAndParse bills the total to the same per-document pool, so the under-cap
 * shapes add up and run it out exactly like any other dense block.
 *
 * `flatten` keeps three run-length triggers as an EXTRA flatten, all far above
 * ordinary prose:
 *   - an `@` preceded by a run longer than MD_EMAIL_RUN_MAX (the local part):
 *     marked stops the text token at every position of that run and each stop
 *     scans the rest of it;
 *   - a run longer than MD_EMAIL_RUN_MAX right after an `@` (the domain, whose
 *     label class `[a-zA-Z0-9-_]` is a subset of this one, so measuring the
 *     wider run is the conservative choice);
 *   - ANY run longer than MD_EMAIL_RUN_HARD_MAX, no `@` needed: a long
 *     protocol-word run (`HTTP` repeated) has a stop every fourth character,
 *     and urlScanCost already charges those — this is the same family, caught
 *     by length alone so the check never has to know about stops.
 *
 * They also keep the cost arithmetic small: a block that trips one returns
 * before the rest of its runs are billed, and the verdict would be the same (a
 * 4,096-character run alone costs ~1.7e7, four times the whole budget).
 *
 * One linear pass still: resuming just after the `@` walks each run at most
 * twice (once as one `@`'s domain, once as the candidate local part that
 * follows it), so a block costs O(len) here whatever its shape.
 * @param {string} s
 * @returns {{ cost: number, flatten: boolean }} `cost` in budget attempts (the
 *   characters marked's email retry scans there, rounded to run²); `flatten`
 *   when a per-run cap says this block must be flattened rather than lexed
 */
function emailRunScan(s) {
  const n = s.length;
  let cost = 0;
  let i = 0;
  while (i < n) {
    if (!isEmailRunChar(s.charCodeAt(i))) { i++; continue; }
    let end = i + 1;
    while (end < n && isEmailRunChar(s.charCodeAt(end))) end++;
    const run = end - i;
    if (run > MD_EMAIL_RUN_HARD_MAX) return { cost, flatten: true };
    if (end < n && s.charCodeAt(end) === 64 /* @ */) {
      if (run > MD_EMAIL_RUN_MAX) return { cost, flatten: true };
      let d = end + 1;
      while (d < n && isEmailRunChar(s.charCodeAt(d))) d++;
      const domain = d - end - 1;
      if (domain > MD_EMAIL_RUN_MAX) return { cost, flatten: true };
      // Every stop in the local run walks the domain run, so the domain is paid
      // per stop (run × domain); and the run after the `@` is NOT skipped — the
      // next pass scans it again as a candidate local part, so a run that is one
      // `@`'s domain and the next `@`'s local part is billed run² too.
      cost += run * run + run * domain;
      i = end + 1;
      continue;
    }
    i = end;
  }
  return { cost, flatten: false };
}

/** The budgets of the linear pre-pass above, plus the link-definition cap that
 *  removes the inline lexer's other per-block scan. Shared by BOTH rendered
 *  paths (bot and owner) because they bound the same inline lexer, and per
 *  document, so a 128 KB owner document costs no more inside marked than a
 *  64 KB bot reply does. Exported so the tests can prove they really exercise
 *  the guarded path (and that an ordinary story stays far below every one of
 *  them) instead of assuming it. */
export const BOT_MD_BLOCK_DELIMS = 1024;
/** The whole-document budget, in "attempts": Σ over the document's inline blocks
 *  of d² (the emphasis/link retries) PLUS the characters marked's url EMAIL
 *  alternative would scan there — urlScanCost for the protocol-word stops
 *  (~2.4 ns each at 1 MiB) and emailRunScan for the `@` runs (Σrun² + run ×
 *  domain per `@`), the same quadratic reached without a protocol word. All
 *  three are paid
 *  from this one pool, so a document cannot spend 4e6 on delimiters and another
 *  4e6 on scans: the worst case is 4e6 attempts of any kind, ~50 ms of d² or
 *  ~10 ms of url scan. Real prose stays orders of magnitude below it (a 1 MiB
 *  post quoting `HTTP` a hundred times costs ~1e3; forty links cost ~1e3; the
 *  contacts document below costs ~2e4; the 24 KB pinned post in
 *  tests/owner-markdown-guard.test.js costs under 2e4). */
export const BOT_MD_SQ_BUDGET = 4_000_000;
export const BOT_MD_MAX_LINK_DEFS = 256;

/** `src` as escaped plain text tokens: one per line, a <br> between them (what
 *  `breaks: true` emits for a plain paragraph today). A text token's `text` is
 *  character data, not markup — marked escapes it itself in parseInline
 *  (measured: a text token holding `<b>&` renders `&lt;b&gt;&amp;`) — so the
 *  RAW line goes in here, never a pre-escaped one (that would double-escape). */
function plainTextTokens(src) {
  const lines = String(src).split("\n");
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) tokens.push({ type: "br" });
    tokens.push({ type: "text", raw: lines[i], text: lines[i] });
  }
  return tokens;
}

/** marked's two lexing phases, with the per-block guard in between: block
 *  tokens (cheap, linear), then the guard, then inline lexing of whatever was
 *  left formatted. Guarded blocks are filled with escaped text tokens and
 *  their inline source is never lexed. Splitting the phases this way is what
 *  keeps the guard per INLINE BLOCK: `lexer.inlineQueue` is exactly the list
 *  of texts marked was about to inline-lex (paragraphs, headings, list item
 *  contents, table cells) — no re-implementation of block splitting, so
 *  rendering stays marked's own. This is the ONLY rendering path for EITHER
 *  renderer (the bot's and the owner's), so it also does what Lexer#lex does
 *  around the phases (line-ending normalisation) — before that, a CRLF reply
 *  kept its `\r`.
 *
 *  `instance` is the Marked instance to drive, and it is the ONLY difference
 *  between the two paths: its defaults are the Lexer's options (so botMarked
 *  carries the math extensions and ownerMarked carries none — a post about
 *  prices keeps its dollar signs) and its parser is what renders the tokens
 *  (so each keeps its own image renderer and link opt-out). Nothing else is
 *  shared, and nothing about the budgets depends on the instance, because they
 *  bound marked's inline lexer, which is the same code in both.
 *
 *  It leans on that split being stable, and the digest tests pin it: ordinary
 *  and delimiter-dense documents are rendered through here and must match the
 *  unguarded renderer byte for byte (tests/bot-markdown-quadratic.test.js for
 *  the bot path, tests/owner-markdown-guard.test.js for the owner's), so a
 *  marked upgrade that moves the phases fails in CI instead of silently
 *  changing published output. */
function guardAndParse(src, instance) {
  // marked's Lexer#lex normalises line endings before block lexing; calling
  // blockTokens directly skips that, so a CRLF reply (a tool result pasted
  // from Windows) kept a `\r` on every line and flattened into one escaped
  // paragraph. Do exactly what marked does.
  src = src.replace(/\r\n|\r/g, "\n");
  // Bound container nesting from INSIDE the block lexer (see "THE
  // BLOCK-NESTING CLIFF"): "1) " x 64 KB used to spend ~1 s here and then trip
  // the stack. The guard is a depth counter (plus, on the tokenizer's re-lex
  // path, a byte budget) inside the lexer, so `src` itself is never rewritten:
  // code, fences, HTML and math keep every character.
  const lexer = boundedLexer(instance.defaults, src.length);
  lexer.blockTokens(src, lexer.tokens);
  // Cap the link definitions BEFORE any inline lexing: inlineTokens scans
  // `Object.keys(this.tokens.links)` on every inline block, so a flood of
  // definitions is paid once per paragraph. Insertion order is kept (numeric
  // labels sort first, as they do in marked's own map).
  const links = lexer.tokens.links;
  if (links) {
    const labels = Object.keys(links);
    for (const label of labels.slice(BOT_MD_MAX_LINK_DEFS)) delete links[label];
  }
  let budget = BOT_MD_SQ_BUDGET;
  for (const entry of lexer.inlineQueue) {
    const d = countDelims(entry.src);
    // Three independent costs share the document budget, each measured in the
    // units it makes marked's inline lexer spend: d² for the emphasis/link
    // retries (see the table at the top of this section), the url email scan
    // (urlScanCost, ~2.4 ns per character) and the email autolink's run scan
    // (emailRunScan: Σrun² + run × domain per `@` — the same quadratic,
    // reached with no protocol word, that urlScanCost cannot see; see "A THIRD
    // quadratic"
    // above). A block is flattened when its delimiter count is over the
    // per-block cap, or when what is left of the document budget cannot pay for
    // all three costs — which also covers one block whose url or email-run scan
    // alone would exceed the whole budget. emailRunScan's per-run caps are an
    // EXTRA trigger alongside them: they only flatten, never admit, and they
    // keep the cost arithmetic small.
    const scan = urlScanCost(entry.src);
    const email = emailRunScan(entry.src);
    const cost = d * d + scan + email.cost;
    if (d <= BOT_MD_BLOCK_DELIMS && cost <= budget && !email.flatten) {
      budget -= cost;
      continue;
    }
    entry.guarded = true;
    for (const token of plainTextTokens(entry.src)) entry.tokens.push(token);
  }
  for (const entry of lexer.inlineQueue) {
    if (!entry.guarded) lexer.inlineTokens(entry.src, entry.tokens);
  }
  lexer.inlineQueue.length = 0;
  return instance.parser(lexer.tokens);
}

/**
 * marked's image renderer, shared by both paths. `false` lets marked draw the
 * `<img>` (the sanitizer's exclusiveFilter then re-checks the same rule);
 * otherwise the alt text, escaped by us, is emitted as character data in its
 * place — text, never a link, so a refused image cannot become a click target.
 * @param {{ href?: string, text?: string }} token
 * @returns {string|false}
 */
function renderImageToken(token) {
  const href = String(token.href ?? "");
  // Judge the src the sanitizer will actually emit: a `storage:<key>` src is
  // rewritten to `/blog/media/<key>` in sanitizeRendered, so `storage:../../x`
  // must be refused HERE — it would resolve out of the media route — instead
  // of passing a `storage:` prefix test and losing its alt text to the
  // sanitize step.
  const src = href.startsWith("storage:")
    ? BOT_IMAGE_PREFIX + href.slice("storage:".length)
    : href;
  if (isAllowedImageSrc(src, imageContext.policy, imageContext.storageOrigin)) return false;
  // This string lands in the HTML as character data (not inside an attribute),
  // so it must never carry markup of its own.
  return escapeText(String(token.text ?? ""));
}

/**
 * The owner's parser: marked exactly as the blog always had it (gfm, breaks,
 * NO math extensions — a post about prices keeps its dollar signs), plus the
 * image rule, so a refused image leaves its escaped alt text where the <img>
 * would have been.
 */
const ownerMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    image(token) { return renderImageToken(token); },
  },
});

/**
 * Render a bot's markdown (Perch live frames and transcript history — both
 * paths call this, so they render identically) to sanitized HTML: everything
 * renderMarkdown does, plus math delimiters shown once as source. Over
 * BOT_MD_MAX_INPUT it returns "" (callers fall back to plain text): marked's
 * own lexer degrades sharply on long escape-dense input (see above). Under
 * it, EVERY input takes guardAndParse: a depth counter inside marked's block
 * lexer bounds container nesting, a linear pre-pass keeps the inline-lexer
 * cliff out of reach, and the digest tests pin both byte-identical to plain
 * marked.parse for ordinary content.
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
  let html;
  // guardAndParse drives marked's Lexer itself (blockTokens/inlineQueue/
  // inlineTokens, public in marked 17 and pinned by the digest tests). If a
  // future marked moves any of that, answer the way an over-cap reply is
  // answered — no HTML, the callers' documented plain-text path — rather than
  // throw on the gateway's event loop or quietly leave the cliff open.
  //
  // Both halves run inside the bot image context: the image renderer reads it
  // DURING the parse (guardAndParse lexes with botMarked's own defaults and
  // renders with botMarked.parser, so the image hook and the math extensions
  // are the bot's), and the sanitizer re-checks the same rule after it.
  return withImageContext({ policy: "bot", storageOrigin: null }, () => {
    try {
      html = guardAndParse(src, botMarked);
    } catch {
      return "";
    }
    return sanitizeRendered(html, { imagePolicy: "bot" });
  });
}

/**
 * The shared post-parse half: storage: rewrite, allow-list sanitize, tables.
 * `imagePolicy` picks the image rule and the link opt-outs:
 *   "none"  — no rule (Crow Artifacts' blocks; their sandboxed frame owns this)
 *   "bot"   — `/blog/media/` images only; links opt out of prefetch AND Drive
 *   "owner" — the owner's rule (see isAllowedImageSrc); links opt out of
 *             prefetch only, so the owner's own navigation stays on Turbo
 */
function sanitizeRendered(raw, { imagePolicy = "none", storageOrigin = null } = {}) {
  const bot = imagePolicy === "bot";
  const governed = imagePolicy !== "none";
  const linkAttrs = governed ? (bot ? BOT_LINK_ATTRS : OWNER_LINK_ATTRS) : [];
  // Rewrite storage: URLs to public blog media route. The same prefix the image
  // renderer judges at parse time (BOT_IMAGE_PREFIX), so the two cannot drift.
  const processed = raw.replace(
    /(<img\s[^>]*src=")storage:([^"]+)(")/g,
    (_m, before, key, after) => before + BOT_IMAGE_PREFIX + key + after
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
      // The renderer's own Turbo opt-outs are allow-listed on `a` — both on
      // the bot path, only the prefetch one on the owner's. sanitize-html runs
      // transformTags BEFORE it filters attributes, so the values here are the
      // ones the transform writes; an author-supplied data-* never survives.
      a: ["href", "title", "target", "rel", ...linkAttrs],
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
    // The owner path is the only one that may keep a `data:` image (inline, so
    // no request; the page CSP allows data:). The bot path keeps the scheme
    // list it always had — its image rule drops a data: URL either way.
    ...(imagePolicy === "owner" ? { allowedSchemesByTag: { img: ["http", "https", "data"] } } : {}),
    // Both rendered paths (bot replies and the owner's markdown) get three
    // rules; the artifact blocks get none.
    //
    // (1) An <img> whose src is not allowed for this policy is dropped after
    // the storage: rewrite, so the viewer's browser never makes that request
    // (isAllowedImageSrc owns the decision — /blog/media/ and, on the owner
    // path only, a published /blog/figures/ figure, a /kb/media/ file, a
    // /api/meta-glasses/photo/ note photo, the storage origin and inline
    // images). A markdown image's alt text has already been emitted in
    // its place by marked's image renderer; a raw HTML <img> in the markdown
    // simply disappears. sanitize-html's own filter (not a regex over the
    // HTML) owns this decision.
    //
    // `exclusiveFilter` is ONE function, `(frame) => boolean`, called on the
    // CLOSING tag, and a truthy return DROPS the element together with its
    // content (sanitize-html 2.x — it is not a per-tag map). It runs after the
    // attribute filter, so `frame.attribs.src` is the src the browser would
    // have received. So: drop every <img> whose src is not allowed, plus (3)
    // below — one function, both decisions, never one replacing the other.
    //
    // (2) Every <a> gets data-turbo-prefetch="false". Rendered markdown is
    // shown in the OWNER's browser, and Turbo 8 (the vendored
    // turbo-8.0.5.umd.js) PREFETCHES a same-origin link on hover: a GET fired
    // with the viewer's cookies just by pointing at the link — the same trick
    // the <img> rule above exists to stop (it was `![x](/dashboard/logout)`; a
    // link to a state-changing GET is the same move). A bot reply ALSO gets
    // data-turbo="false": a click there must not navigate via Turbo Drive.
    // The owner's own links keep Drive — that is the owner's navigation — and
    // only lose the prefetch. The values are written by us, after the author's
    // own attributes, so a bot cannot ask for `data-turbo-prefetch="true"`
    // back.
    //
    // (3) An <input> survives ONLY as a GFM task-list checkbox: every other
    // type (and a missing type, which reads as `text`) is dropped whole —
    // `type="image"` is the `src` GET the image rule above exists to stop, and
    // a text/submit control has no business in rendered prose. It runs in the
    // same exclusiveFilter as (1).
    ...(governed
      ? {
        transformTags: {
          a: (tagName, attribs) => ({
            tagName,
            attribs: {
              ...attribs,
              "data-turbo-prefetch": "false",
              ...(bot ? { "data-turbo": "false" } : {}),
            },
          }),
        },
        exclusiveFilter: (frame) => {
          if (frame.tag === "img") {
            return !isAllowedImageSrc(frame.attribs && frame.attribs.src, imagePolicy, storageOrigin);
          }
          if (frame.tag === "input") return !isCheckboxInput(frame.attribs);
          return false;
        },
      }
      : {}),
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

/**
 * Top-level Markdown blocks, each rendered and sanitized on its own (Crow
 * Artifacts, the `document` type: every block becomes an addressable anchor
 * `b<n>` for comments). Same parser and sanitizer as renderMarkdown; blank
 * `space` tokens are skipped. Callers bound the input size first (marked has
 * a cliff on long escape-dense input, see BOT_MD_MAX_INPUT above).
 * @returns {{ type: string, text: string, html: string }[]}
 */
export function markdownBlocks(markdown) {
  if (!markdown) return [];
  return marked.lexer(String(markdown))
    .filter((t) => t.type !== "space")
    .map((t) => ({
      type: t.type,
      ...(t.type === "code" ? { lang: String(t.lang || "").trim().split(/\s+/)[0].toLowerCase(), code: String(t.text || "") } : {}),
      text: String(t.text || t.raw || "").replace(/\s+/g, " ").trim().slice(0, 400),
      // No imagePolicy: the artifact frame's own CSP rules images there, and
      // its figures are relative paths (`__render/b2.svg`) by design.
      html: sanitizeRendered(marked.parser([t])),
    }));
}
