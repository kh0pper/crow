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
//     that arrive with bare `\r` / `\r\n`, and quote+indent+marker stacks render
//     in well under half a second of CPU on BOTH paths, and neither path throws;
//   - CODE IS VERBATIM: fences, indented code, raw <pre> and math blocks come out
//     with no backslash that was not in the source;
//   - ordinary deeply-nested content (8 levels of lists in quotes in lists, code
//     in lists) renders EXACTLY as it did before any guard — pinned below, the
//     digests were captured from the renderer before the change;
//   - the owner path caps its input (OWNER_MD_MAX_INPUT, 1 MiB) and answers the
//     escaped text instead of parsing, and its escaped-text fallback does not
//     show what the author hid in an HTML comment;
//   - the file viewer refuses a file over that cap before reading it;
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
import { renderMarkdown, renderBotMarkdown, MD_MAX_NEST, OWNER_MD_MAX_INPUT } from "../servers/blog/renderer.js";

const CAP = 64 * 1024 - 1;
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);

// CPU time of THIS process, not wall-clock: rendering is synchronous and
// single-threaded, so the cost still shows in full while the parallel suite's
// load on other cores does not (the same measure bot-markdown-quadratic.test.js
// uses). The bound is sized for a loaded runner: the worst measured render after
// the guard is 128 ms, the regression it guards was 0.7–1.4 s AND a throw.
const BOUND_MS = 500;
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

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

function assertBounded(result, what) {
  for (const [who, r] of Object.entries(result)) {
    assert.ok(r.ms < BOUND_MS, `${what} took ${r.ms.toFixed(0)} ms on the ${who} path (bound ${BOUND_MS} ms)`);
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

test("64 KB of every container marker renders in < 500 ms on both paths, no throw", (t) => {
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
    assertBounded(result, `64 KB of ${name} marker lines`);
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

test("random-search smoke: 30 seeded 64 KB marker mixes, each < 500 ms, no throw", (t) => {
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

// --- the owner input cap --------------------------------------------------
test("owner input over 1 MiB is not parsed: escaped text, fast, and 4 MiB does not crash", (t) => {
  assert.equal(OWNER_MD_MAX_INPUT, 1024 * 1024);
  const over = "x ".repeat(Math.ceil((OWNER_MD_MAX_INPUT + 1) / 2));
  assert.equal(over.length, OWNER_MD_MAX_INPUT + 2);

  const t0 = cpuMs();
  const html = renderMarkdown(over);
  const ms = cpuMs() - t0;
  t.diagnostic(`1 MiB + 2 chars on the owner path: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 200, `over-cap owner input took ${ms.toFixed(0)} ms (bound 200 ms)`);
  // The escaped-text answer, not a parse: one <p>, no markdown structure.
  assert.ok(html.startsWith("<p>"), html.slice(0, 120));
  assert.ok(html.includes("x x x"), "the text is still shown");

  // 4 MiB must not crash the process (it used to be an OOM in marked's tree).
  const huge = "a ".repeat(2 * 1024 * 1024);
  assert.equal(huge.length, 4 * 1024 * 1024);
  const t1 = cpuMs();
  const hugeHtml = renderMarkdown(huge);
  t.diagnostic(`4 MiB on the owner path: ${(cpuMs() - t1).toFixed(0)} ms`);
  assert.ok(hugeHtml.length > 0, "4 MiB answers text rather than throwing");
  // The escaped-text answer, not a parsed tree: the output is the input plus a
  // <p> wrapper (one <br /> per line; this fixture has no line breaks).
  assert.ok(hugeHtml.startsWith("<p>a a a"), hugeHtml.slice(0, 40));
  assert.ok(hugeHtml.length < huge.length + 32, `output ${hugeHtml.length} vs input ${huge.length}`);
});

test("the owner fallback does not show what the author hid in an HTML comment", () => {
  // The over-cap path IS the escaped-text fallback, so this is the fallback.
  const hidden = "<!-- internal: do not publish -->";
  const body = "x ".repeat(Math.ceil((OWNER_MD_MAX_INPUT + 1) / 2));
  const html = renderMarkdown(hidden + "\n" + body);
  assert.ok(!html.includes("internal: do not publish"), "the comment's text must not be shown");
  assert.ok(!html.includes("&lt;!--"), "and neither must the escaped comment itself");
  // Everything else stays visible, escaped.
  assert.ok(html.includes("x x x"));

  // A comment in the MIDDLE, several of them, and an unclosed one (left alone).
  const html2 = renderMarkdown("<!--a-->" + body + "<!--b-->tail<!-- unclosed");
  assert.ok(!html2.includes("<!--a-->") && !html2.includes("a--&gt;"), "leading comment stripped");
  assert.ok(html2.includes("tail"), "text around the comments survives");
  assert.ok(!/b-->/.test(html2), "middle comment stripped");
  assert.ok(html2.includes("&lt;!-- unclosed"), "an unclosed `<!--` is left as text");
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

// --- the file viewer refuses a file over the renderer's cap ----------------
let srv, base, root, smallMd, bigMd;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "md-nest-fileview-"));
  smallMd = join(root, "small.md");
  bigMd = join(root, "big.md");
  writeFileSync(smallMd, "# Small\n\nsome *text*\n");
  // One byte over the cap, with a sentinel so "the content was not shown" is a
  // real assertion rather than a length check.
  writeFileSync(bigMd, "# Big\n\nSECRET-CONTENT\n\n" + "x ".repeat(OWNER_MD_MAX_INPUT / 2));
  process.env.CROW_FILEVIEW_ROOT = root;
  const { default: fileviewRouter } = await import("../servers/gateway/routes/fileview.js");
  const app = express();
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).type("text/plain").send("login"));
  app.use(fileviewRouter(dashboardAuth));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); rmSync(root, { recursive: true, force: true }); });

const get = (path) => fetch(base + path, { headers: { cookie: "crow_session=good" } });

test("fileview: a file over 1 MiB shows a short notice instead of its content", async () => {
  const ok = await get("/dashboard/fileview?path=" + encodeURIComponent(smallMd));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<h1[^>]*>Small<\/h1>/, "the harness renders a normal file");

  const r = await get("/dashboard/fileview?path=" + encodeURIComponent(bigMd));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /too large to view here/, "the notice");
  assert.ok(!html.includes("SECRET-CONTENT"), "the content is not read into the page");
  assert.ok(!html.includes("<article>"), "no article body at all");
  assert.ok(html.includes('lang="en"'), "the notice is marked as English");
});