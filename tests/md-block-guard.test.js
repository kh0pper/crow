// Markdown rendering: the remaining quadratic BLOCK-LEXER shapes.
//
// The depth guard (boundedLexer + MD_MAX_NEST, tests/md-nesting-depth.test.js)
// bounds NESTING. Other shapes are quadratic without nesting and without
// touching marked's `this.blockquote(f)` re-lex path, so neither the depth
// counter nor the re-lex byte budget sees them. Measured on this tree (marked
// 17.0.6), CPU ms of one whole render, before the guards:
//
//   shape (repeated to fill)      8 KB  16 KB  32 KB  64 KB  128 KB (owner)
//   "a\n-|-\n"                    117    236    795   2850    11374
//   "|a\n|-|-\n"                   38    125    469   1771     7311
//   "a\n-\n"                       41    106    395   1070     3942
//   "a|b\n-|-|-\n"                 30    112    330   1243     5121
//   "a\n -\n"                      21     80    312   1213     4802
//   "    x\n>     y\n"             19     53    190    676     2744
//   "  -\t\n"                       …      …      …   4000    16900
//   "*\t\n"                         …      …      …   2500    10700
//
// …~4x per doubling, i.e. O(rest of the document) work paid once per line (every
// shape is explained, with the per-rule attribution and the measured numbers, in
// "TWO MORE QUADRATIC BLOCK-LEXER SHAPES" and "A THIRD QUADRATIC BLOCK-LEXER
// SHAPE" in servers/blog/renderer.js).
//
// What must stay true:
//   - every shape above renders 64 KB in < 300 ms of CPU on the bot path and the
//     128 KB owner head in < 600 ms. Each render runs in a WORKER with a 5 s
//     kill, so the pre-guard cost (1 s to 17 s per render, minutes at the owner
//     cap for the table shapes) fails the test instead of hanging the suite;
//   - the table precheck can NEVER reject a table marked accepts: 2,000 seeded
//     random table-shaped documents — 2-6 lines of pipes, dashes, colons, spaces
//     and letters, plus real tables of 1-6 columns with alignment — render
//     BYTE-IDENTICALLY with the guard on and off, on both paths (the off switch
//     is the exported test seam setMdTableGuardEnabled, which drops BOTH halves
//     of the shape-1 fix and leaves marked's own rules in place);
//   - the blockquote-span budget charges only the OVERRUN (the span the rule
//     scanned minus the characters the token used), so ordinary nesting is free:
//     an email-style thread nested 10, 12, 14 and 16 levels at ~80 KB and
//     ~128 KB must render BYTE-IDENTICALLY to the same render with the budget
//     off (setMdBlockquoteSpanGuardEnabled) and keep every `<blockquote>` it
//     opened. Charging the full span instead lost the formatting of a 10-level
//     128 KB thread from character ~334 on;
//   - the setext-heading precheck can NEVER reject a heading marked accepts:
//     2,000 seeded documents of short lines — `-`/`*`/`+`/`=`, digits with `.`
//     or `)`, tabs, 0-4 spaces, text, blank lines, list items, quotes, code —
//     render BYTE-IDENTICALLY with it on and off (setMdLheadingGuardEnabled) on
//     both paths, and every listed unit stays under the 300/600 ms bounds at 16,
//     32 and 64 KB on the bot path (the cost is not monotone in size) plus the
//     128 KB owner head;
//   - a FLATTENED block keeps its line breaks as `<br>` instead of running its
//     lines together (see plainTextTokens in the renderer);
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
  renderMarkdown, renderBotMarkdown, setMdTableGuardEnabled,
  setMdBlockquoteSpanGuardEnabled, setMdLheadingGuardEnabled, BOT_MD_MAX_INPUT, MD_MAX_NEST,
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

// --- shape 2: the span budget must be blind to ordinary nesting -----------
// The budget is charged the OVERRUN — what the blockquote rule scanned minus
// the characters the token it produced used — so a quote that keeps its whole
// match costs nothing, at any depth. Charging the FULL span charged every
// nesting level the rest of the document: `deepQuote` below then lost its
// formatting (measured: 2,566 escaped `&gt;` markers at 10 levels / 128 KB where
// the fixed render has none, and 14,539 at 16 levels), while the same document
// with the budget off (main) renders in full. Both fixtures are checked — an
// ordinary ramp, and a body quoted `levels` deep.
const THREAD_MARKER = "THREAD-END-MARKER";

/** An email-style thread `levels` deep and about `size` characters: level k is a
 *  run of lines carrying exactly k `> ` prefixes, so the document opens one
 *  quote level at a time and each level's quote match covers everything below
 *  it. Every line is EXPLICITLY quoted — no lazy continuation lines — because at
 *  this size lazy lines inside a deep quote are the RE-LEX cliff (thousands of
 *  chunks, bounded by its own byte budget), which flattens a tail with or
 *  without the span budget and would hide what this fixture is about. */
function emailThread(levels, size) {
  const share = Math.floor((size - 1024) / levels);
  const out = [];
  for (let k = 1; k <= levels; k++) {
    const prefix = "> ".repeat(k);
    const line = `${prefix}reply body line of level ${k}\n`;
    out.push(line.repeat(Math.max(1, Math.floor(share / line.length))));
    if (k < levels) out.push(`${prefix}signing off at level ${k}\n`);
  }
  out.push("> ".repeat(levels) + `${THREAD_MARKER} **end of thread**\n`);
  return out.join("");
}

/** A body quoted `levels` deep from its first line (the report's "body 10 levels
 *  deep"): every line carries the full prefix, so each of the `levels`
 *  blockquote tokenizer calls sees a rule match and a token that are BOTH the
 *  whole remaining document (overrun 0) — and the full-span charge summed to
 *  1.08 MB at 10 levels / 128 KB and 1.12 MB at 16, past the 1 MiB budget, which
 *  is the reported regression. */
function deepQuote(levels, size) {
  const prefix = "> ".repeat(levels);
  const line = `${prefix}quoted body line of the thread\n`;
  const body = line.repeat(Math.max(1, Math.floor((size - 1024) / line.length)));
  return body + prefix + `${THREAD_MARKER} **end of thread**\n`;
}

test("a deeply quoted body and an email thread render exactly as the unguarded lexer does, at 10-16 levels and 80/128 KB", async (t) => {
  for (const [shape, make] of [["email thread", emailThread], ["body 10-16 levels deep", deepQuote]]) {
    for (const levels of [10, 12, 14, 16]) {
      for (const size of [80 * 1024, OWNER_HEAD]) {
        const src = make(levels, size);
        assert.ok(src.length <= size, `${shape}, ${levels} levels: the fixture stays under ${size} chars (${src.length})`);
        const guarded = renderMarkdown(src);
        let plain;
        setMdBlockquoteSpanGuardEnabled(false);
        try {
          plain = renderMarkdown(src);
        } finally {
          setMdBlockquoteSpanGuardEnabled(true);
        }
        const where = `${shape}, ${levels} levels at ${src.length} chars`;
        const depth = (guarded.match(/<blockquote>/g) || []).length;
        assert.equal(depth, levels,
          `${where}: opened ${levels} blockquotes, got ${depth} `
          + `(a spent budget shows the rest as escaped text) — ${JSON.stringify(guarded.slice(-200))}`);
        // Neither document has a `>` in its CONTENT, so escaped `&gt;` means a
        // guard flattened quote source instead of lexing it.
        assert.equal((guarded.match(/&gt;/g) || []).length, 0,
          `${where}: the document was not turned into escaped text`);
        assert.equal(sha256(guarded), sha256(plain),
          `${where}: the blockquote-span budget changed the render\n`
          + `  guarded length: ${guarded.length}, budget-off length: ${plain.length}`);
        assert.ok(guarded.includes(THREAD_MARKER), `${where}: the thread's end is still there`);
        // 16 levels is the depth guard's own limit (the innermost paragraph is
        // flattened there, exactly as it is with the budget off); below it the
        // deepest line is still rendered as formatting.
        if (levels < MD_MAX_NEST) {
          assert.match(guarded, /<strong>end of thread<\/strong>/,
            `${where}: the deepest line is still formatted, got ${JSON.stringify(guarded.slice(-160))}`);
        }
        t.diagnostic(`${where}: identical to the budget-off render, ${depth} blockquotes`);
      }
    }
  }
});

// --- shape 3: an empty list marker + TAB (the setext-heading rescan) -------
// A marker with nothing after it but a TAB is not a list item, so the line
// becomes a one-line paragraph and `lheading` is asked at every line — where a
// failure has already scanned the whole remaining paragraph run. These are the
// units from the report. The cost is NOT monotone in size (`"-\t\n"` is ~1.0 s
// at 32 KB but 82 ms at 64 KB: the regex engine's backtracking, not a guard),
// so every unit is measured at 16, 32 AND 64 KB, plus the 128 KB owner head.
const SETEXT_UNITS = {
  "  -\\t": "  -\t",
  "\\t\\n  -": "\t\n  -",
  "   *\\t": "   *\t",
  "*\\t": "*\t",
  "+\\t": "+\t",
  "1.\\t": "1.\t",
  "1)\\t": "1)\t",
  "a\\n*\\t": "a\n*\t",
  "-\\t": "-\t",
};
const SETEXT_SIZES = [16, 32, 64];

test("every empty-marker+TAB unit renders in < 300 ms at 16/32/64 KB and < 600 ms at the 128 KB owner head", async (t) => {
  let worstBot = { ms: 0, what: "" };
  let worstOwner = { ms: 0, what: "" };
  for (const [name, unit] of Object.entries(SETEXT_UNITS)) {
    for (const kb of SETEXT_SIZES) {
      const src = rep(unit, kb * 1024);
      const bot = await renderInWorker("bot", src);
      if (bot.ms > worstBot.ms) worstBot = { ms: bot.ms, what: `${name} @${kb} KB` };
      assert.ok(bot.length > 0, `${name} @${kb} KB: the bot path still renders`);
      assert.ok(bot.ms < 300, `${name} @${kb} KB took ${bot.ms.toFixed(0)} ms on the bot path (bound 300 ms)`);
    }
    const ownerSrc = rep(unit, OWNER_HEAD);
    const owner = await renderInWorker("owner", ownerSrc);
    if (owner.ms > worstOwner.ms) worstOwner = { ms: owner.ms, what: `${name} @128 KB owner` };
    assert.ok(owner.length > 0, `${name} @128 KB: the owner path still renders`);
    assert.ok(owner.ms < 600, `${name} @the 128 KB owner head took ${owner.ms.toFixed(0)} ms (bound 600 ms)`);
  }
  t.diagnostic(`worst bot render of a setext unit: ${worstBot.ms.toFixed(1)} ms — ${worstBot.what}`);
  t.diagnostic(`worst owner render of a setext unit: ${worstOwner.ms.toFixed(1)} ms — ${worstOwner.what}`);
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

// --- the differential test: the setext precheck never rejects a heading -----
// Deterministic (mulberry32) like the table differential, so a failure is
// reproducible. The fragments are the ones that decide marked's `lheading` rule:
// setext underlines (`=`/`-` runs), things that only LOOK like one, list
// markers with and without the space the list rule wants, digits with `.`/`)`,
// tabs, 0-4 leading spaces, ATX headings, quotes, fences, code spans, blank
// lines and plain text.
const SETEXT_FRAGMENTS = [
  "-", "--", "---", "----", "=", "==", "===", "- - -", "_ _ _",
  "*", "+", "* ", "+ ", "- ", "  -", "  *", "\t-", "  -\t", "*\t", "+\t",
  "1.", "1)", "12.", "12)", "1. ", "1) ", "0)",
  "\t", " ", "  ", "   ", "    ", "\t\t",
  "text", "more text", "a", "b", "word",
  "`code`", "`a|b`", "> quote", ">", "# h", "#", "```", "    code",
];

/** 1-8 lines, each 1-4 fragments after 0-4 leading spaces, with blank lines and
 *  (sometimes) a deliberate setext underline under the previous line — the
 *  acceptance and the rejection paths both. */
function randomSetextDoc(rnd) {
  const lines = 1 + Math.floor(rnd() * 8);
  const out = [];
  for (let i = 0; i < lines; i++) {
    if (rnd() < 0.15) { out.push(""); continue; }
    let line = " ".repeat(Math.floor(rnd() * 5));
    const parts = 1 + Math.floor(rnd() * 4);
    for (let p = 0; p < parts; p++) line += SETEXT_FRAGMENTS[Math.floor(rnd() * SETEXT_FRAGMENTS.length)];
    out.push(line);
    if (rnd() < 0.3) out.push(rnd() < 0.5 ? "===" : "---");
  }
  return out.join("\n");
}

test("differential: 2,000 seeded setext-shaped documents render the same with the precheck on and off", () => {
  const rnd = mulberry32(0x5e7e27);
  let headings = 0;
  let candidates = 0;
  for (let n = 0; n < 2000; n++) {
    const doc = randomSetextDoc(rnd);
    const guardedBot = renderBotMarkdown(doc);
    const guardedOwner = renderMarkdown(doc);
    setMdLheadingGuardEnabled(false);
    let plainBot;
    let plainOwner;
    try {
      plainBot = renderBotMarkdown(doc);
      plainOwner = renderMarkdown(doc);
    } finally {
      // Always back on: every later render in this file must be guarded.
      setMdLheadingGuardEnabled(true);
    }
    assert.equal(guardedBot, plainBot,
      `doc #${n} (bot path) changed with the setext precheck: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedBot)}\n  plain:   ${JSON.stringify(plainBot)}`);
    assert.equal(guardedOwner, plainOwner,
      `doc #${n} (owner path) changed with the setext precheck: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedOwner)}\n  plain:   ${JSON.stringify(plainOwner)}`);
    if (/<h[12]>/.test(guardedBot)) headings++;
    // A line AFTER the first that reads as a setext underline: the shape the
    // precheck decides without asking marked.
    const lines = doc.split("\n");
    if (lines.slice(1).some((l) => /^ {0,3}(?:=+|-+) *$/.test(l))) candidates++;
  }
  // Not vacuous in either direction: documents where a setext underline was
  // there (and may or may not have made a heading), and documents that really
  // did render a heading.
  assert.ok(candidates > 200, `the corpus contains setext-underline shapes (${candidates} documents)`);
  assert.ok(headings > 50, `the corpus rendered real setext headings (${headings} documents)`);
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

// --- a flattened block keeps its line breaks --------------------------------
// A guard that flattens an inline block fills it with plainTextTokens: one text
// token per line and a `br` between them. That is what `breaks: true` emits for
// a real paragraph, and it is a DELIBERATE change from main, which put the whole
// flattened block in ONE text token — a text token's newlines are not breaks (it
// is the paragraph tokenizer that applies `breaks`), so every line break was a
// literal `\n` and the block rendered as one run-together line.
const FLATTEN_DOC = `${"*a* ".repeat(600)}\nsecond line of the same paragraph\nthird line with a [link](/blog/x)`;

test("a flattened block keeps its line breaks as <br> (and stays plain text)", () => {
  for (const [who, html] of [
    ["bot", renderBotMarkdown(FLATTEN_DOC)],
    ["owner", renderMarkdown(FLATTEN_DOC)],
  ]) {
    // The block really was flattened: 1,200+ delimiters is past
    // BOT_MD_BLOCK_DIMS, so no emphasis and no link are rendered.
    assert.ok(!html.includes("<em>"), `${who}: the flattened block is plain text, got ${JSON.stringify(html.slice(0, 120))}`);
    assert.ok(!html.includes("<a "), `${who}: the flattened block's link stayed text`);
    assert.ok(html.includes("*a* *a*"), `${who}: the emphasis markers are shown literally`);
    // One break per line boundary — two here — and no literal newline in
    // place of a break.
    const breaks = html.match(/<br ?\/?>/g) || [];
    assert.equal(breaks.length, 2,
      `${who}: both line breaks became <br>, got ${breaks.length}: ${JSON.stringify(html.slice(-200))}`);
    assert.match(html, /second line of the same paragraph<br ?\/?>third line with a \[link\]\(\/blog\/x\)/, `${who}: the lines are separated by <br>, not by a literal newline`);
  }
});