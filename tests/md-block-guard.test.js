// Markdown rendering: the two remaining quadratic BLOCK-LEXER shapes.
//
// The depth guard (boundedLexer + MD_MAX_NEST, tests/md-nesting-depth.test.js)
// bounds NESTING. Two shapes are quadratic without nesting and without touching
// marked's `this.blockquote(f)` re-lex path, so neither the depth counter nor
// the re-lex byte budget sees them. Measured on this tree (marked 17.0.6), CPU
// ms of one whole render, before the guards:
//
//   shape (repeated to fill)      8 KB  16 KB  32 KB  64 KB  128 KB (owner)
//   "a\n-|-\n"                    117    236    795   2850    11374
//   "|a\n|-|-\n"                   38    125    469   1771     7311
//   "a\n-\n"                       41    106    395   1070     3942
//   "a|b\n-|-|-\n"                 30    112    330   1243     5121
//   "a\n -\n"                      21     80    312   1213     4802
//   "    x\n>     y\n"             19     53    190    676     2744
//
// …~4x per doubling, i.e. O(rest of the document) work paid once per line (both
// shapes are explained, with the per-rule attribution and the measured numbers,
// in "TWO MORE QUADRATIC BLOCK-LEXER SHAPES" in servers/blog/renderer.js).
//
// What must stay true:
//   - every table shape above, and the quote/indented-code shape, renders 64 KB
//     in < 300 ms of CPU on the bot path and the 128 KB owner head in < 600 ms.
//     Each render runs in a WORKER with a 5 s kill, so the pre-guard cost (2.8 s
//     to 11 s per render, minutes at the owner cap for the table shapes) fails
//     the test instead of hanging the suite;
//   - the table precheck can NEVER reject a table marked accepts: 2,000 seeded
//     random table-shaped documents — 2-6 lines of pipes, dashes, colons, spaces
//     and letters, plus real tables of 1-6 columns with alignment — render
//     BYTE-IDENTICALLY with the guard on and off, on both paths (the off switch
//     is the exported test seam setMdTableGuardEnabled, which drops BOTH halves
//     of the shape-1 fix and leaves marked's own rules in place);
//   - ordinary content is untouched: the pinned document below (several real
//     tables — alignment, escaped pipes, inline code holding a pipe — and code
//     blocks inside quotes) renders as it did before the guards, and the pins in
//     tests/md-nesting-depth.test.js, tests/owner-markdown-guard.test.js,
//     tests/bot-markdown-quadratic.test.js and tests/marked-link-label-redos.test.js
//     still match (they are run alongside this file);
//   - real tables are still real tables: the precheck only ever answers "ask the
//     tokenizer" or "no table", so a valid table keeps its structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  renderMarkdown, renderBotMarkdown, setMdTableGuardEnabled, BOT_MD_MAX_INPUT,
} from "../servers/blog/renderer.js";

const CAP = BOT_MD_MAX_INPUT; // renderBotMarkdown refuses only ABOVE this
const OWNER_HEAD = 128 * 1024; // the owner path's markdown-parsed head
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// --- the pathological shapes, each repeated to fill ------------------------
// The five table shapes are the ones in the report: a header row followed by a
// delimiter row marked then REJECTS (no `|`/`:`, or a column count that differs
// from the header's), repeated — so every line is a table attempt that scans the
// rest of the document and then fails. The last shape is the quote holding
// indented code, indented code alternating with it.
const SHAPES = {
  "a\\n-|-": () => rep("a\n-|-\n", CAP),
  "|a\\n|-|-": () => rep("|a\n|-|-\n", CAP),
  "a\\n-": () => rep("a\n-\n", CAP),
  "a|b\\n-|-|-": () => rep("a|b\n-|-|-\n", CAP),
  "a\\n -": () => rep("a\n -\n", CAP),
  "indented code / quote holding indented code": () => rep("    x\n>     y\n", CAP),
};

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
      reject(new Error(`${kind} render of ${src.length} chars did not finish in ${KILL_MS} ms — a block-lexer guard is gone`));
    }, KILL_MS);
    worker.once("message", (msg) => { clearTimeout(timer); worker.terminate(); resolve(msg); });
    worker.once("error", (err) => { clearTimeout(timer); worker.terminate(); reject(err); });
  });
}

test("each pathological shape renders in < 300 ms at 64 KB and < 600 ms at the 128 KB owner head", async (t) => {
  let worstBot = { ms: 0, what: "" };
  let worstOwner = { ms: 0, what: "" };
  for (const [name, make] of Object.entries(SHAPES)) {
    const src = make();
    assert.equal(src.length, CAP, `${name}: the fixture fills the bot cap (${src.length})`);

    const bot = await renderInWorker("bot", src);
    if (bot.ms > worstBot.ms) worstBot = { ms: bot.ms, what: name };
    assert.ok(bot.length > 0, `${name}: the bot path still renders (an over-cap answer would be "")`);
    assert.ok(bot.ms < 300, `${name}: 64 KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 300 ms)`);

    const ownerSrc = rep(make(), OWNER_HEAD);
    assert.equal(ownerSrc.length, OWNER_HEAD, `${name}: the fixture fills the owner head`);
    const owner = await renderInWorker("owner", ownerSrc);
    if (owner.ms > worstOwner.ms) worstOwner = { ms: owner.ms, what: name };
    assert.ok(owner.length > 0, `${name}: the owner path still renders`);
    assert.ok(owner.ms < 600, `${name}: the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 600 ms)`);
  }
  t.diagnostic(`worst 64 KB bot render: ${worstBot.ms.toFixed(0)} ms — ${worstBot.what}`);
  t.diagnostic(`worst 128 KB owner render: ${worstOwner.ms.toFixed(0)} ms — ${worstOwner.what}`);
});

// --- the flat token meets marked's paragraph-CLIPPING branch -----------------
// The blockquote-span guard fires while a quote's content is being lexed with
// `lastParagraphClipped = true`, and that branch of marked's `blockTokens`
// merges a following paragraph into the previous paragraph token with
// `inlineQueue.pop(); inlineQueue.at(-1).src = lastToken.text`. A flat paragraph
// token with no inline-queue entry behind it breaks that pairing: the pop takes
// the NEW paragraph's own entry and `at(-1)` then reads `undefined` at the start
// of a frame — measured: `"> "` x 32,000 + `"x\nlazy"` threw
// `TypeError: Cannot set properties of undefined (setting 'src')` on the bot
// path, which answered "" (the owner path lost the quote) — so flatGuardToken
// pushes the entry and guardAndParse fills it from the entry's CURRENT src. Each document below ends with a marker: if a merge dropped the
// flattened tail, the render or the marker would be gone. Rendered in the same
// worker harness as the shapes above: these are pathological documents too.
const TAIL_MARKER = "PARAGRAPH-TAIL-MARKER";
const TAIL_SHAPES = {
  "quote+list chunks with lazy lines": () => rep("> - x\nlazy line\n", CAP - 64) + `${TAIL_MARKER}\n`,
  "indented code / quote holding indented code": () => rep("    x\n>     y\n", CAP - 64) + `${TAIL_MARKER}\n`,
  "quote run": () => rep("> ", CAP - 64) + `${TAIL_MARKER}\n`,
};

test("a flattened quote tail is still rendered on both paths (nothing dropped)", async (t) => {
  for (const [name, make] of Object.entries(TAIL_SHAPES)) {
    for (const [who, size] of [["bot", CAP], ["owner", OWNER_HEAD]]) {
      const src = rep(make(), size);
      const r = await renderInWorker(who, src);
      assert.ok(r.length > 0, `${name} (${who}): the render did not throw (a thrown parse answers "")`);
      assert.ok(r.html.includes(TAIL_MARKER),
        `${name} (${who}): the flattened tail is still shown, got ${JSON.stringify(r.html.slice(-300))}`);
    }
    t.diagnostic(`${name}: tail marker rendered on both paths`);
  }
});

// --- the differential test: the precheck never rejects a real table --------
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fragments a table-shaped line can be built from: the delimiter row's own
 *  alphabet (pipes, dashes, colons, spaces) plus letters, and the cell shapes
 *  an author writes (escaped pipes, inline code holding a pipe). */
const LINE_FRAGMENTS = [
  "|", " | ", "| ", " |", "|a", "a|", "-", "--", "---", ":-", "-:", ":--:", ":---:",
  ":", " ", "  ", "   ", "\t", "a", "b", "x", "word", "1", "`a|b`", "a\\|b",
  "| a |", "| - |", "|-|-|", "| :-: |", "a | b", " | b | c | ", "| | |",
];
const ALIGNMENTS = ["---", ":--", "--:", ":--:", ":-:", "---:", ":-", "-", ":--:"];

/** A 2-6 line document of table-shaped lines: the precheck's rejection rules
 *  (delimiter row without a `|`/`:`, column-count mismatch, no second line) are
 *  exactly what these hit. */
function randomTableDoc(rnd) {
  const lines = 2 + Math.floor(rnd() * 5);
  const out = [];
  for (let i = 0; i < lines; i++) {
    let line = "";
    const parts = 1 + Math.floor(rnd() * 5);
    for (let p = 0; p < parts; p++) line += LINE_FRAGMENTS[Math.floor(rnd() * LINE_FRAGMENTS.length)];
    out.push(line);
  }
  return out.join("\n");
}

/** A REAL table of 1-6 columns with alignment, plus (sometimes) a surrounding
 *  paragraph or a leading blank line, so both acceptance and rejection paths of
 *  marked's own rules are exercised. */
function validTableDoc(rnd) {
  const cols = 1 + Math.floor(rnd() * 6);
  const pick = () => ALIGNMENTS[Math.floor(rnd() * ALIGNMENTS.length)];
  const cell = (i) => (rnd() < 0.25 ? `a\\|b${i}` : rnd() < 0.25 ? `\`a|b\`${i}` : `c${i}`);
  const header = (rnd() < 0.2 ? "|" : "| ") + Array.from({ length: cols }, (_, i) => `h${i}`).join(" | ") + " |";
  const delim = (rnd() < 0.2 ? "|" : "| ") + Array.from({ length: cols }, pick).join(" | ") + " |";
  const rows = [];
  const rowCount = 1 + Math.floor(rnd() * 3);
  for (let r = 0; r < rowCount; r++) {
    rows.push("| " + Array.from({ length: cols }, (_, i) => cell(i)).join(" | ") + " |");
  }
  const body = [header, delim, ...rows].join("\n");
  if (rnd() < 0.25) return `A paragraph before it.\n\n${body}\n`;
  if (rnd() < 0.25) return `${body}\n\nafter`;
  return body;
}

test("differential: 2,000 seeded table-shaped documents render the same with the precheck on and off", () => {
  const rnd = mulberry32(0x7ab1e5);
  let tables = 0;
  let rejected = 0;
  for (let n = 0; n < 2000; n++) {
    const doc = n % 4 === 3 ? validTableDoc(rnd) : randomTableDoc(rnd);
    const guardedBot = renderBotMarkdown(doc);
    const guardedOwner = renderMarkdown(doc);
    setMdTableGuardEnabled(false);
    let plainBot;
    let plainOwner;
    try {
      plainBot = renderBotMarkdown(doc);
      plainOwner = renderMarkdown(doc);
    } finally {
      // Always back on: every later render in this file must be guarded.
      setMdTableGuardEnabled(true);
    }
    assert.equal(guardedBot, plainBot,
      `doc #${n} (bot path) changed with the table precheck: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedBot)}\n  plain:   ${JSON.stringify(plainBot)}`);
    assert.equal(guardedOwner, plainOwner,
      `doc #${n} (owner path) changed with the table precheck: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedOwner)}\n  plain:   ${JSON.stringify(plainOwner)}`);
    if (guardedBot.includes("<table>")) tables++;
    // A table-SHAPED document (a header line followed by something that reads
    // as a delimiter row) that did not become a table: marked rejected it, and
    // that is the shape the precheck decides without asking marked.
    const lines = doc.split("\n");
    if (lines.length >= 2 && /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(lines[1])
      && !guardedBot.includes("<table>")) rejected++;
  }
  // Not vacuous in either direction: real tables were rendered (the precheck let
  // them through) and table-shaped text that marked rejects was seen too (the
  // precheck's own subject).
  assert.ok(tables > 50, `the corpus rendered real tables (${tables} documents)`);
  assert.ok(rejected > 0, `the corpus contains rejected table shapes (${rejected} documents)`);
});

// --- ordinary content: a pinned document full of real tables --------------
// Captured from the renderer BEFORE the block-lexer guards (with
// setMdTableGuardEnabled(false) — marked's own rules — which is also asserted
// below), for BOTH paths. Every table shape an author writes is here:
// alignment in each of the four spellings, escaped pipes, an inline code span
// holding a pipe, a table inside a quote, and code blocks (fenced and indented)
// inside quotes. If one of these changes, a guard altered ordinary rendering.
function pinnedDoc() {
  return [
    "# Tables, escaped pipes and quoted code",
    "",
    "A paragraph with *emphasis*, `inline code with a | pipe` and a [link](/blog/x).",
    "",
    "| name | qty | price | notes |",
    "| :--- | :-: | ----: | :---- |",
    "| left | center | right | plain |",
    "| a \\| b | 2 | 3.50 | `x\\|y` |",
    "",
    "Aligned either way:",
    "",
    "| one | two | three | four | five | six |",
    "| :- | -: | :-: | --- | :---: | ---- |",
    "| 1 | 2 | 3 | 4 | 5 | 6 |",
    "| 7 | 8 | 9 | 10 | 11 | 12 |",
    "",
    "A one-column table:",
    "",
    "| solo |",
    "| ---- |",
    "| only |",
    "",
    "> A quote with a table in it:",
    ">",
    "> | k | v |",
    "> | - | - |",
    "> | a | b |",
    "",
    "> A quote with indented code:",
    ">",
    ">     code line one",
    ">     code line two",
    "",
    "    indented code outside a quote",
    "",
    "> A quote with a fence:",
    ">",
    "> ```js",
    "> const pipe = 'a|b';",
    "> ```",
    "",
    "| not | a table |",
    "| - | - |",
    "",
    "Done.",
  ].join("\n");
}

const PINNED_BOT = "54e26dae05630e237866da95dfd167dc44f50af8a249e4b4cac02a994cb80d2e";
const PINNED_OWNER = "8fd9b94a3cac5a12d00ee700d447fc319bea9a4392717483d357d8f5b413e621";

test("the pinned document (real tables, escaped pipes, quoted code) renders exactly as before the guards", () => {
  const doc = pinnedDoc();
  const bot = renderBotMarkdown(doc);
  const owner = renderMarkdown(doc);
  assert.equal(sha256(bot), PINNED_BOT,
    `the bot path changed for ordinary table content: ${JSON.stringify(bot.slice(0, 600))}`);
  assert.equal(sha256(owner), PINNED_OWNER,
    `the owner path changed for ordinary table content: ${JSON.stringify(owner.slice(0, 600))}`);

  // The guard really is transparent: the same bytes with marked's own rules.
  setMdTableGuardEnabled(false);
  let plainBot;
  let plainOwner;
  try {
    plainBot = renderBotMarkdown(doc);
    plainOwner = renderMarkdown(doc);
  } finally {
    setMdTableGuardEnabled(true);
  }
  assert.equal(bot, plainBot, "the table guard must not change the bot path's bytes");
  assert.equal(owner, plainOwner, "the table guard must not change the owner path's bytes");

  // And the structure is real (a pin cannot make a broken render pass): every
  // table in the document became a table, escaped pipes stayed cells, the
  // inline code kept its pipe, and the quoted code is still code.
  assert.equal((bot.match(/<table>/g) || []).length, 5, "all five tables rendered: " + bot.slice(0, 400));
  assert.match(bot, /<th align="center">qty<\/th>/, "alignment survives");
  assert.match(bot, /<td align="right">3\.50<\/td>/, "right alignment survives");
  assert.match(bot, /a \| b/, "an escaped pipe stays one cell");
  assert.match(bot, /<code>x\|y<\/code>/, "an inline code span keeps its pipe");
  assert.match(bot, /<blockquote>\n<p>A quote with indented code:<\/p>\n<pre><code>code line one/,
    "indented code inside a quote is a code block: " + bot.slice(-800));
  assert.match(bot, /<pre><code class="language-js">const pipe = 'a\|b'/, "the quoted fence is code");
  assert.match(bot, /<div class="table-scroll"><table>/, "tables keep the scroll wrapper");
});