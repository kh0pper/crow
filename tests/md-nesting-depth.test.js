// Markdown rendering: the BLOCK-NESTING CLIFF.
//
// marked's BLOCK lexer recurses once per container level, and one line can open
// tens of thousands of levels by itself: `1) `, `1. `, `- `, `* `, `+ `, `>` and
// mixes like `- > 1. ` are all containers. 64 KB of `1) ` used to cost ~1.0 s in
// renderBotMarkdown (which then caught the eventual RangeError and answered "")
// and ~1.36 s in renderMarkdown — where NOTHING caught it, so a deeply nested
// blog post, KB article, memory or workspace .md threw a stack overflow into a
// route.
//
// The bound is a DEPTH COUNTER INSIDE marked's block lexer (boundedLexer +
// MD_MAX_NEST, see "THE BLOCK-NESTING CLIFF" in servers/blog/renderer.js): the
// one Lexer a parse creates has its `blockTokens(src, tokens,
// lastParagraphClipped)` wrapped — the method every container tokenizer calls
// recursively for its content — and past MD_MAX_NEST the remaining content is
// pushed as ONE paragraph of plain text instead of being lexed into more
// containers. The source string is never rewritten, which is the whole point of
// this shape: an earlier version put backslash escapes into the document and
// corrupted code (a fenced YAML block with `- name:` at 32 spaces came out as
// `\- name`).
//
// What must stay true:
//   - 64 KB of any container marker, 30 seeded random mixes of them, marker lines
//     that arrive with bare `\r` / `\r\n`, quote+indent+marker stacks and a
//     marker run followed by a LAZY continuation line render in under a second
//     of CPU on BOTH paths (measured: 74 ms for the fixed markers, 138 ms for
//     the seeded mixes, 185 ms for the bare-`\r` shapes), and neither path
//     throws;
//   - the depth counter also sees the SECOND way down marked's blockquote
//     tokenizer has — its own `this.blockquote(f)` / `this.list(f)` re-lex for
//     lazy continuation lines, which never passes through blockTokens — so a
//     lazy line cannot walk past the limit (`"> ".repeat(40) + "x\nlazy"` used
//     to open 40 levels where `"> ".repeat(40) + "x"` opens 16), and that same
//     path is budgeted in RE-READ CHARACTERS (per parse, `max(1 MiB, 8 × the
//     document)`), never in steps: ordinary content that relies on lazy
//     continuation lines — one quote whose list has 17+ items with a wrapped
//     line each — renders byte-identically to plain marked (pinned below);
//   - CODE IS VERBATIM: fences, indented code, raw <pre> and math blocks come out
//     with no backslash that was not in the source;
//   - ordinary deeply-nested content (8 levels of lists in quotes in lists, code
//     in lists) renders EXACTLY as it did before any guard — pinned below, the
//     digests were captured from the renderer before the change;
//   - the owner path splits a document longer than OWNER_MD_MAX_INPUT (128 KB)
//     into CONSECUTIVE chunks and renders EVERY one of them, so a long document
//     comes out fully formatted; each cut is a safe block boundary — a cut never
//     lands inside a fenced code block while a blank line in the cap's second
//     half is available (a fence that was not a fence — "```inline```" is inline
//     code — may cost a chunk at most half the cap, then a line break is the
//     cut), and a cut that falls AT the cap never splits a UTF-16 surrogate pair
//     (one emoji in half is not a character, and both halves would render as
//     U+FFFD); only the total-time budget (OWNER_MD_RENDER_BUDGET_MS of CPU for
//     the whole document) or the hard 8 MiB ceiling turns a remainder into the
//     plain-text tail, and then the WHOLE remainder follows under the notice
//     (the chunked path itself is pinned by tests/md-chunked-render.test.js);
//   - the owner path's parse-failure fallback (escaped text, HTML comments
//     stripped) is still what a < cap document gets when marked throws;
//   - the file viewer reads a file up to 8 MiB and refuses only past that (it
//     used to refuse over 1 MiB, which hid content the renderer now degrades);
//   - the existing pinned digests of tests/bot-markdown-quadratic.test.js still
//     match (that file is the byte-identical pin for ordinary bot output, and it
//     is run alongside this one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { renderMarkdown, renderBotMarkdown, MD_MAX_NEST, OWNER_MD_MAX_INPUT, OWNER_MD_MAX_TOTAL_INPUT, ownerMarkdownCut, ownerMarkdownChunks, setOwnerRenderBudgetMs, OWNER_MD_RENDER_BUDGET_MS } from "../servers/blog/renderer.js";

const CAP = 64 * 1024 - 1;
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);

// CPU time of THIS process, not wall-clock: rendering is synchronous and
// single-threaded, so the cost still shows in full while the parallel suite's
// load on other cores does not (the same measure bot-markdown-quadratic.test.js
// uses).
//
// Every bound below is 5x the WORST of three measured runs on the dev box
// (CPU ms, the same process), rounded up to a clean number, and each records
// the cliff it guards (the before-fix times in the comments above):
//   - BOUND_MS — the 64 KB container markers, quote+indent+marker stacks, the
//     lazy-continuation shapes and the 30 seeded marker mixes (measured 1 ms to
//     138 ms, the seeded mixes being the slowest); the cliff is the unguarded
//     64 KB nesting parse, 1.0 s on the bot path and 1.36 s on the owner's,
//     which then threw. 700 ms is above a THIRD of that cliff (233-333 ms): the
//     audit's conflict — a runner ~3.5x slower than this box costs ~483 ms on
//     the seeded mixes, so a bound that cannot flake is necessarily above a
//     third of a 1 s cliff;
//   - CRLF_BOUND_MS — the bare `\r` / `\r\n` / mixed line-break shapes, the
//     same cliff reached through borrowed line breaks: measured 163-185 ms on
//     the bot path, 71-126 ms on the owner's. 5x is 925 ms, so 1,000 ms sits AT
//     the bot-side cliff (1.0 s): another irreconcilable pair reported by the
//     audit (this shape's guard is only ~5-6x faster than the unguarded parse);
//   - LONG_DOC_BOUND_MS — the 300 KB realistic document through the chunked
//     path: measured 179-231 ms. No pathological cliff is recorded for THAT
//     fixture (it is a realistic document, so marked is near-linear on it);
//     the bound is a tripwire against a chunking regression, and 5x is what a
//     runner ~3x slower than this box needs (CI measured 502 ms once against
//     the old shared 500 ms bound — the flake this split fixes).
const BOUND_MS = 700;
const CRLF_BOUND_MS = 1000;
const LONG_DOC_BOUND_MS = 1200;
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

/** The budget a CHUNKER assertion runs under: high enough that no runner's
 *  speed can turn "the whole document is formatted" into a plain-text tail. The
 *  budget is 1 s of CPU and a 300 KB document measures 179-231 ms here, so a CI
 *  runner a few times slower than this box is what used to make these
 *  assertions depend on the box rather than on the split. Whether the DEFAULT
 *  budget keeps a render bounded (and drops nothing when it stops) is pinned
 *  separately, by tests that render with it and read the tail back. */
const FULL_RENDER_BUDGET_MS = 60_000;

/** renderMarkdown with the total-time budget raised out of the way, for the
 *  "the whole document is formatted" / "the last line is on the page"
 *  assertions — a property of the chunker, not of the runner. The budget is
 *  restored before returning, so no other test sees it. */
function renderFully(src) {
  const restore = setOwnerRenderBudgetMs(FULL_RENDER_BUDGET_MS);
  try {
    return renderMarkdown(src);
  } finally {
    restore();
  }
}

/** Both renderers on one input: CPU ms each, and anything thrown. */
function both(src) {
  const out = {};
  for (const [name, fn] of [["bot", renderBotMarkdown], ["owner", renderMarkdown]]) {
    const t0 = cpuMs();
    let html = "", error = null;
    try { html = fn(src); } catch (e) { error = e; }
    out[name] = { html, error, ms: cpuMs() - t0 };
  }
  return out;
}

/** Collects the worst render of one test, reported as its diagnostic (the bound
 *  is the assertion; the number is the evidence). */
function tracker(t) {
  const worst = { ms: 0, what: "nothing yet" };
  return (result, what) => {
    for (const [who, r] of Object.entries(result)) {
      assert.equal(r.error, null,
        `${what} threw on the ${who} path: ${r.error && r.error.stack}`);
      if (r.ms > worst.ms) { worst.ms = r.ms; worst.what = what; }
    }
    t.diagnostic(`worst render so far: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
  };
}

function assertBounded(result, what, bound = BOUND_MS) {
  for (const [who, r] of Object.entries(result)) {
    assert.ok(r.ms < bound, `${what} took ${r.ms.toFixed(0)} ms on the ${who} path (bound ${bound} ms)`);
  }
}

test("MD_MAX_NEST is 16 (far above real content, far below the cliff)", () => {
  // Ordinary content sits at 2–4 levels (a list in a quote in a list); 8–10 is
  // about as deep as hand-written Markdown stays readable. A 64 KB marker run
  // opens ~32,000 levels. Pinned so moving it is a deliberate decision.
  assert.equal(MD_MAX_NEST, 16);
});

// --- the marker shapes, each repeated to 64 KB - 1 characters ---------------
// (the same cap renderBotMarkdown refuses above: BOT_MD_MAX_INPUT = 64 KB)
const staircase = () => {
  // Each line two columns deeper than the last: nesting that grows by
  // indentation rather than by markers on one line.
  const lines = [];
  let size = 0;
  for (let k = 1; ; k++) {
    const line = " ".repeat(2 * k) + "- x";
    if (size + line.length + 1 > CAP) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
};

const SHAPES = {
  "1) ": () => rep("1) ", CAP),
  "1. ": () => rep("1. ", CAP),
  "- 1) ": () => rep("- 1) ", CAP),
  "> 1) ": () => rep("> 1) ", CAP),
  "> ": () => rep("> ", CAP),
  "> (no space)": () => rep(">", CAP),
  "- ": () => rep("- ", CAP),
  "* ": () => rep("* ", CAP),
  "+ ": () => rep("+ ", CAP),
  "- > 1. ": () => rep("- > 1. ", CAP),
  "indentation staircase": staircase,
};

test("64 KB of every container marker renders in < 700 ms on both paths, no throw", (t) => {
  const note = tracker(t);
  for (const [name, make] of Object.entries(SHAPES)) {
    const src = make();
    assert.equal(src.length <= CAP, true, `fixture stays under the cap (${name})`);
    const result = both(src);
    note(result, JSON.stringify(name));
    assertBounded(result, `64 KB of ${JSON.stringify(name)}`);
    // Still rendered: an over-limit document shows its remainder as text,
    // never as an empty answer.
    assert.ok(result.bot.html.length > 0, `${JSON.stringify(name)}: the bot path still renders`);
    assert.ok(result.owner.html.length > 0, `${JSON.stringify(name)}: the owner path still renders`);
  }
});

test("a bare \\r cannot bypass the bound (borrowed line breaks, both paths)", (t) => {
  const note = tracker(t);
  // marked's Lexer#lex turns a bare `\r` into a line break, so "x\r" + "1) " x N
  // is N container LINES, not one long one. The guard sits inside the lexer that
  // has already normalised, and renderMarkdown normalises before it looks at the
  // input, so every spelling is bounded the same way.
  const shapes = {
    "bare \\r": () => rep("x\r1) ", CAP),
    "\\r\\n": () => rep("x\r\n1) ", CAP),
    "mixed \\r and \\n": () => rep("x\r1) \r\n> ", CAP),
  };
  for (const [name, make] of Object.entries(shapes)) {
    const src = make();
    const result = both(src);
    note(result, name);
    assertBounded(result, `64 KB of ${name} marker lines`, CRLF_BOUND_MS);
    assert.ok(result.bot.html.length > 0, `${name}: the bot path still renders`);
    assert.ok(result.owner.html.length > 0, `${name}: the owner path still renders`);
  }
});

test("quote + indented marker stacks are bounded at 64 KB and at 256 KB (owner)", (t) => {
  const note = tracker(t);
  // Whitespace after `>` is consumed by marked's blockquote rule, so
  // "> " + "      " + "- " x 15 opens 16 containers per line, then a 17th list
  // level — the shape a same-line-marker count used to miss.
  const line = "> " + "      " + "- ".repeat(15);
  const small = rep(line + "\n", 64 * 1024);
  const smallResult = both(small);
  note(smallResult, "64 KB quote+indent+marker stack");
  assertBounded(smallResult, "64 KB of quote+indent+marker stacks");

  // Over BOT_MD_MAX_INPUT the bot path answers "" by design (its callers fall
  // back to textContent), so only the owner path renders 256 KB — which is
  // exactly the input that used to be unbounded on that path.
  const big = rep(line + "\n", 256 * 1024);
  const t0 = cpuMs();
  const ownerHtml = renderMarkdown(big);
  const ms = cpuMs() - t0;
  t.diagnostic(`256 KB owner quote+indent stack: ${ms.toFixed(0)} ms`);
  assert.ok(ms < BOUND_MS, `256 KB of quote+indent+marker stacks took ${ms.toFixed(0)} ms on the owner path`);
  assert.ok(ownerHtml.length > 0, "the owner path still renders");
});

// --- the tokenizer's own re-lex path: the SECOND way down --------------------
// marked 17.0.4's blockquote tokenizer does not only recurse through the
// lexer. When the LAST token inside a quote is itself a blockquote (or a list)
// and lazy continuation lines remain, it re-lexes by calling `this.blockquote(f)`
// / `this.list(f)` DIRECTLY on the tokenizer, with the last token's raw plus
// those lines as the source — never through blockTokens, so every step of that
// chain ran at the depth it started from. `"> ".repeat(40) + "x"` stopped at
// MD_MAX_NEST; the same line with one lazy continuation line opened all 40
// levels, and at 64 KB each step re-read the rest of the source (measured 6.2 s
// on the bot path and 6.0 s on the owner path; 256 KB on the owner path took
// 26 s, and main failed fast with a RangeError instead).
//
// boundedLexer wraps those two tokenizer methods too, counting them against the
// SAME limit — one container token is one level whichever way it was reached —
// and budgets the characters that path may re-read, per parse (`max(1 MiB,
// 8 × the document)`): the blockquote tokenizer's chunk loop re-lexes the
// growing last token once per chunk, all at ONE level (`"> - x\nlazy\n"`
// repeated to 64 KB is ~5,300 steps, each re-reading the rest of the source —
// 1.2 s with only the depth counter in place). A step COUNT was the first
// attempt at that bound and it cut ordinary content, so the budget is bytes;
// the lazy-content test at the end pins the shapes it must never touch.
test("a lazy continuation line cannot walk past the bound (both paths)", (t) => {
  const note = tracker(t);
  const deep = "> ".repeat(40) + "x\nlazy";
  const result = both(deep);
  note(result, "40 quotes + a lazy continuation line");
  for (const [who, r] of Object.entries(result)) {
    assert.equal((r.html.match(/<blockquote>/g) || []).length, MD_MAX_NEST,
      `${who}: 40 quote levels with a lazy line must stop at ${MD_MAX_NEST} `
      + `blockquotes, got ${(r.html.match(/<blockquote>/g) || []).length}: ${r.html.slice(0, 300)}`);
    assert.match(r.html, /lazy/, `${who}: the lazy line is still shown`);
  }

  // The same markers at the 64 KB cap, each with a lazy continuation line: a
  // re-lex step re-reads the rest of the source, so an uncounted chain was O(n)
  // steps of O(n) work. Both paths, both markers, and the shapes the report
  // named.
  const LAZY_SHAPES = {
    '">" run + lazy': () => rep(">", CAP - 8) + "x\nlazy",
    '"> " run + lazy': () => rep("> ", 32000) + "x\nlazy",
    '"- " run + lazy': () => rep("- ", CAP - 8) + "x\nlazy",
    '"1) " run + lazy': () => rep("1) ", CAP - 8) + "x\nlazy",
    '"> - " run + lazy': () => rep("> - ", CAP - 8) + "x\nlazy",
    "quote+list chunks with lazy lines": () => rep("> - x\nlazy\n", CAP),
  };
  for (const [name, make] of Object.entries(LAZY_SHAPES)) {
    const src = make();
    assert.equal(src.length <= CAP, true, `fixture stays under the cap (${name})`);
    const r = both(src);
    note(r, name);
    assertBounded(r, `64 KB ${name}`);
    assert.ok(r.bot.html.length > 0, `${name}: the bot path still renders`);
    assert.ok(r.owner.html.length > 0, `${name}: the owner path still renders`);
  }

  // 256 KB is over BOT_MD_MAX_INPUT (the bot path answers "" by design), so
  // only the owner path parses it — and this is the input that used to take 26 s
  // there. It is also over the chunk size, so the owner path renders it in
  // chunks (each with the depth bound); the whole document is on the page. Its
  // own bound: 1 s.
  const huge = "> ".repeat(131072) + "x\nlazy";
  assert.ok(huge.length > OWNER_MD_MAX_INPUT && huge.length < 4 * OWNER_MD_MAX_INPUT,
    `the fixture is over the owner cap (${huge.length} > ${OWNER_MD_MAX_INPUT})`);
  const t0 = cpuMs();
  const hugeHtml = renderMarkdown(huge);
  const ms = cpuMs() - t0;
  t.diagnostic(`256 KB owner "> " run + lazy line: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, `256 KB of "> " + a lazy line took ${ms.toFixed(0)} ms on the owner path (bound 1000 ms)`);
  assert.ok(hugeHtml.length > 0, "the owner path still renders");
  assert.ok((hugeHtml.match(/<blockquote>/g) || []).length <= MD_MAX_NEST,
    "and the depth is still capped: " + (hugeHtml.match(/<blockquote>/g) || []).length);
});

// --- random search smoke: 30 seeded 64 KB mixes of the same markers.
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random-search smoke: 30 seeded 64 KB marker mixes, each < 700 ms, no throw", (t) => {
  const note = tracker(t);
  const MIX = ["1) ", "1. ", "- ", "* ", "+ ", "> ", ">", "- 1) ", "> 1) ", "- > 1. ", "\n", "  ", "text "];
  const rnd = mulberry32(0x5eed1e);
  for (let n = 0; n < 30; n++) {
    const parts = [];
    let size = 0;
    while (size < CAP) {
      const unit = MIX[Math.floor(rnd() * MIX.length)];
      parts.push(unit);
      size += unit.length;
    }
    const src = parts.join("").slice(0, CAP);
    const result = both(src);
    note(result, `marker mix #${n}`);
    assertBounded(result, `marker mix #${n}`);
    assert.ok(result.bot.html.length > 0, `marker mix #${n}: the bot path still renders`);
    assert.ok(result.owner.html.length > 0, `marker mix #${n}: the owner path still renders`);
  }
});

// --- the cut keeps the text, drops only the structure ----------------------
test("over-limit markers come out as their own text (nothing is dropped)", () => {
  // 200 `>` are 200 container levels: MD_MAX_NEST of them open blockquotes (so
  // their `>` is structure), the other 184 render as their own `>` text.
  const quotes = renderBotMarkdown(">".repeat(200) + " hello");
  assert.equal((quotes.match(/&gt;/g) || []).length, 200 - MD_MAX_NEST,
    "every `>` past the limit is still on screen");
  assert.equal((quotes.match(/<blockquote>/g) || []).length, MD_MAX_NEST);
  assert.match(quotes, /hello/);
  // Nothing was rewritten: no backslash appears anywhere in the output, and the
  // remainder is ONE piece of text (the paragraph the guard pushed).
  assert.ok(!quotes.includes("\\"), "no backslash is inserted: " + quotes.slice(0, 200));
  assert.ok(quotes.includes("&gt;".repeat(184).slice(0, 40)), "the remainder is contiguous text");

  const ordered = renderBotMarkdown("1) ".repeat(200) + "done");
  assert.equal((ordered.match(/1\)/g) || []).length, 200 - MD_MAX_NEST,
    "every `1)` past the limit is still on screen");
  assert.equal((ordered.match(/<li>/g) || []).length, MD_MAX_NEST);
  assert.ok(!ordered.includes("\\"), "no backslash survives into the rendered text: " + ordered.slice(0, 200));
  assert.match(ordered, /done/);

  const bullets = renderBotMarkdown("- ".repeat(200) + "x");
  assert.equal((bullets.replace(/<[^>]+>/g, "").match(/-/g) || []).length, 200 - MD_MAX_NEST,
    "every `- ` past the limit is still on screen");
  assert.equal((bullets.match(/<ul>/g) || []).length, MD_MAX_NEST);
  assert.match(bullets, /x/);

  // The cap itself is not a cliff: exactly MD_MAX_NEST containers open, and one
  // more marker on the line is text instead of a 17th level.
  const atLimit = renderBotMarkdown("- ".repeat(MD_MAX_NEST) + "x");
  const over = renderBotMarkdown("- ".repeat(MD_MAX_NEST + 1) + "x");
  assert.equal((atLimit.match(/<ul>/g) || []).length, MD_MAX_NEST);
  assert.equal((over.match(/<ul>/g) || []).length, MD_MAX_NEST, "no 17th level: " + over.slice(0, 300));
  assert.ok(!over.includes("</ul>\n<ul>"), "the excess `- ` did not start a sibling list");
});

// --- code is verbatim: the guard never rewrites the source ------------------
test("code, fences, raw HTML and math keep every character (no inserted backslashes)", () => {
  /** The rendered output must contain `needle` literally and carry no backslash
   *  at all — the old text pre-pass escaped container markers, which landed a
   *  `\` inside fenced and indented code. */
  const verbatim = (html, needle, what) => {
    assert.ok(html.includes(needle),
      `${what}: expected ${JSON.stringify(needle)} in ${JSON.stringify(html.slice(0, 400))}`);
    assert.ok(!html.includes("\\"), `${what}: a backslash was inserted: ${JSON.stringify(html.slice(0, 400))}`);
  };

  // A fence holding 20 quote markers: inside a code block, `> ` is text.
  const quoted = "```\n" + "> ".repeat(20) + "deep\n```\n";
  verbatim(renderMarkdown(quoted), "&gt; ".repeat(20) + "deep", "fenced quote run, owner");
  verbatim(renderBotMarkdown(quoted), "&gt; ".repeat(20) + "deep", "fenced quote run, bot");

  // Deep YAML: `- name:` at 32 columns and `1. ` lines — the shape the old
  // pre-pass turned into `\- name`.
  const yaml = "```yaml\n" + " ".repeat(32) + "- name: x\n" + " ".repeat(32) + "- name: y\n1. one\n2. two\n```\n";
  for (const [who, render] of [["owner", renderMarkdown], ["bot", renderBotMarkdown]]) {
    const html = render(yaml);
    verbatim(html, " ".repeat(32) + "- name: x", `deep YAML, ${who}`);
    verbatim(html, " ".repeat(32) + "- name: y", `deep YAML, ${who}`);
    verbatim(html, "1. one\n2. two", `deep YAML ordered lines, ${who}`);
  }

  // Tabs are spaces to marked; a fence keeps them exactly.
  const tabs = "```\n" + "\t".repeat(8) + "- item\n```\n";
  verbatim(renderBotMarkdown(tabs), "\t".repeat(8) + "- item", "tab-indented fence, bot");
  verbatim(renderMarkdown(tabs), "\t".repeat(8) + "- item", "tab-indented fence, owner");

  // An indented code block: 40 spaces in, 36 out (marked drops the 4-space
  // indent), and the `- ` is text.
  const indented = "\n\n" + " ".repeat(40) + "- x\n";
  verbatim(renderMarkdown(indented), " ".repeat(36) + "- x", "indented code, owner");
  verbatim(renderBotMarkdown(indented), " ".repeat(36) + "- x", "indented code, bot");

  // Raw <pre> passes through as HTML (its content is escaped character data).
  const pre = "<pre>\n" + "> ".repeat(20) + "deep\n</pre>\n";
  verbatim(renderMarkdown(pre), "&gt; ".repeat(20) + "deep", "raw <pre>, owner");
  verbatim(renderBotMarkdown(pre), "&gt; ".repeat(20) + "deep", "raw <pre>, bot");

  // Display math on the bot path: the `- x` inside `$$` is math source, not a
  // list item, and nothing escaped it.
  const math = "$$\n- x\n$$\n";
  const mathHtml = renderBotMarkdown(math);
  assert.equal(mathHtml, '<pre class="math"><code>- x</code></pre>\n');
  assert.ok(!mathHtml.includes("\\"));
  // The owner parser has no math extension: it renders `$$` as its own
  // paragraph and `- x` as a list. Unchanged by the guard, and still no
  // backslash.
  assert.ok(!renderMarkdown(math).includes("\\"), "owner: no backslash either");
});

// --- the owner cap: a long document is CHUNKED, not cut -------------------
// marked's block lexer is still quadratic on a few shapes the depth/byte guard
// does not cover ("    x\n>     y\n" repeated used to cost 11 s at 256 KB and
// ~200 s at 1 MiB), and the owner path is reachable from public /blog, the file
// viewer and federated memories. So NO chunk handed to marked is larger than
// 128 KB — but a longer document is no longer degraded: it is split into
// consecutive chunks at safe block boundaries and every chunk is rendered, so
// the whole document comes out formatted (the chunked path itself is pinned by
// tests/md-chunked-render.test.js). What this section pins is the CUT: where a
// chunk ends, that it never lands inside a fence while a blank line is
// available, that it never splits a UTF-16 surrogate pair, and that the one
// path that still produces plain text — past the hard 8 MiB ceiling — keeps
// every character of the remainder.
const TAIL_NOTICE = '<p class="md-tail-notice">Long document: the rest is shown as plain text.</p>';
const TAIL_OPEN = '<pre class="md-tail">';
/** sha256 of a < cap document's render — see "a document under the cap". Captured
 *  from this tree; a > cap document takes the chunked path, which a <= cap
 *  document never reaches (it is one chunk). */
const NEAR_CAP_PIN = "7b1a34447b802619710e25c22dc3d9c5714c2d8929bb32646ab19fc1d33ea38f";

/** The inverse of the renderer's escapeText (five characters), so a tail can be
 *  read back out of the HTML the way a reader sees it. */
function unescapeText(html) {
  return html
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The notice, and the tail <pre> that follows it, out of one rendered page. */
function tailOf(html, end = html.length) {
  const at = html.indexOf(TAIL_NOTICE);
  assert.ok(at > 0, "the long-document notice is missing: " + html.slice(0, 200));
  const head = html.slice(0, at);
  const from = at + TAIL_NOTICE.length;
  const open = html.indexOf(TAIL_OPEN, from);
  assert.equal(open, from, "the <pre> comes straight after the notice");
  const close = html.lastIndexOf("</pre>", end);
  assert.ok(close > open, "the tail <pre> is closed");
  return { head, text: unescapeText(html.slice(open + TAIL_OPEN.length, close)) };
}

/** One section of the realistic document: heading, prose, list, table, code. */
function realisticSection(i) {
  return [
    `## Section ${i}`,
    "",
    `Prose with *emphasis*, a [link](/blog/section-${i}) and \`inline code\`.`,
    "",
    "- first bullet",
    "- second bullet",
    "  - nested bullet",
    "",
    "| key | value |",
    "| --- | ----- |",
    `| key-${i} | value-${i * 2} |`,
    "",
    "```js",
    `const section = ${i};`,
    "```",
    "",
  ].join("\n");
}

/** A realistic document of about `size` characters: headings, paragraphs,
 *  lists, a table and fenced code — with ONE fence opened just before the first
 *  chunk's cap and closed just after it, so the first cut has to skip it. */
function realisticDoc(size = 300 * 1024) {
  const parts = [];
  let length = 0;
  let n = 0;
  // Fill to just short of the cap …
  while (length + realisticSection(n).length < OWNER_MD_MAX_INPUT - 1500) {
    const chunk = realisticSection(n++);
    parts.push(chunk);
    length += chunk.length;
  }
  // … then a fence that STRADDLES the cap: opened below it, closed above it.
  // Its leading newline is the blank line the cut lands on.
  const straddle = "\n```text\n"
    + Array.from({ length: 40 }, (_, i) => `straddling code line ${i} ${"y".repeat(50)}`).join("\n")
    + "\n```\n\n";
  parts.push(straddle);
  length += straddle.length;
  while (length < size) {
    const chunk = realisticSection(n++);
    parts.push(chunk);
    length += chunk.length;
  }
  parts.push("PLAIN-TAIL-END\n");
  return parts.join("");
}

/** A realistic document just under the cap, with no straddling fence. */
function nearCapDoc() {
  const parts = [];
  let length = 0;
  let n = 0;
  for (;;) {
    const chunk = realisticSection(n);
    if (length + chunk.length > OWNER_MD_MAX_INPUT - 64) break;
    parts.push(chunk);
    length += chunk.length;
    n++;
  }
  return parts.join("");
}

test("the owner cap is 128 KB, and a 300 KB document is rendered in full", (t) => {
  assert.equal(OWNER_MD_MAX_INPUT, 128 * 1024);
  const doc = realisticDoc();
  assert.ok(doc.length > 300 * 1024, `the fixture is a long document (${doc.length})`);

  const cut = ownerMarkdownCut(doc);
  assert.ok(cut > 0 && cut <= OWNER_MD_MAX_INPUT, `cut ${cut} is inside the cap`);
  assert.equal(doc[cut - 1], "\n", "the cut is at a line boundary");
  // NOT inside the straddling fence: the first chunk's fence markers balance,
  // so the fence (with the whole 40-line body) is in a later chunk.
  const fencesInFirst = doc.slice(0, cut).split("\n").filter((l) => /^ {0,3}```/.test(l)).length;
  assert.equal(fencesInFirst % 2, 0, "the cut does not land inside a fenced code block");

  const t0 = cpuMs();
  const html = renderFully(doc);
  const ms = cpuMs() - t0;
  t.diagnostic(`300 KB document (first cut ${cut} chars): ${ms.toFixed(0)} ms`);
  assert.ok(ms < LONG_DOC_BOUND_MS, `a 300 KB realistic document took ${ms.toFixed(0)} ms (bound ${LONG_DOC_BOUND_MS} ms)`);

  // Fully formatted: no notice, no plain-text tail.
  assert.ok(!html.includes("md-tail"), "the whole document is formatted: " + html.slice(-300));
  assert.match(html, /<h2[^>]*>Section 0<\/h2>/, html.slice(0, 300));
  assert.match(html, /<li>first bullet<\/li>/);
  assert.match(html, /<div class="table-scroll"><table>/, "tables are formatted");
  assert.equal((html.match(/<h2/g) || []).length, (doc.match(/^## /gm) || []).length,
    "every heading in the document was rendered");
  assert.match(html, /<pre><code class="language-js">/, "fences on both sides of the cut are real code blocks");
  // The straddling fence is a CODE BLOCK, not text: its 40 lines are inside a
  // <pre> and none of them leaked into a paragraph.
  assert.ok(html.includes("straddling code line 0"), "the fence body is on the page");
  assert.ok(html.includes("straddling code line 39"), "all 40 of its lines are");
  assert.ok(!/<p>\s*straddling code line/.test(html), "and not as paragraph text");
  assert.match(html, /PLAIN-TAIL-END/, "the end of the document is on screen");
});

test("no chunk is dropped: random 200-600 KB documents render every character", (t) => {
  const rnd = mulberry32(0x0ddba11);
  const POOL = [
    "alpha beta gamma delta\n", "**bold** and *em* and `code`\n", "- bullet\n", "1. ordered\n",
    "> quote\n", "    indented code\n", "| a | b |\n| - | - |\n| 1 | 2 |\n", "\n",
    "```\n", "~~~\n", "### heading\n", "text with a [link](/x) and <b>raw html</b>\n",
  ];
  for (let n = 0; n < 4; n++) {
    const target = 200 * 1024 + Math.floor(rnd() * 400 * 1024);
    const parts = [];
    let size = 0;
    while (size < target) {
      const unit = POOL[Math.floor(rnd() * POOL.length)];
      parts.push(unit);
      size += unit.length;
    }
    const src = parts.join("") + `END-OF-DOC-${n}`;
    // The chunk boundaries cover the document exactly (see
    // tests/md-chunked-render.test.js for the full property).
    const chunks = ownerMarkdownChunks(src);
    assert.equal(chunks.map(([start, end]) => src.slice(start, end)).join(""), src,
      `doc #${n}: joined chunks reproduce the source`);
    assert.ok(chunks.every(([start, end]) => end - start <= OWNER_MD_MAX_INPUT),
      `doc #${n}: every chunk is inside the cap`);
    const t0 = cpuMs();
    const html = renderFully(src);
    t.diagnostic(`random doc #${n} (${src.length} chars): ${(cpuMs() - t0).toFixed(0)} ms`);
    assert.ok(html.length > 0, `doc #${n}: still rendered`);
    // These documents are nowhere near the render budget, so nothing is plain
    // text — and the last line of the document is on the page.
    assert.ok(!html.includes("md-tail"), `doc #${n}: fully formatted`);
    assert.ok(html.includes(`END-OF-DOC-${n}`), `doc #${n}: the end of the document is on screen`);
  }
});

test("the pathological 1 MiB shape is bounded by the chunk guards (well under the old 30 s)", (t) => {
  // Measured before the block-level guard: 11 s at 256 KB, ~200 s at 1 MiB. It is
  // now parsed as eight 128 KB chunks, each through the guarded pipeline, so the
  // whole render is fast. The bound is 5 s rather than the 30 s the old head+tail
  // split needed: the CHUNKS must be bounded, and a return to the quadratic block
  // lexer would blow past this on any runner.
  const src = rep("    x\n>     y\n", 1024 * 1024);
  assert.equal(src.length, 1024 * 1024);

  // (1) THE DEFAULT BUDGET: bounded time, and nothing dropped — either the whole
  // document is formatted, or the tail is the document's own remainder from a
  // chunk boundary. Measured 295 ms here; the budget is 1 s of CPU, so a slower
  // runner may reach it, and that is not a failure — dropping content would be.
  const cpu0 = cpuMs();
  const wall0 = Date.now();
  const budgeted = renderMarkdown(src);
  const ms = cpuMs() - cpu0;
  const wall = Date.now() - wall0;
  t.diagnostic(`1 MiB "    x\\n>     y\\n" (default ${OWNER_MD_RENDER_BUDGET_MS} ms budget): `
    + `${ms.toFixed(0)} ms CPU, ${wall} ms wall, `
    + (budgeted.includes(TAIL_NOTICE) ? "the budget ran out (the tail is the whole remainder)" : "the whole document rendered"));
  assert.ok(ms < 5000, `1 MiB of the pathological shape took ${ms.toFixed(0)} ms (bound 5000 ms)`);
  assert.ok(budgeted.length > 0);
  if (budgeted.includes(TAIL_NOTICE)) {
    const { text } = tailOf(budgeted);
    assert.ok(src.endsWith(text), "the tail is the end of the document");
    assert.ok(ownerMarkdownChunks(src).some(([start]) => src.slice(start) === text),
      "and it starts exactly at a chunk boundary (nothing between the HTML and the tail was dropped)");
  }

  // (2) THE CHUNKER: with the budget out of the way, every chunk is rendered —
  // that is the property a slow runner must not be able to flip.
  const html = renderFully(src);
  const chunks = ownerMarkdownChunks(src);
  assert.ok(chunks.length >= 8, `the document is split into chunks (${chunks.length})`);
  for (const [start, end] of chunks) assert.ok(end - start <= OWNER_MD_MAX_INPUT,
    `chunk ${start}-${end} is inside the cap, so no parse is ever over it`);
  assert.ok(!html.includes("md-tail"), "the whole document is formatted (under the budget)");
  // Every character is still there: each line of `x` appears as text.
  assert.ok(html.includes("x"), "the text is on the page");
  assert.ok(html.replace(/<[^>]+>/g, "").includes("x"), "and it is text, not just markup");
});

test("a cut at the cap never splits a UTF-16 surrogate pair", (t) => {
  // One line of 70,000 😀: 140,000 UTF-16 units (each emoji is a surrogate
  // pair) and not a single newline, so ownerMarkdownCut finds no blank line and
  // no line break and the cut falls AT the cap — the one branch where the index
  // is not already a line boundary. A cut between a high surrogate and its low
  // half would leave one chunk ending with half a character and the next
  // starting with the other half (both render as U+FFFD, and the halves are no
  // longer the characters the author wrote).
  const src = "😀".repeat(70000);
  assert.equal(src.length, 140000, "70,000 emoji are 140,000 UTF-16 units");
  assert.ok(src.length > OWNER_MD_MAX_INPUT, `the document is over the cap (${src.length})`);
  assert.ok(!src.includes("\n"), "a single line: nothing for the cut to land on");
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

  const t0 = cpuMs();
  const html = renderFully(src);
  t.diagnostic(`single-line 70,000 emoji document (${src.length} chars): ${(cpuMs() - t0).toFixed(0)} ms`);

  const cut = ownerMarkdownCut(src);
  assert.ok(cut > 0 && cut <= OWNER_MD_MAX_INPUT, `cut ${cut} is inside the cap`);
  assert.ok(!isHigh(src.charCodeAt(cut - 1)), `the first chunk does not end with a lone high surrogate at ${cut - 1}`);
  assert.ok(!isLow(src.charCodeAt(cut)), `the next chunk does not start with a lone low surrogate at ${cut}`);
  // Every chunk boundary of the rendered document is on a character boundary.
  const chunks = ownerMarkdownChunks(src);
  assert.ok(chunks.length >= 2, `the document is split (${chunks.length} chunks)`);
  for (const [start, end] of chunks) {
    assert.ok(!isHigh(src.charCodeAt(end - 1)), `chunk ending at ${end} does not split a pair`);
    assert.ok(!isLow(src.charCodeAt(end)), `chunk starting at ${end} does not split a pair`);
    assert.ok(end - start > 0);
  }
  assert.equal(chunks.map(([start, end]) => src.slice(start, end)).join(""), src,
    "the chunks are the whole document");
  // Nothing was lost: all 70,000 emoji are on the page, and no replacement
  // character stands in for half of one.
  assert.equal((html.match(/😀/g) || []).length, 70000, "every emoji is rendered");
  assert.ok(!html.includes("\uFFFD"), "and none of them became U+FFFD");

  // The cap (131,072) is EVEN, so on this document it happens to land on a pair
  // boundary and the guard has nothing to do. One leading ASCII character moves
  // every pair start by one unit, putting a high surrogate right before the cap
  // — the case the guard exists for, and the one that fails without it.
  const shifted = "a" + src;
  const shiftedCut = ownerMarkdownCut(shifted);
  assert.equal(shifted.charCodeAt(OWNER_MD_MAX_INPUT - 1) & 0xfc00, 0xd800,
    "the fixture puts a high surrogate just before the cap");
  assert.equal(shiftedCut, OWNER_MD_MAX_INPUT - 1, "so the cut steps back one unit");
  assert.ok(!isHigh(shifted.charCodeAt(shiftedCut - 1)), "and the chunk ends on a character boundary");
  assert.ok(!isLow(shifted.charCodeAt(shiftedCut)), "as does the next one");
  assert.ok(isHigh(shifted.charCodeAt(shiftedCut)) && isLow(shifted.charCodeAt(shiftedCut + 1)),
    "the next chunk begins with a whole pair: " + shifted.charCodeAt(shiftedCut).toString(16));
  assert.equal((renderMarkdown(shifted).match(/😀/g) || []).length, 70000,
    "and the shifted document renders every emoji too");
});

test("inline backticks do not open a fence, so a chunk is not collapsed", () => {
  // A backtick fence's info string may not itself contain a backtick
  // (CommonMark), so this line is a paragraph with inline code in it, not an
  // opener. Read as one — the bug — the "fence" never closes, every later blank
  // line is skipped, and the cut lands 7 characters into a 200 KB document.
  const paragraphs = rep("A paragraph of ordinary prose, long enough to be worth wrapping.\n\n", 200 * 1024);
  const src = "intro\n\n```inline``` is how you write it\n\n" + paragraphs;
  assert.ok(src.length > 200 * 1024, `the fixture is a long document (${src.length})`);

  const cut = ownerMarkdownCut(src);
  assert.ok(cut > 100_000, `the first chunk keeps most of the cap (${cut} of ${OWNER_MD_MAX_INPUT})`);
  assert.ok(cut <= OWNER_MD_MAX_INPUT, `cut ${cut} is inside the cap`);
  assert.equal(src[cut - 1], "\n", "the cut is at a line boundary");
  const html = renderFully(src);
  assert.ok(!html.includes("md-tail"), "the whole document is formatted");
  assert.ok(html.replace(/<[^>]+>/g, "").includes("worth wrapping"), "the text is on the page");

  // The fence state machine can still be wrong about something marked knows
  // better, so a misjudged fence may cost a chunk at most HALF the cap: with
  // only one blank line — right at the top — and none after it, the cut falls on
  // the last line break before the cap instead of at character 7.
  const noBlanks = "intro\n\n```inline``` is how you write it\n" + rep("a line of prose\n", 200 * 1024);
  assert.ok(!noBlanks.slice(7).includes("\n\n"), "the only blank line is the one at the top");
  const fallbackCut = ownerMarkdownCut(noBlanks);
  assert.ok(fallbackCut > 100_000, `the line-break fallback keeps the chunk (${fallbackCut})`);
  assert.ok(fallbackCut <= OWNER_MD_MAX_INPUT, `and stays inside the cap (${fallbackCut})`);
  assert.equal(noBlanks[fallbackCut - 1], "\n", "the fallback cut is still a line boundary");
  const fallbackHtml = renderFully(noBlanks);
  assert.ok(!fallbackHtml.includes("md-tail"), "the fallback document is formatted too");
  assert.ok(fallbackHtml.replace(/<[^>]+>/g, "").includes("a line of prose"),
    "and its text is on the page");
});

test("a whitespace line that ends past the cap is not a cut point", () => {
  // The cut is the end of a blank line. A run of spaces that STARTS just under
  // the cap and runs on for 7 MB ended 7 MB past it, so the "head" handed to
  // marked was 7.1 MB — far over the cap the whole split exists for.
  const unit = "Filler paragraph of ordinary prose for the cap test.\n\n";
  const lead = unit.repeat(Math.floor((OWNER_MD_MAX_INPUT - 20) / unit.length));
  const spaces = " ".repeat(7 * 1024 * 1024);
  const src = lead + spaces;
  assert.ok(lead.length < OWNER_MD_MAX_INPUT && lead.length > OWNER_MD_MAX_INPUT / 2,
    `the whitespace line starts just under the cap (${lead.length})`);
  assert.equal(src.indexOf(spaces), lead.length, "and the whitespace line is the last line");
  assert.ok(!lead.includes("```") && !lead.includes("~~~"), "no fence in the lead");

  const cut = ownerMarkdownCut(src);
  assert.ok(cut > 0 && cut <= OWNER_MD_MAX_INPUT, `cut ${cut} is inside the cap`);
  assert.equal(cut, lead.length, "the cut is the last blank line that ends before the cap");

  // The chunks never reach past the hard ceiling with a window that ends 7 MB
  // later: the run of spaces is covered as its own chunks, and the text is on
  // the page.
  const html = renderFully(src);
  assert.ok(html.length > 0, "still rendered");
  assert.ok(!html.includes("md-tail"), "the run of spaces is under the 8 MiB ceiling");
  assert.ok(html.replace(/<[^>]+>/g, "").includes("Filler paragraph"), "and the prose is on the page");
});

test("a real fence opened just under the cap is still never split", () => {
  const unit = "Ordinary prose paragraph for the fence test.\n\n";
  const lead = unit.repeat(Math.floor((OWNER_MD_MAX_INPUT - 200) / unit.length));
  const openAt = lead.length;
  assert.ok(openAt < OWNER_MD_MAX_INPUT && openAt > OWNER_MD_MAX_INPUT / 2,
    `the fence opens just under the cap (${openAt})`);
  const src = lead + "```text\n" + rep("straddling code line\n", 40 * 1024) + "```\n\n" + "after the fence\n\nEND\n";

  const cut = ownerMarkdownCut(src);
  assert.equal(cut, openAt, "the cut lands on the blank line before the fence");
  assert.ok(cut <= OWNER_MD_MAX_INPUT, `cut ${cut} is inside the cap`);

  // No chunk boundary falls inside the fence: every cut either precedes its
  // opening line or follows its closing one, so the whole fence is code in ONE
  // chunk and nothing of it becomes text.
  const fenceStart = openAt;
  const fenceEnd = openAt + "```text\n".length + rep("straddling code line\n", 40 * 1024).length + 4;
  const chunks = ownerMarkdownChunks(src);
  assert.equal(chunks.map(([start, end]) => src.slice(start, end)).join(""), src,
    "the chunks are the whole document");
  for (const [start, end] of chunks.slice(1, -1)) {
    assert.ok(end <= fenceStart || start >= fenceEnd,
      `chunk boundary ${start}-${end} does not fall inside the fence (${fenceStart}-${fenceEnd})`);
  }
  const html = renderFully(src);
  assert.ok(!html.includes("md-tail"), "the whole document is formatted");
  assert.match(html, /<pre><code class="language-text">/, "the fence is one real code block");
  assert.ok(html.includes("straddling code line"), "with its body");
  assert.ok(!/<p>\s*straddling code line/.test(html), "and none of it as paragraph text");
  assert.match(html, /after the fence/);
});

test("a document under the cap is rendered exactly as before (no notice, no tail)", () => {
  // Just under the cap, so this is the single-render path — the same one every
  // document took before the split existed. The digest was captured from this
  // tree; the code path for a <= cap document is unchanged (renderOwnerHead is
  // the parse renderMarkdown used to inline).
  const doc = nearCapDoc();
  assert.ok(doc.length < OWNER_MD_MAX_INPUT, `under the cap (${doc.length})`);
  const html = renderMarkdown(doc);
  assert.ok(!html.includes("md-tail"), "no tail notice for a document under the cap");
  assert.match(html, /<h2[^>]*>Section 0<\/h2>/);
  assert.equal(sha256(html), NEAR_CAP_PIN, "a < cap document must not change: " + sha256(html));
});

test("the plain-text tail is only reached at the hard ceiling, and keeps every character", (t) => {
  // A document of at most OWNER_MD_MAX_INPUT is rendered (not shown as text):
  // the sanitizer drops a comment, as it always did, and nothing is escaped.
  const hidden = "<!-- internal: do not publish -->";
  const body = "x ".repeat(Math.ceil((OWNER_MD_MAX_INPUT + 1) / 2));
  const small = renderFully(hidden + "\n\n" + body + "\n<!-- small-doc note -->\nEND");
  assert.ok(!small.includes("md-tail"), "an over-cap document is still fully formatted");
  assert.ok(!small.includes("internal: do not publish"), "the comment is dropped by the sanitizer");
  assert.ok(!small.includes("small-doc note"), "and so is the other one");
  assert.match(small, /END/);

  // Past OWNER_MD_MAX_TOTAL_INPUT (8 MiB, the file viewer's own read cap)
  // nothing more is parsed: the remainder is plain text under the notice, and
  // there NOTHING is stripped — an HTML comment is shown, escaped, exactly as
  // the author wrote it (that is tailHtml's job, not escapedTextHtml's).
  // Indented code is used as filler because it is cheap to render.
  const filler = rep("    code line\n", OWNER_MD_MAX_TOTAL_INPUT + 1);
  const src = hidden + "\n\n" + filler + "\n<!-- tail note -->\nEND\n";
  assert.ok(src.length > OWNER_MD_MAX_TOTAL_INPUT, `over the hard ceiling (${src.length})`);
  const t0 = cpuMs();
  const html = renderMarkdown(src);
  t.diagnostic(`8 MiB + tail document: ${(cpuMs() - t0).toFixed(0)} ms`);
  const { text } = tailOf(html);
  assert.equal(text, src.slice(OWNER_MD_MAX_TOTAL_INPUT),
    "the tail is exactly the remainder past the ceiling");
  assert.ok(html.includes("&lt;!-- tail note --&gt;"), "the tail's comment is shown, escaped: " + html.slice(-200));
  assert.ok(!html.includes("<!-- tail note -->"), "and never as live markup");
  assert.ok(!html.includes("internal: do not publish"), "the parsed head's comment is not shown");
  assert.ok(text.endsWith("END\n"));
});

// --- normal content is untouched -------------------------------------------
// Lists in quotes in lists, code in lists, eight levels deep — the deepest
// nesting a hand-written document plausibly reaches. The digests were captured
// from this tree BEFORE any nesting guard existed, for BOTH renderers.
function nestedLegit() {
  return [
    "# Nesting that must not change",
    "",
    "> Level 1 quote with *emphasis* and a [link](/blog/x).",
    ">",
    "> - Level 2 list item",
    ">   - Level 3 nested item",
    ">     > Level 4 quote inside a list",
    ">     >",
    ">     > 1. Level 5 ordered item",
    ">     >    - Level 6 bullet",
    ">     >      - Level 7 bullet",
    ">     >        - Level 8 bullet with `code`",
    ">     >",
    ">     > ```js",
    ">     > const deep = { a: 1 };",
    ">     > ```",
    "",
    "- list with a code block:",
    "",
    "  ```sh",
    "  npm test",
    "  ```",
    "",
    "  - nested, with a quoted list:",
    "",
    "    > - inner",
    "    > - inner bullet",
    "    >   - deeper bullet",
    "",
    "1. ordered",
    "   1. nested ordered",
    "      - bullet under it",
    "        - another",
    "          - another",
    "",
    "- [ ] task with **bold**",
    "- [x] done",
    "",
    "| a | b |",
    "| - | - |",
    "| *x* | `y` |",
    "",
    "    indented code, eight levels of four spaces would be 32",
  ].join("\n");
}

// Eight levels of same-line markers, growing indentation, and eight nested
// quotes — everything just under MD_MAX_NEST, which is exactly the content the
// guard must leave alone.
function staircaseLegit() {
  const out = [];
  for (let k = 0; k < 8; k++) out.push(" ".repeat(2 * k) + "- level " + (k + 1));
  out.push("");
  for (let k = 0; k < 8; k++) out.push(" ".repeat(2 * k) + "* star " + (k + 1));
  out.push("");
  for (let k = 0; k < 8; k++) out.push(">".repeat(k + 1) + " quote " + (k + 1));
  out.push("");
  out.push("- - - - - - - - eight same-line bullets");
  out.push(">".repeat(8) + " eight same-line quotes");
  out.push("1) 2) 3) 4) 5) 6) 7) 8) eight ordered markers");
  return out.join("\n");
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Captured from the renderer BEFORE the nesting guard existed. If one of these
// changes, the guard altered ordinary rendering — find out why before updating
// the pin.
const NESTED_LEGIT_BOT = "054c2a94c76d0d77e3e4c34a053c034cea7836b4c58cc2263d7ceb132c11e98c";
const NESTED_LEGIT_OWNER = "3b49cc774f433c67e8aa39b977d08bd3c0a1454478bcdfdbfd966b7191afb4fe";
const STAIRCASE_LEGIT_BOT = "92e0899583b848cccb23c8abd7a572eba691d9c10f69017e57dd3de5a40fb35e";
const STAIRCASE_LEGIT_OWNER = "92e0899583b848cccb23c8abd7a572eba691d9c10f69017e57dd3de5a40fb35e";

test("nesting up to 8 levels renders byte-identical to before the guard (both paths)", () => {
  const nested = nestedLegit();
  assert.equal(sha256(renderBotMarkdown(nested)), NESTED_LEGIT_BOT,
    "the bot path must not change content within the nesting limit: " + renderBotMarkdown(nested).slice(0, 400));
  assert.equal(sha256(renderMarkdown(nested)), NESTED_LEGIT_OWNER,
    "the owner path must not change content within the nesting limit: " + renderMarkdown(nested).slice(0, 400));

  const stair = staircaseLegit();
  assert.equal(sha256(renderBotMarkdown(stair)), STAIRCASE_LEGIT_BOT,
    "8 nested marker levels must be untouched: " + renderBotMarkdown(stair).slice(0, 400));
  assert.equal(sha256(renderMarkdown(stair)), STAIRCASE_LEGIT_OWNER,
    "8 nested marker levels must be untouched: " + renderMarkdown(stair).slice(0, 400));

  // Not vacuously text: the structure within the limit is real. The deepest
  // level of each chain is still a LIST ITEM (a bullet whose marker had been
  // escaped would come out as the text "- level 8" instead).
  const nestedHtml = renderMarkdown(nested);
  assert.match(nestedHtml, /<blockquote>/);
  assert.match(nestedHtml, /<li>/, "lists survive");
  assert.match(nestedHtml, /<pre><code class="language-js">/, "fenced code in a quote survives");
  assert.match(nestedHtml, /<li>Level 8 bullet with <code>code<\/code>/, "eight levels still nest as lists");
  const stairHtml = renderBotMarkdown(stair);
  assert.match(stairHtml, /<li>level 8/, "the deepest indentation level is still a list item");
  assert.match(stairHtml, /<li>star 8/);
  assert.ok(!/- level 8/.test(stairHtml.replace(/<[^>]+>/g, " ")), "its bullet was not escaped into text");
  assert.ok((stairHtml.match(/<blockquote>/g) || []).length >= 8, "eight same-line quotes still nest");
  assert.match(stairHtml, /eight same-line bullets/, "the same-line bullet chain still parses");
});

// --- lazy continuation lines on ORDINARY content ---------------------------
// A lazy continuation line makes marked's blockquote tokenizer RE-LEX (the
// "second way down" — see boundedLexer in servers/blog/renderer.js), and that
// path is bounded by a per-parse budget of RE-READ CHARACTERS, not by a step
// count: a step count cannot tell a flood from a document. One quote whose list
// has 17 items with a lazy continuation line each takes 17 steps, and a
// per-frame step cap turned the tail of that list into literal text (`- item
// 18`) where plain marked — and main, before this branch — renders a list.
//
// The digests below were captured from this tree with the step cap REMOVED,
// i.e. they are main's own output, for BOTH renderers (the two agree on all of
// these shapes), and they must keep matching now that the byte budget is what
// bounds the path. Each case also asserts the STRUCTURE — N list items, and no
// marker showing up as literal text — so updating a digest cannot quietly
// accept a truncated list.
const lazyBullets = (n) => {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(`> - item ${i}`);
    out.push(`wrapped continuation of item ${i}`);
  }
  return out.join("\n");
};
const lazySteps = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) { out.push("> 1. step"); out.push("continued"); }
  return out.join("\n");
};
// A quote intro, then 25 bullets each with an indented continuation line and a
// lazy line of its own.
const lazyQuoteBullets = (n) => {
  const out = ["> A quote intro that sets up the list:", ">"];
  for (let i = 1; i <= n; i++) {
    out.push(`> - bullet ${i}`);
    out.push(`>   indented continuation of bullet ${i}`);
    out.push(`lazy line of bullet ${i}`);
  }
  return out.join("\n");
};
const lazyBlocks = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push("> - b\n>   > inner\n>   lazy-ish\nlazy");
  return out.join("\n");
};

const LAZY_NORMAL = [
  { name: "17 quoted bullets with lazy continuations", src: lazyBullets(17), li: 17, literal: /- item \d/, sha: "995ccc868867512f5f5c3aba72feaf3e3e2a3a6fdb4d322060a1fa9552cffdea" },
  { name: "40 quoted bullets with lazy continuations", src: lazyBullets(40), li: 40, literal: /- item \d/, sha: "6fbfdab4ce4c4cf06fc39a2cb1a7e49fa2707a0ec8918a86383be09e7efa63fa" },
  { name: "20 quoted ordered steps with lazy continuations", src: lazySteps(20), li: 20, literal: /1\. step/, sha: "cf734921bbfa5af43ea1243ed02d682e5d91babdb1f361e80523b89fa16469ce" },
  { name: "quote intro + 25 bullets with indented and lazy continuations", src: lazyQuoteBullets(25), li: 25, literal: /- bullet \d/, sha: "bbea8002e3b4fed31ea68bb6b1cf93c2950a0dc61a12fb921baab4f245d03ed9" },
  { name: "25 quote/list/lazy blocks", src: lazyBlocks(25), li: 25, literal: /- b\b/, sha: "895278b1038c1a1af9d30850a42d1be3688ac178c6c174d95c1a2144b8c022ac" },
];

test("lazy continuation lines on ordinary content render exactly as main (both paths)", () => {
  for (const { name, src, li, literal, sha } of LAZY_NORMAL) {
    for (const [who, render] of [["bot", renderBotMarkdown], ["owner", renderMarkdown]]) {
      const html = render(src);
      assert.equal(sha256(html), sha,
        `${name} (${who}): the lazy re-lex path must not change ordinary content: ${html.slice(0, 400)}`);
      assert.equal((html.match(/<li>/g) || []).length, li,
        `${name} (${who}): ${li} list items, got ${(html.match(/<li>/g) || []).length}: ${html.slice(0, 400)}`);
      const text = html.replace(/<[^>]+>/g, " ");
      assert.ok(!literal.test(text),
        `${name} (${who}): a list item came out as literal text (${literal}): ${html.slice(-400)}`);
    }
  }
});

// --- the file viewer: a long file is a document, not a refusal ------------
// The page used to refuse any .md over 1 MiB before reading it, which hid
// content. It has one hard cap now — FILEVIEW_MAX_BYTES, 8 MiB of bytes, stat'd
// before the read — and everything under it is read and rendered in FULL:
// renderMarkdown renders a long document in 128 KB chunks, so a 600 KB or
// 1.5 MiB document comes out formatted end to end.
let srv, base, root, smallMd, midDoc, midMd, overDoc, overMd, hugeMd, hugeBytes, fileviewMaxBytes;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "md-nest-fileview-"));
  smallMd = join(root, "small.md");
  midMd = join(root, "medium.md");
  overMd = join(root, "over-old-cap.md");
  hugeMd = join(root, "huge.md");
  writeFileSync(smallMd, "# Small\n\nsome *text*\n");

  // 600 KB, with a formatted body and a sentinel at the very end so "the whole
  // file is on the page" is a real assertion.
  midDoc = realisticDoc(600 * 1024);
  assert.ok(midDoc.length > 600 * 1024 && midDoc.length > 4 * OWNER_MD_MAX_INPUT);
  writeFileSync(midMd, midDoc);

  // 1.5 MiB — over the OLD 1 MiB refusal:
  const overParts = ["# Over One MiB\n\n"];
  let overLength = overParts[0].length;
  while (overLength < 1.5 * 1024 * 1024) {
    const para = "A paragraph of ordinary prose, long enough to be worth wrapping.\n\n";
    overParts.push(para);
    overLength += para.length;
  }
  overParts.push("OVER-1MIB-TAIL-SENTINEL\n");
  overDoc = overParts.join("");
  writeFileSync(overMd, overDoc);

  // Over the read cap (8 MiB), with a sentinel that must never be read.
  fileviewMaxBytes = 8 * 1024 * 1024;
  hugeBytes = fileviewMaxBytes + 4096;
  writeFileSync(hugeMd, "# Huge\n\nHUGE-SECRET-" + "x ".repeat(hugeBytes / 2));

  process.env.CROW_FILEVIEW_ROOT = root;
  const { default: fileviewRouter, FILEVIEW_MAX_BYTES } = await import("../servers/gateway/routes/fileview.js");
  assert.equal(FILEVIEW_MAX_BYTES, fileviewMaxBytes, "the page's hard read cap is 8 MiB");
  const app = express();
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).type("text/plain").send("login"));
  app.use(fileviewRouter(dashboardAuth));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); rmSync(root, { recursive: true, force: true }); });

const get = (path) => fetch(base + path, { headers: { cookie: "crow_session=good" } });

test("fileview: a 600 KB file is rendered in FULL (no notice, no plain-text tail)", async (t) => {
  const ok = await get("/dashboard/fileview?path=" + encodeURIComponent(smallMd));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<h1[^>]*>Small<\/h1>/, "the harness renders a normal file");

  const t0 = cpuMs();
  // The route renders in THIS process, so the same seam applies: "the whole
  // FILE is formatted" is a property of the chunked render, not of the box's
  // speed (the 600 KB file measures ~280 ms against a 1 s budget here).
  const restore = setOwnerRenderBudgetMs(FULL_RENDER_BUDGET_MS);
  let r;
  let ms;
  try {
    r = await get("/dashboard/fileview?path=" + encodeURIComponent(midMd));
    ms = cpuMs() - t0;
  } finally {
    restore();
  }
  t.diagnostic(`fileview on a ${midDoc.length}-char file: ${ms.toFixed(0)} ms (CPU, incl. the request)`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.doesNotMatch(html, /too large to view here/, "a 600 KB file is not refused");
  const article = html.slice(html.indexOf("<article>"), html.indexOf("</article>"));
  assert.ok(!article.includes("md-tail"), "the whole file is formatted");
  assert.match(article, /<h2[^>]*>Section 0<\/h2>/, "the first section is rendered markdown");
  assert.equal((article.match(/<h2[^>]*>/g) || []).length, (midDoc.match(/^## /gm) || []).length,
    "every section heading of the file is an <h2> on the page");
  assert.match(article, /<div class="table-scroll"><table>/, "tables are formatted");
  assert.ok(article.includes("PLAIN-TAIL-END"), "right to the last line");
});

test("fileview: a file over the old 1 MiB refusal is rendered in full now", async () => {
  assert.ok(overDoc.length > 1024 * 1024, `fixture is over the old cap (${overDoc.length})`);
  // Same seam as above: 1.5 MiB of prose is over the default 1 s budget on a
  // slower runner, and "the whole file is formatted" must not depend on that.
  const restore = setOwnerRenderBudgetMs(FULL_RENDER_BUDGET_MS);
  let r;
  try {
    r = await get("/dashboard/fileview?path=" + encodeURIComponent(overMd));
  } finally {
    restore();
  }
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.doesNotMatch(html, /too large to view here/, "nothing over the old 1 MiB is refused");
  assert.match(html, /<h1[^>]*>Over One MiB<\/h1>/, "its title is rendered");
  const article = html.slice(html.indexOf("<article>"), html.indexOf("</article>"));
  assert.ok(!article.includes("md-tail"), "the whole file is formatted, not head + text");
  assert.ok(article.includes("OVER-1MIB-TAIL-SENTINEL"), "down to its last line");
});

test("fileview: a file over the 8 MiB read cap shows its size and is not read", async () => {
  const r = await get("/dashboard/fileview?path=" + encodeURIComponent(hugeMd));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /too large to view here/, "the notice");
  const mb = (hugeBytes / (1024 * 1024)).toFixed(1);
  assert.ok(html.includes(`${mb} MB`), `the notice names the file's size (${mb} MB): ` + html.slice(0, 400));
  assert.ok(!html.includes("HUGE-SECRET"), "the content is not read into the page");
  assert.ok(!html.includes("<article>"), "no article body at all");
  assert.ok(html.includes('lang="en"'), "the notice is marked as English");
});