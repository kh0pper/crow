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
  return withImageContext({ policy: "owner", storageOrigin }, () =>
    sanitizeRendered(ownerMarked.parse(String(markdown)), { imagePolicy: "owner", storageOrigin }));
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
// (5-25 ms at 8 KB).
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
// So EVERY bot render runs marked's own two phases (block tokens, then inline
// tokens — the same split Lexer#lex does) with a linear scan between them: an
// inline block that is over budget keeps its place and its container (a <p>
// stays a <p>, a <td> a <td>) but its text is escaped instead of inline-lexed.
// The pre-pass is linear, so there is no fast path to preserve: the digest
// tests pin the guarded path byte-identical to plain marked.parse for ordinary
// content (a normal ~19 KB reply, a delimiter-dense but legitimate document),
// and routing everything through ONE path is what puts a CRLF reply, a
// definition flood and a delimiter flood on the same, guarded, code.
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
//   - BOT_MD_MAX_LINK_DEFS, link definitions in one document: marked's
//     inlineTokens rebuilds `Object.keys(this.tokens.links)` and scans it on
//     EVERY inline block, so thousands of `[N]:x` definitions make every
//     paragraph O(definitions) — measured 2.2 s for ~39 KB of definitions plus
//     5,000 tiny `*a*` paragraphs. Past this many the extra definitions are
//     dropped (insertion order kept; a link to a dropped one renders as its
//     own text).
//
// One cost is bounded but NOT covered by these budgets: marked's email
// autolink scan is linear yet expensive per character, so a long run of
// `HTTP` (a plausible word, not just an attack — one 64 KB email local-part
// candidate) costs ≈0.5 s at the cap, measured 543 ms. It does not compound
// with the d² term, so it is recorded here and left unguarded.
//
// With the budgets in place, every adversarial unit x container shape at the
// cap, the medium-block case, the `_`+filler worst shape, the definitions
// flood and 50 random 64 KB delimiter soups all measured ≤ 253 ms of CPU
// (worst: the `_`+filler shape at 253 ms; 133 ms for a unit x shape, 116 ms
// for the definitions flood; tests/bot-markdown-quadratic.test.js pins the
// bounds and records the worst render in a diagnostic).
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

/** The budgets of the linear pre-pass above, plus the link-definition cap that
 *  removes the inline lexer's other per-block scan. Exported so the tests can
 *  prove they really exercise the guarded path (and that an ordinary story
 *  stays far below every one of them) instead of assuming it. */
export const BOT_MD_BLOCK_DELIMS = 1024;
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
 *  rendering stays marked's own. This is the ONLY bot rendering path, so it
 *  also does what Lexer#lex does around the phases (line-ending
 *  normalisation) — before that, a CRLF reply kept its `\r`.
 *
 *  It leans on that split being stable, and the digest tests in
 *  tests/bot-markdown-quadratic.test.js pin it: ordinary and delimiter-dense
 *  documents are rendered through here and must match the unguarded renderer
 *  byte for byte, so a marked upgrade that moves the phases fails in CI
 *  instead of silently changing bot output. */
function guardAndParse(src) {
  // marked's Lexer#lex normalises line endings before block lexing; calling
  // blockTokens directly skips that, so a CRLF reply (a tool result pasted
  // from Windows) kept a `\r` on every line and flattened into one escaped
  // paragraph. Do exactly what marked does.
  src = src.replace(/\r\n|\r/g, "\n");
  const lexer = new Lexer({ ...botMarked.defaults });
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
    if (d <= BOT_MD_BLOCK_DELIMS && d * d <= budget) {
      budget -= d * d;
      continue;
    }
    entry.guarded = true;
    for (const token of plainTextTokens(entry.src)) entry.tokens.push(token);
  }
  for (const entry of lexer.inlineQueue) {
    if (!entry.guarded) lexer.inlineTokens(entry.src, entry.tokens);
  }
  lexer.inlineQueue.length = 0;
  return botMarked.parser(lexer.tokens);
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
 * it, EVERY input takes guardAndParse: a LINEAR pre-pass keeps the
 * inline-lexer cliff out of reach, and the digest tests pin it byte-identical
 * to plain marked.parse for ordinary content.
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
      html = guardAndParse(src);
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
