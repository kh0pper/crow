// Markdown rendering: the BLOCK-NESTING CLIFF.
//
// marked's BLOCK lexer recurses once per container level, and one line can open
// tens of thousands of levels by itself: `1) `, `1. `, `- `, `* `, `+ `, `>` and
// mixes like `- > 1. ` are all containers. 64 KB of `1) ` used to cost ~1.0 s in
// renderBotMarkdown (which then caught the eventual RangeError and answered "")
// and ~1.36 s in renderMarkdown — where NOTHING caught it, so a deeply nested
// blog post, KB article, memory or workspace .md threw a stack overflow into a
// route. Both renderers now bound container nesting in a LINEAR pre-pass before
// marked's block lexer (limitContainerNesting + MD_MAX_NEST, see "THE
// BLOCK-NESTING CLIFF" in servers/blog/renderer.js).
//
// What must stay true:
//   - 64 KB of any container marker, and 30 seeded random mixes of them, render
//     in well under half a second of CPU on BOTH paths, and neither path throws;
//   - ordinary deeply-nested content (8 levels of lists in quotes in lists, code
//     in lists) renders EXACTLY as it did before the guard — pinned below, the
//     digests were captured from the renderer before the change;
//   - the excess markers are not lost: they come out as text;
//   - the existing pinned digests of tests/bot-markdown-quadratic.test.js still
//     match (that file is the byte-identical pin for ordinary bot output).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderMarkdown, renderBotMarkdown, MD_MAX_NEST } from "../servers/blog/renderer.js";

const CAP = 64 * 1024 - 1;
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);

// CPU time of THIS process, not wall-clock: rendering is synchronous and
// single-threaded, so the cost still shows in full while the parallel suite's
// load on other cores does not (the same measure bot-markdown-quadratic.test.js
// uses). The bound is sized for a loaded runner: the worst measured render after
// the guard is ~225 ms, the regression it guards was 0.7–1.4 s AND a throw.
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
    // Still rendered: an over-limit document is escaped, never refused.
    assert.ok(result.bot.html.length > 0, `${JSON.stringify(name)}: the bot path still renders`);
    assert.ok(result.owner.html.length > 0, `${JSON.stringify(name)}: the owner path still renders`);
  }
});

test("a CRLF document is bounded the same way (both paths)", (t) => {
  const note = tracker(t);
  // 50 marker levels per line, CRLF line endings: marked normalises them before
  // block lexing, and so must the pre-pass (it reads a marker followed by CR as a
  // marker at end of line).
  const src = rep("1) ".repeat(50) + " x\r\n", CAP);
  const result = both(src);
  note(result, "CRLF marker lines");
  assertBounded(result, "64 KB of CRLF marker lines");
  assert.ok(result.bot.html.length > 0);
  assert.ok(result.owner.html.length > 0);
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

// --- the excess markers are kept as TEXT, not dropped ----------------------
test("over-limit markers come out as their own text (nothing is dropped)", () => {
  // 200 `>` are 200 container levels: the first MD_MAX_NEST open blockquotes (so
  // their `>` is structure), the other 184 render as their own `>` text.
  const quotes = renderBotMarkdown(">".repeat(200) + " hello");
  assert.equal((quotes.match(/&gt;/g) || []).length, 200 - MD_MAX_NEST,
    "every `>` past the limit is still on screen");
  assert.equal((quotes.match(/<blockquote>/g) || []).length, MD_MAX_NEST);
  assert.match(quotes, /hello/);
  // An ordered marker's DELIMITER is escaped (`1\)` — `\1` is not an escape).
  const ordered = renderBotMarkdown("1) ".repeat(200) + "done");
  assert.equal((ordered.match(/1\)/g) || []).length, 200 - MD_MAX_NEST,
    "every `1)` past the limit is still on screen");
  assert.ok(!ordered.includes("\\"), "no backslash survives into the rendered text: " + ordered.slice(0, 200));
  assert.match(ordered, /done/);
  // …and a bullet list's `- ` is likewise text, not a bullet.
  const bullets = renderBotMarkdown("- ".repeat(200) + "x");
  assert.equal((bullets.replace(/<[^>]+>/g, "").match(/-/g) || []).length, 200 - MD_MAX_NEST,
    "every `- ` past the limit is still on screen");
  assert.match(bullets, /x/);
  // The cap itself is not a cliff: exactly MD_MAX_NEST containers open, and one
  // more marker on the line is text instead of a 17th level.
  const atLimit = renderBotMarkdown("- ".repeat(MD_MAX_NEST) + "x");
  const over = renderBotMarkdown("- ".repeat(MD_MAX_NEST + 1) + "x");
  assert.equal((atLimit.match(/<ul>/g) || []).length, MD_MAX_NEST);
  assert.equal((over.match(/<ul>/g) || []).length, MD_MAX_NEST, "no 17th level: " + over.slice(0, 300));
  assert.ok(!over.includes("</ul>\n<ul>"), "the excess `- ` did not start a sibling list");
});

// --- normal content is untouched -------------------------------------------
// Lists in quotes in lists, code in lists, eight levels deep — the deepest
// nesting a hand-written document plausibly reaches. The digests were captured
// from this tree BEFORE limitContainerNesting existed, for BOTH renderers.
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