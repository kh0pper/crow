// Perch bot markdown: the INLINE-LEXER CLIFF.
//
// `renderBotMarkdown` runs synchronously on the gateway's event loop for a bot
// reply of up to BOT_MD_MAX_INPUT (64 KB). marked's inline lexer is QUADRATIC
// on mixed emphasis delimiters inside one inline block — measured before the
// guard: 8 KB of "*a_" 349 ms, "_*a" 376 ms, "**a_" 418 ms, "**_a" 213 ms,
// ~4x per doubling, i.e. ~21 s at the cap. One bot reply stalled every gateway
// user. The fix is a LINEAR pre-pass (see "THE INLINE-LEXER CLIFF" in
// servers/blog/renderer.js): delimiter counts are bounded per inline block and
// per document, and an over-budget block is rendered as its escaped text.
//
// What must stay true:
//   - any input up to the cap renders in about a second of CPU or less, in every
//     shape an attacker can pour delimiters into (one paragraph, many
//     paragraphs, list items, table cells, headings), in the `_`+filler shape
//     the total budget was halved for (the slowest of them: measured 256 ms,
//     bound 2,000 ms), and as a flood of link definitions (which marked scans on
//     every inline block; measured 73 ms);
//   - the email-autolink run shapes (`a…@a…`, `HTTP…@a…`, a long `HTTP` run, an
//     `@` every 4,096 `a`s) stay under 500 ms at the cap (measured 2-3 ms) while
//     ordinary email content still autolinks and renders byte-identically;
//   - ordinary bot prose renders EXACTLY as it did before the guard (pinned
//     below: the digest was captured from the renderer before the change),
//     whether it arrives with LF or CRLF line endings;
//   - a flattened block is inert (its text is text) and its neighbours keep
//     their formatting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  renderBotMarkdown, BOT_MD_MAX_INPUT,
  BOT_MD_BLOCK_DELIMS, BOT_MD_SQ_BUDGET, BOT_MD_MAX_LINK_DEFS,
} from "../servers/blog/renderer.js";

const CAP = BOT_MD_MAX_INPUT - 1;
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);

// CPU time of THIS process, not wall-clock: rendering is synchronous and
// single-threaded, so the cost still shows in full while the parallel suite's
// load on other cores does not (the same measure bot-markdown-render.test.js
// uses).
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

function delims(s) { return (s.match(/[*_[\]~`(<]/g) || []).length; }

/** Render once, returning the HTML and the CPU ms it took. */
function timed(src) {
  const t0 = cpuMs();
  const html = renderBotMarkdown(src);
  return { html, ms: cpuMs() - t0 };
}

/** Collects the worst render of one test, reported as that test's diagnostic
 *  (the bound is the assertion; the number is the evidence). */
function tracker(t) {
  const worst = { ms: 0, what: "nothing yet" };
  return (ms, what) => {
    if (ms > worst.ms) { worst.ms = ms; worst.what = what; }
    t.diagnostic(`worst render so far: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
  };
}

// --- the shapes an attacker (or an unlucky model) can put delimiters in ------
// Every shape carries ~64 KB of the same adversarial unit; only the container
// differs, which is what decides whether one inline block or many see it.
const BLOCKS = 40;
const chunks = (unit) => {
  const size = Math.floor(CAP / BLOCKS);
  return Array.from({ length: BLOCKS }, () => rep(unit, size));
};

// Every shape is sliced to CAP: separators, list bullets and table pipes add
// length, and over the cap renderBotMarkdown deliberately returns "".
const atCap = (s) => s.slice(0, CAP);

const SHAPES = {
  "one paragraph": (unit) => rep(unit, CAP),
  "40 paragraphs": (unit) => atCap(chunks(unit).join("\n\n")),
  "list items": (unit) => atCap(chunks(unit).map((c) => "- " + c).join("\n")),
  "headings": (unit) => atCap(chunks(unit).map((c) => "## " + c).join("\n\n")),
  "table cells": (unit) => {
    const half = Math.floor(CAP / 2 / BLOCKS);
    const rows = Array.from({ length: BLOCKS }, () => `| ${rep(unit, half)} | ${rep(unit, half)} |`);
    return atCap(["| a | b |", "| - | - |", ...rows].join("\n"));
  },
};

// The units from the report (each was a measured cliff before the guard), plus
// the two that were already linear ("*a", "\[ x") as controls.
const UNITS = ["*a_", "_*a", "**_a", "**a_", "_a_", "[a](", "*a", "\\[ x\n"];

test("every adversarial unit x shape at the cap renders in < 1000 ms of CPU", (t) => {
  const note = tracker(t);
  for (const unit of UNITS) {
    for (const [name, shape] of Object.entries(SHAPES)) {
      const src = shape(unit);
      const { html, ms } = timed(src);
      note(ms, `${JSON.stringify(unit)} in ${name}`);
      assert.ok(html.length > 0, `still rendered: ${JSON.stringify(unit)} in ${name}`);
      assert.ok(ms < 1000, `${JSON.stringify(unit)} in ${name} (${src.length} chars) took ${ms.toFixed(0)} ms`);
    }
  }
});

test("many medium blocks (each just under the per-block cap) still bounded", (t) => {
  const note = tracker(t);
  // The case the total budget exists for: no single block is over the per-block
  // cap, so nothing would be flattened on delimiters alone. The 4e6 budget
  // admits four blocks of ~1,000 delimiters (~220–270 ms at the 55–67 ns per
  // pair measured on that shape) and flattens the other 28.
  for (const [unit, chars] of [["**a_", 1360], ["*a_", 1500], ["_*a", 1500], ["**_a", 1360]]) {
    const block = rep(unit, chars);
    assert.ok(delims(block) < BOT_MD_BLOCK_DELIMS, `fixture block must stay under the cap (${delims(block)})`);
    const src = atCap(Array.from({ length: 32 }, () => block).join("\n\n"));
    const { ms } = timed(src);
    note(ms, `32 medium blocks of ${unit}`);
    assert.ok(ms < 1000, `32 blocks of ${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
  }
});

// The shape that motivated halving BOT_MD_SQ_BUDGET: ~1,000 `_` per block with
// `$&/!{` filler between them. At the old 8e6 budget all eight blocks were
// inline-lexed and it cost 539 ms (55–67 ns per delimiter pair); 4e6 admits
// four and flattens four.
test("the `_` + $&/!{ filler worst shape (8 x ~1,000 delimiters) is < 2000 ms", (t) => {
  const note = tracker(t);
  const block = rep("_$&/!{\n", 7 * 1000);
  assert.equal(delims(block), 1000, `one _ per repeat unit (${delims(block)})`);
  assert.ok(delims(block) <= BOT_MD_BLOCK_DELIMS, "the block itself is under the per-block cap");
  const src = atCap(Array.from({ length: 8 }, () => block).join("\n\n"));
  assert.ok(src.length <= CAP, `fixture size ${src.length}`);
  const { html, ms } = timed(src);
  note(ms, "`_` + $&/!{ filler, 8 blocks x 1,000 delimiters");
  assert.ok(html.length > 0, "still rendered");
  // Measured 256 ms on the dev box: the 4e6 delimiter budget inline-lexes four
  // blocks and flattens four (the OLD 8e6 budget lexed all eight for 539 ms, and
  // an unguarded 64 KB of this shape is ~21 s), so 2,000 ms gives a slow runner
  // room without coming anywhere near the cliff.
  assert.ok(ms < 2000, `filler shape (${src.length} chars) took ${ms.toFixed(0)} ms`);
});

// --- random search smoke: 50 seeded 64 KB strings over the delimiter alphabet.
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random-search smoke: 50 seeded 64 KB delimiter soups, each < 1000 ms", (t) => {
  const note = tracker(t);
  const ALPHABET = "*_[]()~`<>!\\ a\n";
  const rnd = mulberry32(0x5eed1e);
  for (let n = 0; n < 50; n++) {
    let s = "";
    for (let i = 0; i < CAP; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    const { ms } = timed(s);
    note(ms, `random soup #${n}`);
    assert.ok(ms < 1000, `random soup #${n} took ${ms.toFixed(0)} ms`);
  }
});

// --- normal content is untouched -------------------------------------------
// A ~19 KB bot reply: headings, lists, fenced code, a table, blockquotes,
// links, and a few dozen emphasis spans.
function bigReply() {
  const out = ["# Weekly status for the Rook project\n"];
  out.push("Here is what the flock got done. The *big* win was the **migration** " +
    "and the `check-ports` gate, which now runs on every commit.\n");
  for (let i = 0; i < 20; i++) {
    out.push(`## Section ${i + 1}: notes on *item ${i + 1}*\n`);
    out.push(
      `The **first** pass over *phase ${i + 1}* landed, and _the second_ is queued. ` +
      "We measured `p95` latency and it stayed flat, which *matters* because the " +
      "previous run **stalled** on the event loop. See [the notes](/blog/notes) and " +
      "[the board](/dashboard/board) for details.\n"
    );
    out.push("- a bullet with *emphasis* and a `code span`\n" +
      "- another bullet with **strong text** and a [link](https://example.com/x)\n" +
      "- a third bullet that mentions _underscores in prose_ and the -- dashes\n");
    out.push("```js\n" +
      "const x = { a: 1, b: [2, 3] };\n" +
      "if (x.a > 0) console.log(\"yay\", x.b.length);\n" +
      "```\n");
    out.push("| metric | before | after |\n| --- | --- | --- |\n" +
      "| latency | 21 s | 120 ms |\n| memory | 210 MB | 180 MB |\n");
    out.push("> a quoted aside with *emphasis* and a `span`\n");
    out.push(
      "Closing paragraph for the section: the **point** of the change is that " +
      "one slow reply can no longer *stall* every other user of the gateway, " +
      "and the guarded path only ever engages on *adversarial* input.\n"
    );
  }
  return out.join("\n");
}

// A ~28 KB story that IS delimiter-dense but legitimate: forty ordinary
// paragraphs, each with a normal amount of emphasis/links/math. Its TOTAL
// crosses the guard's enter threshold (so this render really goes through
// guardAndParse) while every single inline block stays far under every budget
// (so nothing is flattened) — which is what makes the pinned digest below a
// proof that the guarded path is faithful to marked.
function denseLegit() {
  const out = [];
  for (let i = 0; i < BLOCKS; i++) {
    out.push(
      `Paragraph ${i}: the *quick* brown fox **jumped** over the _lazy_ dog, ` +
      "and then it [ran away](/blog/x) while reading `code` and wearing a " +
      "**fancy** *hat* with $\\alpha_{" + i + "}$ inside it. " +
      "Filler text keeps the paragraph realistic and long enough to matter, " +
      "with a few more *italics* and a **bold** phrase and a [second link](/blog/y) " +
      "plus *more* and **more** and _more_ and `span` and [third](/blog/z) here. " +
      "Another sentence with *still* **more** _delimiters_ and a [fourth](/blog/w) " +
      "link, so the delimiter total is comfortably past any sane whole-document " +
      "gate while each paragraph stays a normal-looking bot paragraph. " +
      "The last sentence adds _text_ and *text* and **text** without any links.\n"
    );
    if (i % 10 === 0) out.push("$$\nx_{" + i + "}^2 + y\n$$\n");
  }
  out.push("| a | b |\n| - | - |\n| *e* | `c` |\n");
  return out.join("\n");
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Digests captured from the renderer BEFORE the guard existed. If one of these
// changes, something about bot rendering changed on purpose — find out what
// before you update the pin.
const BIG_REPLY_SHA = "6fc559c14c5897a74efe1d9f681570875027ae1fad849020c7fb404a5522731e";
const DENSE_LEGIT_SHA = "a1498ae94f6a627cf8c080b2b9e3da4b8e3f617750f056461280ce0bd0869e59";

test("a normal ~19 KB bot reply renders byte-identical to before the guard", (t) => {
  const note = tracker(t);
  const src = bigReply();
  assert.ok(src.length > 18000 && src.length < BOT_MD_MAX_INPUT, `reply size ${src.length}`);
  const { html, ms } = timed(src);
  note(ms, "normal ~19 KB reply");
  assert.equal(sha256(html), BIG_REPLY_SHA,
    "the guarded path must not change ordinary rendering: " + html.slice(0, 400));
  // Every render takes the guarded path now, so this pin (captured before the
  // guard existed) is the proof that the pre-pass leaves ordinary content
  // exactly as plain marked.parse did.
  assert.match(html, /<h1>Weekly status for the Rook project<\/h1>/);
  assert.match(html, /<table>/, "the table survives");
  assert.match(html, /data-turbo-prefetch="false"/, "bot links still carry the Turbo opt-outs");
});

// --- CRLF: marked's Lexer#lex normalises line endings before block lexing.
// The guard drives blockTokens itself, so it must normalise the same way —
// without it a CRLF reply (a tool result pasted from Windows) kept a `\r` on
// every line and flattened into one escaped paragraph.
function cutAtParagraph(src, n) {
  const at = src.lastIndexOf("\n\n", n);
  return src.slice(0, at === -1 ? n : at);
}

test("a ~13 KB CRLF reply renders byte-identical to its LF version", () => {
  const lf = cutAtParagraph(bigReply(), 13000);
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.ok(crlf.length > 12000 && crlf.length < 14000, `CRLF reply size ${crlf.length}`);
  const lfHtml = renderBotMarkdown(lf);
  const crlfHtml = renderBotMarkdown(crlf);
  assert.equal(crlfHtml, lfHtml, "the CRLF reply must render exactly like the LF one");
  // …and neither was flattened into one escaped paragraph: the structure is
  // still there (a flattened block would show `*item 1*` as text).
  assert.match(crlfHtml, /<h1>Weekly status for the Rook project<\/h1>/);
  assert.match(crlfHtml, /<h2>Section 1: notes on <em>item 1<\/em><\/h2>/);
  assert.match(crlfHtml, /<table>/, "the table survives");
  assert.ok(!crlfHtml.includes("*item"), "no emphasis source left as text: " + crlfHtml.slice(0, 400));
});

test("a delimiter-dense but legitimate document (guarded path) is byte-identical too", (t) => {
  const note = tracker(t);
  const src = denseLegit();
  const blocks = src.split("\n\n");
  const perBlock = blocks.map(delims);
  assert.ok(Math.max(...perBlock) < BOT_MD_BLOCK_DELIMS, "no single block may be over budget");
  assert.ok(perBlock.reduce((a, d) => a + d * d, 0) < BOT_MD_SQ_BUDGET, "and the document may not be either");
  const { html, ms } = timed(src);
  note(ms, "dense but legitimate");
  assert.equal(sha256(html), DENSE_LEGIT_SHA,
    "guardAndParse must reproduce marked byte for byte: " + html.slice(0, 400));
  assert.match(html, /<em>quick<\/em>/, "emphasis survives, nothing was flattened");
  assert.match(html, /<pre class="math"><code>x_\{0\}\^2 \+ y<\/code><\/pre>/, "math extension still wired");
  assert.match(html, /<code>\\alpha_\{0\}<\/code>/, "inline math still resolves");
});

test("a flattened block's text is escaped, and its neighbours keep their formatting", () => {
  const hostile = rep("*a_<img src=x onerror=alert(1)>[l](javascript:alert(1))", CAP / 4);
  const src = "normal *paragraph* one\n\n" + hostile + "\n\nnormal **paragraph** two";
  const { html } = timed(src);
  assert.match(html, /^<p>normal <em>paragraph<\/em> one<\/p>/);
  assert.match(html, /<p>normal <strong>paragraph<\/strong> two<\/p>\n?$/);
  assert.ok(!/<img/i.test(html), "the flattened block contributed no <img>");
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<[^>]*\son\w+=/i.test(html), "no event handler inside any tag: " + html.slice(0, 300));
  assert.ok(!/href="javascript:/i.test(html), "no javascript: link survives: " + html.slice(0, 300));
  // The block keeps its container (here a <p>); only its content is text, so
  // the markup and the link source are shown, escaped, and do nothing.
  assert.match(html, /<p>\*a_&lt;img src=x onerror=alert\(1\)&gt;\[l\]\(javascript:alert\(1\)\)/,
    html.slice(0, 300));
});

test("reference links still resolve on the guarded path", () => {
  // The guard calls marked's inline phase itself, so `lexer.tokens.links` (the
  // link definitions collected by the block phase) must still reach it — and
  // this is the only rendering path, so there is no unguarded one to compare
  // against (the digest pins above are that comparison).
  const body = Array.from({ length: 200 }, (_, i) =>
    `Paragraph ${i} with [a ref link][r] and *emphasis* plus **more** and [another][r].`).join("\n\n");
  const src = body + "\n\n[r]: /blog/ref-target\n";
  const { html } = timed(src);
  assert.match(html, /<a href="\/blog\/ref-target"/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.ok(!/\[r\]/.test(html.replace(/<a [^>]*>/g, "").replace(/: \/blog\/ref-target/g, "")),
    "the ref marker never leaks as text: " + html.slice(0, 200));
});

test("the cap still returns \"\" (the caller's plain-text path)", () => {
  assert.equal(renderBotMarkdown(rep("*a_", BOT_MD_MAX_INPUT + 1)), "");
});

// --- the email-autolink run cliff (the bot path shares the guard) ---------
// marked's inline text rule ends a token at EVERY position of a run of
// `[A-Za-z0-9.!#$%&'*+/=?_`{|}~-]` that `@` follows, and each of those stops
// retries the url tokenizer's email alternative (`^[A-Za-z0-9._+-]+@…`), which
// walks the rest of the run and then the domain: quadratic in the run length,
// with no protocol word involved, so the whole-document url-scan budget cannot
// see it. Measured on the owner path before the run-length guard: `a…@a…` at
// 64 KB = 1833 ms, an `@` every 4,096 `a`s at 64 KB = 415 ms. The bot path
// shares the guard, so these are its shapes at its own cap.
function aThen(unit, n) {
  const local = rep(unit, Math.floor((n - 1) * 4 / 5));
  return local + "@" + "a".repeat(n - 1 - local.length);
}
function aEveryAt(n, gap) {
  const parts = [];
  let size = 0;
  while (size < n) {
    const len = Math.min(gap, n - size);
    parts.push("a".repeat(len));
    size += len;
    if (size < n) { parts.push("@"); size += 1; }
  }
  return parts.join("");
}

test("email-autolink runs at the cap are flattened: each < 500 ms", (t) => {
  const note = tracker(t);
  const shapes = {
    "`a…@a…`": aThen("a", CAP),
    "`HTTP…@a…`": aThen("HTTP", CAP),
    "`HTTP` repeated": rep("HTTP", CAP),
    "`a` with `@` every 4096": aEveryAt(CAP, 4096),
  };
  for (const [name, src] of Object.entries(shapes)) {
    assert.equal(src.length, CAP, `${name}: fixture size`);
    const { html, ms } = timed(src);
    note(ms, name);
    assert.ok(html.length > 0, `${name}: still rendered (never "")`);
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)} ms`);
    assert.ok(!/<a[\s>]/.test(html), `${name}: nothing was autolinked`);
  }
});

// --- normal email content is untouched, and still autolinks ---------------
// Digest captured from the renderer BEFORE the run-length guard.
function emailDoc() {
  const out = ["# Contacts", ""];
  out.push("Write to alex@example.com or to sam@example.org for details.");
  out.push("");
  out.push("A bare address in a sentence: first.last+tag@sub.example.co.uk works too.");
  out.push("");
  out.push("[mail alex](mailto:alex@example.com) or <mailto:sam@example.org>.");
  out.push("");
  for (let i = 0; i < 200; i++) out.push(`- person ${i}: user${i}@example.com`);
  out.push("");
  out.push(Array.from({ length: 200 }, (_, i) => `u${i}@example.com`).join(", "));
  return out.join("\n");
}

const EMAIL_DOC_BOT_SHA = "fb08ca092f668e1055970435d0caa7d60306e668e6602575f53bb01617f84146";

test("normal email content renders byte-identical, and still autolinks (bot)", () => {
  const doc = emailDoc();
  const html = renderBotMarkdown(doc);
  assert.equal(sha256(html), EMAIL_DOC_BOT_SHA,
    "the run-length guard must not touch ordinary email content: " + html.slice(0, 400));
  assert.equal((html.match(/href="mailto:/g) || []).length, 405);
  assert.match(html, /<a href="mailto:alex@example\.com"/);
  assert.match(html, /<a href="mailto:first\.last\+tag@sub\.example\.co\.uk"/);
  assert.match(html, /<a href="mailto:u199@example\.com"/);
  assert.match(html, /data-turbo="false"/, "bot links still carry their opt-outs");
});

// --- reference-definition flood: marked's inlineTokens rebuilds
// `Object.keys(this.tokens.links)` and scans it on EVERY inline block, so
// thousands of definitions make every paragraph O(definitions). This fixture
// (5,000 tiny `*a*` paragraphs + as many `[N]:x` definitions as fit under the
// cap, ~39 KB of them) measured 2.2 s before the definitions were capped.
function refFlood() {
  const paras = Array.from({ length: 5000 }, () => "*a*").join("\n\n");
  const budget = CAP - paras.length - 2;
  const defs = [];
  let size = 0;
  for (let i = 0; ; i++) {
    const line = `[r${i}]:x\n`;
    if (size + line.length > budget) break;
    defs.push(line);
    size += line.length;
  }
  return { src: defs.join("") + "\n" + paras, defs: size };
}

test("a reference-definition flood renders in < 1000 ms of CPU", (t) => {
  const note = tracker(t);
  const { src, defs } = refFlood();
  assert.ok(src.length <= CAP, `fixture size ${src.length}`);
  assert.ok(defs > 36000 && defs < 42000, `definitions size ${defs} B`);
  const { html, ms } = timed(src);
  note(ms, `definitions flood (${defs} B of definitions, 5,000 paragraphs)`);
  assert.ok(html.length > 0, "still rendered");
  assert.ok(ms < 1000, `definitions flood (${src.length} chars) took ${ms.toFixed(0)} ms`);
  assert.match(html, /<em>a<\/em>/, "the tiny paragraphs are still formatted, not flattened");
});

test("300 definitions still resolve links to the first 256", () => {
  const n = 300;
  assert.ok(n > BOT_MD_MAX_LINK_DEFS, `fixture must exceed the cap (${n} vs ${BOT_MD_MAX_LINK_DEFS})`);
  const body = Array.from({ length: n }, (_, i) => `a paragraph with [link ${i}][d${i}] in it.`).join("\n\n");
  const defs = Array.from({ length: n }, (_, i) => `[d${i}]: /blog/d${i}`).join("\n");
  const src = body + "\n\n" + defs;
  assert.ok(src.length < BOT_MD_MAX_INPUT, `fixture size ${src.length}`);
  const html = renderBotMarkdown(src);
  const text = html.replace(/<[^>]+>/g, "");
  // Kept: the first 256 definitions, in insertion order.
  for (const i of [0, 1, 200, BOT_MD_MAX_LINK_DEFS - 1]) {
    assert.ok(html.includes(`href="/blog/d${i}"`), `definition d${i} must still resolve`);
  }
  // Dropped: everything past the cap renders as its own text, inert.
  for (const i of [BOT_MD_MAX_LINK_DEFS, n - 1]) {
    assert.ok(!html.includes(`href="/blog/d${i}"`), `definition d${i} was dropped, so it cannot resolve`);
    assert.ok(text.includes(`[link ${i}][d${i}]`), `d${i} must render as text: ` + text.slice(-300));
  }
  assert.ok(!/[<>]/.test(text), "no markup leaked into the flattened link text");
});