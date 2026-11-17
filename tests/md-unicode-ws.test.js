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
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  renderMarkdown, renderBotMarkdown, BOT_MD_MAX_INPUT,
  setMdBrScanGuardEnabled, mdBrScanStats, MD_BR_SCAN_MAX,
} from "../servers/blog/renderer.js";

const CAP = BOT_MD_MAX_INPUT; // renderBotMarkdown refuses only ABOVE this
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