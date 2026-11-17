// Markdown rendering: the inline `br` rule's quadratic lookahead on lines of
// Unicode whitespace.
//
// marked's inline `br` rule is `^( {2,}|\\)\n(?!\s*$)` (17.0.6, `rules.inline.br`)
// and that negative lookahead walks the WHOLE run of `\s` after the line break
// before it can answer. A paragraph whose lines hold ONLY Unicode whitespace is
// ONE paragraph — marked's block rules read such a line as text, not as a blank
// line — so the tokenizer is retried at every line and every retry walks the
// rest of the run: Σ(the rest of the run), quadratic. Measured on this tree (CPU
// ms, one whole render, BEFORE the guard; each render in its own worker):
//
//   one paragraph of lines holding only…        64 KB bot   128 KB owner
//   U+FEFF (BOM / ZWNBSP)                          857        3,340
//   U+3000 (ideographic space)                     831        3,323
//   U+2028 (LINE SEPARATOR)                        996        3,466
//   U+2029 (PARAGRAPH SEPARATOR)                   812        3,311
//   U+202F (narrow no-break space)                 888        3,449
//   U+2003 (EM SPACE)                              855        3,520
//   U+000B (VT)                                    576        2,003
//   U+00A0 (NBSP)                                  436        1,695
//   U+FEFF+U+3000 mixed                            704        2,657
//   U+0085 (NEL) — NOT `\s`, so never this shape   138          234
//
// …~4x per doubling, ~93% of the profile inside the br tokenizer, and the next
// one up does not even reach the existing budgets: the delimiter count is 0
// (whitespace is no delimiter), urlScanCost sees no protocol word and
// emailRunScan sees no `@`. It also set the chunked owner path's worst case: a
// 1 MiB document of U+FEFF lines took 3,518 ms of CPU (the 1,000 ms render
// budget plus one ~2.75 s chunk).
//
// What must stay true (see brScanCost / MD_BR_SCAN_MAX in servers/blog/renderer.js):
//   - every unit above renders 64 KB in < 1,000 ms on the bot path and the 128 KB
//     owner head in < 2,000 ms, and a 1 MiB document of them through the CHUNKED
//     owner path in < 6,000 ms in total. Each render runs in a WORKER with a
//     20 s kill, so the pre-guard cost (436–996 ms at 64 KB, 1.7–3.5 s at 128 KB)
//     fails the test instead of hanging the suite. The bounds are 5x the worst of
//     three measured runs here in a fresh worker: 135–185 ms at 64 KB, 200–205 ms
//     at the owner head, 949–1,029 ms for a 1 MiB chunked document. NOTE the
//     conflict the audit found: the pre-guard cost of the CHEAPEST unit is 436 ms
//     at 64 KB, so a bound that keeps a ~3.5x-slower CI runner green (1,000 ms)
//     is necessarily above a third of that cliff and cannot catch a return of the
//     regression for U+000B/U+00A0 — it catches only the 996 ms end of the range.
//     That the guard is PRESENT (rather than merely that the box is fast) is
//     separately and non-temporally pinned below: brScanStats says the
//     pathological block was flattened, and 2,000 documents are compared byte for
//     byte with the guard on and off;
//   - and neither is "fully formatted" for a document whose CHUNKS are each
//     pathological: that assertion runs with the total-time budget raised out of
//     the way (it is a property of the CHUNKER), and the DEFAULT budget is
//     separately checked to keep the render inside its time bound with a tail
//     that is the WHOLE remainder — nothing dropped (see
//     setOwnerRenderBudgetMs in servers/blog/renderer.js);
//   - ordinary content is untouched, byte for byte: the pins below were captured
//     from the renderer BEFORE the guard (prose with line breaks, a poem with
//     indented lines, an address block with trailing spaces, a CRLF document, an
//     NBSP used the way prose uses it, and CJK text with U+3000 inside
//     sentences), and the pins in tests/md-chunked-render.test.js,
//     tests/md-block-guard.test.js, tests/owner-markdown-guard.test.js,
//     tests/bot-markdown-quadratic.test.js and tests/md-nesting-depth.test.js
//     still match (they are run alongside this file);
//   - the differential: 2,000 seeded documents that mix ordinary lines (prose,
//     hard breaks, list items, quotes, tables, NBSP inside a sentence, CJK with
//     U+3000) with occasional lines of Unicode whitespace render BYTE-IDENTICALLY
//     with the br guard on and off, for every document the guard left alone
//     (`mdBrScanStats.flattened === 0`). The off switch is the exported test seam
//     setMdBrScanGuardEnabled, which removes BOTH the br charge and the per-block
//     cap and leaves marked's own rule in place;
//   - U+0085 (NEL) is NOT in JS's `\s`, so a paragraph of NEL lines is not this
//     shape at all: it must not trip the guard (brScanStats stays 0), it renders
//     identically with the guard on and off, and it stays under the same 1,000 /
//     2,000 ms bounds;
//   - the per-block cap is far above real content: the most expensive markdown
//     file in this repository has a br cost of 715.
//
// The SECOND half of this file covers a different, pre-existing quadratic on the
// OWNER path only: a run of plain ASCII spaces inside a paragraph (marked's
// inline text rule rescans the rest of the space run at every position of its
// lazy `[\s\S]*?`), which no budget or charge could see and which the bot path
// never had because its math extension's start() already caps each text-rule
// scan at about 4,096 characters. The owner path now carries the same window; see
// "--- plain ASCII spaces: a FIFTH inline-lexer quadratic" below for what must
// stay true (bounds at 64 KB / 128 KB / 1 MiB, and a 3,000-document
// differential that must be byte-identical with the window on and off).
//
// What the window may NOT do, and what most of the boundary tests below are
// about: marked turns a start() hint into `l = e.substring(0, p + 1)` and hands
// only that SLICE to the text tokenizer, so an arbitrary cut reads as END OF
// INPUT to marked's own regexes. A cut inside `https://…` loses the autolink,
// a cut inside `foobar@example.com` links to `oobar@example.com`, and a cut
// between the two spaces of `x  \nnext` leaves a stray space before the <br>
// (the old fixed 4,096 cut did all three; 3 of 200 offsets in a realistic long
// paragraph with a link near the boundary already differed). Both paths now cut
// ONLY between two characters of one run of spaces/tabs, and in a run that ends
// in a line break only before its final all-space stretch — the stretch a
// breaks-mode `br` takes — and not at all in a stretch with no such run (which is
// linear anyway — see textRunCut in servers/blog/renderer.js). That is the
// invariant the straddle sweep below checks token by token, at offsets -3..+5
// around the old cut, on both paths (the bot path's window has its own seam,
// setBotTextWindowEnabled, so the comparison is possible there too).
//
// The end of this file pins the two regressions the window introduced, in the
// order they were found: THE MATH HINT MUST NOT DEPEND ON THE CUT (the bot
// path's start() reports the nearer of the next math opener and the cut, scans
// the whole source for the opener, and memoizes the two separately), and A RUN
// THAT ENDS IN A LINE BREAK IS USABLE UP TO ITS LAST TAB (only the final
// all-space stretch before the break is excluded), plus the memo being PER
// INLINE FRAME rather than per parse behind a 32-character fingerprint.
// "Fully formatted / no plain-text tail" is a property of the CHUNKER, and the
// budget is what decides whether the tail appears — so the two are asserted
// apart: the fully-formatted render runs with the budget raised out of the way
// (setOwnerRenderBudgetMs), and a separate test renders with the DEFAULT budget
// and requires only what the budget promises — bounded time, and a tail that is
// the WHOLE remainder (nothing dropped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  renderMarkdown, renderBotMarkdown, BOT_MD_MAX_INPUT,
  setMdBrScanGuardEnabled, mdBrScanStats, MD_BR_SCAN_MAX,
  setOwnerTextWindowEnabled, mdOwnerTextWindowStats,
  setBotTextWindowEnabled, mdBotTextWindowStats,
  OWNER_MD_RENDER_BUDGET_MS,
  ownerMarkdownChunks,
} from "../servers/blog/renderer.js";

const CAP = BOT_MD_MAX_INPUT; // renderBotMarkdown refuses only ABOVE this

/** The budget the CHUNKER assertions run under: high enough that no runner's
 *  speed can turn "the whole document is formatted" into a tail (1 MiB of these
 *  units measures ~0.7-0.8 s of CPU on the dev box, against the 1 s default). */
const FULL_RENDER_BUDGET_MS = 60_000;

/** The long-document notice and the plain-text tail's <pre>, so a budgeted render
 *  can be read back the way a reader sees it. */
const TAIL_NOTICE_TEXT = '<p class="md-tail-notice">Long document: the rest is shown as plain text.</p>';
const TAIL_OPEN = '<pre class="md-tail">';

/** The inverse of the renderer's escapeText (five characters), for the tail. */
function unescapeText(html) {
  return html
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The window both paths use (START_WINDOW in servers/blog/renderer.js): the
 *  largest preferred cut index. The old fixed cut was exactly here. */
const CUT_WINDOW = 4096;

const OWNER_HEAD = 128 * 1024; // the owner path's markdown-parsed head
const CHUNKED = 1024 * 1024; // a document the owner path renders in chunks
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// --- the worker harness: a regression must FAIL, not hang ------------------
const RENDERER_URL = new URL("../servers/blog/renderer.js", import.meta.url).href;
// A HANG guard, not an assertion: the bounds asserted below (1-5 s) are what
// fails a regression, and this only stops a truly runaway render (minutes) from
// wedging the suite. 20 s because a render under a RAISED budget (see
// renderInWorker's budgetMs) may legitimately take seconds on a slow runner, and
// the kill has to stay above that.
const KILL_MS = 20000;
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const mod = await import(workerData.module);
  if (workerData.budgetMs != null) mod.setOwnerRenderBudgetMs(workerData.budgetMs);
  const t0 = process.cpuUsage();
  const html = workerData.kind === "owner"
    ? mod.renderMarkdown(workerData.src)
    : mod.renderBotMarkdown(workerData.src);
  const spent = process.cpuUsage(t0);
  parentPort.postMessage({ ms: (spent.user + spent.system) / 1000, length: html.length, html });
})();
`;

/** One render of `src` on `kind` ("bot" | "owner") in its own thread, killed
 *  after KILL_MS. Resolves `{ ms, length, html }`: CPU ms of the render itself
 *  (the worker's own cpuUsage delta, so the parent's load on other cores does
 *  not count), the HTML length and the HTML. `budgetMs` sets the owner path's
 *  total-time budget inside the worker (the seam is module state, so the
 *  parent's value does not reach it); omitted, the production default applies. */
function renderInWorker(kind, src, { budgetMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { kind, src, budgetMs, module: RENDERER_URL } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${kind} render of ${src.length} chars did not finish in ${KILL_MS} ms — a guard is gone`));
    }, KILL_MS);
    worker.once("message", (msg) => { clearTimeout(timer); worker.terminate(); resolve(msg); });
    worker.once("error", (err) => { clearTimeout(timer); worker.terminate(); reject(err); });
  });
}

// --- the pathological shape: one paragraph of Unicode-whitespace lines ------
// Every one of these characters is in JS's `\s` (and therefore in the br
// lookahead's class) — the long list is the point: one member is enough.
const UNITS = {
  "U+FEFF": "\uFEFF",
  "U+3000": "\u3000",
  "U+000B": "\u000B",
  "U+000C": "\u000C",
  "U+00A0": "\u00A0",
  "U+2028": "\u2028",
  "U+2029": "\u2029",
  "U+1680": "\u1680",
  "U+2000": "\u2000",
  "U+2001": "\u2001",
  "U+2002": "\u2002",
  "U+2003": "\u2003",
  "U+2004": "\u2004",
  "U+2005": "\u2005",
  "U+2006": "\u2006",
  "U+2007": "\u2007",
  "U+2008": "\u2008",
  "U+2009": "\u2009",
  "U+200A": "\u200A",
  "U+202F": "\u202F",
  "U+205F": "\u205F",
  "U+FEFF+U+3000": "\uFEFF\u3000",
  "U+00A0+U+2028+U+000B": "\u00A0\u2028\u000B",
};

test("every Unicode-whitespace line unit renders in < 1000 ms at 64 KB and < 2000 ms at the 128 KB owner head", async (t) => {
  let worstBot = { ms: 0, what: "" };
  let worstOwner = { ms: 0, what: "" };
  for (const [name, unit] of Object.entries(UNITS)) {
    const botSrc = rep(`${unit}\n`, CAP);
    assert.equal(botSrc.length, CAP, `${name}: the fixture fills the bot cap (${botSrc.length})`);

    const bot = await renderInWorker("bot", botSrc);
    if (bot.ms > worstBot.ms) worstBot = { ms: bot.ms, what: name };
    assert.ok(bot.length > 0, `${name}: the bot path still renders (an over-cap answer would be "")`);
    // 1,000 ms is ~7x the 135-137 ms this measures here in a fresh worker, and
    // above what a CI runner ~3.5x slower than this box needs; the PRE-guard
    // cost was 436-996 ms for this shape, so the bound only catches the top of
    // that range (see the note in the header: 5x measured and 1/3 of the
    // cheapest cliff cannot both hold).
    assert.ok(bot.ms < 1000, `${name}: 64 KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 1000 ms)`);

    const ownerSrc = rep(`${unit}\n`, OWNER_HEAD);
    assert.equal(ownerSrc.length, OWNER_HEAD, `${name}: the fixture fills the owner head`);
    const owner = await renderInWorker("owner", ownerSrc);
    if (owner.ms > worstOwner.ms) worstOwner = { ms: owner.ms, what: name };
    assert.ok(owner.length > 0, `${name}: the owner path still renders`);
    // The block is flattened rather than inline-lexed: the lines survive as
    // visible text (the flattened-block contract, see plainTextTokens), so the
    // content is never dropped.
    assert.ok(owner.length >= OWNER_HEAD * 0.9,
      `${name}: the 128 KB owner head still shows its content (got ${owner.length} chars of HTML)`);
    // Same reasoning as the bot bound: measured 200-205 ms here, 1.7-3.5 s before
    // the guard.
    assert.ok(owner.ms < 2000, `${name}: the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 2000 ms)`);
  }
  t.diagnostic(`worst 64 KB bot render: ${worstBot.ms.toFixed(0)} ms — ${worstBot.what}`);
  t.diagnostic(`worst 128 KB owner render: ${worstOwner.ms.toFixed(0)} ms — ${worstOwner.what}`);
});

// (1) THE CHUNKER: every one of the document's eight 128 KB chunks rendered, in
// order, no plain-text tail. That is not a statement about the box's speed, so
// the total-time budget is raised out of the way for it (the budget is 1 s of
// CPU and this document measures ~0.7-0.8 s here — on a slower runner it would
// run out and the tail would appear, which is the CI flake this split fixes).
test("the CHUNKED owner path renders a 1 MiB document of them FULLY (all 8 chunks, no plain-text tail)", async (t) => {
  assert.equal(OWNER_MD_RENDER_BUDGET_MS, 1000, "the budget is the production default");
  let worst = { ms: 0, what: "" };
  for (const [name, unit] of Object.entries(UNITS)) {
    const src = rep(`${unit}\n`, CHUNKED);
    assert.equal(src.length, CHUNKED, `${name}: the fixture is 1 MiB`);
    const r = await renderInWorker("owner", src, { budgetMs: FULL_RENDER_BUDGET_MS });
    if (r.ms > worst.ms) worst = { ms: r.ms, what: name };
    // Measured 949-1,029 ms (worst of three runs) for 1 MiB with the budget
    // raised; the bound is 6,000 ms, 5x that, so a CI runner ~3.5x slower than
    // this box stays inside it. The pre-guard cost of this document was 3,518 ms
    // (the 1 s budget plus one ~2.75 s chunk), so the bound sits above a third
    // of that cliff — reported by the audit rather than pretended away.
    assert.ok(r.ms < 6000,
      `${name}: a 1 MiB document took ${r.ms.toFixed(0)} ms through the chunked owner path with the budget raised (bound 6000 ms)`);
    assert.equal((r.html.match(/md-tail-notice/g) || []).length, 0,
      `${name}: all 8 chunks rendered (no plain-text tail), got ${JSON.stringify(r.html.slice(-200))}`);
    assert.ok(r.html.length >= CHUNKED,
      `${name}: all 1 MiB of content is on the page (got ${r.html.length} chars of HTML)`);
  }
  t.diagnostic(`worst 1 MiB chunked owner render (budget raised): ${worst.ms.toFixed(0)} ms — ${worst.what}`);
});

// (2) THE BUDGET, on the same documents with the DEFAULT budget: the render
// finishes inside its time bound, and if the budget ran out, what follows the
// notice is the WHOLE remainder — starting at a chunk boundary of the same
// document, readable back character for character. Nothing is ever dropped, and
// both outcomes (whole document, or a real remainder) are a pass here: which one
// happens is a property of the box, and (1) is where "fully formatted" is pinned.
test("the CHUNKED owner path keeps 1 MiB of them inside 5000 ms on the DEFAULT budget, dropping nothing", async (t) => {
  let worst = { ms: 0, what: "" };
  let budgetedOut = 0;
  for (const [name, unit] of Object.entries(UNITS)) {
    const src = rep(`${unit}\n`, CHUNKED);
    assert.equal(src.length, CHUNKED, `${name}: the fixture is 1 MiB`);
    const r = await renderInWorker("owner", src);
    if (r.ms > worst.ms) worst = { ms: r.ms, what: name };
    // Budget plus at most one bounded chunk, on any runner: measured 954-964 ms
    // here (5x is 5,000 ms, so this bound is unchanged), and the pre-chunking
    // quadratic was 3.5 s for this shape at 1 MiB.
    assert.ok(r.ms < 5000, `${name}: a 1 MiB document took ${r.ms.toFixed(0)} ms through the chunked owner path (bound 5000 ms)`);
    assert.ok(r.html.length >= CHUNKED,
      `${name}: all 1 MiB of content is on the page (got ${r.html.length} chars of HTML)`);
    if (r.html.includes(TAIL_NOTICE_TEXT)) {
      budgetedOut++;
      // The tail is the document's own remainder from a chunk boundary: nothing
      // between the formatted part and the tail was dropped.
      const at = r.html.indexOf(TAIL_NOTICE_TEXT);
      const open = r.html.indexOf(TAIL_OPEN, at);
      assert.ok(open > at, `${name}: the tail <pre> follows the notice`);
      const close = r.html.lastIndexOf("</pre>");
      const text = unescapeText(r.html.slice(open + TAIL_OPEN.length, close));
      assert.ok(text.length > 0, `${name}: the tail is a real remainder, not an empty one`);
      assert.ok(src.endsWith(text), `${name}: the tail is the end of the document`);
      assert.ok(ownerMarkdownChunks(src).some(([start]) => src.slice(start) === text),
        `${name}: the tail starts exactly at a chunk boundary (nothing was dropped)`);
    }
  }
  t.diagnostic(`worst 1 MiB chunked owner render (default budget): ${worst.ms.toFixed(0)} ms — ${worst.what}, `
    + `${budgetedOut} of ${Object.keys(UNITS).length} documents reached the budget`);
});

// --- ordinary content: pinned BEFORE the guard existed ---------------------
// sha256 of renderBotMarkdown / renderMarkdown for each document, captured from
// the renderer before brScanCost and MD_BR_SCAN_MAX existed. These are the
// shapes the guard must never touch: prose that wraps, a poem whose lines are
// indented, an address block (trailing spaces — marked's `  \n` hard break), a
// CRLF document, an NBSP used the way prose uses it, and CJK text with U+3000
// between sentences.
const PINS = {
  prose: {
    bot: "e16ebb0a182fe68a7559bc5ce6ee0245ab8f115b326bd3eef0a05a26ccfeae2b",
    owner: "bc91a2252126f824519162fdbb8df35b9e6d0232cca3848248e7799193d90749",
  },
  poem: {
    bot: "83d6e18ad72de627125a1a793d6269a3b8921a2b18df786a05edcdd76940288d",
    owner: "83d6e18ad72de627125a1a793d6269a3b8921a2b18df786a05edcdd76940288d",
  },
  address: {
    bot: "a48f5440f26fdbbd1b8c1dd42bca092414e1e5d0c85bb2326b6790a3ad5bb67c",
    owner: "a48f5440f26fdbbd1b8c1dd42bca092414e1e5d0c85bb2326b6790a3ad5bb67c",
  },
  crlf: {
    bot: "6f1dd893762c4520506f6f78eaf8a589e7c74230bc9025d79d4b99b6b4d0cae6",
    owner: "6f1dd893762c4520506f6f78eaf8a589e7c74230bc9025d79d4b99b6b4d0cae6",
  },
  nbsp: {
    bot: "10cf89b36287b28b0d9be04641dc4ff78f3592a49e07d731d7c1f94ef69c9d1f",
    owner: "10cf89b36287b28b0d9be04641dc4ff78f3592a49e07d731d7c1f94ef69c9d1f",
  },
  cjk: {
    bot: "4b77e1f4d6fd43477ad9d93be91b6917df108dc78f86deb173c939367066c9b7",
    owner: "4b77e1f4d6fd43477ad9d93be91b6917df108dc78f86deb173c939367066c9b7",
  },
};

function ordinaryDocs() {
  return {
    prose: [
      "# A heading",
      "",
      "A paragraph with a line",
      "break in the middle of it, a *small* emphasis run, a [link](/blog/x)",
      "and some `inline code`.",
      "",
      "- a list item",
      "- another one",
      "",
    ].join("\n"),
    poem: [
      "The road goes ever on and on",
      "Down from the door where it began.",
      "Now far ahead the road has gone,",
      "And I must follow, if I can.",
      "",
      "  an indented line of a poem",
      "  and another indented line",
      "",
    ].join("\n"),
    address: [
      "Alex Example",
      "12 Sample Street",
      "Suite 400",
      "Springfield",
      "",
      "Notes:   two spaces before the value",
      "and a line of trailing spaces   ",
      "end.",
    ].join("\n"),
    crlf: "A Windows document\r\nwith CRLF endings\r\n\r\n- and a list\r\n- with two items\r\n",
    nbsp: "A normal use of NBSP: 10\u00A0km, and \u00A0padding\u00A0 around a word.\nStill one paragraph.\n",
    cjk: "日本語の文\u3000です。\u3000これは普通の文章です。\n第二段落も\u3000含まれます。\n",
  };
}

test("ordinary content renders exactly as it did before the guard (pinned sha256)", () => {
  const docs = ordinaryDocs();
  for (const [name, doc] of Object.entries(docs)) {
    const bot = renderBotMarkdown(doc);
    const owner = renderMarkdown(doc);
    assert.equal(sha256(bot), PINS[name].bot,
      `${name} (bot path) changed: ${JSON.stringify(bot)}`);
    assert.equal(sha256(owner), PINS[name].owner,
      `${name} (owner path) changed: ${JSON.stringify(owner)}`);
    // The pins are pinned to a render the guard left ALONE — that is what makes
    // them evidence about the guard rather than about the document.
    assert.equal(mdBrScanStats.brFlattened, 0, `${name}: nothing was flattened for its br scan`);
  }
});

test("the br guard fires on the pathological shape, and not on prose", () => {
  const pathological = rep("\uFEFF\n", 4096);
  renderBotMarkdown(pathological);
  assert.ok(mdBrScanStats.brFlattened > 0,
    "a 4 KB paragraph of U+FEFF lines is flattened for its br scan");
  assert.ok(mdBrScanStats.charged > MD_BR_SCAN_MAX,
    `its br cost (${mdBrScanStats.charged}) is over the per-block cap (${MD_BR_SCAN_MAX})`);

  renderBotMarkdown(ordinaryDocs().prose);
  assert.equal(mdBrScanStats.flattened, 0, "ordinary prose flattens nothing");
  assert.ok(mdBrScanStats.charged < 1000,
    `ordinary prose's br cost is negligible (${mdBrScanStats.charged})`);
});

// U+0085 (NEL) is a line break in some encodings and NOT in JS's `\s`, so a
// paragraph of NEL lines is not this shape at all: the br lookahead never scans
// it, the guard must be blind to it (brScanStats stays 0), and the render must
// be identical either way. It is the boundary of the character class, so it is
// measured at both caps like the others — it was never slow, and it must not
// become slow, or change, because a guard was added for its neighbours.
test("a paragraph of U+0085 lines (not `\\s`) is not this shape: no charge, identical render", async () => {
  const bot = await renderInWorker("bot", rep("\u0085\n", CAP));
  assert.ok(bot.ms < 1000, `U+0085: 64 KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 1000 ms)`);
  const owner = await renderInWorker("owner", rep("\u0085\n", OWNER_HEAD));
  // Measured 121-131 ms (bot) and 185 ms (owner head) here in a fresh worker:
  // this shape never had the quadratic (138 / 234 ms before the guard), so it
  // only has to stay under the same bounds its guarded neighbours get.
  assert.ok(owner.ms < 2000, `U+0085: the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 2000 ms)`);

  const src = rep("\u0085\n", 4096);
  const guarded = renderBotMarkdown(src);
  assert.equal(mdBrScanStats.brFlattened, 0, "U+0085 is not in the br lookahead's class");
  assert.equal(mdBrScanStats.charged, 0, "U+0085 was not charged to the br budget");
  setMdBrScanGuardEnabled(false);
  let plain;
  try {
    plain = renderBotMarkdown(src);
  } finally {
    setMdBrScanGuardEnabled(true);
  }
  assert.equal(guarded, plain, "U+0085 lines render the same with the br guard on and off");
});

// --- the differential: 2,000 seeded documents, guard on vs guard off -------
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ordinary lines — the ones a real document is made of, including the two
 *  spellings of a hard break, an indented continuation, an NBSP inside a
 *  sentence and a U+3000 inside CJK text. */
const NORMAL_LINES = [
  "A line of ordinary prose that wraps.",
  "Another line, with *emphasis* and a [link](/blog/x).",
  "`inline code` in a sentence.",
  "a hard break at the end of this line  ",
  "a backslash hard break at the end of this line\\",
  "  an indented continuation line",
  "日本語の文\u3000です。",
  "10\u00A0km of NBSP used where prose uses it",
  "- a list item",
  "- another list item",
  "1. an ordered item",
  "> a quoted line",
  "> > a doubly quoted line",
  "# a heading",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "```",
  "code block line",
  "```",
  "",
];

/** Lines made of Unicode whitespace — the shape under test, in every unit and
 *  in mixtures, one to four characters wide. */
const WS_LINES = [
  "\uFEFF", "\u3000", "\u000B", "\u000C", "\u00A0", "\u2028", "\u2029", "\u1680",
  "\u2000", "\u2003", "\u2007", "\u200A", "\u202F", "\u205F",
  "\uFEFF\u3000", "\u00A0\u2028\u000B", "\u3000\u3000", "\u00A0\u00A0\u00A0",
  " \u00A0 ", "\u202F\u202F\u202F\u202F",
];

/** One document: 1-6 blocks of 1-6 lines, each line either ordinary or — with
 *  probability `wsChance` — a line of Unicode whitespace. Small by
 *  construction: no document here can reach MD_BR_SCAN_MAX, which is what makes
 *  "the guard left it alone" checkable per document. */
function randomDoc(rnd, wsChance) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const lines = [];
  const blocks = 1 + Math.floor(rnd() * 6);
  let wsLines = 0;
  for (let b = 0; b < blocks; b++) {
    const count = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < count; i++) {
      if (rnd() < wsChance) {
        lines.push(pick(WS_LINES));
        wsLines++;
      } else {
        lines.push(pick(NORMAL_LINES));
      }
    }
    if (b < blocks - 1) lines.push("");
  }
  return { doc: lines.join("\n"), wsLines };
}

test("differential: 2,000 seeded documents mixing normal lines with Unicode-whitespace lines render the same with the br guard on and off", () => {
  const rnd = mulberry32(0xb4a7c1);
  const stats = { withWs: 0, differed: 0, flattened: 0, brFlattened: 0, maxCharged: 0, brFromHardBreak: 0 };
  for (let n = 0; n < 2000; n++) {
    // A third of the corpus is mostly ordinary prose with a rare whitespace
    // line, a third mixes them evenly, a third is whitespace-heavy — so both
    // "the guard must not care" and "the guard must be able to see this" are in
    // the corpus.
    const { doc, wsLines } = randomDoc(rnd, n % 3 === 0 ? 0.05 : n % 3 === 1 ? 0.3 : 0.6);
    if (wsLines > 0) stats.withWs++;

    const guardedBot = renderBotMarkdown(doc);
    stats.flattened += mdBrScanStats.flattened;
    stats.brFlattened += mdBrScanStats.brFlattened;
    if (mdBrScanStats.charged > stats.maxCharged) stats.maxCharged = mdBrScanStats.charged;
    const guardedOwner = renderMarkdown(doc);

    setMdBrScanGuardEnabled(false);
    let plainBot;
    let plainOwner;
    try {
      plainBot = renderBotMarkdown(doc);
      plainOwner = renderMarkdown(doc);
    } finally {
      // Always back on: every later render in this file must be guarded.
      setMdBrScanGuardEnabled(true);
    }
    // The guard is only allowed to change a render it actually acted on. Every
    // document here is far under both the per-block cap and the document
    // budget, so `flattened === 0` is the guard's own statement that it left the
    // document to marked — and then the bytes must be identical.
    assert.equal(mdBrScanStats.flattened, 0,
      `doc #${n}: the guard flattened a block of a short document (${JSON.stringify(doc)})\n`
      + `  guarded: ${JSON.stringify(guardedBot)}`);
    if (guardedBot !== plainBot || guardedOwner !== plainOwner) stats.differed++;
    assert.equal(guardedBot, plainBot,
      `doc #${n} (bot path) changed with the br guard: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedBot)}\n  plain:   ${JSON.stringify(plainBot)}`);
    assert.equal(guardedOwner, plainOwner,
      `doc #${n} (owner path) changed with the br guard: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedOwner)}\n  plain:   ${JSON.stringify(plainOwner)}`);
    if (/<br\s*\/?>/.test(guardedBot)) stats.brFromHardBreak++;
  }
  assert.equal(stats.differed, 0, "no document rendered differently with the guard on");
  // Not vacuous in either direction: the corpus really does contain
  // Unicode-whitespace lines, and the renders really do emit <br> for the hard
  // breaks the rule exists for.
  assert.ok(stats.withWs > 1000, `the corpus contains Unicode-whitespace lines (${stats.withWs} documents)`);
  assert.ok(stats.brFromHardBreak > 500, `the corpus renders real <br> hard breaks (${stats.brFromHardBreak} documents)`);
});

// --- plain ASCII spaces: a FIFTH inline-lexer quadratic, owner path only ----
//
// marked's inline `text` rule stops at ` *\n` (its hard-break alternative) and
// its lazy `[\s\S]*?` retries that lookahead at EVERY position, so a run of
// plain spaces with no newline after it makes each retry walk the rest of the
// run: Σ(rest of the run), quadratic in the run and ~4x per doubling. It is
// pre-existing on the owner path (marked on its own measures the same) and no
// other guard can see it — spaces are no delimiter, no protocol word, no `@`
// and no line break — and the BOT path never had it because its math
// extension's inline start() caps each text-rule scan at about 4,096
// characters (START_WINDOW). The owner path now carries the same window (see
// "THE OWNER PATH'S TEXT-RUN WINDOW" in servers/blog/renderer.js), from an
// extension with a start() and a tokenizer that never matches. Both paths cut
// only between two characters of one run of spaces/tabs — never inside a run
// that ends in a line break, and not at all when there is no such run — because
// marked gives the text tokenizer a SLICE of the source, so an arbitrary cut
// reads as end-of-input (see the straddle sweep below).
//
// Measured on this tree, CPU ms of one whole render in a worker (before ->
// after, the same box):
//
//   'a' + ' ' x N + 'b'      64 KB          128 KB
//   owner path            ~1,366 -> 124   ~5,523 -> 213
//
// (each "after" number is one of two runs — 124–167 and 213–252 — because this
// box varies by up to ~35% between runs) and a line with single spaces only (no
// cut possible, see below) is linear: ~19 ms at 64 KB on the bot path, ~21 ms
// at the 128 KB owner head.
//
// What must stay true:
//   - the shape renders the 64 KB and the 128 KB owner head in < 2,000 ms, and
//     so does the same line inside a heading, a blockquote, a list item, a
//     table cell, a link label and an emphasis span (each is one inline block);
//   - the CHUNKED owner path renders 1 MiB of 120 KB space runs (separated by
//     the blank lines that make them separate chunks) in < 6,000 ms and one
//     1 MiB space line in < 5,000 ms in total;
//
// Those bounds are 5x the worst of three measured runs here in a fresh worker,
// like the test's: 116–119 ms for a container at 64 KB and 218–232 ms at the
// 128 KB owner head, 1,056–1,083 ms and 219–236 ms for the two 1 MiB chunked
// documents (a CI runner's 1,037 ms for the table cell at 128 KB is the case
// that set these); the PRE-window cost was ~1,366 ms at 64 KB and ~5,523 ms at
// the owner head, i.e. still past these bounds.
//   - the output is unchanged: the cut sits BETWEEN two characters of one run of
//     spaces/tabs, where nothing in marked's inline rules can start or stop, so
//     the pieces merge back into the same raw text (`p.raw += o.raw, p.text +=
//     o.text`) — 3,000 seeded documents plus a set of boundary documents (an
//     HTML entity straddling the cut, mixed spaces and tabs, math-like `$` text,
//     every container) must render BYTE IDENTICALLY with the window on and with
//     it off, and the corpus must really reach the window (the cuts are
//     counted);
//   - a token may never be split by the cut: URLs (https://, http://, www.,
//     ftp://), an email's local part and its domain, and both halves of a
//     two-space hard break, swept across the old 4,096 boundary at offsets
//     -3..+5, render identically with the window on and off on BOTH paths, and
//     a realistic long paragraph with a link near the cut does too at 200
//     offsets;
//   - every other pin in the suite is untouched (they are run alongside this
//     file, and the pins in this one are checked above).
/** `prefix` + spaces + `suffix`, exactly `n` characters — every container shape
 *  is one inline block of the size under test. */
const fillSpace = (prefix, suffix, n) => prefix + " ".repeat(n - prefix.length - suffix.length) + suffix;

const SPACE_SHAPES = {
  // The plain shape. The first and last characters are what make marked's
  // block lexer see a paragraph at all (a line of only spaces is a blank line).
  plain: (n) => "a" + " ".repeat(n - 2) + "b",
  heading: (n) => fillSpace("# a", "b\n", n),
  quote: (n) => fillSpace("> a", "b\n", n),
  list: (n) => fillSpace("- a", "b\n", n),
  cell: (n) => fillSpace("| a", "b | x |\n| - | - |\n| c | d |\n", n),
  link: (n) => fillSpace("[a", "b](/blog/x)\n", n),
  emphasis: (n) => fillSpace("*a", "b*\n", n),
};

test("a run of plain spaces renders in < 1000 ms at 64 KB and < 2000 ms at the 128 KB owner head, in every container", async (t) => {
  let worst = { ms: 0, what: "" };
  for (const [name, shape] of Object.entries(SPACE_SHAPES)) {
    // The plain shape at both sizes; every container at the owner head (each is
    // one inline block of the same length, so it is the same scan).
    const sizes = name === "plain" ? [CAP, OWNER_HEAD] : [OWNER_HEAD];
    for (const size of sizes) {
      const src = shape(size);
      assert.equal(src.length, size, `${name}: the fixture is ${size} chars`);
      const r = await renderInWorker("owner", src);
      if (r.ms > worst.ms) worst = { ms: r.ms, what: `${name} @ ${size}` };
      // Two bounds, because the two sizes cost differently: the 64 KB one is
      // ~1,366 ms of quadratic before the window (so 1,000 ms catches it — but
      // only just, and see the header note), the 128 KB containers measured
      // 218-232 ms here in a fresh worker and 2,000 ms covers a CI runner ~3.5x
      // slower than this box (5x measured would be 1,200 ms, and the ~5,523 ms
      // pre-window cost is still past either bound).
      const bound = size >= OWNER_HEAD ? 2000 : 1000;
      assert.ok(r.ms < bound,
        `${name} at ${size} chars took ${r.ms.toFixed(0)} ms on the owner path (bound ${bound} ms)`);
      // The text survives: this shape is a paragraph, not something flattened.
      assert.ok(r.length >= src.length * 0.99,
        `${name}: the content is on the page (got ${r.length} chars of HTML for ${src.length})`);
    }
  }
  t.diagnostic(`worst plain-space render: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
});

test("the CHUNKED owner path renders 1 MiB of plain-space runs in < 6000 ms in total", async (t) => {
  // 120 KB runs, each ended by a blank line so every chunk holds ONE of them —
  // the shape that makes the per-chunk cost, rather than the split, the thing
  // under test.
  const runs = rep("a" + " ".repeat(120000 - 2) + "b\n\n", CHUNKED);
  const r = await renderInWorker("owner", runs);
  // Over the per-document budget the remainder becomes the plain-text tail, so
  // the bound is "budget plus one chunk" (see OWNER_MD_RENDER_BUDGET_MS) — and
  // nothing is dropped either way. Measured 1,056-1,083 ms (worst of three
  // runs); the bound is 6,000 ms, 5x that. No before-fix time is recorded for
  // THIS 1 MiB fixture (the window's cliff, ~1,366 ms at 64 KB and ~5,523 ms at
  // the 128 KB owner head, is on the shapes above).
  assert.ok(r.ms < 6000, `1 MiB of 120 KB space runs took ${r.ms.toFixed(0)} ms through the chunked owner path (bound 6000 ms)`);
  assert.ok(r.html.length >= CHUNKED, `all 1 MiB of content is on the page (got ${r.html.length} chars of HTML)`);

  const one = SPACE_SHAPES.plain(CHUNKED);
  const r2 = await renderInWorker("owner", one);
  assert.ok(r2.ms < 5000, `one 1 MiB space line took ${r2.ms.toFixed(0)} ms through the chunked owner path (bound 5000 ms)`);
  assert.ok(r2.length > 0, "the 1 MiB space line still renders");
  t.diagnostic(`1 MiB space runs: ${r.ms.toFixed(0)} ms; one 1 MiB line: ${r2.ms.toFixed(0)} ms`);
});

// The other side of the cut rule: a stretch with no two adjacent spaces/tabs has
// no quadratic space run for the window to break up, so it must be left uncut
// entirely — and that must stay linear (marked's text rule walks it once, not
// once per position, because there is no ` *\n` to look for).
test("a stretch with no double space is left uncut and stays linear (bot 64 KB, owner 128 KB)", async (t) => {
  const botSrc = rep("word ", CAP);
  const ownerSrc = rep("word ", OWNER_HEAD);
  assert.equal(botSrc.length, CAP);
  assert.equal(ownerSrc.length, OWNER_HEAD);
  // In-process, so the counters belong to the render under test.
  const botOnce = renderBotMarkdown(botSrc);
  assert.equal(mdBotTextWindowStats.cuts, 0, "the bot window does not cut a single-space line");
  const ownerOnce = renderMarkdown(ownerSrc);
  assert.equal(mdOwnerTextWindowStats.cuts, 0, "the owner window does not cut a single-space line");
  assert.ok(botOnce.length > 0 && ownerOnce.length > 0, "both paths still render the words");

  const bot = await renderInWorker("bot", botSrc);
  // Measured 18-22 ms here in a fresh worker (a single-space line has no usable
  // cut and is linear), so 500 ms is ~23x it: the pre-guard bounds stay, nothing
  // to head for.
  assert.ok(bot.ms < 500, `a 64 KB single-space line took ${bot.ms.toFixed(0)} ms on the bot path (bound 500 ms)`);
  const owner = await renderInWorker("owner", ownerSrc);
  assert.ok(owner.ms < 1000, `a 128 KB single-space line took ${owner.ms.toFixed(0)} ms on the owner path (bound 1000 ms)`);
  t.diagnostic(`single-space lines (no cut): bot 64 KB ${bot.ms.toFixed(0)} ms, owner 128 KB ${owner.ms.toFixed(0)} ms`);
});

/** Every token an arbitrary cut used to be able to split: the four URL
 *  spellings marked autolinks, an email's local part and its domain, and both
 *  halves of a two-space hard break. `inner` is how many of the token's
 *  characters sit before the boundary. */
const STRADDLE_TOKENS = [
  ["https:// (first character)", "https://example.com/p tail", 0],
  ["https:// (inside the protocol)", "https://example.com/p tail", 4],
  ["http://", "http://example.com/p tail", 2],
  ["www.", "www.example.com/p tail", 1],
  ["ftp://", "ftp://example.com/p tail", 3],
  ["an email (local part)", "foobar@example.com tail", 2],
  ["an email (domain)", "foobar@example.com tail", 10],
  ["a hard break (its spaces)", "x  \nnext tail", 1],
  ["a hard break (its newline)", "x  \nnext tail", 3],
];

/** `token` placed so that its `inner`th character sits at document index
 *  CUT_WINDOW + offset — the fixed 4,096 cut landed inside it for offsets
 *  -3..+5. The filler before it is one long run of spaces, which is where the
 *  cut may (and must) land instead. */
function straddlingDoc(token, inner, offset) {
  const pad = Math.max(1, CUT_WINDOW + offset - inner - 1);
  return "a" + " ".repeat(pad) + token;
}

// Documents that put something interesting exactly AT the window boundary. The
// window is a character count, so whatever sits near it must not be able to
// notice — and with the fixed 4,096 cut things did: a token that crossed the
// cut was never matched (the text rule stops at the slice's end, which reads as
// end-of-input), so a URL became plain text, an email linked to the wrong
// address and a hard break grew a stray space. The window may now only cut
// between two characters of one run of spaces/tabs (never inside a run that
// ends in a line break), so everything below must render exactly as it does
// with the window off.
// (`&#123;` is the case worth naming: `&` is the one character whose escaping
// looks at what follows it — measured identical, because marked's inline text
// tokenizer keeps the raw source and merges the pieces.)
const BOUNDARY_DOCS = [
  "x ".repeat(2048) + "&#123;" + "y ".repeat(2000),
  "x ".repeat(2048) + "&amp;" + "y ".repeat(2000),
  "x ".repeat(2046) + "&&#123;" + "y ".repeat(2000),
  "a" + "\t ".repeat(2100) + "b",
  "a" + " ".repeat(4096) + "$5 and $10, $x$ and $$y$$, \\(z\\) " + " ".repeat(4096) + "b",
  "    a" + " ".repeat(5000) + "b\n",
  "```\na" + " ".repeat(5000) + "b\n```\n",
  "*a" + " ".repeat(5000) + "b* [link](/blog/x) `code` **strong** _em_\n",
  // …and every token a cut must never split, at every offset -3..+5.
  ...STRADDLE_TOKENS.flatMap(([, token, inner]) =>
    Array.from({ length: 9 }, (_, k) => straddlingDoc(token, inner, k - 3))),
];

test("a token straddling the cut renders identically with the text-run window on and off, on BOTH paths (offsets -3..+5)", () => {
  let compared = 0;
  let ownerCuts = 0;
  let botCuts = 0;
  for (const [name, token, inner] of STRADDLE_TOKENS) {
    for (let offset = -3; offset <= 5; offset++) {
      const doc = straddlingDoc(token, inner, offset);
      const botOn = renderBotMarkdown(doc);
      const botCut = mdBotTextWindowStats.cuts;
      const ownerOn = renderMarkdown(doc);
      const ownerCut = mdOwnerTextWindowStats.cuts;
      ownerCuts += ownerCut;
      botCuts += botCut;
      setBotTextWindowEnabled(false);
      setOwnerTextWindowEnabled(false);
      let botOff;
      let ownerOff;
      try {
        botOff = renderBotMarkdown(doc);
        assert.equal(mdBotTextWindowStats.cuts, 0, `${name} @ ${offset}: the bot window is off`);
        ownerOff = renderMarkdown(doc);
        assert.equal(mdOwnerTextWindowStats.cuts, 0, `${name} @ ${offset}: the owner window is off`);
      } finally {
        // Always back on: every later render in this file must be windowed.
        setBotTextWindowEnabled(true);
        setOwnerTextWindowEnabled(true);
      }
      assert.equal(botOn, botOff,
        `${name} at offset ${offset} (bot path) changed with the window (${botCut} cuts): ${JSON.stringify(doc.slice(-40))}\n`
        + `  windowed:  ${JSON.stringify(botOn)}\n  unlimited: ${JSON.stringify(botOff)}`);
      assert.equal(ownerOn, ownerOff,
        `${name} at offset ${offset} (owner path) changed with the window (${ownerCut} cuts): ${JSON.stringify(doc.slice(-40))}\n`
        + `  windowed:  ${JSON.stringify(ownerOn)}\n  unlimited: ${JSON.stringify(ownerOff)}`);
      compared++;
    }
  }
  assert.equal(compared, STRADDLE_TOKENS.length * 9, "every token was checked at every offset");
  // Not vacuous: the fixtures are long enough that both windows really cut.
  assert.equal(ownerCuts, compared, `the owner window cut every fixture (${ownerCuts} of ${compared})`);
  assert.equal(botCuts, compared, `the bot window cut every fixture (${botCuts} of ${compared})`);
});

test("the owner text-run window is on by default, counts its cuts, and boundary documents render identically with it on and off", () => {
  // On by default: a > 4 KB run is cut without anyone setting a switch.
  renderMarkdown(SPACE_SHAPES.plain(8192));
  assert.ok(mdOwnerTextWindowStats.cuts > 0,
    `a 8 KB space run is cut at the window by default (${mdOwnerTextWindowStats.cuts} cuts)`);

  for (const doc of BOUNDARY_DOCS) {
    const on = renderMarkdown(doc);
    const cuts = mdOwnerTextWindowStats.cuts;
    let off;
    setOwnerTextWindowEnabled(false);
    try {
      off = renderMarkdown(doc);
      assert.equal(mdOwnerTextWindowStats.cuts, 0, `the window is off (${JSON.stringify(doc.slice(0, 40))})`);
    } finally {
      // Always back on: every later render in this file must be windowed.
      setOwnerTextWindowEnabled(true);
    }
    assert.equal(on, off,
      `a window boundary changed the render of ${JSON.stringify(doc.slice(0, 60))} (${cuts} cuts)\n`
      + `  on:  ${JSON.stringify(on)}\n  off: ${JSON.stringify(off)}`);
  }
});

/** `n` characters of ordinary prose words separated by single spaces (the
 *  last word may be cut short — that is still prose). */
function proseFiller(n, separator = " ") {
  let s = "word";
  while (s.length < n) s += separator + "word";
  return s.slice(0, n);
}

// The shape a real long post has: one long single-line paragraph, a link near
// the window, and words separated by single spaces — so the window mostly has
// nothing to cut (where a sliced filler happens to end on a space there is one
// double space, and that is the whole cut) and must leave the paragraph exactly
// as marked would. The reported regression was here: with the fixed 4,096 cut,
// 3 of these 200 offsets put the cut inside `https://example.com/page` and the
// link came out as plain text.
test("a realistic long paragraph with a link near the cut renders identically at 200 offsets on both paths", (t) => {
  const tail = proseFiller(3600);
  let differed = 0;
  let cut = 0;
  for (let offset = -100; offset < 100; offset++) {
    const doc = proseFiller(4000 + offset) + " see https://example.com/page " + tail + " end.";
    const botOn = renderBotMarkdown(doc);
    const ownerOn = renderMarkdown(doc);
    cut += mdOwnerTextWindowStats.cuts + mdBotTextWindowStats.cuts;
    setBotTextWindowEnabled(false);
    setOwnerTextWindowEnabled(false);
    let botOff;
    let ownerOff;
    try {
      botOff = renderBotMarkdown(doc);
      ownerOff = renderMarkdown(doc);
    } finally {
      setBotTextWindowEnabled(true);
      setOwnerTextWindowEnabled(true);
    }
    if (botOn !== botOff || ownerOn !== ownerOff) differed++;
    assert.equal(botOn, botOff,
      `offset ${offset} (bot path) changed with the window: ${JSON.stringify(botOn.slice(3800, 4300))}\n`
      + `  vs ${JSON.stringify(botOff.slice(3800, 4300))}`);
    assert.equal(ownerOn, ownerOff,
      `offset ${offset} (owner path) changed with the window: ${JSON.stringify(ownerOn.slice(3800, 4300))}\n`
      + `  vs ${JSON.stringify(ownerOff.slice(3800, 4300))}`);
    // The link really is a link either way (not just "the same plain text").
    assert.match(ownerOn, /<a href="https:\/\/example\.com\/page"/,
      `offset ${offset}: the owner path autolinks the URL`);
    assert.match(botOn, /<a href="https:\/\/example\.com\/page"/,
      `offset ${offset}: the bot path autolinks the URL`);
  }
  assert.equal(differed, 0, "no offset rendered differently with the window on");
  t.diagnostic(`200 offsets around the cut: ${differed} differences, ${cut} cuts (single spaces only)`);

  // The same 200 offsets written with sentence spacing (two spaces after every
  // word): now the window really does cut, a few characters from the same link,
  // and the sentence-spaced prose must still match the unlimited render.
  let spacedDiffered = 0;
  let spacedCuts = 0;
  for (let offset = -100; offset < 100; offset++) {
    const doc = proseFiller(4000 + offset, "  ") + " see https://example.com/page " + proseFiller(3600, "  ") + " end.";
    const botOn = renderBotMarkdown(doc);
    const ownerOn = renderMarkdown(doc);
    spacedCuts += mdOwnerTextWindowStats.cuts + mdBotTextWindowStats.cuts;
    setBotTextWindowEnabled(false);
    setOwnerTextWindowEnabled(false);
    let botOff;
    let ownerOff;
    try {
      botOff = renderBotMarkdown(doc);
      ownerOff = renderMarkdown(doc);
    } finally {
      setBotTextWindowEnabled(true);
      setOwnerTextWindowEnabled(true);
    }
    if (botOn !== botOff || ownerOn !== ownerOff) spacedDiffered++;
    assert.equal(botOn, botOff, `sentence-spaced offset ${offset} (bot path) changed with the window`);
    assert.equal(ownerOn, ownerOff, `sentence-spaced offset ${offset} (owner path) changed with the window`);
  }
  assert.equal(spacedDiffered, 0, "no sentence-spaced offset rendered differently with the window on");
  assert.ok(spacedCuts >= 200, `the window really cut the sentence-spaced paragraphs (${spacedCuts} cuts)`);
  t.diagnostic(`200 sentence-spaced offsets around the cut: ${spacedDiffered} differences, ${spacedCuts} cuts`);
});

/** One seeded owner document: ordinary markdown (prose, indentation, hard
 *  breaks, emphasis, links, code spans, tables, headings, math-like `$` text —
 *  the owner path has no math extension, so `$` is just a character there) with
 *  some blocks replaced by — or wrapped around — a long run of plain spaces. */
function randomOwnerDoc(rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  /** One in four runs is long enough to cross the 4,096-character window (a
   *  run below it is never cut, so the rest of the tier stays cheap). */
  const size = () => (rnd() < 0.25 ? 4100 + Math.floor(rnd() * 200) : 8 + Math.floor(rnd() * 392));
  const run = (s) => "a" + " ".repeat(s) + "b";
  const container = (s) => pick([
    () => "# " + run(s),
    () => "> " + run(s),
    () => "- " + run(s),
    () => "| " + run(s) + " | y |\n| - | - |\n| c | d |",
    () => "[" + run(s) + "](/blog/x) and *" + run(s) + "*",
    () => run(s),
    () => "a" + "\t ".repeat(Math.max(1, Math.floor(s / 2))) + "b",
    () => run(s).replace(/ {8}/, " $5 and $10 $$"),
  ])();
  const blocks = [];
  const count = 1 + Math.floor(rnd() * 5);
  let spaceRuns = 0;
  for (let b = 0; b < count; b++) {
    const kind = rnd();
    if (kind < 0.45) {
      // Ordinary lines, straight out of the br differential's corpus.
      blocks.push(pick(NORMAL_LINES));
    } else if (kind < 0.55) {
      blocks.push("    an indented line");
    } else {
      blocks.push(container(size()));
      spaceRuns++;
    }
  }
  return { doc: blocks.join("\n"), spaceRuns };
}

test("differential: 3,000 seeded owner documents render byte-identically with the owner text-run window on and off", () => {
  const rnd = mulberry32(0x5c4e11);
  const stats = { cuts: 0, docsWithCuts: 0, maxCuts: 0, withRuns: 0, differed: 0 };
  const docs = BOUNDARY_DOCS.slice();
  for (let n = 0; n < 3000; n++) {
    const { doc, spaceRuns } = randomOwnerDoc(rnd);
    if (spaceRuns > 0) stats.withRuns++;
    docs.push(doc);
  }
  for (let n = 0; n < docs.length; n++) {
    const doc = docs[n];
    const on = renderMarkdown(doc);
    const cuts = mdOwnerTextWindowStats.cuts;
    stats.cuts += cuts;
    if (cuts > 0) stats.docsWithCuts++;
    if (cuts > stats.maxCuts) stats.maxCuts = cuts;
    let off;
    setOwnerTextWindowEnabled(false);
    try {
      off = renderMarkdown(doc);
      assert.equal(mdOwnerTextWindowStats.cuts, 0, `doc #${n}: no cut with the window off`);
    } finally {
      setOwnerTextWindowEnabled(true);
    }
    // Nothing changes output now: the cut sits between two characters of one
    // space/tab run, so the pieces merge back into the same raw text. See the
    // straddle sweep above for the tokens an arbitrary cut used to split.
    if (on !== off) stats.differed++;
    assert.equal(on, off,
      `doc #${n} (owner path) changed with the text-run window (${cuts} cuts): ${JSON.stringify(doc)}\n`
      + `  windowed: ${JSON.stringify(on)}\n  unlimited: ${JSON.stringify(off)}`);
  }
  assert.equal(stats.differed, 0, "no document rendered differently with the window on");
  // Not vacuous: the corpus really does carry plain-space runs, and the window
  // really does fire on a large part of it.
  assert.ok(stats.withRuns > 1500, `the corpus contains plain-space runs (${stats.withRuns} documents)`);
  assert.ok(stats.docsWithCuts > 500,
    `the window really cut text runs (${stats.docsWithCuts} documents, ${stats.cuts} cuts, worst ${stats.maxCuts})`);
});

// --- the two regressions the window introduced, pinned ---------------------
//
// (1) THE MATH HINT MUST NOT DEPEND ON THE CUT. The bot path's start() is the
// only thing that makes marked's text rule (which does not stop at `$`) stop
// where math starts, and it used to report the text-run cut ALONE whenever the
// first START_WINDOW characters held no `$`/`\(` — and to remember "no cut"
// for the whole source, so every shorter suffix was answered without a scan.
// Math past the window was then swallowed as raw text: `prose(5000) + " $x^2$"
// came out with the dollars on the page, and a `$` that later fell INSIDE a
// window was lost too. The hint is now the MINIMUM of "the next opener, scanned
// over the whole source" and "the text-run cut, or none", with the two memoized
// separately, and the window-off seam keeps math detection whole — which is the
// reference the sweep below measures against.

/** The four reported repros. `fill(n)` is single-spaced prose (the shape with no
 *  usable cut at all), and each document is also required to RENDER its math,
 *  not merely to match the reference. */
const MATH_PAST_WINDOW = [
  ["math past a 5,000-character prose paragraph", () => proseFiller(5000) + " $x^2$ end", ["<code>x^2</code>"]],
  ["$$y^2$$ past 4 KB", () => proseFiller(5000) + " $$y^2$$ end", ["<code>y^2</code>"]],
  ["math after an emphasis span at 4.5 KB", () => proseFiller(4500) + " *a* " + proseFiller(300) + " $x^2$",
    ["<code>x^2</code>", "<em>a</em>"]],
  ["math after a URL at 4.5 KB", () => proseFiller(4500) + " https://example.com/p " + proseFiller(300) + " $x^2$",
    ["<code>x^2</code>", '<a href="https://example.com/p"']],
];

test("math past the window still renders as math on the bot path (B1)", () => {
  for (const [name, build, marks] of MATH_PAST_WINDOW) {
    const doc = build();
    const on = renderBotMarkdown(doc);
    setBotTextWindowEnabled(false);
    let off;
    try {
      off = renderBotMarkdown(doc);
    } finally {
      setBotTextWindowEnabled(true);
    }
    assert.equal(on, off,
      `${name}: the window changed the render\n  windowed:  ${JSON.stringify(on.slice(-240))}\n  unlimited: ${JSON.stringify(off.slice(-240))}`);
    for (const mark of marks) {
      assert.ok(on.includes(mark), `${name}: ${mark} is rendered — got ${JSON.stringify(on.slice(-240))}`);
    }
    // Not vacuous: the document really is longer than the window.
    assert.ok(doc.length > CUT_WINDOW * 1.1, `${name}: the document reaches past the window (${doc.length})`);
  }
});

/** One opener spelling per shape the hint scans for. `\[…\]` is only math at a
 *  line start, so mid-paragraph it is escaped text in BOTH renders — the case
 *  that proves the hint may look for it without changing anything. */
const MATH_SPELLINGS = [
  (body) => `$${body}$`,
  (body) => `$$${body}$$`,
  (body) => `\\(${body}\\)`,
  (body) => `\\[${body}\\]`,
  (body) => `$${body}+1$`,
  (body) => `$${body}_2$`,
];

// 240 cases: 6 spellings x 20 positions x 2 fillers, the positions straddling
// the 4 KB window (3,000-7,750) and going past it. The reference side is
// setBotTextWindowEnabled(false): math detection with NO window, which is
// main's behaviour for the hint itself. main still missed 14 of these with its
// own 4,096-character scan (recorded below as the sweep's baseline, so this
// test can only fail if the fix makes things WORSE than main); the broken
// commit missed 54.
const MAIN_MATH_MISSES = 14;

test("240-case math sweep around and beyond the 4 KB window: no new misses on the bot path", (t) => {
  let cases = 0;
  let misses = 0;
  let referenceMath = 0;
  let cutCases = 0;
  let worst = null;
  for (const spelling of MATH_SPELLINGS) {
    for (const spaced of [false, true]) {
      // Single-spaced prose has no usable cut at all; sentence-spaced prose has
      // one every few characters, so half the sweep runs through the CUT branch
      // of the hint (where the opener may sit anywhere on either side of it).
      const fill = (n) => proseFiller(n, spaced ? "  " : " ");
      for (let k = 0; k < 20; k++) {
        const pos = 3000 + k * 250;
        const doc = fill(pos) + " " + spelling("x^2") + " tail";
        const on = renderBotMarkdown(doc);
        if (mdBotTextWindowStats.cuts > 0) cutCases++;
        setBotTextWindowEnabled(false);
        let off;
        try {
          off = renderBotMarkdown(doc);
        } finally {
          setBotTextWindowEnabled(true);
        }
        cases++;
        if (off.includes("<code>") || off.includes('class="math"')) referenceMath++;
        if (on !== off) {
          misses++;
          if (!worst) worst = `${JSON.stringify(spelling("x^2"))} at ${pos} (${spaced ? "sentence" : "single"}-spaced)\n`
            + `  windowed:  ${JSON.stringify(on.slice(pos - 40, pos + 120))}\n`
            + `  unlimited: ${JSON.stringify(off.slice(pos - 40, pos + 120))}`;
        }
      }
    }
  }
  assert.equal(cases, 240, "every case was rendered");
  // Not vacuous: the reference really does find math in the sweep, and the sweep
  // really does reach the window's cut branch.
  assert.ok(referenceMath >= 190, `the reference renders math in the sweep (${referenceMath} of ${cases})`);
  assert.ok(cutCases >= 100, `the sweep lands on the text-run cut (${cutCases} cases)`);
  if (worst) t.diagnostic(`first miss: ${worst}`);
  t.diagnostic(`math sweep: ${cases} cases, ${misses} misses (main recorded ${MAIN_MATH_MISSES}, the broken `
    + `commit 54), ${referenceMath} with math, ${cutCases} through the cut`);
  // Stricter than "no worse than main": the hint now scans exactly what the
  // window-free reference does, so no case may differ at all.
  assert.equal(misses, 0,
    `${misses} of ${cases} math cases render differently with the window on (main recorded `
    + `${MAIN_MATH_MISSES}, the broken commit 54): ${worst}`);
});

// (2) A RUN THAT ENDS IN A LINE BREAK IS USABLE UP TO ITS LAST TAB. Excluding
// such a run whole (the old rule) left `"a" + " " * N + "\t\nb"` quadratic:
// the tab makes ` *\n` fail, and the text rule's lazy `[\s\S]*?` retried it at
// every position of the run — 1,175 ms for 60 KB on the bot path (main: 89 ms),
// 5,255 ms for the 128 KB owner head and 4,576 ms for the 1 MiB chunked
// document. Past the last tab the run IS one all-space stretch, which ` *\n`
// stops at and `br` takes, so only that stretch is excluded (see the invariant
// above textRunCut in servers/blog/renderer.js).

/** Exactly `n` characters: the run, then a tab, then the line break. */
const TAB_BREAK_SHAPES = {
  "spaces then a tab then a line break": (n) => "a" + " ".repeat(n - 4) + "\t\nb",
  "half spaces, half tabs, then a line break": (n) => {
    const spaces = Math.floor((n - 3) / 2);
    return "a" + " ".repeat(spaces) + "\t".repeat(n - 3 - spaces) + "\nb";
  },
};

test("a run that ends in a line break is cut up to its last tab (B2): bot 60 KB < 1000 ms, owner 128 KB < 2000 ms", async (t) => {
  for (const [name, shape] of Object.entries(TAB_BREAK_SHAPES)) {
    const botSrc = shape(60 * 1024);
    assert.equal(botSrc.length, 60 * 1024, `${name}: the bot fixture is 60 KB`);
    const bot = await renderInWorker("bot", botSrc);
    // Measured 112-114 ms here in a fresh worker; the pre-fix cost was 1,175 ms
    // on this path, so 1,000 ms still separates it (5x measured would be 600 ms).
    assert.ok(bot.ms < 1000, `${name}: 60 KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 1000 ms)`);
    assert.ok(bot.length > 0, `${name}: the bot path still renders`);

    const ownerSrc = shape(OWNER_HEAD);
    assert.equal(ownerSrc.length, OWNER_HEAD, `${name}: the owner fixture is the 128 KB head`);
    const owner = await renderInWorker("owner", ownerSrc);
    // Measured 204-215 ms here; the pre-fix cost was 5,255 ms on this path.
    assert.ok(owner.ms < 2000, `${name}: the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 2000 ms)`);
    assert.ok(owner.length >= ownerSrc.length * 0.99, `${name}: the content is on the page`);

    // The cut is invisible: the same document renders byte-identically with the
    // window off. A smaller document, because the reference side is quadratic on
    // this shape by definition (that is the regression).
    const small = shape(8 * 1024);
    const botOn = renderBotMarkdown(small);
    const botCuts = mdBotTextWindowStats.cuts;
    const ownerOn = renderMarkdown(small);
    const ownerCuts = mdOwnerTextWindowStats.cuts;
    setBotTextWindowEnabled(false);
    setOwnerTextWindowEnabled(false);
    let botOff;
    let ownerOff;
    try {
      botOff = renderBotMarkdown(small);
      ownerOff = renderMarkdown(small);
    } finally {
      setBotTextWindowEnabled(true);
      setOwnerTextWindowEnabled(true);
    }
    assert.ok(botCuts > 0, `${name}: the bot window cut the 8 KB shape (${botCuts} cuts)`);
    assert.ok(ownerCuts > 0, `${name}: the owner window cut the 8 KB shape (${ownerCuts} cuts)`);
    assert.equal(botOn, botOff, `${name}: the bot render changed with the window (${botCuts} cuts)`);
    assert.equal(ownerOn, ownerOff, `${name}: the owner render changed with the window (${ownerCuts} cuts)`);
    t.diagnostic(`${name}: bot 60 KB ${bot.ms.toFixed(0)} ms, owner 128 KB ${owner.ms.toFixed(0)} ms, `
      + `${botCuts}+${ownerCuts} cuts on the 8 KB shape`);
  }
});

/** The same shape in every spelling the new rule tells apart, each exactly `n`
 *  characters: the run starts at index 1 and reaches past 4,096, so the cut the
 *  window wants always falls INSIDE it. Past a run's last tab the run is one
 *  all-space stretch (which ` *\n` stops at and `br` takes) — so that stretch
 *  is the only part of a run this rule may not cut, and the all-spaces shape
 *  must stay uncut while every spelling with a tab in it is cut and renders
 *  exactly as it does with no window at all. */
const BREAK_RUN_SHAPES = {
  "all spaces (no cut: the br owns the stretch)": (n) => "a" + " ".repeat(n - 3) + "\nb",
  "spaces, then one tab": (n) => "a" + " ".repeat(n - 4) + "\t\nb",
  "spaces, a tab, then three spaces": (n) => "a" + " ".repeat(n - 7) + "\t   \nb",
  "spaces, a tab, then one space": (n) => "a" + " ".repeat(n - 5) + "\t \nb",
  "tabs, then two spaces": (n) => "a" + "\t".repeat(n - 5) + "  \nb",
  "spaces, then two tabs": (n) => "a" + " ".repeat(n - 5) + "\t\t\nb",
};

test("every spelling of a run that ends in a line break renders exactly as it does with no window", () => {
  let compared = 0;
  let cuts = 0;
  for (const [name, shape] of Object.entries(BREAK_RUN_SHAPES)) {
    const allSpaces = name.startsWith("all spaces");
    for (let size = 4100; size <= 4400; size += 10) {
      const doc = shape(size);
      assert.equal(doc.length, size, `${name}: the fixture is ${size} chars`);
      const botOn = renderBotMarkdown(doc);
      const botCuts = mdBotTextWindowStats.cuts;
      const ownerOn = renderMarkdown(doc);
      const ownerCuts = mdOwnerTextWindowStats.cuts;
      cuts += botCuts + ownerCuts;
      if (allSpaces) {
        assert.equal(botCuts + ownerCuts, 0,
          `${name}: an all-space stretch before the line break is never cut (${botCuts}+${ownerCuts})`);
      }
      setBotTextWindowEnabled(false);
      setOwnerTextWindowEnabled(false);
      let botOff;
      let ownerOff;
      try {
        botOff = renderBotMarkdown(doc);
        ownerOff = renderMarkdown(doc);
      } finally {
        setBotTextWindowEnabled(true);
        setOwnerTextWindowEnabled(true);
      }
      assert.equal(botOn, botOff,
        `${name} at ${size} chars (bot path) changed with the window (${botCuts} cuts): ${JSON.stringify(doc.slice(4080, 4130))}`);
      assert.equal(ownerOn, ownerOff,
        `${name} at ${size} chars (owner path) changed with the window (${ownerCuts} cuts): ${JSON.stringify(doc.slice(4080, 4130))}`);
      compared++;
    }
  }
  assert.ok(cuts > compared, `the shapes with a tab really cut (${cuts} cuts over ${compared} documents)`);
});

const TAB_BREAK_UNIT = "a" + " ".repeat(120000 - 2) + "\t\nb\n\n";

test("the CHUNKED owner path renders 1 MiB of space-run-then-tab-then-line-break units in < 6000 ms", async (t) => {
  const src = rep(TAB_BREAK_UNIT, CHUNKED);
  assert.equal(src.length, CHUNKED, "the fixture is 1 MiB");
  const r = await renderInWorker("owner", src);
  // Measured 1,174-1,203 ms here (budget plus one chunk); the bound is 6,000 ms,
  // 5x that. The pre-fix cost was 4,576 ms — BELOW this bound, so this assertion
  // cannot catch a full return of the regression (it catches a hang); the audit
  // reports that, and the per-shape bounds above (bot 1,000 / owner 2,000 against
  // 1,175 / 5,255 ms) are where the regression is caught.
  assert.ok(r.ms < 6000,
    `1 MiB of 120 KB space runs ending in ` + "`\\t\\n`" + ` took ${r.ms.toFixed(0)} ms through the chunked owner path (bound 6000 ms)`);
  assert.ok(r.length > 0, "the 1 MiB document still renders");
  t.diagnostic(`1 MiB space-run/tab units: ${r.ms.toFixed(0)} ms (${r.length} chars of HTML)`);
});

// (3) THE MEMO IS PER INLINE FRAME. A 32-character fingerprint let one inline
// block's answer — usually "no cut in this source" — apply to a DIFFERENT block
// that merely matched it, which silenced the window for that block's space run
// (the quadratic back in full) and could hand it a cut no run of its own
// carries. The two blocks below are built to collide on BOTH fingerprints
// (first 32 characters at the aligned offset, and last 32), the first with no
// double space at all (so its answer is "no cut") and the second a long space
// run: the memo is now reset per inlineTokens frame, so the second block scans
// its own source.

const COLLIDE_HEAD = "Start of the block: the same first thirty-two ch";
const COLLIDE_TAIL = "Same last thirty-two characters: and then it ends";

/** Two inline blocks (separate paragraphs) of the same length: `head` at the
 *  start, `tail` at the end, single-spaced prose in the first and one long run
 *  of spaces in the second. */
function collisionDoc(size) {
  const room = size - COLLIDE_HEAD.length - COLLIDE_TAIL.length;
  assert.ok(room > 8192, `collisionDoc(${size}): the space run must reach past the window`);
  // One space between words, none at either end: no double space anywhere, so
  // the first block's text-run answer is "no cut" — the answer a fingerprint
  // collision used to hand the second block.
  let prose = "word";
  while (prose.length < room - 1) prose += " word";
  prose = prose.slice(0, room - 1).replace(/ +$/, "");
  const a = COLLIDE_HEAD + prose + " " + COLLIDE_TAIL;
  const b = COLLIDE_HEAD + " ".repeat(a.length - COLLIDE_HEAD.length - COLLIDE_TAIL.length) + COLLIDE_TAIL;
  assert.equal(a.length, b.length, "the two blocks are the same length");
  assert.equal(a.slice(0, 32), b.slice(0, 32), "they share their first 32 characters");
  assert.equal(a.slice(-32), b.slice(-32), "they share their last 32 characters");
  assert.ok(!/ {2}/.test(a), "the first block has no double space (its answer is 'no cut')");
  assert.ok(/ {8192}/.test(b), "the second block carries a run well past the window");
  return a + "\n\n" + b;
}

test("a memo collision between two inline blocks cannot silence the window (M)", async (t) => {
  // The same document is small enough to render both ways here: identical bytes,
  // on both paths, and both paths really cut the second block.
  const small = collisionDoc(16 * 1024);
  const botOn = renderBotMarkdown(small);
  const botCuts = mdBotTextWindowStats.cuts;
  const ownerOn = renderMarkdown(small);
  const ownerCuts = mdOwnerTextWindowStats.cuts;
  setBotTextWindowEnabled(false);
  setOwnerTextWindowEnabled(false);
  let botOff;
  let ownerOff;
  try {
    botOff = renderBotMarkdown(small);
    ownerOff = renderMarkdown(small);
  } finally {
    setBotTextWindowEnabled(true);
    setOwnerTextWindowEnabled(true);
  }
  assert.ok(botCuts > 0, `the bot window cut the second block (${botCuts} cuts)`);
  assert.ok(ownerCuts > 0, `the owner window cut the second block (${ownerCuts} cuts)`);
  assert.equal(botOn, botOff, "the bot render changed with the window");
  assert.equal(ownerOn, ownerOff, "the owner render changed with the window");

  // …and the 128 KB version — the size at which a stale "no cut" answer cost
  // the whole quadratic — renders in well under the bound instead of in ~5 s.
  const big = collisionDoc(OWNER_HEAD - 1);
  const r = await renderInWorker("owner", big);
  // Measured 226-229 ms here in a fresh worker; the stale-memo cost was ~5 s.
  assert.ok(r.ms < 2000, `the 128 KB collision document took ${r.ms.toFixed(0)} ms (bound 2000 ms)`);
  assert.ok(r.length >= big.length * 0.99, "the content is on the page");
  t.diagnostic(`collision document: 16 KB ${botCuts}+${ownerCuts} cuts, 128 KB owner ${r.ms.toFixed(0)} ms`);
});