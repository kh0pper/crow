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
//   - every unit above renders 64 KB in < 500 ms on the bot path and the 128 KB
//     owner head in < 1,000 ms, and a 1 MiB document of them through the CHUNKED
//     owner path in < 2,500 ms in total. Each render runs in a WORKER with a 5 s
//     kill, so the pre-guard cost (436–996 ms at 64 KB, 1.7–3.5 s at 128 KB)
//     fails the test instead of hanging the suite;
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
//     identically with the guard on and off, and it stays under the same 500 /
//     1,000 ms bounds;
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
// ONLY between two characters of one run of spaces/tabs, never inside a run that
// ends in a line break, and not at all in a stretch with no such run (which is
// linear anyway — see textRunCut in servers/blog/renderer.js). That is the
// invariant the straddle sweep below checks token by token, at offsets -3..+5
// around the old cut, on both paths (the bot path's window has its own seam,
// setBotTextWindowEnabled, so the comparison is possible there too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  renderMarkdown, renderBotMarkdown, BOT_MD_MAX_INPUT,
  setMdBrScanGuardEnabled, mdBrScanStats, MD_BR_SCAN_MAX,
  setOwnerTextWindowEnabled, mdOwnerTextWindowStats,
  setBotTextWindowEnabled, mdBotTextWindowStats,
} from "../servers/blog/renderer.js";

const CAP = BOT_MD_MAX_INPUT; // renderBotMarkdown refuses only ABOVE this

/** The window both paths use (START_WINDOW in servers/blog/renderer.js): the
 *  largest preferred cut index. The old fixed cut was exactly here. */
const CUT_WINDOW = 4096;

const OWNER_HEAD = 128 * 1024; // the owner path's markdown-parsed head
const CHUNKED = 1024 * 1024; // a document the owner path renders in chunks
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// --- the worker harness: a regression must FAIL, not hang ------------------
const RENDERER_URL = new URL("../servers/blog/renderer.js", import.meta.url).href;
const KILL_MS = 5000;
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const mod = await import(workerData.module);
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
 *  not count), the HTML length and the HTML. */
function renderInWorker(kind, src) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { kind, src, module: RENDERER_URL } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${kind} render of ${src.length} chars did not finish in ${KILL_MS} ms — the inline br guard is gone`));
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

test("every Unicode-whitespace line unit renders in < 500 ms at 64 KB and < 1000 ms at the 128 KB owner head", async (t) => {
  let worstBot = { ms: 0, what: "" };
  let worstOwner = { ms: 0, what: "" };
  for (const [name, unit] of Object.entries(UNITS)) {
    const botSrc = rep(`${unit}\n`, CAP);
    assert.equal(botSrc.length, CAP, `${name}: the fixture fills the bot cap (${botSrc.length})`);

    const bot = await renderInWorker("bot", botSrc);
    if (bot.ms > worstBot.ms) worstBot = { ms: bot.ms, what: name };
    assert.ok(bot.length > 0, `${name}: the bot path still renders (an over-cap answer would be "")`);
    assert.ok(bot.ms < 500, `${name}: 64 KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 500 ms)`);

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
    assert.ok(owner.ms < 1000, `${name}: the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 1000 ms)`);
  }
  t.diagnostic(`worst 64 KB bot render: ${worstBot.ms.toFixed(0)} ms — ${worstBot.what}`);
  t.diagnostic(`worst 128 KB owner render: ${worstOwner.ms.toFixed(0)} ms — ${worstOwner.what}`);
});

test("the CHUNKED owner path renders a 1 MiB document of them in < 2500 ms in total", async (t) => {
  let worst = { ms: 0, what: "" };
  for (const [name, unit] of Object.entries(UNITS)) {
    const src = rep(`${unit}\n`, CHUNKED);
    assert.equal(src.length, CHUNKED, `${name}: the fixture is 1 MiB`);
    const r = await renderInWorker("owner", src);
    if (r.ms > worst.ms) worst = { ms: r.ms, what: name };
    assert.ok(r.ms < 2500, `${name}: a 1 MiB document took ${r.ms.toFixed(0)} ms through the chunked owner path (bound 2500 ms)`);
    // Every chunk of this shape is bounded on its own, so the whole document is
    // rendered in chunks — nothing is dropped to the plain-text tail.
    assert.equal((r.html.match(/md-tail-notice/g) || []).length, 0,
      `${name}: all 8 chunks rendered (no plain-text tail), got ${JSON.stringify(r.html.slice(-200))}`);
    assert.ok(r.html.length >= CHUNKED,
      `${name}: all 1 MiB of content is on the page (got ${r.html.length} chars of HTML)`);
  }
  t.diagnostic(`worst 1 MiB chunked owner render: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
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
  assert.ok(bot.ms < 500, `U+0085: 64 KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 500 ms)`);
  const owner = await renderInWorker("owner", rep("\u0085\n", OWNER_HEAD));
  assert.ok(owner.ms < 1000, `U+0085: the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 1000 ms)`);

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
//   - the shape renders the 64 KB and the 128 KB owner head in < 1,000 ms, and
//     so does the same line inside a heading, a blockquote, a list item, a
//     table cell, a link label and an emphasis span (each is one inline block);
//   - the CHUNKED owner path renders 1 MiB of 120 KB space runs (separated by
//     the blank lines that make them separate chunks) and one 1 MiB space line
//     in < 2,500 ms in total;
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

test("a run of plain spaces renders in < 1000 ms at 64 KB and at the 128 KB owner head, in every container", async (t) => {
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
      assert.ok(r.ms < 1000,
        `${name} at ${size} chars took ${r.ms.toFixed(0)} ms on the owner path (bound 1000 ms)`);
      // The text survives: this shape is a paragraph, not something flattened.
      assert.ok(r.length >= src.length * 0.99,
        `${name}: the content is on the page (got ${r.length} chars of HTML for ${src.length})`);
    }
  }
  t.diagnostic(`worst plain-space render: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
});

test("the CHUNKED owner path renders 1 MiB of plain-space runs in < 2500 ms in total", async (t) => {
  // 120 KB runs, each ended by a blank line so every chunk holds ONE of them —
  // the shape that makes the per-chunk cost, rather than the split, the thing
  // under test.
  const runs = rep("a" + " ".repeat(120000 - 2) + "b\n\n", CHUNKED);
  const r = await renderInWorker("owner", runs);
  // Over the per-document budget the remainder becomes the plain-text tail, so
  // the bound is "budget plus one chunk" (see OWNER_MD_RENDER_BUDGET_MS) — and
  // nothing is dropped either way.
  assert.ok(r.ms < 2500, `1 MiB of 120 KB space runs took ${r.ms.toFixed(0)} ms through the chunked owner path (bound 2500 ms)`);
  assert.ok(r.html.length >= CHUNKED, `all 1 MiB of content is on the page (got ${r.html.length} chars of HTML)`);

  const one = SPACE_SHAPES.plain(CHUNKED);
  const r2 = await renderInWorker("owner", one);
  assert.ok(r2.ms < 2500, `one 1 MiB space line took ${r2.ms.toFixed(0)} ms through the chunked owner path (bound 2500 ms)`);
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