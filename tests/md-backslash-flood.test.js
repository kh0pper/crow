// A DOCUMENT OF BACKSLASH-ESCAPED PUNCTUATION — the punctuation MASK PASS.
//
// `renderMarkdown` draws the public blog and the public knowledge base, neither
// of which is cached, so an anonymous reader can hand this function a document
// of any shape up to OWNER_MD_MAX_INPUT (128 KB, one chunk). Every other
// inline-lexer cliff has a budget of its own (delimiters, url email scans,
// email runs, the `br` lookahead — see servers/blog/renderer.js), and this shape
// walked through all of them: a BACKSLASH is not a delimiter, a protocol word,
// an `@` or a line break.
//
// The cost is marked's own pre-pass, in Lexer#inlineTokens, which masks every
// `\`+punctuation pair out of a copy of the whole block (so `\*` cannot be read
// as emphasis):
//
//   const n = src;
//   while ((r = rules.inline.anyPunctuation.exec(n)) !== null)   // /\\([\p{P}\p{S}])/gu
//     n = n.slice(0, r.index) + "++" + n.slice(anyPunctuation.lastIndex);
//
// One masked-string REBUILD per pair, i.e. one copy of the block per pair:
// pairs × block length. Measured on this tree (CPU ms of one whole render, worst
// of three runs), BEFORE the guard added for it:
//
//   a single block of            owner 128 KB    bot 64 KB
//   "\\" (a run of backslashes)        2,148           66
//   "\."                               2,151          ~66
//   "\-"                               2,211          ~66
//   "\!"                               2,193           —
//   "\|"                               2,174           —
//   "\*"                                   3            1   (already flattened:
//     `*` is a delimiter, so the delimiter cap caught it)
//   "\ " (no pair — `\`+space)            40           15
//   "\\\n" (a backslash hard break)       63           21
//   "a\\" (no pair — `\`+letter)          21           12
//
// Isolating marked's inline lexer confirmed the mechanism: 128 KB of `\\` is
// 2,113 ms with the mask pass and 3 ms with it neutered, and the cost per pair
// is flat at 32-33 µs at 128 KB whatever the density (1 pair per 100 characters
// or every character) — below ~64 KB V8 hands the slices back as views, which
// is why the bot path never showed it (~1.5 µs per pair).
//
// The guard is the same per-block pre-pass as the others: punctMaskCost prices
// the block as pairs × length in one linear pass, charges it to the per-document
// budget, and flattens a block over MD_PUNCT_MASK_MAX to escaped text. After it,
// every backslash shape above renders in 2-63 ms at either cap.
//
// What must stay true:
//   - every variant above renders well under a second at 128 KB on the owner
//     path and at 64 KB on the bot path, in a worker that is KILLED after 5 s
//     (the failure mode is a hang, and a terminated worker fails the test
//     instead of stalling the suite);
//   - a flattened block shows its backslashes as text and drops nothing;
//   - ordinary content with backslashes — Windows paths, UNC shares, escaped
//     markdown, LaTeX-ish math, regexes in code spans — renders BYTE-IDENTICAL
//     to the pre-guard renderer (the sha256 pins were captured before the guard
//     existed) and charges next to nothing;
//   - 1,000 seeded documents of ordinary prose with sprinkled backslashes
//     render byte-identically with the guard on and off, and the guard flattens
//     none of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  renderMarkdown, renderBotMarkdown,
  OWNER_MD_MAX_INPUT, BOT_MD_MAX_INPUT, BOT_MD_SQ_BUDGET,
  setMdPunctMaskGuardEnabled, mdPunctMaskStats,
} from "../servers/blog/renderer.js";

/** Absolute URL of the renderer, resolved from this test file. */
const RENDERER_URL = pathToFileURL(
  join(import.meta.dirname, "..", "servers", "blog", "renderer.js"),
).href;

/** Wall-clock budget for one worker: start-up + import + every render in it. A
 *  render that never returns is the failure mode here, so this is the hang
 *  guard (it terminates the worker and fails the test). */
const WORKER_TIMEOUT_MS = 5_000;

/** CPU budget per render. The worst measured on the dev box after the guard is
 *  63 ms (`"\\\n"`, one of the shapes that was never slow); the guarded family
 *  is 2-5 ms and was 2.1 s. 500 ms is ~8x the worst measurement and a quarter
 *  of the pre-guard cost. */
const RENDER_CPU_BUDGET_MS = 500;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);

/** CPU time of THIS thread: the renders are synchronous and single-threaded, so
 *  the cost still shows in full while the rest of the suite runs elsewhere. */
function cpuMs() {
  const usage = typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage()
    : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

const WORKER_SRC = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

function cpuMs() {
  const usage = typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage()
    : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

(async () => {
  const { renderBotMarkdown, renderMarkdown } = await import(workerData.rendererUrl);
  const timings = [];
  for (const item of workerData.cases) {
    const render = item.renderer === "bot" ? renderBotMarkdown : renderMarkdown;
    const started = cpuMs();
    const html = render(item.input);
    timings.push({ name: item.name, ms: cpuMs() - started, length: typeof html === "string" ? html.length : -1 });
  }
  parentPort.postMessage({ timings });
})().catch((error) => {
  parentPort.postMessage({ error: String((error && error.stack) || error) });
});
`;

/**
 * Render every case in a throwaway worker thread and resolve with its CPU ms.
 * Rejects — after terminating the worker — if it has not answered within
 * WORKER_TIMEOUT_MS, so a render that never returns fails the test instead of
 * hanging the suite.
 * @param {{name: string, renderer: "owner"|"bot", input: string}[]} cases
 */
function renderInWorker(cases) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: { rendererUrl: RENDERER_URL, cases } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(
      `no answer within ${WORKER_TIMEOUT_MS} ms wall-clock (worker terminated): the markdown ` +
      "renderer is blocking on the punctuation mask pass again — marked's inlineTokens " +
      "rebuilds the whole block once per `\\`+punctuation pair, so a block of them is quadratic",
    )), WORKER_TIMEOUT_MS);
    worker.once("message", (message) => {
      if (message && message.error) finish(reject, new Error(`worker failed: ${message.error}`));
      else finish(resolve, (message && message.timings) || []);
    });
    worker.once("error", (error) => finish(reject, new Error(`worker error: ${(error && error.message) || error}`)));
    worker.once("exit", (code) => finish(reject, new Error(`worker exited (code ${code}) before answering`)));
  });
}

// --- the shape, in every spelling the report names -------------------------
// Each unit is repeated to the cap, so every fixture is ONE inline block — the
// unit of the quadratic — of exactly the cap's length. The label is the unit
// itself, JSON-quoted, so a failure names the exact character sequence.
const VARIANTS = [
  "\\\\", // a run of backslashes (the report's fixture: `"\\".repeat(N)`)
  "\\\\\\\\", // the same run, two pairs wide
  "\\.",
  "\\-",
  "\\!",
  "\\|",
  "\\*", // already covered by the delimiter cap; must stay cheap
  "\\ ", // NO pair: `\`+space is no escape
  "\\\n", // a backslash hard break: `\`+newline is no escape either
  "a\\", // `\`+letter: no pair
];

test("every backslash variant renders in < 500 ms at the owner cap and at the bot cap", async (t) => {
  const cases = [];
  for (const unit of VARIANTS) {
    cases.push({ name: `${JSON.stringify(unit)} @ owner 128 KB`, renderer: "owner", input: rep(unit, OWNER_MD_MAX_INPUT) });
    cases.push({ name: `${JSON.stringify(unit)} @ bot 64 KB`, renderer: "bot", input: rep(unit, BOT_MD_MAX_INPUT) });
  }
  for (const c of cases) {
    assert.equal(c.input.length, c.renderer === "bot" ? BOT_MD_MAX_INPUT : OWNER_MD_MAX_INPUT,
      `${c.name}: fixture size`);
  }
  // One worker, one 5 s wall-clock budget for all of them: a hang in any single
  // render kills it and fails here.
  const timings = await renderInWorker(cases);
  assert.equal(timings.length, cases.length, "the worker answered for every case");
  let worst = { ms: 0, what: "nothing yet" };
  for (const timing of timings) {
    assert.ok(timing.length > 0, `${timing.name}: still rendered (never "")`);
    if (timing.ms > worst.ms) worst = { ms: timing.ms, what: timing.name };
    assert.ok(timing.ms < RENDER_CPU_BUDGET_MS,
      `${timing.name} took ${timing.ms.toFixed(0)} ms of CPU (budget ${RENDER_CPU_BUDGET_MS} ms). ` +
      "Before the punctuation-mask guard this family was ~2.1 s at 128 KB and ~66 ms at 64 KB, " +
      "and the cost is pairs x block length: see punctMaskCost in servers/blog/renderer.js.");
  }
  t.diagnostic(`worst render: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
});

test("the mask guard is what makes the run cheap, and it flattens that block", () => {
  // The report's fixture, on the owner path (the public one): the block is
  // flattened to escaped text, and the pre-pass charged it as over the cap.
  const src = rep("\\\\", OWNER_MD_MAX_INPUT);
  const html = renderMarkdown(src);
  assert.ok(mdPunctMaskStats.flattened > 0, "the run was flattened rather than inline-lexed");
  assert.ok(mdPunctMaskStats.maskFlattened > 0, "the punctuation mask charge decided it");
  assert.ok(mdPunctMaskStats.charged >= BOT_MD_SQ_BUDGET,
    `the charge alone is a whole document budget (${mdPunctMaskStats.charged} attempts): ` +
    "a block at MD_PUNCT_MASK_MAX is priced at exactly that");

  // Nothing was dropped or rewritten: the backslashes are on the page as text,
  // and no emphasis or link was invented out of them.
  const text = html.replace(/<[^>]+>/g, "");
  assert.ok(html.startsWith("<p>"), `the block is still a paragraph: ${html.slice(0, 80)}`);
  assert.ok(text.includes("\\".repeat(64)), "the backslashes are still on screen");
  assert.ok(!/<em>|<strong>|<a[\s>]|<code/.test(html), "no markup was manufactured out of the run");
  assert.ok(text.length >= src.length, `every character is on the page (${text.length} of ${src.length})`);

  // A neighbour in the SAME block shares the flatten (as with the other guards):
  // `*hi*` beside a `\.` flood is shown as its source, not as emphasis.
  const flooded = "*hi* " + rep("\\.", 60 * 1024);
  const floodedHtml = renderMarkdown(flooded);
  assert.ok(!floodedHtml.includes("<em>"), "the flooded block shows source, not emphasis");
  assert.ok(floodedHtml.includes("*hi*"), "…and its text is still on screen");

  // The shapes with NO `\`+punctuation pair were never slow and must not be
  // flattened: nothing in them matches marked's mask regex.
  for (const unit of ["\\ ", "\\\n", "a\\"]) {
    renderMarkdown(rep(unit, OWNER_MD_MAX_INPUT));
    assert.equal(mdPunctMaskStats.charged, 0,
      `${JSON.stringify(unit)} has no escaped punctuation, so it costs the mask pass nothing`);
    assert.equal(mdPunctMaskStats.flattened, 0, `${JSON.stringify(unit)} is not flattened`);
  }
});

// --- ordinary content with backslashes is untouched -----------------------
// Every document below was rendered through the PRE-GUARD renderer and its
// sha256 pinned (owner and bot path separately: each has its own parser,
// image rule and link opt-outs). If one of these changes, the guard altered
// ordinary rendering — find out why before updating a pin.
function windowsDoc() {
  return [
    "# Backup script notes",
    "",
    "The nightly job copies `C:\\Users\\alex\\Documents\\reports` to the NAS at",
    "`\\\\nas01\\backups\\crow\\` and then verifies every file's hash.",
    "",
    "```bat",
    "robocopy C:\\Users\\alex\\Documents\\reports \\\\nas01\\backups\\crow\\ /MIR /R:2",
    "reg add HKCU\\Software\\Crow /v Path /d C:\\ProgramData\\Crow",
    "```",
    "",
    "- Source: `D:\\lab\\2026\\q3\\raw`",
    "- Target: `\\\\lab-nas\\lab\\2026\\q3`",
    "- Log: `%LOCALAPPDATA%\\Crow\\backup.log`",
    "",
    "> If `\\\\nas01` is unreachable the job retries twice and then rings the bell.",
    "",
    "| path | size |",
    "| --- | --- |",
    "| `C:\\Temp\\a.txt` | 4 KB |",
    "| `\\\\nas01\\x\\b.bin` | 12 MB |",
    "",
    "See [the port table](/docs/developers/port-allocation) for the rest.",
  ].join("\n");
}

function escapedMarkdownDoc() {
  return [
    "# Literal syntax, please",
    "",
    "Write \\*not emphasis\\* and \\_not emphasis either\\_ when you mean the",
    "asterisks themselves. A literal \\# is not a heading, \\- is not a bullet,",
    "and \\[not a link\\] stays text. To show a backtick, escape it: \\`like this\\`.",
    "",
    "1. \\* first literal item",
    "2. \\* second literal item",
    "3. \\> not a quote",
    "",
    "A table of literal markers:",
    "",
    "| written | means |",
    "| --- | --- |",
    "| \\* | a literal asterisk |",
    "| \\_ | a literal underscore |",
    "| \\| | a literal pipe, escaped |",
    "| \\\\ | a literal backslash |",
    "",
    "```md",
    "\\*not emphasis\\*",
    "\\[not a link\\](/nowhere)",
    "```",
    "",
    "Ends with a backslash hard break\\",
  ].join("\n");
}

function latexDoc() {
  const out = ["# Notes on the harmonic oscillator", ""];
  out.push("The potential is $V(x) = \\frac{1}{2}kx^{2}$, so the equation reads");
  out.push("\\[ x'' + \\omega^{2} x = 0 \\] and its solution uses $\\{A, B\\}$ with");
  out.push("$\\omega = \\sqrt{k/m}$. Energy levels: $E_n = \\hbar\\omega\\left(n + \\tfrac{1}{2}\\right)$.");
  out.push("");
  out.push("Use \\, between terms, \\; in matrices, and \\! to pull things together:");
  out.push("$a\\,b\\;c\\!d$. A set is $\\{x : x > 0\\}$ and a norm is $\\lVert x \\rVert$.");
  out.push("");
  out.push("- inline: $\\alpha \\to \\beta$, $p \\le 0.05$, $\\sum_{i=1}^{n} x_i$");
  out.push("- display-ish: $\\int_0^1 f(x)\\,dx = 1$");
  out.push("- escaped dollar: \\$5 and \\$10 stay prices");
  out.push("");
  out.push("| symbol | meaning |");
  out.push("| --- | --- |");
  out.push("| $\\hbar$ | reduced Planck |");
  out.push("| $\\{a\\}$ | a set |");
  out.push("");
  out.push("A code span keeps its backslashes: `printf(\"%d\\n\", x)` and `s/\\s+/ /g`.");
  out.push("");
  out.push("```tex");
  out.push("\\begin{align}");
  out.push("  x(t) &= A\\cos(\\omega t) + B\\sin(\\omega t) \\\\");
  out.push("\\end{align}");
  out.push("```");
  return out.join("\n");
}

/** Escaped punctuation at ~1 pair per 30 characters, over 60 paragraphs — the
 *  densest legitimate document here, and still 170x under the per-block cap. */
function pathProseDoc() {
  const out = ["# Server notes", ""];
  for (let i = 0; i < 60; i++) {
    out.push(
      `Phase ${i + 1}: the job reads \`C:\\lab\\run${i}\\input\` and writes ` +
      "`\\\\lab-nas\\lab\\out`, then logs to `%APPDATA%\\Crow\\run.log`. " +
      "Escaped markers like \\*this\\* and \\_that\\_ are rare but real, and " +
      "a regex in a code span looks like `^\\\\d{3}-\\\\d{4}$`."
    );
    out.push("");
  }
  return out.join("\n");
}

const PINS = {
  "Windows paths, UNC shares and a .bat fence": [windowsDoc,
    "ae1629c602af79254f188ed4c01c49732dfda9cd11edb77e674a8aeafc85bde2",
    "43ac80687ae2378fad2740113fd4e9099b107a05b345e246bb2b67fdecc28f7a"],
  "escaped markdown markers": [escapedMarkdownDoc,
    "007027c0e1f05b5d2535417a98f2348ba4e904ab00affd9154e19e08636b9b27",
    "007027c0e1f05b5d2535417a98f2348ba4e904ab00affd9154e19e08636b9b27"],
  "LaTeX-ish math and escaped dollars": [latexDoc,
    "0a5495c0d3e5822e77bc4867e765856f4deb6b6a3949b3cbd745cbbcbc5077a4",
    "a0e6dd8600829c45b392a5b18d82a7ca447c62ae881ea5373cd21fdb52d189dd"],
  "paths and escapes in prose, 14 KB": [pathProseDoc,
    "390faa7a60cc573c0d978e90376c6e8b16f43020f8e73333085ea8e7a7ae14b8",
    "390faa7a60cc573c0d978e90376c6e8b16f43020f8e73333085ea8e7a7ae14b8"],
};

test("ordinary content with backslashes renders byte-identical to before the guard", (t) => {
  for (const [name, [make, ownerSha, botSha]] of Object.entries(PINS)) {
    const doc = make();
    const started = cpuMs();
    const owner = renderMarkdown(doc);
    const ownerMs = cpuMs() - started;
    const ownerCharged = mdPunctMaskStats.charged;
    assert.equal(mdPunctMaskStats.flattened, 0, `${name}: nothing was flattened`);
    assert.equal(sha256(owner), ownerSha, `${name} (owner) must not change: ${owner.slice(0, 300)}`);
    // The guard saw this document and priced it as negligible: no escaped
    // punctuation here is anywhere near MD_PUNCT_MASK_MAX.
    assert.ok(ownerCharged < 1000,
      `${name}: the mask charge is negligible (${ownerCharged} attempts of the whole budget)`);

    const bot = renderBotMarkdown(doc);
    assert.equal(mdPunctMaskStats.flattened, 0, `${name}: nothing was flattened on the bot path`);
    assert.equal(sha256(bot), botSha, `${name} (bot) must not change: ${bot.slice(0, 300)}`);
    t.diagnostic(`${name}: ${doc.length} chars, ${ownerMs.toFixed(1)} ms, charge ${ownerCharged}`);
  }
  // …and they really went through marked's own inline lexer: the escapes were
  // eaten as escapes, and the markdown around them is still markdown.
  const escaped = renderMarkdown(escapedMarkdownDoc());
  assert.match(escaped, /\*not emphasis\*/, "an escaped asterisk stays a literal asterisk");
  assert.ok(!escaped.includes("<em>not emphasis</em>"), "…and is not read as emphasis");
  assert.match(escaped, /<em>a literal pipe, escaped<\/em>|<td>a literal pipe, escaped<\/td>/,
    "the unescaped markdown around the escapes still works");
  assert.match(renderMarkdown(latexDoc()), /\{A, B\}/, "escaped braces stay literal");
  assert.match(renderMarkdown(windowsDoc()), /<code>C:\\Users\\alex\\Documents\\reports<\/code>/,
    "a Windows path keeps its backslashes inside a code span");
});

// --- the differential: seeded ordinary documents with backslashes --------
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ordinary lines, most of them carrying a backslash of some kind. */
const NORMAL_LINES = [
  "A line of ordinary prose that wraps.",
  "Write \\*literal\\* asterisks when you mean them.",
  "A Windows path: `C:\\Users\\alex\\notes.txt`.",
  "A UNC share: `\\\\nas01\\backups\\crow\\`.",
  "Escaped markers: \\_x\\_, \\#hash, \\[not a link\\].",
  "LaTeX-ish: $\\{a, b\\}$, $\\alpha\\,x$, $\\lVert v \\rVert$.",
  "A regex in a code span: `s/\\s+/ /g` and `^\\\\d{3}$`.",
  "a line ending in a backslash hard break\\",
  "- a list item with \\*literal\\* text",
  "- another item, a path: `D:\\lab\\2026`",
  "1. an ordered item with \\- a literal dash",
  "> a quoted line with \\[brackets\\]",
  "# a heading with \\# in it",
  "| a | b |",
  "| - | - |",
  "| `C:\\Temp` | 4 KB |",
  "```",
  "echo C:\\Temp\\x \\\\ \\*",
  "```",
  "",
];

/** Lines that are denser in escaped punctuation (still ordinary markdown). */
const ESC_LINES = [
  "Literal: \\. \\- \\! \\| \\^ \\; \\, \\: \\~",
  "A table row of escapes: \\* \\_ \\` \\# \\[ \\]",
  "$x = \\{a\\, b\\; c\\! d\\}$ and $\\alpha\\,\\beta$",
  "`grep -E '\\\\d{3}\\\\-\\\\d{4}' file.txt` finds a number",
  "Paths: `C:\\a\\b`, `\\\\host\\share`, `%APPDATA%\\Crow`",
];

/** One document: 1-6 blocks of 1-6 lines, each line ordinary, and with
 *  probability `escChance` a denser escaped-punctuation line instead. Small by
 *  construction: no document here can come near MD_PUNCT_MASK_MAX. */
function randomDoc(rnd, escChance) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const lines = [];
  const blocks = 1 + Math.floor(rnd() * 6);
  for (let b = 0; b < blocks; b++) {
    const count = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < count; i++) lines.push(rnd() < escChance ? pick(ESC_LINES) : pick(NORMAL_LINES));
    if (b < blocks - 1) lines.push("");
  }
  return lines.join("\n");
}

test("differential: 1,000 seeded documents with sprinkled backslashes render the same with the mask guard on and off", () => {
  const rnd = mulberry32(0xbac451a5);
  const stats = { withBackslash: 0, differed: 0, maxCharged: 0, flattened: 0 };
  for (let n = 0; n < 1000; n++) {
    // A third mostly-prose, a third mixed, a third escape-dense, so both "the
    // guard must not care" and "the guard really prices something" are in here.
    const doc = randomDoc(rnd, n % 3 === 0 ? 0.1 : n % 3 === 1 ? 0.4 : 0.8);
    if (doc.includes("\\")) stats.withBackslash++;

    const guardedBot = renderBotMarkdown(doc);
    stats.flattened += mdPunctMaskStats.flattened;
    if (mdPunctMaskStats.charged > stats.maxCharged) stats.maxCharged = mdPunctMaskStats.charged;
    const guardedOwner = renderMarkdown(doc);

    let plainBot;
    let plainOwner;
    setMdPunctMaskGuardEnabled(false);
    try {
      plainBot = renderBotMarkdown(doc);
      plainOwner = renderMarkdown(doc);
    } finally {
      // Always back on: every later render in this file must be guarded.
      setMdPunctMaskGuardEnabled(true);
    }
    // The guard may only change a render it acted on. Every document here is
    // far under both the per-block cap and the document budget, so
    // `flattened === 0` is the guard's own statement that it left the document
    // to marked — and then the bytes must be identical.
    assert.equal(mdPunctMaskStats.flattened, 0,
      `doc #${n}: the guard flattened a block of a short ordinary document (${JSON.stringify(doc)})`);
    if (guardedBot !== plainBot || guardedOwner !== plainOwner) stats.differed++;
    assert.equal(guardedBot, plainBot,
      `doc #${n} (bot path) changed with the mask guard: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedBot)}\n  plain:   ${JSON.stringify(plainBot)}`);
    assert.equal(guardedOwner, plainOwner,
      `doc #${n} (owner path) changed with the mask guard: ${JSON.stringify(doc)}\n`
      + `  guarded: ${JSON.stringify(guardedOwner)}\n  plain:   ${JSON.stringify(plainOwner)}`);
  }
  assert.equal(stats.differed, 0, "no document rendered differently with the guard on");
  assert.equal(stats.flattened, 0, "the guard flattened nothing in 1,000 ordinary documents");
  // Not vacuous: the corpus really carries backslashes, and the estimate really
  // prices them (an all-zero max would mean the scan never matched anything).
  assert.ok(stats.withBackslash > 900, `the corpus carries backslashes (${stats.withBackslash} documents)`);
  assert.ok(stats.maxCharged > 0,
    "the mask estimate priced escaped punctuation somewhere in the corpus (max charge 0 means it saw none)");
});