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
 * see "THE BLOCK-NESTING CLIFF" below), the inline-lexer cliff is guarded by
 * the same linear pre-pass the bot path uses (see "THE INLINE-LEXER CLIFF"),
 * and long inline TEXT runs are cut inside a whitespace run near 4,096
 * characters, at the same index the bot path's math extension cuts them at (see
 * textRunCut and "THE OWNER PATH'S TEXT-RUN WINDOW").
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
 * THE LONG DOCUMENT: CHUNKED, NOT CUT. marked's block lexer is still quadratic
 * on a few shapes the depth and byte guard below do not cover (`"    x\n>     y\n"`
 * repeated cost 11 s at 256 KB and ~200 s at 1 MiB), and the owner path
 * is reachable from public /blog, the file viewer and federated memories. So a
 * document is never handed to marked in one piece: it is split into CONSECUTIVE
 * chunks of at most OWNER_MD_MAX_INPUT characters (128 KB), each cut at a safe
 * block boundary by ownerMarkdownCut (see ownerMarkdownChunks), and every chunk
 * is rendered through the SAME guarded pipeline and sanitizer as before. A
 * document of 500 KB-1 MB — the owner's lab notes, opened in the file viewer —
 * is therefore FULLY formatted, not a formatted head followed by plain text.
 * A document of at most 128 KB is one chunk and takes exactly the path it always
 * did (pinned byte-for-byte by the digest tests).
 *
 * Three things make the split safe:
 *   - the CUT is a block boundary: the end of a blank line outside a fence, else
 *     the last line break, else the cap on a character boundary (ownerMarkdownCut).
 *     A chunk almost never ends mid-block; where it does — a list, quote or table
 *     that spans the cut — the block closes at the end of one chunk and reopens
 *     in the next. The text is never altered, only its wrappers are split, and
 *     `\n\n` (the preferred cut) is a block boundary to marked, which is what
 *     makes it rare.
 *   - CROSS-CHUNK REFERENCES: marked resolves `[label]` against ONE lexer's
 *     `tokens.links`, so a definition written at the top of the document would
 *     be invisible to the chunk that uses it. collectLinkDefinitions scans the
 *     whole document linearly first (same fence rules, at most three spaces of
 *     indent, marked's own def tokenizer for label/href/title, the first 256
 *     labels — marked's first-wins) and every chunk is handed that map.
 *   - CROSS-CHUNK NESTING: a cut usually lands on a blank line, i.e. with every
 *     container closed, but a document with no block boundary in the window (one
 *     256 KB line of `> ` markers, a list running past the cap) is cut
 *     MID-BLOCK. The next chunk then reopens the containers the cut fell inside
 *     — so those levels are still on the page, and a fresh depth counter per
 *     chunk would let a 256 KB marker run show 2 x MD_MAX_NEST nested
 *     blockquotes where one parse shows MD_MAX_NEST. The chunk loop therefore
 *     carries the number of container levels the cut left OPEN (openContainerDepth,
 *     `depthState` in boundedLexer) into the next chunk's lexer, which starts its
 *     depth counter at that value: one document, one MD_MAX_NEST bound, however
 *     many chunks it takes. A cut on a blank line leaves 0 open, which is every
 *     chunk of a real document — those render exactly as they did before.
 *   - the TOTAL-TIME BUDGET: a document whose chunks are EACH pathological is
 *     still bounded, because the render stops once it has spent
 *     OWNER_MD_RENDER_BUDGET_MS (1000 ms) of CPU on chunks and every remaining
 *     chunk becomes the old plain-text tail — the notice, then the WHOLE
 *     remainder as escaped text in one <pre> (tailHtml). Nothing is ever
 *     dropped. Under that sits a hard ceiling too: nothing past
 *     OWNER_MD_MAX_TOTAL_INPUT (8 MiB, the file viewer's own read cap) is parsed
 *     at all — it is the plain-text tail — so this function is safe on its own
 *     even if a caller forgets that cap.
 *
 * Real content is far below all of it (every stored blog post, KB article and
 * memory is < 60 KB); the file viewer's lab documents are what the chunks are
 * for. Everything handed to marked still goes through the same guarded pipeline,
 * and a chunk whose parse throws answers its own escaped text — never "": a
 * public page renders what was written.
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
    // Longer than one chunk: render every chunk that fits the budget, then the
    // WHOLE remainder as plain text (see renderOwnerLongDocument).
    return renderOwnerLongDocument(src, storageOrigin);
  });
}

/**
 * A document longer than one chunk (see "THE LONG DOCUMENT: CHUNKED, NOT CUT"
 * above), rendered chunk by chunk: every chunk through the guarded pipeline and
 * the sanitizer, the concatenation returned as one HTML string, and the part the
 * budget (or the hard input ceiling) does not reach rendered as the plain-text
 * tail. Nothing is dropped.
 * @param {string} src line-ending-normalised document, longer than
 *   OWNER_MD_MAX_INPUT
 * @param {string|null} storageOrigin
 * @returns {string} Safe HTML
 */
function renderOwnerLongDocument(src, storageOrigin) {
  // The budget is measured from HERE, in CPU time — this thread's own where Node
  // exposes process.threadCpuUsage (see cpuNow). Rendering is synchronous and
  // single-threaded, so this is the render's own cost whatever load the box
  // carries elsewhere.
  const started = cpuNow();
  // The whole document's link definitions, first: marked resolves `[x][y]`
  // against the ONE lexer's `tokens.links`, so without this map a link in chunk
  // 3 whose `[y]: …` line sits in chunk 1 renders as its literal text.
  const seedLinks = collectLinkDefinitions(src, ownerMarked);
  const context = { imagePolicy: "owner", storageOrigin };
  let html = "";
  /** Where the markdown-rendered part ends — where a tail would begin. */
  let rendered = 0;
  /** The container levels the PREVIOUS chunk's cut left open, so the next chunk
   *  continues at that depth instead of starting a fresh MD_MAX_NEST budget
   *  (see "CROSS-CHUNK NESTING" above and depthState in boundedLexer). A cut on
   *  a blank line — every chunk of a real document — leaves 0. */
  const depthState = { open: 0 };
  for (const [start, end] of ownerMarkdownChunks(src)) {
    // Over the budget: this chunk and every one after it become the plain-text
    // tail below. Checked BEFORE the chunk starts (so a pathological chunk
    // cannot commit another 128 KB of work) and only after the first chunk (so a
    // long document always shows at least one formatted chunk).
    if (rendered > 0 && elapsedCpuMs(started) > OWNER_MD_RENDER_BUDGET_MS) break;
    html += sanitizeRendered(renderOwnerHead(src.slice(start, end), seedLinks, depthState), context);
    rendered = end;
  }
  // The remainder: the chunks the budget stopped before, and anything past
  // OWNER_MD_MAX_TOTAL_INPUT (which ownerMarkdownChunks never covers). All of it,
  // escaped, under the notice.
  if (rendered < src.length) html += tailHtml(src.slice(rendered));
  return html;
}

/**
 * A CPU-time reading for the render budget: `process.threadCpuUsage()` (Node 24)
 * measures THIS thread, which is exactly what the budget means — the render runs
 * synchronously on the thread that started it, so nothing else can spend on its
 * behalf and no other thread's work can spend its budget. Where that API is not
 * available, fall back to the whole process's `process.cpuUsage()`: still CPU
 * time, just a coarser measure.
 * @returns {{thread: boolean, reading: object}}
 */
function cpuNow() {
  const thread = typeof process.threadCpuUsage === "function";
  return { thread, reading: thread ? process.threadCpuUsage() : process.cpuUsage() };
}

/** CPU milliseconds spent since `start` (a cpuNow() reading). */
function elapsedCpuMs(start) {
  const spent = start.thread ? process.threadCpuUsage(start.reading) : process.cpuUsage(start.reading);
  return (spent.user + spent.system) / 1000;
}

/**
 * The owner path's markdown half: one guarded parse, or — if the parse still
 * throws — the document as escaped text (see escapedTextHtml). Never more than
 * OWNER_MD_MAX_INPUT characters is handed to it (that is one chunk).
 * @param {string} src
 * @param {object|null} [seedLinks] the whole document's link definitions, for a
 *   chunk of a longer document (see collectLinkDefinitions); omitted for the
 *   single-chunk path, which must stay byte-identical to what it always rendered
 * @param {{open: number}|null} [depthState] the container levels the previous
 *   chunk's cut left open, and where this chunk's own residual depth is written
 *   back (see "CROSS-CHUNK NESTING" and depthState in boundedLexer); omitted for
 *   the single-chunk path, which starts at depth 0 and stays byte-identical
 * @returns {string} unsanitized HTML
 */
function renderOwnerHead(src, seedLinks = null, depthState = null) {
  try {
    // The same guarded pipeline as the bot path — marked's own two lexing
    // phases with the inline guard between them, plus the depth-bounded block
    // lexer — driven with ownerMarked, so the defaults are the owner's (the
    // image renderer leaves a refused image as its escaped alt text) and there
    // is no math extension; it carries one extension of its own instead, a
    // text-run window (see "THE OWNER PATH'S TEXT-RUN WINDOW" below) with a
    // start() and a tokenizer that never matches — no token type, no renderer.
    // ownerMarked carries no hooks, no renderer/childTokens extensions and no
    // walkTokens; if a future extension does any of that, guardAndParse has to
    // be told (parse's opt.hooks branch is the code that would otherwise run
    // it).
    return guardAndParse(src, ownerMarked, seedLinks, depthState);
  } catch {
    // Fail safe, never a 500 and never an empty page: the document as escaped
    // text (see escapedTextHtml — it drops what the author hid, an HTML
    // comment). The caller's sanitizer still runs, so the fallback cannot carry
    // markup either.
    return escapedTextHtml(src);
  }
}

/**
 * The owner path's largest markdown-parsed span — ONE CHUNK, in characters
 * (128 KB).
 *
 * It used to be the whole document's markdown cap (and 1 MiB before that, which
 * was safe only against memory: marked's block lexer is QUADRATIC on some
 * cheap-looking shapes — `"    x\n>     y\n"` repeated cost 11 s at 256 KB and
 * ~200 s at 1 MiB — and this function runs synchronously in a route reachable
 * from public /blog, the file viewer and federated memories). A document longer
 * than this is no longer cut: it is rendered in consecutive chunks of at most
 * this many characters (ownerMarkdownChunks), so every span marked sees stays
 * bounded exactly as before while the reader gets the WHOLE document formatted.
 * Exported so the tests share the number.
 */
export const OWNER_MD_MAX_INPUT = 128 * 1024;

/**
 * The furthest index into a document renderMarkdown will ever hand to marked, in
 * characters (8 MiB) — the file viewer's own read cap (FILEVIEW_MAX_BYTES).
 * Nothing past it is parsed: that remainder is the plain-text tail, so the
 * renderer is safe on its own whatever its caller allows. Exported so the tests
 * share the number.
 */
export const OWNER_MD_MAX_TOTAL_INPUT = 8 * 1024 * 1024;

/**
 * How much CPU one renderMarkdown call may spend rendering chunks before it
 * stops and shows the rest of the document as plain text (see
 * renderOwnerLongDocument). Every chunk is bounded on its own, so this only ever
 * bites a document whose chunks are EACH pathological — a 1 MiB document of
 * table-shaped lines spends it after a few chunks and shows the remainder as
 * text instead of making a public page wait. Exported so the tests share the
 * number.
 *
 * The budget never covers the LAST chunk it started, because it is checked
 * before each chunk rather than inside one: the worst total is therefore this
 * budget plus one worst-case chunk. The worst chunk measured today is 128 KB of
 * ONE run of plain ASCII spaces (`'a' + ' ' x N + 'b'`, a single paragraph with
 * no newline in it), ~200 ms — marked's inline text rule is quadratic on it, and
 * the owner path now cuts a long text run inside its space run, near 4,096
 * characters but never inside the all-space stretch a line break owns (see
 * textRunCut and "THE OWNER PATH'S TEXT-RUN WINDOW" below), which is what
 * brought that chunk down from 5.8 s. Next is a 128 KB chunk of Unicode-whitespace-only lines, ~180 ms —
 * marked's inline `br` rule is quadratic on it, and that shape has its own guard
 * (brScanCost / MD_BR_SCAN_MAX) — and every other shape under the existing
 * block guards costs tens of milliseconds per chunk. Hence the number: 1000 ms
 * of budget, not the 1500 it used to be.
 */
export const OWNER_MD_RENDER_BUDGET_MS = 1000;

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
 * Where renderMarkdown splits a document: the end of the last blank line at or
 * before the cap that is NOT inside a fenced code block or a raw-HTML block,
 * else the last newline before the cap, else the cap itself. Called once per
 * chunk, with `from` at the previous cut (see ownerMarkdownChunks), so a long
 * document is split into consecutive chunks by the SAME rule — and with `from`
 * at 0 for a document that fits in one chunk, which is the path that has to stay
 * byte-identical.
 *
 * A window whose REMAINDER FITS is not cut at all: the answer is the end of the
 * document. Cutting at the last blank line there would put the document's final
 * lines in a chunk of their own, and a setext heading's underline (or a table's
 * last row) reads as a paragraph when it is parsed alone — `Heading\n=======`
 * with no trailing newline became `<p>Heading</p><p>=======</p>`.
 *
 * "\n\n" is a block boundary to marked, so a chunk usually parses cleanly
 * instead of starting (or ending) mid-paragraph, and a fence is skipped as a cut
 * point so a code block is rarely split in half by the seam. One linear pass
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
 * A raw-HTML block is tracked the same way (see htmlBlockOpener): a comment and
 * a `<script>`/`<style>`/`<textarea>`/`<pre>` body (CommonMark's html block types
 * 2 and 1) run ACROSS blank lines and end only at the line carrying their
 * closing marker. Their text is meant to be invisible — the sanitizer drops the
 * whole block — so a cut inside one would put the hidden second half on the page
 * as an ordinary paragraph, and the last line break before the cap is taken from
 * outside such a block for the same reason. (A cut inside a FENCE is still
 * allowed: splitting code is cosmetic, its text is visible either way.)
 *
 * That state machine is an approximation of marked, so a cut is never allowed to
 * cost a chunk more than half the cap: when the last usable blank line sits
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
 * @param {number} [from] the index this chunk starts at (0 for the first)
 * @returns {number} the cut index: this chunk is `src.slice(from, cut)`, the
 *   next one starts at `cut`
 */
export function ownerMarkdownCut(src, cap = OWNER_MD_MAX_INPUT, from = 0) {
  const length = String(src).length;
  const base = from > 0 ? Math.min(from, length) : 0;
  const limit = Math.min(base + cap, length);
  // The whole remainder fits in this window: there is nothing to cut. The end of
  // the document is a real character boundary of the input (no surrogate to step
  // back over), and cutting anywhere before it would split the last block.
  if (limit === length) return length;
  let lastBlank = -1;
  /** The open fence: its character and its run length, or null. */
  let fence = null;
  /** The open raw-HTML block (a comment, or a <script>/<style>/<textarea>/<pre>
   *  body): the test that ENDS it, or null. */
  let htmlBlock = null;
  /** The index of the last `\n` at or before the cap that is NOT inside one of
   *  those blocks (`lineBreak` below). */
  let lastHtmlFreeBreak = -1;
  for (let start = base; start < limit;) {
    const nl = src.indexOf("\n", start);
    const end = nl === -1 ? length : nl;
    const line = src.slice(start, end);
    if (fence) {
      // A closing fence: same character, at least as long, then spaces only.
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
    } else if (htmlBlock) {
      // Inside a raw-HTML block: its blank lines are its CONTENT, and only the
      // line carrying the closing marker ends it.
      if (htmlBlock.end.test(line)) htmlBlock = null;
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
      else htmlBlock = htmlBlockOpener(line);
    }
    // A line break that is not inside a raw-HTML block is a safe cut point even
    // when it is inside a fence (see above). Its index is the `\n` itself, so
    // the answer is the same one `lastIndexOf("\n", limit - 1)` gave.
    if (nl !== -1 && nl < limit && !htmlBlock) lastHtmlFreeBreak = nl;
    if (nl === -1) break;
    start = end + 1;
  }
  // The last line break before the cap that is not inside a raw-HTML block; a
  // blank line counted above always has one at lastBlank - 1, so this is never
  // before the blank line's newline.
  const lineBreak = lastHtmlFreeBreak;
  let cut;
  if (lastBlank > base && ((lastBlank - base) * 2 >= limit - base || lineBreak + 1 <= lastBlank)) {
    cut = lastBlank;
  } else if (lineBreak >= base) {
    // No blank line in this window at all, or only one in its first half (a
    // fence that was not a fence): cut on a plain line break, so the chunk is
    // never collapsed to a few characters.
    cut = lineBreak + 1;
  } else {
    cut = lastBlank > base ? lastBlank : limit;
  }
  // The cap is a hard bound (renderOwnerHead hands marked nothing longer), and a
  // cut inside a UTF-16 surrogate pair would cut one character in half: the
  // chunk would end with a lone high surrogate and the next begin with its low
  // half (each renders as U+FFFD, and the split is no longer the characters the
  // author wrote). Step back one unit instead, so the halves stay at most one
  // character shorter and still meet on a character boundary.
  const safe = Math.min(cut, limit);
  return safe > base && isHighSurrogate(src.charCodeAt(safe - 1)) ? safe - 1 : safe;
}

/** True for the first half of a UTF-16 surrogate pair (U+D800–U+DBFF). */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * The raw-HTML block `line` opens, if any, as the test that ENDS it (or null):
 * the two CommonMark HTML block types that run ACROSS blank lines — type 1, a
 * `<script>`, `<style>`, `<textarea>` or `<pre>` start tag, and type 2, a
 * comment. Both start at the beginning of a line with at most three spaces of
 * indent (CommonMark's rule, the one marked applies) and end at the line that
 * carries their closing marker; every other HTML block ends at a blank line,
 * which ownerMarkdownCut already treats as a cut point.
 *
 * The opening line is checked for the closing marker too, so a one-line
 * `<!-- a note -->` (or `<script>…</script>`) opens nothing.
 * @param {string} line
 * @returns {{end: RegExp}|null}
 */
function htmlBlockOpener(line) {
  // One cheap scan first: the opener is a `<` at the very start or after at most
  // three spaces, which most lines do not have at all.
  const lt = line.indexOf("<");
  if (lt < 0 || lt > 3) return null;
  const m = /^ {0,3}(?:<(script|pre|style|textarea)(?=[\s>]|$)|<!--)/i.exec(line);
  if (!m) return null;
  if (m[1]) {
    const end = new RegExp("</" + m[1].toLowerCase() + ">", "i");
    return end.test(line.slice(m[0].length)) ? null : { end };
  }
  return line.includes("-->", m[0].length) ? null : { end: /-->/ };
}

/**
 * The chunks renderMarkdown hands to marked, in order, as `[start, end)` pairs
 * into `src`: consecutive, non-overlapping, each at most `cap` characters, and
 * together exactly `[0, min(src.length, limit))`.
 *
 * Every boundary comes from ownerMarkdownCut (the end of a blank line outside a
 * fence and outside a raw-HTML block, else the last line break, else the cap on
 * a character boundary — and the document's own end whenever the remainder
 * fits), so a chunk almost always ends where marked sees a block boundary. Slicing at those
 * ends and rendering each slice on its own is what makes a 500 KB-1 MB document
 * fully formatted while every span marked parses stays bounded: nothing is
 * dropped, nothing is rewritten, and joining the chunks reproduces the input
 * character for character (pinned by tests/md-chunked-render.test.js).
 *
 * Where a cut does land inside a block — a list, quote or table that spans it —
 * the block is closed by the sanitizer at the end of one chunk and reopened by
 * the next: the text is unchanged, only its wrappers are split in two. The cut
 * rule makes that rare.
 * @param {string} src line-ending-normalised document
 * @param {number} [cap] the largest chunk, in characters
 * @param {number} [limit] the furthest index any chunk may reach
 * @returns {[number, number][]}
 */
export function ownerMarkdownChunks(src, cap = OWNER_MD_MAX_INPUT, limit = OWNER_MD_MAX_TOTAL_INPUT) {
  const text = String(src);
  const total = Math.min(text.length, limit);
  const chunks = [];
  let start = 0;
  while (start < total) {
    const window = Math.min(cap, total - start);
    let end = ownerMarkdownCut(text, window, start);
    if (end <= start) {
      // ownerMarkdownCut steps back over a surrogate pair; on a one-unit window
      // that would answer the chunk's own start. Take the window instead, on a
      // character boundary, so the loop always advances.
      end = Math.min(start + window, total);
      if (end > start + 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    chunks.push([start, end]);
    start = end;
  }
  return chunks;
}

/** A line that could be a link reference definition (`[label]: …` at ≤3 spaces). */
const LINK_DEF_CANDIDATE = /^ {0,3}\[/;

/**
 * Every link reference definition in `src`, collected in ONE linear pass — the
 * map marked itself would have built had the whole document been lexed at once.
 *
 * This is what makes a chunked render correct for references: marked resolves a
 * `[x][y]` link against the inline lexer's `tokens.links`, and that map only
 * ever holds the definitions of the ONE lexer that parsed the block. Without
 * this, a document whose definitions sit at the top (the normal way to write
 * one) would lose every reference link from the second chunk on.
 *
 * The scan applies the same fence rules as ownerMarkdownCut (a definition inside
 * a fenced code block is code, not a definition), takes only lines with at most
 * three spaces of indent (four is indented code), and lets marked's OWN def
 * tokenizer decide the rest — the tag marked will look the link up by (lowercased,
 * escapes removed), the href and the title — so the two can never disagree about
 * syntax. Duplicate labels keep the FIRST occurrence (marked's rule, and the map
 * assignment marked makes in its own block lexer), and the scan stops after
 * BOT_MD_MAX_LINK_DEFS labels, which is the same cap guardAndParse applies: a
 * definition past it is dropped there too, and not scanning further keeps a
 * definition flood linear. It also stops at OWNER_MD_MAX_TOTAL_INPUT: the part
 * of a document past the hard ceiling is never parsed, so it cannot contribute
 * a definition either.
 *
 * The scan is line-shaped, like marked's own def rule, so a def-LOOKING line
 * that marked would have folded into a paragraph (one written directly under a
 * paragraph line, no blank line between) is collected too. That is the one place
 * a chunked render can resolve a reference a single whole-document parse would
 * not; it can never do the reverse (a real definition is always collected), and
 * it is what appending the definition block to each chunk would do as well.
 *
 * A line longer than OWNER_MD_MAX_INPUT is skipped, and the whole scan is wrapped
 * in a try/catch. Both are needed: marked's def tokenizer runs its label/href/
 * title patterns over the WHOLE line, and on a multi-megabyte one (a lone `[`, or
 * an unclosed `[x]: u "` title) its regex recursion overflows the stack and
 * throws RangeError. That throw used to escape renderMarkdown — this scan runs
 * OUTSIDE renderOwnerHead's try/catch — so such a document was a 500. Skipping
 * the line cannot lose a definition, either: chunking splits a line that long,
 * so marked itself can never read one as a definition.
 *
 * The map has NO prototype (`Object.create(null)`), exactly like marked's own
 * `tokens.links`: with a plain `{}`, a definition labelled `constructor` looks
 * already present (the inherited function is truthy) and one labelled
 * `__proto__` becomes a prototype assignment instead of an entry.
 * @param {string} src line-ending-normalised document
 * @param {object} instance the Marked instance whose syntax is in force
 * @returns {Record<string, {href: string, title: string|undefined}>}
 */
function collectLinkDefinitions(src, instance) {
  const links = Object.create(null);
  let found = 0;
  try {
    // A Lexer of its own, on a COPY of the options: marked's Lexer caches a
    // Tokenizer on the options object it is given, and it must never be the
    // shared defaults (see boundedLexer). Only `tokenizer.def` is used — no
    // lexing.
    const lexer = new Lexer({ ...instance.defaults });
    const tokenizer = lexer.tokenizer;
    tokenizer.lexer = lexer;
    const length = Math.min(src.length, OWNER_MD_MAX_TOTAL_INPUT);
    /** The open fence: its character and its run length, or null. */
    let fence = null;
    for (let start = 0; start < length;) {
      const nl = src.indexOf("\n", start);
      const end = nl === -1 || nl > length ? length : nl;
      const line = src.slice(start, end);
      // A line this long cannot be a definition marked could have read, and its
      // def rule overflows the stack on one: skip it outright.
      if (line.length <= OWNER_MD_MAX_INPUT) {
        if (fence) {
          const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
          if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
        } else if (LINK_DEF_CANDIDATE.test(line)) {
          const def = tokenizer.def(line);
          if (def && !links[def.tag]) {
            links[def.tag] = { href: def.href, title: def.title };
            if (++found >= BOT_MD_MAX_LINK_DEFS) break;
          }
        } else {
          const open = /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})/.exec(line);
          if (open) fence = { char: open[1][0], length: open[1].length };
        }
      }
      if (nl === -1) break;
      start = end + 1;
    }
  } catch {
    // Anything marked's own tokenizer throws on is unknowable here, so the map is
    // simply empty: every reference link renders as its literal text, exactly as
    // it would with no definitions at all, and never as a 500.
    return Object.create(null);
  }
  return links;
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
// that this pipeline already splits — together with that lexer's url-scan,
// email-run and `br`-lookahead quadratics (the last one on a paragraph of
// Unicode-whitespace lines), all four charged to one per-document budget. A
// FIFTH, a run of plain ASCII spaces in the text rule itself, is not charged:
// it is cut at the window below — and that window is the OWNER path's too (see
// "THE OWNER PATH'S TEXT-RUN WINDOW"), which is why the number lives here.
const MAX_INLINE = 500;
const MAX_DISPLAY = 2000;
const START_WINDOW = 4096;
export const BOT_MD_MAX_INPUT = 64 * 1024;

/** The bot path's text-run window is on by default. false stops the math
 *  extension reporting a text-run CUT and leaves its `$`/`\(`/`\[` hint exactly
 *  as it is — math detection with no window at all, the "window off" side of
 *  tests/md-unicode-ws.test.js and its reference for the math sweep. */
let botTextWindowOn = true;

/** @param {boolean} enabled false renders the bot path with no text-run cut in
 *  the math extension's inline start() (the math hint is unchanged and still
 *  covers the whole source). */
export function setBotTextWindowEnabled(enabled) {
  botTextWindowOn = enabled !== false;
}

/**
 * What the bot path's text-run window did in the LAST renderBotMarkdown call:
 * how many text-run cuts the math extension's start() FOUND (a cut is found by
 * a scan and reused for every shorter suffix until the tokenizer passes it, so
 * this counts cuts, not calls). Reset at the start of every renderBotMarkdown
 * call. Read by tests/md-unicode-ws.test.js, which has to show that the
 * documents it compares byte for byte are not all too short to reach the window.
 */
export const mdBotTextWindowStats = { cuts: 0 };

// ---------------------------------------------------------------------------
// WHERE A TEXT-RUN CUT MAY LAND.
//
// Both paths cap marked's inline text rule by reporting a start() hint: the bot
// path's math extension (inlineStart) and the owner path's ownerTextWindow, both
// from textRunCut below, and there is no "once the window holds no opener" to it.
// marked turns the hint into
// `l = e.substring(0, p + 1)` and hands ONLY that slice to the text tokenizer,
// so the cut reads as end-of-input to marked's own regexes. The pieces are
// merged back (`p.raw += o.raw, p.text += o.text`), which makes most cuts
// invisible — but NOT every cut:
//
//   - the text rule stops at the end of the slice, so a multi-character token
//     that crosses the cut is never matched: `https://…` cut inside the
//     protocol is plain text, an email `foobar@example.com` cut after the `f`
//     links to `oobar@example.com`, and `x  \nnext` cut inside the spaces keeps
//     a space the `br` rule would have eaten (`x <br>` for `x<br>`);
//   - the resume position is where the NEXT token is tried, and only a text
//     token there merges back into the one before it.
//
// So the cut may only sit BETWEEN TWO CHARACTERS of one run of spaces/tabs and,
// in a run that ends in a line break, only before that run's final stretch of
// ASCII SPACES. Nothing else in the inline rules can start at a space, and the
// text token on the far side of the cut merges back into the near one — so the
// two renders are byte-identical. Verified over 3,000 seeded documents and a
// set of boundary documents at every offset around the cut
// (tests/md-unicode-ws.test.js).
//
// THE INVARIANT, stated against the rule that decides it. Both paths parse with
// gfm + `breaks: true`, where marked 17.0.6's inline rules are
//
//   text: /^([`~]+|[^`~])(?:(?= *\n)|(?=[email chars]+@)|[\s\S]*?(?:(?=[\\<!\
//          [`*~_]|\b_| *\n|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|www\.|$)|
//          [^ ](?= *\n)|[^email chars](?=[email chars]+@)))/
//   br:   /^( *|\\)\n(?!\s*$)/
//
// (the two email alternatives spelled out in short to keep this readable), and
// two consequences own the cut:
//
//   - ` *\n` — zero or more SPACES then a newline — is in the text rule's stop
//     set, so the rule ends its token at the FIRST index q where the rest of the
//     line is spaces followed by `\n`, and `br` then takes `[q, \n]`, whose raw
//     spaces never reach the page. A cut AFTER q leaves those spaces in a text
//     token instead, so no cut may sit inside that final all-space stretch; a cut
//     at q itself — just after the run's last TAB, which ` *` cannot cross — is
//     invisible, because the text rule stops there on its own in both parses.
//     That ONE exclusion is the whole rule. Excluding every run followed by a
//     line break (what this did before) left `"a" + " " * N + "\t\nb"`
//     quadratic, the tab being enough to make ` *\n` fail while the lazy
//     `[\s\S]*?` retried it at every position — measured 1,175 ms for 60 KB on
//     the bot path (main: 89 ms), 5,255 ms for the 128 KB owner head and
//     4,576 ms for the 1 MiB chunked document.
//   - no OTHER stop alternative can fire inside a space/tab run: `[\\<!\[`*~_]`,
//     `\b_`, `[hH][tT][tT][pP][sS]?`, `www\.`, `ftp://` and the email
//     alternatives all need a non-space character (the bare `http` word a
//     greedy scan likes to sit on cannot start at a space either), so no token
//     can start there and none can span the cut.
//
// A stretch with no usable index at all is left uncut, and that stays linear: the
// quadratic this window exists for is one long run of spaces (each position of
// the text rule's lazy `[\s\S]*?` walks the rest of the run looking for the
// ` *\n` that is not there), and a stretch with no two adjacent spaces/tabs has
// no such run. A run whose spaces all sit before a line break is the mirror
// image: ` *\n` matches at every position of it, so the rule stops immediately
// and there is nothing to walk.

/** Space or tab — the two characters marked's inline `br` rule and the text
 *  rule's space-run lookahead look at. */
function isCutSpace(code) {
  return code === 32 || code === 9;
}

/**
 * The index a text-run cut may use, or -1 when the stretch has none.
 *
 * `src` is what marked passes to a start(): the inline source minus its first
 * character, so the returned `p` cuts BETWEEN `src[p - 1]` and `src[p]` (the
 * text token then consumes the source up to and including `src[p - 1]`).
 *
 * The last usable index at or below `limit` wins; failing that, the FIRST one
 * after it (a long run of spaces with no gap in the window is still cut, just
 * later); failing that, -1 — no cut, see the invariant above on why that is
 * linear. `limit` is START_WINDOW for both paths.
 *
 * A run that ends in a line break is usable only up to and including its last
 * TAB (see the invariant): `hi` backs up over the run's trailing spaces,
 * because that final all-space stretch is the one ` *\n` stops at and `br`
 * takes. A run with no tab before the break therefore has no usable index at
 * all, which is the one case the old "a run before a line break is never cut"
 * rule got right.
 * @param {string} src marked's start() argument
 * @param {number} limit the largest preferred cut index
 * @returns {number} a cut index in [1, src.length - 1], or -1
 */
function textRunCut(src, limit) {
  const n = src.length;
  if (n < 2) return -1;
  let before = -1; // the last usable index at or below `limit`
  let after = -1; // the first usable index above it
  let i = 0;
  while (i < n) {
    if (!isCutSpace(src.charCodeAt(i))) {
      i++;
      continue;
    }
    // The maximal run of spaces/tabs starting here: src[i .. end - 1]. A cut
    // inside it is between src[p - 1] and src[p] with Math.max(i + 1, 1) <= p
    // <= hi (p >= 1 whatever i is, which is all a cut at p == 1 needs).
    let end = i + 1;
    while (end < n && isCutSpace(src.charCodeAt(end))) end++;
    let hi = end - 1;
    if (end < n && src.charCodeAt(end) === 10 /* \n */) {
      // The run ends in a line break: past its last tab the run is ONE all-space
      // stretch, which the text rule stops at and `br` takes, so the cut may go
      // no further than just past that tab. A run that is all spaces backs up to
      // hi = i, below lo = i + 1: no cut in it, exactly as before.
      while (hi >= i && src.charCodeAt(hi) === 32) hi--;
      hi++;
    }
    const lo = Math.max(i + 1, 1);
    if (lo <= hi) {
      if (hi <= limit) {
        before = hi;
      } else {
        if (before < 0) {
          const first = Math.max(lo, limit + 1);
          if (first <= hi) after = first;
        }
        // This run reaches past the limit, so no later candidate is smaller
        // than `before` and `after` is the first one past it: done.
        break;
      }
    }
    i = end;
  }
  return before >= 0 ? before : after;
}

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

/** Block start() hint memo. marked calls the block hint on successive SUFFIXES
 *  of the source one block-lexing frame works through (once per block position),
 *  so a scan's answer — "the next opener is D chars from the end", or "none up
 *  to D chars from the end" — stays valid for every later, shorter suffix.
 *  Fingerprinted (sameDoc), so a different string misses rather than reusing a
 *  foreign answer. */
function makeBlockMemo() { return { src: null, len: 0, hit: null, scanned: 0 }; }
let blockMemo = makeBlockMemo();
/** Block-opener validity, keyed by distance-from-end + a fingerprint. */
let blockValid = new Map();
const BLOCK_CHECKS_PER_CALL = 16;
const BLOCK_CANDIDATES_PER_CALL = 64;

function sameDoc(memo, src) {
  if (memo.src === null || src.length > memo.len) return false;
  const off = memo.src.length - src.length;
  return memo.src.slice(off, off + 32) === src.slice(0, 32);
}

// ---------------------------------------------------------------------------
// THE INLINE start() MEMO — ONE PER INLINE FRAME.
//
// marked calls an inline start() hint on successive SUFFIXES of ONE inline
// source: its inlineTokens loop takes `src = src.substring(token.raw.length)`
// and asks every hint about `src.slice(1)`, for every inline block in the
// document (a paragraph, a heading, a table cell, a list item's text) AND for
// every NESTED inline source inside one (a link label, an image's alt text, an
// emphasis span), because marked's own link/em tokenizers call
// `this.lexer.inlineTokens` again. A scan's answer is therefore valid for the
// whole tail of ONE inlineTokens call, and for nothing else.
//
// It used to be ONE memo per parse, protected by a 32-character fingerprint
// (sameDoc above, and an owner twin that compared both ends). A fingerprint is
// not a proof: two different inline blocks can agree on it, and the answer that
// then survived was usually "no cut in this source" — which silenced the window
// for a 128 KB space run in a LATER block (the quadratic the window exists for,
// back in full) or handed a block a cut no run of its own carries. boundedLexer
// therefore pushes a FRESH memo around every `inlineTokens` call and pops it
// after (see the wrapper there): frames nest strictly — a nested call opens its
// own — and inside one frame every source asked about is a suffix of that
// frame's own first source, so "what a scan proved about the tail" is exactly
// what the next call needs. No fingerprint, and no way to answer for a source
// the memo has not seen.
//
// The answers are DISTANCES FROM THE END of the scanned source, in two separate
// fields: a scan that found no text-run cut says nothing about where the next
// `$` is, and a source with no cut must still report a math opener that sits
// beyond the window.
// @returns {{math: number|undefined, cut: number|undefined}}
function makeInlineMemo() {
  // `undefined`: not scanned yet in this frame. Otherwise the distance from the
  // end of the source to the nearest math opener (`-1`: none anywhere in it) and
  // to the text-run cut (`-1`: no usable cut anywhere in it). Both "the first
  // one" and "none" keep their meaning for every shorter suffix of the source
  // they were scanned in, which is why nothing else has to be remembered.
  return { math: undefined, cut: undefined };
}

/** The memos of the inlineTokens frames open right now, innermost last. */
let inlineFrames = [];
/** The memo of the frame being lexed, or a throwaway one outside any frame
 *  (which cannot happen — an inline start() is only ever called from inside
 *  one — and stays correct rather than shared if it ever does). */
function inlineFrameMemo() {
  return inlineFrames.length ? inlineFrames[inlineFrames.length - 1] : makeInlineMemo();
}

/** Where the inline hint looks for math: `$` (also the first character of
 *  `$$`) and the two backslash spellings. Hinting at a position that turns out
 *  not to tokenize costs nothing: marked's text rule stops there in main too,
 *  and `\` is in its own stop set. */
const MATH_START = /\$|\\\(|\\\[/;

/**
 * The bot path's inline start() hint: the nearest place the inline lexer has to
 * look, i.e. the MINIMUM of "the next math opener" and "the text-run cut", or
 * undefined when this source has neither.
 *
 * THE MATH HALF MUST NOT DEPEND ON THE CUT. marked's text rule does not stop at
 * `$`, so this hint is the only thing that ever makes it stop where math starts.
 * A hint built from the CUT alone lost every `$x$` past it
 * (`prose(5000) + " $x^2$ end"` rendered the math as raw dollars), and a "no
 * cut" remembered for the whole source silenced the scan for every shorter
 * suffix, so math that later fell INSIDE a window was lost too. The opener scan
 * therefore covers the WHOLE source — not just START_WINDOW, and not only up to
 * the cut — once per frame (see makeInlineMemo), and the hint is the minimum of
 * the two answers: when the cut comes first the text token stops there and the
 * opener is found from the shorter suffix; when the opener comes first nothing
 * cuts past it. With the window OFF the cut half is simply absent, so the
 * seam renders math detection with no window at all — the differential's
 * reference side.
 *
 * A cut is harmless only where textRunCut says it is. It is NOT harmless at
 * block level at all — a paragraph cut is re-joined with "\n", which `breaks`
 * turns into <br> — so the block hint never fakes one.
 * @param {string} src marked's start() argument
 * @returns {number|undefined}
 */
function inlineStart(src) {
  const memo = inlineFrameMemo();
  // 1. The math opener: the first one anywhere in this frame's source, measured
  // from its END so the answer holds for every shorter suffix. A call whose
  // suffix has moved PAST the opener last reported — the tokenizer consumed it —
  // scans again from here, because there may be another one the frame has not
  // looked at yet.
  if (memo.math === undefined || (memo.math >= 0 && src.length < memo.math)) {
    const m = MATH_START.exec(src);
    memo.math = m ? src.length - m.index : -1;
  }
  // A hint of 0 is a real hint: it stops the text token after the source's
  // FIRST character, which is where an opener at this suffix's own index 1 sits
  // (p counts from the source marked passes in, which is this one minus one
  // character — see the docstring above).
  let hint = memo.math >= 0 ? src.length - memo.math : -1;
  // 2. The text-run cut: none at all with the window off, none for a short
  // source (a short run is cheap — see textRunCut).
  if (botTextWindowOn && src.length > START_WINDOW) {
    let c = memo.cut;
    if (c === undefined || (c > 0 && src.length <= c)) {
      // Not scanned yet in this frame, or the tokenizer has advanced PAST the
      // last cut reported: look again from here, because this suffix's own tail
      // may hold the next one.
      const cut = textRunCut(src, START_WINDOW);
      c = memo.cut = cut < 0 ? -1 : src.length - cut;
      if (cut >= 0) mdBotTextWindowStats.cuts++;
    }
    if (c > 0 && src.length > c) {
      const p = src.length - c;
      if (hint < 0 || p < hint) hint = p;
    }
  }
  return hint < 0 ? undefined : hint;
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

// ---------------------------------------------------------------------------
// TWO MORE QUADRATIC BLOCK-LEXER SHAPES — a table precheck and a scan budget
//
// The depth counter above bounds NESTING. It does not bound two other shapes
// the block lexer is quadratic on, both measured on this tree (marked 17.0.6 +
// the math extension; CPU ms for one whole render, before the guards below):
//
//   shape (repeated to fill)      8 KB   16 KB   32 KB   64 KB   128 KB owner
//   "a\n-|-\n"                    117     236     795    2850       11374
//   "|a\n|-|-\n"                   38     125     469    1771        7311
//   "a\n-\n"                      41     106     395    1070        3942
//   "a|b\n-|-|-\n"                 30     112     330    1243        5121
//   "a\n -\n"                     21      80     312    1213        4802
//   "    x\n>     y\n"             19      53     190     676        2744
//
// …i.e. ~4x per doubling. Both are O(rest of the document) work done once per
// line, and neither is nesting, so neither the depth counter nor the re-lex
// byte budget (which only counts marked's `this.blockquote(f)` / `this.list(f)`
// re-lex path) can see them.
//
// SHAPE 1, THE TABLE. The block lexer tries `table` at every line. marked's gfm
// table RULE is header row + delimiter row + `rows` group, and that rows group
// (`(?:(?! *\n|hr|heading|…).*(\n|$))*`) eats EVERY following line; the
// tokenizer then rejects the table — the delimiter row has no `|`/`:`
// (`"a\n-\n"`), or its column count differs from the header's (`"a\n-|-\n"`:
// one header cell, two delimiter cells) — and the block lexer advances by ONE
// line and does it again. So each line rescans the rest: measured per
// TOKENIZER at 8/16/32/64 KB (same shape, plain marked 17.0.6, CPU ms summed
// over every call), `table` costs 71/170/594/2306 ms and the PARAGRAPH
// tokenizer another 20/37/162/442 ms, because the gfm paragraph rule folds the
// same table rule into its stop lookahead (marked's `edit()` strips the `^`
// anchor, so inside the lookahead it can start anywhere) — the paragraph is
// what stops the paragraph at a table-shaped start, and it pays the same rows
// scan to decide (one `paragraph.exec` at a table-shaped start matches 5
// characters and still costs, like one `table.exec`, a linear pass of 0.03 ms
// at 8 KB rising to 0.13 ms at 64 KB).
//
// The fix is the one marked took upstream (markedjs/marked#4213, #4229, not
// released in 17.0.6): decide whether a table STARTS from the header and
// delimiter rows alone. `tableStartsHere` below does exactly that — it runs
// marked's OWN table rule (and marked's own `tableDelimiter`, `tableAlignChars`
// and `splitCells` rules, so the acceptance test cannot drift from the
// tokenizer's) on a source truncated after the delimiter row, and the
// tokenizer is never called when the answer is no. It cannot reject a table
// marked accepts: the rows group only ever extends the match, never decides it,
// and the acceptance checks below are marked's own, in marked's own order.
// The paragraph rule gets the same treatment: `paragraphWithoutTableScan`
// swaps the table rule folded into its lookahead for the header-only one, which
// decides every stop IDENTICALLY (a lookahead only asks "does a table start
// here?") at O(header) instead of O(rest). That equivalence is exact, not
// approximate: the full rule is the header-only match followed by
// `(?:\n(rows)\n*|$)`, `rows` may match ZERO lines, and the header-only form
// ends with `(?:\n|$)`, so the two rules match exactly the same prefixes of a
// source — every string one matches, the other does too. The header and
// delimiter cap groups are within-line for the same reason, so truncating the
// source after the delimiter row cannot change them either. Both are per-Lexer
// (the rules object is the Lexer's own, never marked's prototype or the shared
// rule table), and neither can change the rendered bytes: the differential test
// in tests/md-block-guard.test.js renders 2,000 seeded table-shaped documents
// with and without the precheck and requires identical HTML.
//
// SHAPE 2, A QUOTE HOLDING INDENTED CODE, `"    x\n>     y\n"`. The line
// `    x` is an indented code block (one token, one line). The line `>     y`
// is a quote whose content `    y` is ALSO an indented code block, and that is
// what makes it quadratic: marked's blockquote RULE matches the WHOLE REMAINING
// DOCUMENT (on a 32 KB document the rule matches 32,762 of 32,762 characters)
// while the token it produces is 7 characters long — and it is asked once per
// quote line (2,341 calls at that size). The rule's folded `paragraph`
// alternative has no `code` in its stop set — correctly, an indented line
// continues a paragraph — so after the quoted `    y` it happily swallows every
// following `    x` line as a lazy continuation, and only stops at the next `>`.
// The TOKENIZER then throws all of that away: its chunk loop breaks as soon as
// the last block token of the first chunk is a `code` token, so all it ever
// returns is the first chunk (7 chars on a four-line sample whose remaining 22
// the rule had matched in full). Cost: one full-document regex scan per quote
// line. Measured per tokenizer at 8/16/32/64 KB, the `blockquote` tokenizer is
// 13.1/52.5/179.5/641.6 ms of the whole lex's 17/58/190/660 ms — the only rule
// whose cost grows with the rest of the document (`code`, the second most
// expensive, is 0.8-5.0 ms at all four sizes).
//
// There is no cheap precheck that keeps the output identical here (the match is
// legitimately "everything until the next block start", and a lazy paragraph
// really is part of the quote), so this one is BOUNDED instead, the same way
// the re-lex path is: a per-parse budget of BLOCKQUOTE OVERRUN — the characters
// the rule SCANS that the token it produces does NOT use, i.e. the rule's
// matched span minus the token's `raw.length` — `max(1 MiB, 8 × the document)`,
// the same floor and factor.
//
// The overrun is what makes the budget invisible to ordinary content at ANY
// depth: when the match IS the token the overrun is zero, and a quote's match
// always does cover the quotes nested inside it, so a 128 KB document quoted
// sixteen levels deep is charged nothing at all. Charging the whole span
// instead — the first cut of this guard — charged EVERY nesting level the
// whole remaining document: a body quoted ten levels deep at 128 KB (every line
// carrying the full prefix, so each level's rule match AND its token are the
// whole remaining document) summed to 1.08 MB of span, past the 1 MiB budget,
// and everything the guard saw after that point came out as escaped text, on a
// document that main (no budget at all) renders in full. The shape above still
// spends the budget, because its rule matches the rest of the document and the
// token keeps 7 characters of it: each quote line is charged the rest of the
// document, and the budget is gone after ~16 quote lines at 64 KB. Past it the
// remainder is shown as escaped text, exactly like the depth guard's.
//
// Measured WITH both guards (same shapes, CPU ms, one whole render; the 64 KB
// column is renderBotMarkdown, the 128 KB column renderMarkdown's head):
//
//   shape (repeated to fill)     64 KB    128 KB (owner)
//   "a\n-|-\n"                  172       374
//   "|a\n|-|-\n"                 156       204
//   "a\n-\n"                    177       195
//   "a|b\n-|-|-\n"               128       336
//   "a\n -\n"                   156       188
//   "    x\n>     y\n"            71       106
//
// …i.e. 6x to 36x faster, and the remaining cost is the per-block work those
// documents honestly need (32,000 paragraph tokens at 64 KB). Ordinary content
// pays nothing: a 58 KB post of headings, prose, tables and fences renders in
// 15 ms with the shape-1 guard on and 14 ms with it off. tests/md-block-guard.test.js
// holds every number above to 1,000 ms / 2,000 ms inside a worker with a 5 s kill
// (the bounds leave room for CI runners ~3.5x slower than the box these were
// measured on, and still sit far below the 4-27 s cliffs), and its differential
// test requires the guard to be byte-transparent on 2,000 seeded table-shaped
// documents.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A THIRD QUADRATIC BLOCK-LEXER SHAPE — an empty list marker followed by a TAB
//
// Neither guard above sees this one, and it is not a rejected table attempt
// either. A list marker with nothing after it but a TAB is not a list item:
// marked's list rule is `^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]+?)?(?:\n|$)`,
// so `[ \t][^\n]+?` needs a character after the tab, and `-\t` leaves the tab
// unconsumed. The line falls through to `text`, which takes exactly ONE line, so
// the document becomes a one-line paragraph per line — a fresh block position
// per line — and every one of those positions asks `lheading`, whose rule is
// “paragraph run, then `\n {0,3}(=+|-+) *(?:\n+|$)`”. A failed attempt has by
// then scanned the whole remaining run, and here the run never ends: `  -\t` is
// neither blank nor the start of any block marked knows (the tab is not the
// space its list rule wants, and ` {0,3}\t` needs the tab within the first
// four characters). So each line rescans the rest of the document. Measured
// before the guard, one whole render, CPU ms:
//
//   shape (repeated to fill)     16 KB   32 KB   64 KB   128 KB (owner)
//   "  -\t\n"                      …       …      4000    16900
//   "   *\t\n"                     …       …      3300        …
//   "*\t\n"                        …       …      2500    10700
//   "+\t\n"                        …       …      2300        …
//   "1.\t\n" / "1)\t\n"            …       …      1700        …
//   "a\n*\t\n"                     …       …      1500        …
//
// The cost is not even monotone in size (`"-\t\n"` is ~1.0 s at 32 KB and 82 ms
// at 64 KB) — that is the regex engine's backtracking, not a guard — which is
// why the test pins every listed unit at 16, 32 and 64 KB rather than testing
// one size. Profiled at 32 KB, `lheading` is 556 of the render's 586 ms.
//
// The fix is a PRECHECK, like shape 1's: `setextRunAnswer` answers “can a setext
// underline end the paragraph run that starts here?” by walking lines only
// until the run would end, and the tokenizer is not called at all when the
// answer is no. Two things make it cheap enough to be quadratic no more:
//
//   * the walk is per LINE and allocation-free (isSetextUnderline and marked's
//     own stop alternation, extracted once per rule source —
//     lheadingStopPattern), where marked's rule is a backtracking scan over the
//     whole run per call; and
//   * it is MEMOIZED by distance-from-end (makeSetextMemo, sameDoc): every later
//     call in a frame is on a shorter suffix of the source the answer was
//     computed on, where a line at distance d from the end is still at distance
//     d — so a document of nothing but `  -\t` lines is scanned ONCE, and a
//     paragraph run that keeps being interrupted costs one scan per
//     interruption, each starting where the last one stopped: linear per frame.
//     The memo belongs to the FRAME (it is pushed and popped around
//     blockTokens), because a nested block's source is not a suffix of the
//     block containing it: one set of shared slots let a list item's answer be
//     reused for a quote 30 characters away and changed the quote's heading
//     into a paragraph plus an `<hr>`.
//
// It cannot reject a heading marked would make: the walk's stop set is marked's
// OWN (the alternation is lifted out of the installed rule, so it is neither a
// subset — which let the walk re-scan runs marked had abandoned, the 4-27 s
// bypass — nor a superset, which would stop the walk on a line marked reads as
// text and reject a heading it makes), and a line holding U+2028 or U+2029 ends
// it because the rule's `.` cannot consume them. FALSE is only returned when the
// walk reaches a line that ends the run and no line before it was an underline;
// TRUE just means “ask marked”, which still decides. The guard also installs
// nothing at all unless the installed rule still has the run shape this was
// verified against (lheadingStopPattern), so a future marked that reworks the
// rule keeps its own behavior. Tests: 2,000 seeded documents — short lines
// mixing `-`/`*`/`+`/`=`, digits with `.`/`)`, tabs, 0-4 spaces, text, blank
// lines, list items, quotes and code — must render BYTE-IDENTICALLY with the
// guard on and off on both paths (setMdLheadingGuardEnabled is the seam), a
// 5,000-document fuzz mixing nested quotes and lists with every run end above
// must as well, and every unit in the table above must stay under 1,000 ms at
// 16/32/64 KB on the bot path and under 2,000 ms for the 128 KB owner head.
//
// Measured WITH the guard (same shapes, CPU ms, one whole render; 16/32/64 KB on
// the bot path, 128 KB owner head, on the box the 1,000/2,000 ms bounds in the
// test were set for):
//
//   shape (repeated to fill)     16 KB   32 KB   64 KB   128 KB (owner)
//   "  -\t\n"                     0.8     0.1     0.1        0.3
//   "\t\n  -"                    33      37      69       126
//   "   *\t\n"                    0.6     0.1     0.2        1
//   "*\t\n"                       0       0.1     0.1        2
//   "-\t\n"                       0.3     0.2     0.3        0.7
//   "+\t\n"                      16      18      24        52
//   "1.\t\n"                      5      10      16        31
//   "1)\t\n"                      4       8      17        35
//   "a\n*\t\n"                    42      83      99       165
//
// …plus the run ends the walk used to miss: 64 KB of each bad unit as LINES
// followed by an HTML line, a `|-|-|` row, a U+00A0 line, a U+000B line or a
// line holding U+2028, then `a\n---`. Guarded, the worst of those 30 fixtures
// measured 148 ms on the bot path and 217 ms for the 128 KB owner head; with the
// run end missed (marked's own rules, which is what the guard answered with) the
// same fixtures measured 100-280 ms at 16 KB and 5.2-15.6 s at the owner head —
// quadratic (the review measured 7.1 s / 27 s), because every filler line is its
// own block position and paid for the whole run scan.
// ---------------------------------------------------------------------------

/**
 * The characters marked's `edit()` strips out of a rule source it folds into
 * another rule — `valSource.replace(other.caret, '$1')` in marked 17.0.6's
 * rules.ts, whose `other.caret` this is. Copying the transformation (rather
 * than the folded regex) is what lets the paragraph rule be rebuilt below from
 * marked's own table rule instead of from a re-typed copy of it.
 */
const RULE_CARET = /(^|[^\[])\^/g;

/**
 * marked 17.0.6's gfm table rule up to and including the delimiter row —
 * `block.gfm.table` from its rules.ts, copied verbatim with the trailing
 * `(?:\n(rows)\n*|$)` group dropped. That group only extends the MATCH (the
 * rows), so it can never change whether the rule matches; dropping it is what
 * makes "does a table start here?" an O(header) question. Verified against the
 * installed marked: `boundedLexer` only uses the header-only form when the
 * installed `block.table` source still starts with this exact prefix, so a
 * future marked that changes the rule turns this guard off instead of breaking.
 */
const TABLE_HEAD_SOURCE = "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)";

/** The paragraph rule rebuilt per installed source (there are only ever one or
 *  two: gfm and non-gfm share the folded table rule). `null` means "could not
 *  rebuild it — keep marked's own", which is a slower parse, never a wrong one. */
const headerOnlyParagraphs = new Map();

/**
 * The first two lines of `src` (header row + delimiter row), WITHOUT the line
 * break that ends the delimiter row, so marked's table rule sees the same
 * prefix it would see at the head of the full document and can still take its
 * `$` branch. `null` when there is no second line, i.e. no delimiter row.
 * @param {string} src
 * @returns {string|null}
 */
function tableHead(src) {
  const first = src.indexOf("\n");
  if (first < 0) return null;
  const second = src.indexOf("\n", first + 1);
  return second < 0 ? src : src.slice(0, second);
}

/**
 * How many cells marked's `splitCells` would find in a table header row — the
 * count `Tokenizer.table` compares against the delimiter row's. Copied from
 * marked 17.0.6's helpers.ts (`splitCells(row)` with no count argument): an
 * even run of backslashes escapes a pipe (so `\|` does not split), the split
 * is on ` |`, a leading and a trailing empty cell are dropped. The cell TEXT is
 * not rebuilt here — only the count matters.
 * @param {string} row
 * @param {object} other marked's `other` rules
 * @returns {number}
 */
function tableCellCount(row, other) {
  const piped = row.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    for (let i = offset - 1; i >= 0 && str[i] === "\\"; i--) escaped = !escaped;
    return escaped ? "|" : " |";
  });
  const cells = piped.split(other.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.length;
}

/**
 * Would marked's table tokenizer ACCEPT a table that starts at the head of
 * `src`? This is marked's own acceptance test (see its Tokenizer.table): the
 * rule must match, the delimiter row must contain a `|` or a `:`, and the
 * delimiter row must have exactly as many cells as the header row. Everything
 * it uses (`rules.block.table`, `rules.other.*`) is marked's, so the two cannot
 * disagree about syntax; the only thing not delegated is `splitCells`, whose
 * COUNT is re-derived above (a count cannot be read off the tokenizer without
 * running it).
 *
 * The rule runs on the first two lines only: the rows after them extend the
 * match, never its acceptance, and skipping them is the whole point (see "TWO
 * MORE QUADRATIC BLOCK-LEXER SHAPES" above). TRUE is only ever an
 * "I don't know, ask the tokenizer" answer, so a miss here costs a call and
 * never a table.
 * @param {object} rules the Lexer's rules (block + other)
 * @param {string} src
 * @returns {boolean}
 */
function tableStartsHere(rules, src) {
  const head = tableHead(src);
  if (head === null) return true;
  // Cheap first: the delimiter row can only start with `|`, `:` or `-` (after
  // up to three spaces), so this one indexOf costs a few comparisons instead of
  // a regex exec at every block position of every document.
  let at = head.indexOf("\n") + 1;
  for (let spaces = 0; spaces < 3 && head.charCodeAt(at) === 32 /* space */; spaces++) at++;
  const first = head.charCodeAt(at);
  if (first !== 124 /* | */ && first !== 58 /* : */ && first !== 45 /* - */) return false;
  const cap = rules.block.table.exec(head);
  // No match, or a delimiter row with no `|`/`:`: marked rejects it — and it
  // would reject the same prefix in the full source.
  if (!cap || !rules.other.tableDelimiter.test(cap[2])) return false;
  const aligns = cap[2].replace(rules.other.tableAlignChars, "").split("|");
  return tableCellCount(cap[1], rules.other) === aligns.length;
}

/**
 * marked's gfm paragraph rule with the table alternative IT FOLDS INTO ITS STOP
 * LOOKAHEAD replaced by the header-only one (see "SHAPE 1" above). The
 * lookahead asks only "does a table start here?", and the header-only rule
 * answers that question identically (the dropped group extends the match, it
 * never decides it), so the paragraph rule stops in exactly the same places —
 * at O(header) per stop instead of O(rest of the document).
 *
 * The substitution is done on the COMPILED rule source (marked folds the table
 * rule in at module load, so the rule's own `table` entry is not consulted) and
 * is guarded: if the installed paragraph rule does not contain the folded table
 * rule as marked folds it, this returns `null` and the lexer keeps marked's own
 * rule. Group numbering after the substitution differs only for groups nothing
 * reads (the paragraph tokenizer uses `match[0]` and `match[1]`; the table
 * groups inside the lookahead were never captured for anyone).
 * @param {object} blockRules the Lexer's `rules.block`
 * @returns {RegExp|null}
 */
function paragraphWithoutTableScan(blockRules) {
  const table = blockRules.table;
  const paragraph = blockRules.paragraph;
  if (!table || !paragraph || !table.source.startsWith(TABLE_HEAD_SOURCE)) return null;
  const cached = headerOnlyParagraphs.get(paragraph.source);
  if (cached !== undefined) return cached;
  const folded = table.source.replace(RULE_CARET, "$1");
  const headerOnly = (TABLE_HEAD_SOURCE + "(?:\\n|$)").replace(RULE_CARET, "$1");
  const rule = paragraph.source.includes(folded)
    // A function replacement: the sources contain `$` sequences of their own.
    ? new RegExp(paragraph.source.replace(folded, () => headerOnly), paragraph.flags)
    : null;
  headerOnlyParagraphs.set(paragraph.source, rule);
  return rule;
}

// --- the setext-heading precheck (see "A THIRD QUADRATIC BLOCK-LEXER SHAPE") --

/**
 * The opening of marked 17.0.6's `lheading` paragraph run — the LAZY
 * `(?:.|\n(?!STOP))+?` group — and the tail that follows it. `STOP` is what
 * decides where a paragraph run ends, and the precheck below does NOT re-type
 * it: a hand-written version recognized only PART of it (an HTML line, a GFM
 * table delimiter row and a line of Unicode whitespace were read as run text),
 * so the walk ran past a run marked had already abandoned and marked's
 * quadratic lheading scan came straight back — measured 7.1 s on the bot path
 * at 64 KB and 27 s on the owner's at 128 KB, for a fill of the bad units below
 * (`  -\t`, `-\t`, `*\t`, `+\t`, `1.\t`, `a\n*\t` as lines), one such run end
 * and a trailing `a\n---`. The installed rule's own alternation is EXTRACTED instead and
 * the walk applies it, sticky, at every line start, so the two stop at exactly
 * the same lines. A future marked whose rule no longer opens its run here, or
 * whose tail changed, extracts nothing and the precheck installs NOTHING —
 * marked's own rule then runs as before, which is a slow parse of the shapes
 * above, never a wrong one.
 */
const LHEADING_RUN_OPEN = "((?:.|\\n";
const LHEADING_STOP_OPEN = "(?!";
const LHEADING_RUN_TAIL = ")+?)\\n {0,3}(=+|-+) *(?:\\n+|$)";

/**
 * The index of the `)` closing the group opened at `open`, in a regex SOURCE,
 * or -1. Escapes are skipped and character classes tracked, so the `[^\n>]` and
 * `[:\- ]` classes inside marked's alternatives cannot be mistaken for a group.
 * @param {string} source
 * @param {number} open index of the `(`
 * @returns {number}
 */
function regexGroupEnd(source, open) {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 92 /* backslash */) { i++; continue; }
    if (inClass) { if (c === 93 /* ] */) inClass = false; continue; }
    if (c === 91 /* [ */) { inClass = true; continue; }
    if (c === 40 /* ( */) { depth++; continue; }
    if (c === 41 /* ) */ && --depth === 0) return i;
  }
  return -1;
}

/** Extracted stop alternations, keyed by the installed rule source: there is one
 *  per parse mode (gfm and non-gfm), so a couple for the process — the Lexer,
 *  and with it the rule source, is rebuilt on every render. */
const lheadingStops = new Map();

/**
 * marked's `lheading` run-stop alternation as a STICKY regex that answers, at a
 * line start, "does the paragraph run end here?", or `null` when the installed
 * rule no longer has the shape this extraction was verified against.
 * @param {string} source the installed `block.lheading` rule source
 * @returns {RegExp|null}
 */
function lheadingStopPattern(source) {
  const cached = lheadingStops.get(source);
  if (cached !== undefined) return cached;
  let stop = null;
  const open = source.indexOf(LHEADING_RUN_OPEN);
  if (open >= 0) {
    const groupOpen = open + LHEADING_RUN_OPEN.length;
    const groupEnd = source.startsWith(LHEADING_STOP_OPEN, groupOpen)
      ? regexGroupEnd(source, groupOpen)
      : -1;
    if (groupEnd > groupOpen && source.startsWith(LHEADING_RUN_TAIL, groupEnd + 1)) {
      // Sticky, never global: every alternative is a prefix test on ONE line and
      // must be tried at the line start the walk is at, not at a later one.
      // The lookahead's own `(?!` is dropped with the group it belongs to.
      stop = new RegExp(source.slice(groupOpen + LHEADING_STOP_OPEN.length, groupEnd), "y");
    }
  }
  lheadingStops.set(source, stop);
  return stop;
}

/**
 * Is the line `src[from, to)` — the line break is NOT in that range — a setext
 * underline, marked's ` {0,3}(=+|-+) *(?:\n+|$)`? Written as character tests
 * rather than a regex because this runs once per line of every paragraph run
 * the block lexer walks: a slice plus a regex exec per line is a per-line
 * allocation, which is the cost this guard exists to avoid.
 * @param {string} src
 * @param {number} from line start
 * @param {number} to line end (exclusive)
 * @returns {boolean}
 */
function isSetextUnderline(src, from, to) {
  let at = from;
  for (let spaces = 0; spaces < 3 && at < to && src.charCodeAt(at) === 32; spaces++) at++;
  const mark = src.charCodeAt(at);
  if (mark !== 61 /* = */ && mark !== 45 /* - */) return false;
  while (at < to && src.charCodeAt(at) === mark) at++;
  while (at < to && src.charCodeAt(at) === 32) at++;
  return at >= to;
}

/**
 * Does the line `src[from, to)` END the paragraph run marked's `lheading` rule
 * scans? The rule's run is `(?:.|\n(?!STOP))+?`, so it ends exactly where
 * `STOP` matches at the line start. `stop` is marked's OWN alternation
 * (lheadingStopPattern), so this answer is exactly the rule's: an alternative
 * this missed let the walk re-scan runs marked had already abandoned (the
 * 4-27 s bypasses above), and an alternative it added would reject a heading
 * marked makes.
 * @param {string} src
 * @param {number} from line start
 * @param {number} to line end (exclusive)
 * @param {RegExp} stop marked's run-stop alternation, sticky
 * @returns {boolean}
 */
function lineEndsSetextRun(src, from, to, stop) {
  // `.` matches neither U+2028 nor U+2029, so a line HOLDING one ends the run
  // where no stop alternative can see it: the rule cannot reach anything past
  // that character, so no underline after it is reachable either. (Line endings
  // are normalised to `\n` before block lexing on every path through here, so a
  // bare `\r`, the third character `.` refuses, cannot occur.)
  for (let at = from; at < to; at++) {
    const c = src.charCodeAt(at);
    if (c === 0x2028 || c === 0x2029) return true;
  }
  stop.lastIndex = from;
  return stop.test(src);
}

/**
 * One setext-scan answer, owned by ONE block-lexing frame (see the memo frames
 * in boundedLexer). `hit` is the distance from the END of `src` to the first
 * line after the first that ends the paragraph run (`-1`: none — the run goes to
 * the end of the source) and `underline` whether that line is a setext
 * underline. Distances are from the END because every later call in a frame is
 * on a shorter SUFFIX of the same source, where a line at distance d is still
 * at distance d (the trick sameDoc and the start memos use).
 *
 * One memo per FRAME, not one per parse: `sameDoc` compares a 32-character
 * window, which a nested block's source can share with a suffix of an outer
 * one, so a memo inherited across frames answered for blocks it had never seen
 * — `- start\n  Q…\n  zzz\n\n> Q…\n> ---\n` rendered the quote's setext
 * heading as a paragraph and an `<hr>` (a wrong render, and a bypass: the stale
 * answer is TRUE, so marked's scan runs anyway). Frames nest strictly, they are
 * pushed/popped around blockTokens, and inside one frame the sources asked about
 * are strictly shorter suffixes of that frame's input, so ONE memo per frame is
 * both safe and enough.
 * @returns {{src: string|null, len: number, hit: number, underline: boolean}}
 */
function makeSetextMemo() {
  return { src: null, len: 0, hit: -1, underline: false };
}

/**
 * The walk behind the lheading precheck, memoized in `memo` (see
 * makeSetextMemo):
 * lines are visited from the second of `src` (a run needs a line of text before
 * its underline), each is asked "underline?" and then "does the run end
 * here?", and the first line that answers either gives the answer for this
 * source AND for every shorter suffix of it that still starts before that line.
 * A walk that reaches the end of the source records "no run end from line 1 to
 * the end", which holds for every shorter suffix too (line 1 of a suffix is
 * never earlier than line 1 of the source) — so a document of nothing but
 * paragraph text is scanned once, not once per line.
 * @param {string} src
 * @param {object} memo the current frame's memo
 * @param {RegExp} stop marked's run-stop alternation, sticky
 * @returns {boolean}
 */
function setextRunAnswer(src, memo, stop) {
  if (sameDoc(memo, src)) {
    if (memo.hit < 0) return false;
    if (src.length > memo.hit) return memo.underline;
  }
  const end = src.length;
  const first = src.indexOf("\n");
  const start = first < 0 ? end : first + 1;
  memo.src = src;
  memo.len = end;
  memo.hit = -1;
  memo.underline = false;
  for (let at = start; at < end;) {
    const eol = src.indexOf("\n", at);
    const lineEnd = eol < 0 ? end : eol;
    if (isSetextUnderline(src, at, lineEnd)) {
      memo.hit = end - at;
      memo.underline = true;
      return true;
    }
    if (lineEndsSetextRun(src, at, lineEnd, stop)) {
      memo.hit = end - at;
      return false;
    }
    at = lineEnd + 1;
  }
  return false;
}

/**
 * TEST SEAM: the shape-1 guard (the table precheck AND the header-only table
 * rule in the paragraph rule's stop lookahead — the two halves of the same
 * fix) can be switched off for a render, so tests/md-block-guard.test.js can
 * render one document both ways and require the HTML to be identical. Nothing
 * in the product calls this; it is off-switchable state rather than a render
 * option because the guard lives inside the Lexer, which the Marked instance
 * does not see.
 */
let mdTableGuard = true;

/** @param {boolean} enabled false renders through marked's own table rules */
export function setMdTableGuardEnabled(enabled) {
  mdTableGuard = enabled !== false;
}

/**
 * TEST SEAM: the blockquote-span budget (see "SHAPE 2") can be switched off for
 * a render, so tests/md-block-guard.test.js can render one document with and
 * without it and require the HTML to be identical. Nothing in the product calls
 * this.
 */
let mdBlockquoteSpanGuard = true;

/** @param {boolean} enabled false renders with no blockquote-span budget */
export function setMdBlockquoteSpanGuardEnabled(enabled) {
  mdBlockquoteSpanGuard = enabled !== false;
}

/**
 * TEST SEAM: the setext-heading precheck (see "A THIRD QUADRATIC BLOCK-LEXER
 * SHAPE") can be switched off for a render, so tests/md-block-guard.test.js can
 * require it to be byte-transparent. Nothing in the product calls this.
 */
let mdLheadingGuard = true;

/** @param {boolean} enabled false renders through marked's own lheading rule */
export function setMdLheadingGuardEnabled(enabled) {
  mdLheadingGuard = enabled !== false;
}

/**
 * The token a guard in boundedLexer hands back instead of lexing: ONE paragraph
 * holding the whole source the caller was lexing. `raw` is all of that source,
 * which is what makes the lexer ADVANCE (blockTokens does
 * `src.substring(token.raw.length)`) and what keeps the tokenizer re-lex path
 * (below) from re-parsing a tail it thinks was left over). `tokens` starts empty
 * and is filled with escaped text tokens by guardAndParse (see `guarded`), so a
 * text token's `text` is character data — marked escapes it in parseInline — and
 * no markup, and no backslash, is ever added to the author's words.
 *
 * It is a PARAGRAPH, exactly like marked's own `Tokenizer.paragraph` output — and
 * that means it must be indistinguishable from one to marked's
 * paragraph-CLIPPING branch as well, which is a queue invariant, not a token
 * one. `this.lexer.inline()` pushes one `{ src, tokens }` entry per paragraph
 * token, and when a quote's content is lexed with `lastParagraphClipped = true`
 * marked merges a following paragraph into the previous paragraph token with
 * `inlineQueue.pop(); inlineQueue.at(-1).src = lastToken.text` (Lexer.ts,
 * the paragraph branch). A paragraph token with NO queue entry behind it breaks
 * that pairing: the `pop` takes the NEW paragraph's own entry — the one the
 * surviving token needs — and `at(-1)` then reads the entry before it, or, at
 * the start of a lexer frame, `undefined`: measured on this tree, `"> "` x
 * 32,000 + `"x\nlazy"` threw `TypeError: Cannot set properties of undefined
 * (setting 'src')` the moment the blockquote-span guard began flattening quote
 * lines — a parse that threw, i.e. "" on the bot path. So flatGuardToken
 * (below) pushes the entry, and because that branch rewrites the entry's `src`
 * to the MERGED text, guardAndParse fills `tokens` from the entry's current
 * `src`: nothing the merge folded in is dropped.
 * @param {string} src
 * @returns {{type: string, raw: string, text: string, tokens: object[]}}
 */
function flatTextToken(src) {
  return { type: "paragraph", raw: src, text: src, tokens: [] };
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
 * A third family of quadratic shapes lives in marked's block RULES, below this
 * recursion and invisible to both counters above: a table attempt that rescans
 * the rest of the document and is then rejected, a blockquote rule that
 * matches the whole remainder and then has it dropped, and a setext-heading
 * rule that scans the whole remaining paragraph and then fails. See "TWO MORE
 * QUADRATIC BLOCK-LEXER SHAPES" and "A THIRD QUADRATIC BLOCK-LEXER SHAPE"
 * further up: the table and the setext heading are PRECHECKED away (cheap
 * rules-level decisions, no source rewriting), the blockquote is bounded by a
 * per-parse budget of blockquote OVERRUN — same floor and factor as the re-lex
 * budget — and it degrades the same way once spent.
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
 * @param {{open: number}|null} [depthState] the container levels ALREADY open
 *   around this content, for a chunk of a longer document whose cut fell
 *   mid-block (see "CROSS-CHUNK NESTING" at the top of the file): the depth
 *   counter starts there and the chunks of one document therefore share ONE
 *   MD_MAX_NEST bound — a 256 KB run of `> ` cannot show 2 x MD_MAX_NEST nested
 *   blockquotes just because it was parsed in two pieces. Omitted (null) for
 *   every single-document parse, which starts at 0 as it always did. The
 *   residual depth at the END of this content is computed by the caller from the
 *   tokens (openContainerDepth), not here.
 * @returns {Lexer}
 */
function boundedLexer(options, inputLength = 0, depthState = null) {
  const lexer = new Lexer({ ...options });
  /** Container levels open right now (blockquotes + list levels) — including the
   *  ones this chunk inherited from the previous one (see depthState). */
  let depth = depthState && depthState.open > 0 ? depthState.open : 0;
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
  /** The characters this parse may WASTE in marked's blockquote RULE — the
   *  span it scans minus the token it yields, which is what that rule's
   *  quadratic cost is proportional to (see "SHAPE 2" above). Same floor and
   *  factor as the re-lex budget. */
  const blockquoteBudget = Math.max(RELEX_BUDGET_FLOOR, RELEX_BUDGET_FACTOR * inputLength);
  /** Blockquote-rule overrun spent so far in this parse. */
  let blockquoteSpan = 0;

  const tokenizer = lexer.tokenizer;

  /**
   * flatTextToken PLUS the inline-queue entry marked expects behind every
   * paragraph token (see flatTextToken): `{ src, tokens }` with `tokens` the SAME
   * array the token carries, and `guarded: true` so guardAndParse knows this
   * block is already flattened — it fills the text tokens instead of charging
   * the document's inline budget and inline-lexing them.
   * @param {string} src
   * @returns {{type: string, raw: string, text: string, tokens: object[]}}
   */
  function flatGuardToken(src) {
    const token = flatTextToken(src);
    lexer.inlineQueue.push({ src, tokens: token.tokens, guarded: true });
    return token;
  }

  // 0. The two rules-level guards (see "TWO MORE QUADRATIC BLOCK-LEXER
  //    SHAPES"): the table precheck, the header-only table rule inside the
  //    paragraph rule's stop lookahead, and the blockquote span budget. All
  //    three are per-Lexer: `rules` is this Lexer's own object (marked's Lexer
  //    constructor hands the tokenizer a fresh one), and the paragraph rule is
  //    REPLACED in a copy of it, never mutated in place — the shared rule table
  //    every other marked user in this process parses with keeps marked's own
  //    regex.
  const rules = tokenizer.rules;
  const paragraph = mdTableGuard && rules && rules.block
    ? paragraphWithoutTableScan(rules.block)
    : null;
  if (paragraph) tokenizer.rules = { ...rules, block: { ...rules.block, paragraph } };

  // The table tokenizer: rejected before it can run its rows scan.
  if (mdTableGuard && rules && rules.block && rules.block.table && rules.other) {
    const table = tokenizer.table;
    tokenizer.table = function (src) {
      if (!tableStartsHere(rules, src)) return undefined;
      return table.call(this, src);
    };
  }

  // The blockquote tokenizer: the characters its rule scans and the token it
  // produces does NOT use are what it costs, so that OVERRUN — the rule's
  // matched span minus the token's `raw.length` — is what is charged, and the
  // budget is consulted BEFORE the rule runs, so a document that has spent it
  // never pays for another full-document scan. Charging the whole span instead
  // charged every nesting level the rest of the document (see "SHAPE 2");
  // an ordinary quote, nested or not, keeps its whole match, so its overrun is
  // 0 and it costs nothing. The overrun is only worked out where the rule can
  // match at all (`blockquoteStart`, marked's own `^ {0,3}>`): every block
  // position asks the blockquote tokenizer, and scanning the rest to price a
  // quote that starts with `#` or `- ` would be a per-block cost the guard
  // itself created.
  if (mdBlockquoteSpanGuard && rules && rules.block && rules.block.blockquote
    && rules.other && rules.other.blockquoteStart) {
    const blockquoteRule = rules.block.blockquote;
    const blockquoteStart = rules.other.blockquoteStart;
    const blockquote = tokenizer.blockquote;
    tokenizer.blockquote = function (src) {
      if (blockquoteSpan > blockquoteBudget) return flatGuardToken(src);
      if (!blockquoteStart.test(src)) return blockquote.call(this, src);
      const span = blockquoteRule.exec(src);
      const token = blockquote.call(this, src);
      // Charged AFTER the call, because the token's `raw` is the only measure of
      // what the scan actually bought; the next call sees the new total.
      if (span) blockquoteSpan += Math.max(0, span[0].length - (token ? token.raw.length : 0));
      return token;
    };
  }

  // The lheading (setext heading) tokenizer: asked at every block position,
  // where a FAILED attempt has already scanned the whole remaining paragraph
  // run. `setextRunAnswer` answers "can a setext underline end the run that
  // starts here?" by walking only as far as the run itself, over marked's own
  // stop alternation, and each block-lexing frame's memo makes that walk
  // amortized linear over the frame's successive suffixes (see "A THIRD
  // QUADRATIC BLOCK-LEXER SHAPE" above). Installed only when the installed rule
  // still has the run shape this was verified against: a future marked that
  // changes it keeps its own rule instead.
  const lheadingRule = mdLheadingGuard && rules && rules.block ? rules.block.lheading : null;
  const setextStop = lheadingRule ? lheadingStopPattern(lheadingRule.source) : null;
  /** The memo of every block-lexing frame currently open, innermost last
   *  (empty — or null — when the precheck is not installed). Pushed and popped
   *  by the `blockTokens` wrapper below: a nested block's sources are NOT
   *  suffixes of the block that contains it, so it must never inherit that
   *  block's answer (see makeSetextMemo). */
  const setextMemos = setextStop ? [] : null;
  if (setextStop) {
    const lheading = tokenizer.lheading;
    tokenizer.lheading = function (src) {
      // Outside any block-lexing frame there is nothing to memoize safely: a
      // fresh memo, i.e. one plain walk.
      const memo = setextMemos.length ? setextMemos[setextMemos.length - 1] : makeSetextMemo();
      if (!setextRunAnswer(src, memo, setextStop)) return undefined;
      return lheading.call(this, src);
    };
  }

  // 2. The re-lex path: counted here, because a container token opened by a
  //    direct `this.blockquote(f)` / `this.list(f)` never reaches blockTokens.
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
        return flatGuardToken(src);
      }
      if (depth >= MD_MAX_NEST) return flatGuardToken(src);
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
      out.push(flatGuardToken(src));
      return out;
    }
    // `lastParagraphClipped` is forwarded as given: marked's own default
    // (`false`) applies when it is undefined, and its blockquote tokenizer
    // passes `true`.
    lexFrames++;
    if (setextMemos) setextMemos.push(makeSetextMemo());
    try {
      return blockTokens.call(this, src, tokens || [], lastParagraphClipped);
    } finally {
      if (setextMemos) setextMemos.pop();
      lexFrames--;
    }
  };
  // 3. The inline start() memos are per INLINE FRAME (see makeInlineMemo): one
  //    fresh memo per `inlineTokens` call, pushed here and popped after. This is
  //    the only place a frame can be opened — marked calls inlineTokens itself
  //    for every nested inline source (a link label, an image's alt text, an
  //    emphasis span), so a per-entry reset in guardAndParse would leave those
  //    sharing the outer block's memo, and two inline blocks whose text happens
  //    to agree on a 32-character fingerprint could hand each other an answer
  //    ("no cut in this source" included). Inside one frame every source a hint
  //    is asked about is a suffix of that frame's own first source, which is
  //    what makes the memo exact rather than heuristic.
  const inlineTokens = lexer.inlineTokens;
  lexer.inlineTokens = function (src, tokens) {
    inlineFrames.push(makeInlineMemo());
    try {
      return inlineTokens.call(this, src, tokens || []);
    } finally {
      inlineFrames.pop();
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
// FLATTENS a block outright — it can only flatten, never admit one. The inline
// "br" rule's lookahead scan is a FOURTH cost paid from that same pool, also
// with a per-block cap of its own (brScanCost and MD_BR_SCAN_MAX, below) — see
// "A FOURTH QUADRATIC" below. A FIFTH, a run of plain ASCII spaces in the text
// rule itself, is not charged at all: it is CUT (the owner path's text-run
// window, see "THE OWNER PATH'S TEXT-RUN WINDOW" below), which is cheaper than
// either charging it or flattening the block it sits in.
//
// AT THE OWNER CAP: 1 MiB THEN, 128 KB NOW. The budgets are per document, so
// they bound marked's inline lexer at the owner cap exactly as they do at
// 64 KB — that is the point of the shape, and it is why the same thresholds
// were kept for the owner path instead of being scaled down for it.
// OWNER_MD_MAX_INPUT is 128 KB now — the size of ONE CHUNK of a long document
// (see "THE LONG DOCUMENT: CHUNKED, NOT CUT" at the top of this file), and the
// escape of a remainder the render budget did not reach — so only that much of
// any document reaches the inline lexer at a time: a 1 MB document is eight of
// these, each with its own document budget, and the total render stops at
// OWNER_MD_RENDER_BUDGET_MS. The numbers below are HISTORICAL — they were
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
// A FOURTH QUADRATIC in the same lexer, on the SAME input: marked's inline `br`
// rule is `^( {2,}|\\)\n(?!\s*$)` (rules.inline.br), and that negative
// lookahead walks the WHOLE run of `\s` after the line break before it can
// answer. A paragraph whose lines hold only Unicode whitespace is ONE paragraph
// — marked's block rules read such a line as TEXT, not as a blank line — so the
// tokenizer is retried at every line and every retry walks the rest of the run:
// Σ(the rest of the run), quadratic. Measured on this tree (CPU ms of one whole
// render, before this guard; every render in its own worker):
//
//   one paragraph of lines holding only…         64 KB bot   128 KB owner
//   U+FEFF (BOM / ZWNBSP)                             857        3,340
//   U+3000 (ideographic space)                        831        3,323
//   U+2028 (LINE SEPARATOR)                           996        3,466
//   U+2029 (PARAGRAPH SEPARATOR)                      812        3,311
//   U+202F, U+2003, the U+2000–U+200A block        855–888    3,449–3,520
//   U+000B (VT) / U+00A0 (NBSP)                   576 / 436    2,003 / 1,695
//   U+FEFF+U+3000 mixed                               704        2,657
//   U+0085 (NEL) — NOT `\s`, so not this shape        138          234
//
// …~4x per doubling, ~93% of the profile inside the br tokenizer, and not one
// of the other three costs sees any of it: whitespace is no delimiter, no
// protocol word and no `@`. So it is charged like them: brScanCost (below) pays
// the exact characters the lookahead would scan — computed in ONE BACKWARD pass
// over the block, so it is linear — into the same per-document pool, and a block
// whose own br cost is over MD_BR_SCAN_MAX is flattened outright, the way an
// email run over its per-run cap is. Guarded, every unit above renders in
// 79–125 ms at 64 KB on the bot path and 104–198 ms at the 128 KB owner head
// (from 436–996 and 1,695–3,520), and a 1 MiB document of them through the
// CHUNKED owner path in 1,041 ms worst (from 3,518 — the budget plus one ~2.75 s
// chunk, see OWNER_MD_RENDER_BUDGET_MS). These are the numbers as last measured
// WITH the owner path's text-run window in place (see "THE OWNER PATH'S
// TEXT-RUN WINDOW" below); that window cuts text runs rather than flattening
// or charging them, so it does not change this shape — a flattened block is
// never inline-lexed — and the range is the same as it was without it.
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

/**
 * True for the characters JS's `\s` matches — exactly the class marked's inline
 * `br` rule's lookahead scans (`(?!\s*$)`): TAB, LF, VT, FF, CR, space, NBSP
 * (U+00A0), OGHAM SPACE MARK (U+1680), the EN QUAD..HAIR SPACE block
 * (U+2000–U+200A), LINE SEPARATOR (U+2028), PARAGRAPH SEPARATOR (U+2029),
 * NARROW NO-BREAK SPACE (U+202F), MEDIUM MATHEMATICAL SPACE (U+205F),
 * IDEOGRAPHIC SPACE (U+3000) and the BOM / ZWNBSP (U+FEFF). Written as one
 * numeric test rather than a regex because brScanCost runs it per character of
 * every inline block. U+0085 (NEL) is deliberately NOT here: it is not `\s` in
 * JS, so the br lookahead does not scan it.
 * @param {number} c char code
 * @returns {boolean}
 */
function isInlineWhitespace(c) {
  if (c === 32 || c === 10 || c === 9 || c === 12 || c === 13 || c === 11) return true;
  if (c < 0xa0) return false;
  if (c === 0xa0 || c === 0x1680 || c === 0x2028 || c === 0x2029 || c === 0x202f
    || c === 0x205f || c === 0x3000 || c === 0xfeff) return true;
  return c >= 0x2000 && c <= 0x200a;
}

/**
 * What marked's inline `br` rule will scan in `s`.
 *
 * The rule is `^( {2,}|\\)\n(?!\s*$)` (marked 17.0.6's own `rules.inline.br`).
 * The negative lookahead scans the WHOLE run of `\s` after the line break before
 * it can decide, and the tokenizer is retried at line after line of the same
 * block — so a block whose lines are made of Unicode whitespace (each line is
 * TEXT to marked's block rules, so the whole document is ONE paragraph) costs
 * Σ(the rest of the run) at every line break: measured 855 ms for 64 KB on the
 * bot path and 3,340 ms for the 128 KB owner head for a paragraph of U+FEFF
 * lines, 436/1,695 for U+00A0, 996/3,466 for U+2028 — ~4x per doubling, and
 * none of the delimiter, url-scan or email-run budgets above see any of it.
 *
 * The quantity is charged here in one BACKWARD pass: `run` is the length of the
 * `\s` run starting at the current position, so at a `\n` the lookahead scans
 * exactly `run - 1` characters. That makes the estimate exact (not an upper
 * bound) for the br lookahead, linear to compute, and quadratic exactly where
 * marked is quadratic.
 *
 * Ordinary content is nowhere near it: the largest br cost of any markdown file
 * in this repository is 715 (a 13.6 KB document of hard-wrapped prose and
 * indented list continuations, i.e. ~0.05 per character), so a 128 KB prose
 * chunk of the same shape is ~6,000 — three orders of magnitude below
 * MD_BR_SCAN_MAX.
 * @param {string} s one inline block's source
 * @returns {number} the characters marked's br lookahead would scan in it
 */
function brScanCost(s) {
  let cost = 0;
  let run = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (isInlineWhitespace(c)) {
      run++;
      // The run STARTING at i+1 is what the lookahead after a `\n` at i scans.
      if (c === 10) cost += run - 1;
    } else {
      run = 0;
    }
  }
  return cost;
}

/** The largest br-scan cost ONE inline block may carry before that block is
 *  flattened instead of inline-lexed (see brScanCost). Chosen from measurement:
 *  the most expensive markdown file in this repository costs 715, a 128 KB
 *  prose chunk of the same shape ~6,000 (all of it linear work in marked), the
 *  pathological Unicode-whitespace paragraphs 1.07e9 at 64 KB. 1e6 is ~150x
 *  above any real document and ~1,000x below the shape it guards, so it never
 *  bites ordinary content, while a block that DOES trip it caps marked's br
 *  scanning at ~1.5 ms (measured ~1.5 ns per scanned character) instead of
 *  letting one paragraph spend the whole document budget. Exported so the tests
 *  can pin the bound they exercise. */
export const MD_BR_SCAN_MAX = 1_000_000;

/** The br-scan guard's switch: false renders through marked's own br rule with
 *  no br charge and no per-block cap, which is what the differential test
 *  compares against (tests/md-unicode-ws.test.js). */
let mdBrScanGuard = true;

/** @param {boolean} enabled false renders with no br-scan charge or cap */
export function setMdBrScanGuardEnabled(enabled) {
  mdBrScanGuard = enabled !== false;
}

/**
 * What the br-scan guard did in the LAST guarded parse: how many inline blocks
 * were flattened (`flattened`, for any reason — a delimiter flood as much as a
 * br flood) and how many of those would have been lexed had the br charge not
 * been added (`brFlattened`), plus the br cost the parse charged (`charged`).
 *
 * Reset at the start of every guardAndParse call, so a render reports its own
 * numbers (a chunked owner render reports its LAST chunk). Read by
 * tests/md-unicode-ws.test.js, which can only claim a document rendered
 * byte-identically to the unguarded renderer after establishing that the guard
 * left it alone: `flattened === 0`.
 */
export const mdBrScanStats = { flattened: 0, brFlattened: 0, charged: 0 };

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
 *  domain per `@`), the same quadratic reached without a protocol word — PLUS
 *  the characters marked's inline `br` lookahead would scan (brScanCost, ~1.5 ns
 *  each). All four are paid from this one pool, so a document cannot spend 4e6
 *  on delimiters and another 4e6 on scans: the worst case is 4e6 attempts of any
 *  kind, ~50 ms of d², ~10 ms of url scan or ~6 ms of br scan. Real prose stays
 *  orders of magnitude below it (a 1 MiB post quoting `HTTP` a hundred times
 *  costs ~1e3; forty links cost ~1e3; the contacts document below costs ~2e4; a
 *  128 KB prose chunk's br scan is ~6e3; the 24 KB pinned post in
 *  tests/owner-markdown-guard.test.js costs under 2e4). */
export const BOT_MD_SQ_BUDGET = 4_000_000;
export const BOT_MD_MAX_LINK_DEFS = 256;

/** `src` as escaped plain text tokens: one per line, a <br> between them (what
 *  `breaks: true` emits for a plain paragraph today). A text token's `text` is
 *  character data, not markup — marked escapes it itself in parseInline
 *  (measured: a text token holding `<b>&` renders `&lt;b&gt;&amp;`) — so the
 *  RAW line goes in here, never a pre-escaped one (that would double-escape).
 *
 *  The per-line `br` tokens are deliberate: `breaks: true` only turns a newline
 *  into a break in the PARAGRAPH tokenizer, which a flattened block never
 *  reaches, so a single text token holding the whole block kept its newlines as
 *  literal `\n` characters and rendered as one run-together line (main, before
 *  this helper, did exactly that). Splitting on `\n` keeps the line structure
 *  the author typed, which is also what the unflattened render would show. It
 *  is a change of output for GUARDED blocks only — nothing else calls this —
 *  and tests/md-block-guard.test.js pins it ("a flattened block keeps its line
 *  breaks"). */
function plainTextTokens(src) {
  const lines = String(src).split("\n");
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) tokens.push({ type: "br" });
    tokens.push({ type: "text", raw: lines[i], text: lines[i] });
  }
  return tokens;
}

/**
 * How many container levels (blockquotes and lists) are still OPEN at the end of
 * a block-token list — i.e. how deep the document was when it ran out.
 *
 * This is the state the chunk loop carries between chunks (see "CROSS-CHUNK
 * NESTING" at the top of the file). marked closes every container implicitly at
 * the end of the source it was given, so a chunk cut inside 16 open blockquotes
 * ends with a 16-long chain of `blockquote` tokens whose innermost child holds
 * the last text; the next chunk reopens that chain on the page, so its lexer has
 * to start counting from 16 or the two halves get 16 levels each.
 *
 * Only the LAST token can still be open (any earlier sibling was closed by the
 * next one), so this walks down the last-child chain: a `blockquote` continues
 * through its `tokens`, a `list` through its last item's `tokens` (its items are
 * lexed as blocks, so a nested list is a list token inside an item's tokens).
 * Counting one level per container TOKEN is exactly what boundedLexer's counter
 * charges — one container token = one level. A trailing `space` token (a blank
 * line), a paragraph, a fence or a table ends 0 levels open, which is why a cut
 * on a blank line — every cut of a real document — carries nothing over.
 * @param {object[]} tokens
 * @returns {number}
 */
function openContainerDepth(tokens) {
  let levels = 0;
  let children = tokens;
  for (;;) {
    const last = Array.isArray(children) && children.length
      ? children[children.length - 1]
      : null;
    if (last && last.type === "blockquote" && Array.isArray(last.tokens)) {
      levels++;
      children = last.tokens;
      continue;
    }
    if (last && last.type === "list" && Array.isArray(last.items) && last.items.length) {
      levels++;
      children = last.items[last.items.length - 1].tokens;
      continue;
    }
    return levels;
  }
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
 *  carries the math extensions and ownerMarked carries one of its own — a
 *  text-run window with no token type and no renderer, so a post about prices
 *  still keeps its dollar signs) and its parser is what renders the tokens
 *  (so each keeps its own image renderer and link opt-out). Nothing else is
 *  shared, and nothing about the budgets depends on the instance, because they
 *  bound marked's inline lexer, which is the same code in both.
 *
 *  It leans on that split being stable, and the digest tests pin it: ordinary
 *  and delimiter-dense documents are rendered through here and must match the
 *  unguarded renderer byte for byte (tests/bot-markdown-quadratic.test.js for
 *  the bot path, tests/owner-markdown-guard.test.js for the owner's), so a
 *  marked upgrade that moves the phases fails in CI instead of silently
 *  changing published output.
 *
 *  `seedLinks` is the ONE optional input: a chunk of a longer document is handed
 *  the whole document's link definitions (collectLinkDefinitions), because
 *  marked resolves references against the lexer's own map and a definition in
 *  another chunk would otherwise be invisible. Omitted on every single-document
 *  path, where it would change nothing.
 *
 *  `depthState`, also only for a chunk, is the container depth the chunk loop
 *  carries across cuts (see "CROSS-CHUNK NESTING" above): it goes IN as the
 *  levels the previous cut left open and comes back out as the levels THIS
 *  chunk's cut leaves open (openContainerDepth), so a document parsed in pieces
 *  is bounded by the same MD_MAX_NEST as one parsed whole.
 */
function guardAndParse(src, instance, seedLinks = null, depthState = null) {
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
  const lexer = boundedLexer(instance.defaults, src.length, depthState);
  // A chunk of a longer document: the depth it INHERITED is cleared before block
  // lexing and the residual it leaves OPEN is written back after, so the next
  // chunk's lexer continues at that depth instead of starting a fresh MD_MAX_NEST
  // budget (see depthState in boundedLexer). Clearing first is what makes a parse
  // that THROWS (renderOwnerHead then answers escaped text — nothing is opened)
  // carry 0 forward instead of the previous chunk's depth. The block tokens are
  // exactly what says whether the content ends inside a container.
  if (depthState) depthState.open = 0;
  lexer.blockTokens(src, lexer.tokens);
  if (depthState) depthState.open = openContainerDepth(lexer.tokens);
  // Cap the link definitions BEFORE any inline lexing: inlineTokens scans
  // `Object.keys(this.tokens.links)` on every inline block, so a flood of
  // definitions is paid once per paragraph. Insertion order is kept (numeric
  // labels sort first, as they do in marked's own map).
  const links = lexer.tokens.links;
  if (links) {
    // A chunk of a longer document: its own definitions are a subset of the
    // whole document's, and the seed holds the document's FIRST occurrence of
    // every label (marked's first-wins), so the seed replaces a chunk-local
    // duplicate and adds the definitions that live in other chunks. The cap
    // below still bounds the total, which is what marked's per-block scan costs.
    if (seedLinks) {
      for (const label of Object.keys(seedLinks)) links[label] = seedLinks[label];
    }
    const labels = Object.keys(links);
    for (const label of labels.slice(BOT_MD_MAX_LINK_DEFS)) delete links[label];
  }
  let budget = BOT_MD_SQ_BUDGET;
  mdBrScanStats.flattened = 0;
  mdBrScanStats.brFlattened = 0;
  mdBrScanStats.charged = 0;
  mdOwnerTextWindowStats.cuts = 0;
  // The cut memo needs no reset here: there is one per INLINE FRAME, and a
  // frame is pushed and popped around every inlineTokens call by boundedLexer
  // (see makeInlineMemo), so a second render of the same document — and every
  // inline block of it — cuts (and counts) its own text runs.
  for (const entry of lexer.inlineQueue) {
    // A block-lexer guard (flatGuardToken) already flattened this block: its
    // entry is here only because marked's paragraph-clipping branch expects one
    // behind every paragraph token. Fill it from the entry's CURRENT src — the
    // clipping branch rewrites that when it merges a following paragraph in —
    // and charge nothing: there is no inline lexing left to bound.
    if (entry.guarded) {
      for (const token of plainTextTokens(entry.src)) entry.tokens.push(token);
      continue;
    }
    const d = countDelims(entry.src);
    // Four independent costs share the document budget, each measured in the
    // units it makes marked's inline lexer spend: d² for the emphasis/link
    // retries (see the table at the top of this section), the url email scan
    // (urlScanCost, ~2.4 ns per character) and the email autolink's run scan
    // (emailRunScan: Σrun² + run × domain per `@` — the same quadratic,
    // reached with no protocol word, that urlScanCost cannot see; see "A THIRD
    // quadratic" above), and the characters marked's inline `br` rule would scan
    // in it (brScanCost — the FOURTH quadratic in the same lexer, on a paragraph
    // of Unicode-whitespace lines; see "A FOURTH QUADRATIC" above). A block is
    // flattened when its delimiter count is over the per-block cap, when its br
    // scan is over MD_BR_SCAN_MAX, or when what is left of the document budget
    // cannot pay for all four costs — which also covers one block whose url,
    // email-run or br scan alone would exceed the whole budget. emailRunScan's
    // per-run caps are an EXTRA trigger alongside them: they only flatten, never
    // admit, and they keep the cost arithmetic small.
    const scan = urlScanCost(entry.src);
    const email = emailRunScan(entry.src);
    // What the three earlier costs charge, kept apart so the stats can say
    // whether the br charge is what decided a block (see mdBrScanStats).
    const before = d * d + scan + email.cost;
    const br = mdBrScanGuard ? brScanCost(entry.src) : 0;
    const cost = before + br;
    if (mdBrScanGuard) mdBrScanStats.charged += br;
    const brOverCap = br > MD_BR_SCAN_MAX;
    if (d <= BOT_MD_BLOCK_DELIMS && cost <= budget && !email.flatten && !brOverCap) {
      budget -= cost;
      continue;
    }
    // `before` alone would have let this block through, so the br charge is what
    // decided it (see mdBrScanStats.brFlattened).
    const brDecided = brOverCap || (br > 0 && before <= budget && d <= BOT_MD_BLOCK_DELIMS && !email.flatten);
    if (mdBrScanGuard && brDecided) mdBrScanStats.brFlattened++;
    mdBrScanStats.flattened++;
    entry.guarded = true;
    for (const token of plainTextTokens(entry.src)) entry.tokens.push(token);
  }
  for (const entry of lexer.inlineQueue) {
    if (!entry.guarded) lexer.inlineTokens(entry.src, entry.tokens);
  }
  lexer.inlineQueue.length = 0;
  // Every inline frame is popped in a finally (see the inlineTokens wrapper in
  // boundedLexer), so this is belt and braces: a parse that threw mid-frame
  // cannot leave a frame behind for the next render.
  inlineFrames.length = 0;
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

// ---------------------------------------------------------------------------
// THE OWNER PATH'S TEXT-RUN WINDOW.
//
// marked's inline text rule is the ONE rule with no anchor of its own: a plain
// run of characters is consumed by a lazy `[\s\S]*?` that stops only at a
// delimiter, at a protocol word or at the end of the block, so the text
// tokenizer rescan is as long as the run. A run of plain ASCII SPACES is the
// cheap-looking input that makes that scan expensive: the rule's own stop set
// contains ` *\n` (the hard-break alternative), and the lazy expansion retries
// that lookahead at EVERY position, each retry walking the rest of the space
// run looking for the newline that is not there — Σ(rest of the run), i.e.
// quadratic. One paragraph of `'a' + ' ' x N + 'b'` (no newline at all, so no
// block boundary, no hard break, no delimiter) measured 1,735 ms of CPU at
// 64 KB and 5,826 ms at 128 KB on THIS tree's owner path — ~4x per doubling —
// and marked on its own, with no guard of any kind, measures the same, so all
// of it is marked's. The same shape inside a heading, a blockquote, a list item,
// a table cell, a link label or an emphasis span is the same cost (each is one
// inline block of its own). It is pre-existing — main renders it the same way —
// and it is the one inline-lexer cliff none of the four costs in guardAndParse
// can see: whitespace is no delimiter, no protocol word, no `@` and no line
// break.
//
// The BOT path never had it: botMarked's math extension has an inline start()
// (inlineStart, above) that makes the text rule stop at the nearest `$`/`\(`
// and, past START_WINDOW (4,096) characters, at the text-run cut — so no bot
// text run is much longer than 4,097 characters. It was never safe to cut the
// bot path AT 4,096: the hint is a math hint first, and only a position
// textRunCut calls harmless may be cut at all. ownerMarked has no math
// extension, so its runs were unlimited.
//
// So the owner parser gets the same window, from an extension whose ONLY job
// is that stop: no token type, no renderer, and a tokenizer that never
// matches. marked reports a start() hint as "the next position this extension
// could tokenize at" and cuts the text token there; the pieces are merged back
// into the very same text the author wrote — marked's inline text tokenizer
// keeps the RAW source (`{ type: "text", raw: t[0], text: t[0] }`) and its
// inline loop does `p.raw += o.raw, p.text += o.text`, so escaping, emphasis,
// code spans and every other token are decided on the character stream, not on
// the token boundaries.
//
// What is NOT invisible is WHERE the cut lands. marked hands the text tokenizer
// a SLICE (`l = e.substring(0, p + 1)`), so the cut reads as end-of-input to
// marked's own regexes: a token that crosses an arbitrary cut is never matched
// (`https://example.com` cut inside the protocol is plain text; `foobar@…` cut
// after the `f` links to `oobar@…`), and the resume position is where the NEXT
// token is tried. So both paths cut only where textRunCut (above) allows it —
// between two characters of one run of spaces/tabs, and never inside the
// all-space stretch a line break owns (see the invariant above textRunCut) —
// and the rendered bytes are then identical to an unlimited text run. The
// window is still a character count (the cut is at or just after 4,096), but
// the invariant it relies on is the run of whitespace, not the count.
//
// Measured after it (CPU ms, one whole `renderMarkdown` call, this box; "off"
// is the same document with setOwnerTextWindowEnabled(false), i.e. marked's own
// unlimited text runs):
//
//   'a' + ' ' x N + 'b'      16 KB   32 KB   64 KB   128 KB
//   window off                 103     369   1,366    5,523
//   window on                   36      62   124–167  213–252
//
// …i.e. ~4x per doubling becomes ~2x (the two numbers per size are two runs —
// this box varies by up to ~35%), and the same line inside a heading, a
// blockquote, a list item, a table cell, a link label or an emphasis span costs
// the same (128 KB: 218–252 ms). The 1 MiB CHUNKED path renders 120 KB space
// runs separated by blank lines in 1,046 ms — the per-document budget plus one
// chunk, so the remainder becomes the plain-text tail, nothing dropped — and a
// single 1 MiB line of spaces in 227 ms. Output is unchanged: 3,000 seeded
// owner documents render byte for byte the same with the window on and off
// (tests/md-unicode-ws.test.js counts the cuts, so the comparison is not
// vacuous), the tokens a cut used to split — URLs, emails, `x  \n` hard breaks —
// are swept across the boundary at offsets -3..+5 on BOTH paths, and every
// digest pin in the suite — ordinary prose, tables, math-like `$` text, the
// real-shaped documents — is untouched.

/** The window is on by default; false is the differential test's "off" side
 *  (marked's own unlimited text runs). */
let ownerTextWindowOn = true;

/** @param {boolean} enabled false renders the owner path with no text-run
 *  window at all — the shape this fix is measured against. */
export function setOwnerTextWindowEnabled(enabled) {
  ownerTextWindowOn = enabled !== false;
}

/**
 * What the owner path's text-run window did in the LAST guarded parse: how many
 * text-run cuts were FOUND (one is reported again for every shorter suffix of
 * the same source, so this counts cuts, not calls). Reset at the start of every
 * guardAndParse call (so a chunked render reports its LAST chunk). Read by
 * tests/md-unicode-ws.test.js, which has to show that the documents it compares
 * byte for byte are not all too short to reach the window.
 */
export const mdOwnerTextWindowStats = { cuts: 0 };

/**
 * marked's inline start() hint for the owner path: "stop this text run at the
 * text-run cut" — the same cut botMarked's math extension reports for content
 * with no `$` in it (textRunCut, above), from the same per-frame memo (see
 * makeInlineMemo). Returning undefined leaves marked's own (unlimited) text
 * scan alone.
 *
 * The argument is the source AFTER the first character (that is what marked
 * passes to a start()), and the return value is the number of characters the
 * text token may consume MINUS ONE — the cut then sits between two characters
 * of one run of spaces/tabs, and never inside the all-space stretch a line
 * break owns (see the invariant above textRunCut), which is the only place a
 * cut can land without changing the render: marked slices the source for the
 * text tokenizer, so an arbitrary cut reads as end-of-input. The last usable
 * index at or below START_WINDOW wins; failing that, the first one after it;
 * failing that there is no cut at all, which is linear (see textRunCut).
 * @param {string} src the rest of the inline source, minus its first character
 * @returns {number|undefined}
 */
function ownerTextStart(src) {
  if (!ownerTextWindowOn || src.length <= START_WINDOW) return undefined;
  const memo = inlineFrameMemo();
  let c = memo.cut;
  if (c === undefined || (c > 0 && src.length <= c)) {
    // Not scanned yet in this frame, or the tokenizer has advanced PAST the last
    // cut reported: look again from here.
    const cut = textRunCut(src, START_WINDOW);
    c = memo.cut = cut < 0 ? -1 : src.length - cut;
    if (cut >= 0) mdOwnerTextWindowStats.cuts++;
  }
  if (c > 0 && src.length > c) return src.length - c;
  return undefined;
}

/**
 * The extension above: a start() and NOTHING else. marked only registers a
 * start() hint for an extension that also carries a `tokenizer` (Marked#use),
 * so there is one here and it never matches — no token type, no renderer, no
 * change to what the lexer produces.
 */
const ownerTextWindow = {
  name: "ownerTextWindow",
  level: "inline",
  start(src) { return ownerTextStart(src); },
  tokenizer() { return undefined; },
};

/**
 * The owner's parser: marked exactly as the blog always had it (gfm, breaks,
 * NO math extensions — a post about prices keeps its dollar signs), plus the
 * image rule, so a refused image leaves its escaped alt text where the <img>
 * would have been, and the text-run window (see "THE OWNER PATH'S TEXT-RUN
 * WINDOW" above), which cuts a long text run at the whitespace run near 4,096
 * characters that textRunCut allows and changes nothing else about the output.
 */
const ownerMarked = new Marked({
  gfm: true,
  breaks: true,
  extensions: [ownerTextWindow],
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
  blockMemo = makeBlockMemo();
  blockValid = new Map();
  cutsLeft = MAX_PARAGRAPH_CUTS;
  mdBotTextWindowStats.cuts = 0;
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
    } catch (e) {
      if (process.env.CROW_MD_DEBUG) throw e;
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
