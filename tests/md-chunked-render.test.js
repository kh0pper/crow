// Markdown rendering: a LONG owner document is CHUNKED, not cut.
//
// renderMarkdown used to format only a head of at most OWNER_MD_MAX_INPUT
// (128 KB) and show the whole remainder as escaped plain text under
// "Long document: the rest is shown as plain text." — which hid the formatting
// of the owner's 500 KB-1 MB lab notes (the file viewer's documents) behind a
// wall of literal markdown. A document over the chunk size is now split into
// CONSECUTIVE chunks of at most OWNER_MD_MAX_INPUT characters, each cut at a
// safe block boundary and each rendered through the SAME guarded pipeline and
// sanitizer, so the whole document comes out formatted.
//
// What must stay true:
//   - a realistic 600 KB / 1 MB document renders FULLY formatted: no tail
//     notice, one <h2> per section heading in the source, and every reference
//     link resolves — even though every `[label]: url` definition sits at the
//     TOP of the document, in the FIRST chunk, and is used from every later one
//     (marked resolves references against the one lexer's map, so those
//     definitions are collected document-wide first);
//   - the chunk boundaries cover the document EXACTLY: for 30 random documents
//     of 200 KB-2 MB, joining the chunk sources reproduces the input character
//     for character (nothing dropped, nothing added, nothing rewritten);
//   - the TOTAL-TIME BUDGET works: a 1 MiB document of the pathological shapes
//     (table lines, code/quote, a `1) ` marker run, `_a`) renders in well under
//     3 s of CPU, and a document big enough to spend
//     OWNER_MD_RENDER_BUDGET_MS on any box (8 MiB of the most expensive shape
//     measured) falls back to the plain-text tail — the notice, then the WHOLE
//     remainder, starting exactly at a chunk boundary and readable back
//     character for character;
//   - a document of at most OWNER_MD_MAX_INPUT is still rendered in ONE guarded
//     parse and is byte-identical to what it always rendered (the sha256 pins in
//     tests/md-nesting-depth.test.js, tests/owner-markdown-guard.test.js and
//     tests/md-block-guard.test.js, run alongside this file, are unchanged);
//   - the file viewer renders a 600 KB .md fully formatted through its route.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import {
  renderMarkdown, ownerMarkdownChunks,
  OWNER_MD_MAX_INPUT, OWNER_MD_MAX_TOTAL_INPUT, OWNER_MD_RENDER_BUDGET_MS,
} from "../servers/blog/renderer.js";

const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
const TAIL_NOTICE = '<p class="md-tail-notice">Long document: the rest is shown as plain text.</p>';
const TAIL_OPEN = '<pre class="md-tail">';

// CPU time of THIS process, not wall-clock: rendering is synchronous and
// single-threaded, so the cost still shows in full while the parallel suite's
// load on other cores does not (the measure the other renderer tests use).
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

/** The inverse of the renderer's escapeText (five characters), so a tail can be
 *  read back out of the HTML the way a reader sees it. */
function unescapeText(html) {
  return html
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The plain-text tail of a rendered document: the notice's position, the <pre>
 *  that follows it, and its text read back. */
function tailOf(html) {
  const at = html.indexOf(TAIL_NOTICE);
  assert.ok(at >= 0, "the long-document notice is missing: " + html.slice(0, 200));
  const from = at + TAIL_NOTICE.length;
  const open = html.indexOf(TAIL_OPEN, from);
  assert.equal(open, from, "the <pre> comes straight after the notice");
  const close = html.lastIndexOf("</pre>");
  assert.ok(close > open, "the tail <pre> is closed");
  return { head: html.slice(0, at), text: unescapeText(html.slice(open + TAIL_OPEN.length, close)) };
}

/** True when `tail` is the document's own remainder starting at a chunk
 *  boundary the renderer could have stopped at — the "nothing is dropped" check
 *  for a render whose budget ran out (the tail is `src.slice(start)`). */
function isRemainderAtChunkBoundary(src, tail) {
  return ownerMarkdownChunks(src).some(([start]) => src.slice(start) === tail);
}

// --- the realistic document ------------------------------------------------
// A document shaped like the owner's lab notes: a title, an index, ONE block of
// link reference definitions at the very top, then dozens of sections of prose,
// lists, a table and fenced code — every section linking back through a
// reference definition written in the first chunk. That is the case the old
// head+tail split broke twice: the tail was not formatted, and a reference link
// in chunk 3 could not see a definition in chunk 1.
const REFS = 120;

function realisticDoc(size) {
  const parts = [
    "# Field notes: the long document",
    "",
    "An index of the notes that follow. Every link below is a REFERENCE link,",
    "resolved from a definition written here, at the top of the document.",
    "",
  ];
  for (let i = 0; i < REFS; i++) parts.push(`[sec-${i}]: /blog/field/${i} "Field note ${i}"`);
  parts.push("");
  let length = parts.join("\n").length;
  let n = 0;
  while (length < size) {
    const unit = [
      `## Section ${n}`,
      "",
      `The *notes* for step ${n} are in [field note ${n}][sec-${n % REFS}], with a`,
      `[second reference][sec-${(n + 1) % REFS}] for the follow-up.`,
      "",
      "- first bullet with a `code span`",
      "- second bullet with [a reference][sec-3]",
      "  - nested bullet",
      "",
      "| key | value |",
      "| --- | ----- |",
      `| key-${n} | value-${n * 2} |`,
      "",
      "```js",
      `const section = ${n};`,
      "```",
      "",
      `> A quoted aside for section ${n}, with a [reference][sec-7] in it.`,
      "",
    ].join("\n");
    parts.push(unit);
    length += unit.length + 1;
    n++;
  }
  parts.push("END-OF-THE-FIELD-NOTES\n");
  return parts.join("\n");
}

/** How many reference-link uses (`[text][label]`) a source has. */
function refUseCount(src) {
  return (src.match(/\[[^\[\]\n]+\]\[[^\[\]\n]+\]/g) || []).length;
}

for (const size of [600 * 1024, 1024 * 1024]) {
  test(`a real-shaped ${size / 1024} KB document renders FULLY formatted (no tail)`, (t) => {
    const src = realisticDoc(size);
    assert.ok(src.length >= size, `the fixture reaches ${size} chars (${src.length})`);
    assert.ok(src.length > 2 * OWNER_MD_MAX_INPUT, "and spans several chunks");
    // Every section heading in the source: what the <h2> count is checked
    // against, so a lost chunk cannot pass.
    const headings = (src.match(/^## /gm) || []).length;
    assert.ok(headings > 200, `the fixture has many section headings (${headings})`);
    const chunks = ownerMarkdownChunks(src);
    assert.ok(chunks.length >= 4, `the document is split into chunks (${chunks.length})`);
    assert.equal(chunks.reduce((sum, [start, end]) => sum + (end - start), 0), src.length,
      "the chunks cover the whole document");
    const usages = refUseCount(src);
    assert.ok(usages > 300, `the fixture uses many reference links (${usages})`);

    const t0 = cpuMs();
    const html = renderMarkdown(src);
    const ms = cpuMs() - t0;
    t.diagnostic(`${(src.length / 1024).toFixed(0)} KB realistic document: ${ms.toFixed(0)} ms CPU, `
      + `${chunks.length} chunks, ${usages} reference links, ${html.length} chars of HTML`);
    assert.ok(ms < 3000, `a realistic ${size / 1024} KB document took ${ms.toFixed(0)} ms (bound 3000 ms)`);

    // Nothing was left as plain text: no notice, no tail <pre>.
    assert.ok(!html.includes("md-tail"), "the whole document is formatted: " + html.slice(-300));
    // Every section heading in the source is an <h2> in the output.
    assert.equal((html.match(/<h2[^>]*>/g) || []).length, headings,
      `one <h2> per source "## " heading (${headings})`);
    assert.match(html, /<h2[^>]*>Section 0<\/h2>/);
    assert.match(html, new RegExp(`<h2[^>]*>Section ${headings - 1}<\\/h2>`), "the LAST section too");
    // Every reference link resolved — one <a href> per `[text][label]` use, and
    // not a single one left as its literal markdown text.
    assert.equal((html.match(/<a href="/g) || []).length, usages,
      `one <a href> per reference use (${usages})`);
    assert.ok(!html.includes("]["), "no literal reference link is left in the page");
    assert.match(html, /<a href="\/blog\/field\/\d+"/, "the definitions' URLs are the hrefs");
    // And the rest of the formatting is real, in the last chunk as well.
    assert.match(html, /<div class="table-scroll"><table>/, "tables are wrapped for scroll");
    assert.match(html, /<pre><code class="language-js">/, "fenced code is a code block");
    assert.match(html, /<li>first bullet with a <code>code span<\/code><\/li>/, "lists are lists");
    assert.match(html, /END-OF-THE-FIELD-NOTES/, "the LAST line is on the page");
  });
}

test("the owner cap and the hard ceiling are the chunker's two bounds", () => {
  assert.equal(OWNER_MD_MAX_INPUT, 128 * 1024);
  assert.equal(OWNER_MD_MAX_TOTAL_INPUT, 8 * 1024 * 1024);
  assert.equal(OWNER_MD_RENDER_BUDGET_MS, 1500);
  // Under the chunk size there is nothing to split.
  const small = "# Small\n\nsome *text*\n";
  assert.deepEqual(ownerMarkdownChunks(small), [[0, small.length]]);
  // No block boundary to cut on: the cap is the only cut, on a character.
  const oneLine = "a".repeat(OWNER_MD_MAX_INPUT);
  assert.deepEqual(ownerMarkdownChunks(oneLine), [[0, oneLine.length]]);
  // A document AT the cap may still be split (a blank line is a better boundary
  // than the cap); the pieces are consecutive, bounded and join back exactly.
  const capDoc = rep("a\n\n", OWNER_MD_MAX_INPUT);
  let joined = "";
  for (const [start, end] of ownerMarkdownChunks(capDoc)) {
    assert.ok(end - start > 0 && end - start <= OWNER_MD_MAX_INPUT, `chunk ${start}-${end} is bounded`);
    joined += capDoc.slice(start, end);
  }
  assert.equal(joined, capDoc, "a document at the cap is covered exactly");
  // A document past the hard ceiling is covered only up to it: the rest is the
  // plain-text tail (see renderMarkdown).
  const over = rep("x ", OWNER_MD_MAX_TOTAL_INPUT + 1000);
  const chunks = ownerMarkdownChunks(over);
  assert.equal(chunks.at(-1)[1], OWNER_MD_MAX_TOTAL_INPUT, "the chunks stop at the hard ceiling");
  assert.ok(over.length > OWNER_MD_MAX_TOTAL_INPUT);
});

// --- the concatenation property -------------------------------------------
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("chunk sources concatenate back to the input: 30 random 200 KB-2 MB documents", () => {
  const POOL = [
    "alpha beta gamma delta\n", "**bold** and *em* and `code`\n", "- bullet\n", "1. ordered\n",
    "> quote\n", "    indented code\n", "| a | b |\n| - | - |\n| 1 | 2 |\n", "\n",
    "```\n", "~~~\n", "### heading\n", "text with a [link](/x) and <b>raw html</b>\n",
    "[r1]: /blog/r1 \"a title\"\n", "😀 emoji on a line\n", "a".repeat(300) + "\n",
    "\r\n", "> - nested\n", "  continuation\n",
  ];
  const rnd = mulberry32(0xc4a1e5);
  for (let n = 0; n < 30; n++) {
    const target = 200 * 1024 + Math.floor(rnd() * (2 * 1024 * 1024 - 200 * 1024));
    const parts = [];
    let size = 0;
    while (size < target) {
      const unit = POOL[Math.floor(rnd() * POOL.length)];
      parts.push(unit);
      size += unit.length;
    }
    const src = parts.join("");
    const chunks = ownerMarkdownChunks(src);
    assert.ok(chunks.length > 0, `doc #${n}: at least one chunk`);
    assert.equal(chunks[0][0], 0, `doc #${n}: the first chunk starts at 0`);
    let joined = "";
    let end = 0;
    for (const [start, stop] of chunks) {
      assert.equal(start, end, `doc #${n}: chunk ${start} follows the previous end ${end}`);
      assert.ok(stop > start, `doc #${n}: chunk [${start}, ${stop}) is not empty`);
      assert.ok(stop - start <= OWNER_MD_MAX_INPUT,
        `doc #${n}: chunk ${start}-${stop} is over the cap (${stop - start})`);
      // No chunk boundary splits a UTF-16 surrogate pair.
      const last = src.charCodeAt(stop - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff),
        `doc #${n}: boundary ${stop} splits a surrogate pair`);
      joined += src.slice(start, stop);
      end = stop;
    }
    assert.equal(end, src.length, `doc #${n}: the chunks reach the end of the document`);
    assert.equal(joined, src, `doc #${n}: joined chunks reproduce the input exactly`);
  }
});

// --- the total-time budget -----------------------------------------------
// The four pathological families the renderer is guarded against, each repeated
// to 1 MiB. Every chunk of each one is bounded by the block guards, so the whole
// render is bounded too — that is what this test holds.
const PATHOLOGICAL = {
  "table lines": () => rep("a\n-|-\n", 1024 * 1024),
  "code/quote": () => rep("    x\n>     y\n", 1024 * 1024),
  '"1) " nesting': () => rep("1) ", 1024 * 1024),
  '"_a" delimiters': () => rep("_a", 1024 * 1024),
};

test("budget: 1 MiB of every pathological shape renders in < 3 s CPU and drops nothing", (t) => {
  for (const [name, make] of Object.entries(PATHOLOGICAL)) {
    const src = make();
    assert.equal(src.length, 1024 * 1024, `${name}: fixture size`);
    const t0 = cpuMs();
    const html = renderMarkdown(src);
    const ms = cpuMs() - t0;
    t.diagnostic(`1 MiB of ${name}: ${ms.toFixed(0)} ms CPU, ${html.length} chars of HTML`);
    assert.ok(html.length > 0, `${name}: still rendered`);
    assert.ok(ms < 3000, `1 MiB of ${name} took ${ms.toFixed(0)} ms CPU (bound 3000 ms)`);

    // Nothing dropped. Either the whole document is formatted (no notice), or
    // the notice is followed by the WHOLE remainder — starting exactly at a
    // chunk boundary, and readable back character for character.
    if (!html.includes(TAIL_NOTICE)) {
      assert.ok(html.replace(/<[^>]+>/g, "").length > 0, `${name}: fully formatted`);
      continue;
    }
    const { text } = tailOf(html);
    assert.ok(src.endsWith(text), `${name}: the tail is the end of the document`);
    assert.ok(isRemainderAtChunkBoundary(src, text),
      `${name}: the tail starts at a chunk boundary (nothing between the HTML and the tail was dropped)`);
  }
});

// The notice itself, on a document big enough to spend the budget on ANY box:
// the most expensive shape measured (a one-cell table every three lines —
// ~250 ms of CPU per 128 KB chunk on the dev box) repeated to just past the
// 8 MiB parse ceiling, i.e. ~16 s of unbudgeted work, which still spends the
// 1.5 s budget on a runner an order of magnitude faster. (Whether a 1 MiB
// document reaches 1500 ms depends on the box: the four shapes above measure
// 0.02-1.1 s for 1 MiB here.) The blank line after each table is what the chunk
// cut lands on, so the tail starts at a table, not inside one — and because the
// document is over the hard ceiling, a failure to spend the budget would show up
// as a tail of a few hundred characters instead of a real remainder.
const TABLE_UNIT = "|a|\n|-|\n|b|\n\n";
const budgetDoc = () => rep(TABLE_UNIT, OWNER_MD_MAX_TOTAL_INPUT + 1000);

test("budget: a pathological 8 MiB document shows the notice and keeps the WHOLE remainder", (t) => {
  const src = budgetDoc();
  assert.ok(src.length > OWNER_MD_MAX_TOTAL_INPUT, `the fixture is over the parse ceiling (${src.length})`);
  const t0 = cpuMs();
  const html = renderMarkdown(src);
  const ms = cpuMs() - t0;
  t.diagnostic(`8 MiB of one-cell tables: ${ms.toFixed(0)} ms CPU, ${html.length} chars of HTML`);
  assert.ok(ms < 3000, `the budgeted render took ${ms.toFixed(0)} ms CPU (bound 3000 ms)`);

  const { head, text } = tailOf(html);
  // The formatted part is real HTML (tables, wrapped for scroll by the owner
  // sanitizer), and the tail is the whole rest of the document, from a chunk
  // boundary to its last character.
  assert.match(head, /<div class="table-scroll"><table>/, "the formatted part really is formatted tables");
  assert.ok(src.endsWith(text), "the tail is the end of the document");
  assert.ok(isRemainderAtChunkBoundary(src, text), "and it starts exactly at a chunk boundary");
  assert.ok(text.startsWith(TABLE_UNIT), "where a whole table begins (no table split mid-structure)");
  assert.ok(text.length > OWNER_MD_MAX_INPUT,
    `the budget stopped well inside the document, leaving a real remainder (${text.length} chars)`);
});

test("the budget's remainder is inert text, never markup", () => {
  // The tail is built by the renderer itself, after the sanitizer, from escaped
  // text only — so a document whose remainder is full of raw HTML and scripts
  // cannot smuggle either through it.
  const hostile = budgetDoc() + '\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n';
  const html = renderMarkdown(hostile);
  assert.ok(html.includes(TAIL_NOTICE), "the budget runs out on this fixture");
  const { text } = tailOf(html);
  assert.ok(text.includes("<script>alert(1)</script>"), "the tail SHOWS the source as text");
  assert.ok(!/<script>/.test(html), "and never as live markup");
  assert.ok(!/<img[^>]*onerror/i.test(html), "no event handler survives anywhere");
});

test("cross-chunk references: the document's FIRST definition wins, and one in a fence is not one", () => {
  // The whole-document definition map is built before any chunk is rendered, so
  // it must follow marked's own rules: a label defined twice keeps its FIRST
  // definition (chunk 1), and a `[label]: url` line inside a fenced code block
  // is code, not a definition.
  const filler = [];
  let size = 0;
  while (size < 200 * 1024) {
    const unit = "A paragraph of ordinary prose that fills the document out.\n\n";
    filler.push(unit);
    size += unit.length;
  }
  const src = [
    "# Definitions",
    "",
    "[dup]: /blog/first \"First definition\"",
    "",
    "```text",
    "[fenced]: /blog/fenced",
    "```",
    "",
    ...filler,
    "[dup]: /blog/second \"A later duplicate\"",
    "",
    "Late links: [one][dup] and [two][fenced].",
  ].join("\n");
  assert.ok(src.length > 200 * 1024, `over the chunk size (${src.length})`);
  assert.ok(ownerMarkdownChunks(src).length >= 2, "the document spans several chunks");
  const html = renderMarkdown(src);
  assert.match(html, /<a href="\/blog\/first" title="First definition"[^>]*>one<\/a>/, html.slice(-400));
  assert.ok(!html.includes('href="/blog/second"'), "the later duplicate never wins");
  assert.ok(html.includes("[two][fenced]"),
    "a definition inside a fence is code, so that link stays literal text: " + html.slice(-400));
  assert.ok(!html.includes('href="/blog/fenced"'), "and never becomes a link");
});

// --- the file viewer -------------------------------------------------------
// The route the owner's lab notes actually come through: a 600 KB .md under the
// 8 MiB read cap is read and rendered in full — no refusal, no plain-text tail.
let srv, base, root, midMd, midDoc, midHeadings;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "md-chunked-fileview-"));
  midMd = join(root, "field-notes.md");
  midDoc = realisticDoc(600 * 1024);
  midHeadings = (midDoc.match(/^## /gm) || []).length;
  writeFileSync(midMd, midDoc);
  process.env.CROW_FILEVIEW_ROOT = root;
  const { default: fileviewRouter, FILEVIEW_MAX_BYTES } = await import("../servers/gateway/routes/fileview.js");
  // The renderer's own hard ceiling is the page's read cap: the file viewer can
  // never hand renderMarkdown more than it will parse, so a file it shows is a
  // file that is rendered in full.
  assert.equal(FILEVIEW_MAX_BYTES, OWNER_MD_MAX_TOTAL_INPUT,
    "the file viewer's read cap and the renderer's parse ceiling are the same 8 MiB");
  const app = express();
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).type("text/plain").send("login"));
  app.use(fileviewRouter(dashboardAuth));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); rmSync(root, { recursive: true, force: true }); });

test("fileview: a 600 KB .md renders FULLY formatted through the route", async (t) => {
  assert.ok(midDoc.length >= 600 * 1024, `the fixture is a long document (${midDoc.length})`);
  const t0 = cpuMs();
  const r = await fetch(base + "/dashboard/fileview?path=" + encodeURIComponent(midMd),
    { headers: { cookie: "crow_session=good" } });
  const ms = cpuMs() - t0;
  t.diagnostic(`fileview on a ${midDoc.length}-char file: ${ms.toFixed(0)} ms CPU (incl. the request)`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.doesNotMatch(html, /too large to view here/, "a 600 KB file is not refused");
  const article = html.slice(html.indexOf("<article>"), html.indexOf("</article>"));
  assert.ok(!article.includes("md-tail"), "the whole file is formatted, not head + plain text");
  assert.equal((article.match(/<h2[^>]*>/g) || []).length, midHeadings,
    "every section heading of the file is an <h2> on the page");
  assert.equal((article.match(/<a href="/g) || []).length, refUseCount(midDoc),
    "every reference link in the file resolved through the route");
  assert.match(article, /<div class="table-scroll"><table>/, "its tables are formatted");
  assert.ok(article.includes("END-OF-THE-FIELD-NOTES"), "right to the last line");
});