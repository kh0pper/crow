// The OWNER's markdown renderer: the INLINE-LEXER CLIFFS.
//
// `renderMarkdown` draws the public blog (servers/gateway/routes/blog-public.js)
// and the public knowledge base (bundles/knowledge-base/routes/kb-public.js).
// Both are PUBLIC and UNCACHED, so an anonymous reader can hand this function
// any document up to OWNER_MD_MAX_INPUT (128 KB — the size of ONE CHUNK since
// the long-document split; it was 1 MiB when the measurements below were taken)
// per chunk, and every chunk is parsed through this path — and until this guard
// the owner path had ONLY the block-nesting guard:
// marked's own inline-lexer cliffs were one `curl` away. Measured on the owner
// path before this change: 64 KB of `_a` = 1.8 s, `[a](` = 718 ms, `*a` =
// 530 ms, a ~39 KB reference-definition flood = 1.7-2.3 s — and at the then
// 1 MiB cap: 1 MiB of `HTTP` = 330 s, a definition flood at the cap > 10
// minutes (it never finished).
//
// The fix is the bot path's guard, GENERALISED: guardAndParse now takes the
// Marked instance to drive, so the owner path gets the same linear pre-pass
// (per-inline-block delimiter budget, a whole-document Σd² + url-scan budget,
// link definitions capped at 256, CRLF normalisation, the block-nesting depth
// guard, try/catch) while keeping ownerMarked's own defaults — no math
// extension, the owner image renderer and the owner link opt-out.
//
// What must stay true:
//   - the shapes in the report, at 64 KB and at the owner cap, render in well
//     under a second of CPU each (they used to be seconds to minutes; measured
//     1-6 ms and 33 ms for a normal owner-cap post, and the definition flood at
//     the owner cap — the slowest of the family — 209-243 ms against a 2,000 ms
//     bound sized for a CI runner ~3.5x slower than the dev box);
//   - the email-autolink run shapes (`a…@a…`, `HTTP…@a…`, a long `HTTP` run, an
//     `@` every 4,096 `a`s) do too — < 500 ms at both sizes — while ordinary
//     email content still autolinks and renders byte-identically; and so do runs
//     JUST UNDER the per-run caps (`@` every 256, `@` every 128), whose cost is
//     now charged to the document budget instead of accumulating (they were ~790
//     and ~585 ms at the then-1-MiB owner cap before that);
//   - so do `@`-separated chains, where a run is one `@`'s domain AND the next
//     `@`'s local part (`("x@" + 255 `a`s)…@`, `("a" x200 + "@")…`): the scan
//     resumes just after the `@` and pays run × domain, so every run of the
//     chain is billed instead of every other one;
//   - the owner cap (128 KB) is fully guarded, and the budgets are per
//     document, so a document at the cap is as bounded as a 64 KB one;
//   - ordinary owner content renders EXACTLY as it did before the guard: the
//     four documents below were rendered through the PRE-CHANGE renderer and
//     their sha256 pinned here, and so was a post at the owner cap;
//   - the owner path is still the OWNER's parser (no math), with the owner's
//     image rule and its link opt-out (tests/owner-markdown-images.test.js owns
//     the full matrix and must pass unchanged);
//   - a document that is over budget, or a chunk whose parse fails, comes back
//     as its escaped TEXT — never as "" — and nothing is dropped; a document
//     over the chunk size is rendered in full, chunk by chunk (see
//     tests/md-chunked-render.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  renderMarkdown, renderBotMarkdown,
  OWNER_MD_MAX_INPUT, BOT_MD_SQ_BUDGET, BOT_MD_MAX_LINK_DEFS,
  MD_EMAIL_RUN_MAX, MD_EMAIL_RUN_HARD_MAX,
} from "../servers/blog/renderer.js";

const CAP64 = 64 * 1024 - 1;
const CAP_OWNER = OWNER_MD_MAX_INPUT - 1;
const rep = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);

// CPU time of THIS process, not wall-clock: rendering is synchronous and
// single-threaded, so the cost still shows in full while the parallel suite's
// load on other cores does not (the measure the other renderer tests use).
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

/** Collects the worst render of one test, reported as its diagnostic (the bound
 *  is the assertion; the number is the evidence). */
function tracker(t) {
  const worst = { ms: 0, what: "nothing yet" };
  return (ms, what) => {
    if (ms > worst.ms) { worst.ms = ms; worst.what = what; }
    t.diagnostic(`worst render so far: ${worst.ms.toFixed(0)} ms — ${worst.what}`);
  };
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Render on the owner path; returns the HTML and the CPU ms it took. */
function timed(src) {
  const t0 = cpuMs();
  const html = renderMarkdown(src);
  return { html, ms: cpuMs() - t0 };
}

// --- the shapes from the report, at the bot cap and at the owner cap -------
// Each is one paragraph of the adversarial unit: the worst case for marked's
// inline lexer, and the shape an attacker can put on a public page.
const UNITS = {
  "_a": () => rep("_a", CAP64),
  "[a](": () => rep("[a](", CAP64),
  "*a": () => rep("*a", CAP64),
  "*a_": () => rep("*a_", CAP64),
  "**a_": () => rep("**a_", CAP64),
};

test("64 KB of every reported unit renders in < 1000 ms (they were 0.5-1.8 s)", (t) => {
  const note = tracker(t);
  // Measured 23-24 ms (worst of three runs) against the 1,000 ms bound: ~40x,
  // and 0.5-1.8 s before the guard.
  for (const [unit, make] of Object.entries(UNITS)) {
    const src = make();
    assert.equal(src.length, CAP64, `${unit}: fixture size`);
    const { html, ms } = timed(src);
    note(ms, `64 KB of ${JSON.stringify(unit)}`);
    assert.ok(html.length > 0, `${unit}: still rendered`);
    assert.ok(ms < 1000, `64 KB of ${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
    // Over budget, the block keeps its container and shows its SOURCE as text:
    // nothing is dropped, and nothing in it is markup.
    assert.ok(html.startsWith("<p>"), `${unit}: the block is still a paragraph`);
    if (unit === "_a") assert.ok(html.includes("_a_a"), `${unit}: the text is still on screen`);
    if (unit === "[a](") assert.ok(html.includes("[a]("), `${unit}: the text is still on screen`);
  }
});

test("every reported unit at the owner cap renders in < 1000 ms (they were seconds to minutes)", (t) => {
  const note = tracker(t);
  // The owner cap is 2x the bot path's, and the budgets are per DOCUMENT — so
  // the worst a document can spend in marked's inline lexer does not grow with
  // the input, and a render at the owner cap is bounded like a 64 KB one.
  // Measured with the guard at the current owner cap: 7-10 ms per unit (33 ms
  // for a normal post), against the 1,000 ms bound.
  for (const [unit, make] of Object.entries(UNITS)) {
    const src = rep(make(), CAP_OWNER);
    assert.equal(src.length, CAP_OWNER, `${unit}: fixture size`);
    const { html, ms } = timed(src);
    note(ms, `owner cap of ${JSON.stringify(unit)}`);
    assert.ok(html.length > 0, `${unit}: still rendered`);
    assert.ok(ms < 1000, `owner cap of ${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
    assert.ok(!/<em>|<strong>|<a[\s>]/.test(html), `${unit}: no emphasis or link survived the flatten`);
  }
});

// --- reference-definition flood ------------------------------------------
// marked's inlineTokens rebuilds `Object.keys(this.tokens.links)` and scans it on
// EVERY inline block, so thousands of definitions make every paragraph
// O(definitions). The owner path had NO cap: the 1 MiB version of this fixture
// never finished (> 10 minutes, measured).
function refFlood(cap, paragraphs) {
  const paras = Array.from({ length: paragraphs }, () => "*a*").join("\n\n");
  const budget = cap - paras.length - 2;
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

test("the reference-definition flood is capped at 256 definitions and renders in < 2000 ms at the owner cap", (t) => {
  const note = tracker(t);
  // The report's fixture: ~39 KB of definitions + 5,000 tiny paragraphs.
  const small = refFlood(CAP64, 5000);
  assert.ok(small.src.length <= CAP64, `fixture size ${small.src.length}`);
  assert.ok(small.defs > 36000 && small.defs < 42000, `definitions size ${small.defs} B`);
  const smallRun = timed(small.src);
  note(smallRun.ms, "64 KB definition flood");
  assert.ok(smallRun.html.length > 0, "still rendered");
  assert.ok(smallRun.ms < 1000, `64 KB definition flood took ${smallRun.ms.toFixed(0)} ms`);
  assert.match(smallRun.html, /<em>a<\/em>/, "the tiny paragraphs are still formatted");

  // …and at the owner cap, which used to be the unbounded case. The paragraphs
  // are sized to the cap (10,000 of them, ~50 KB, leaving ~80 KB of
  // definitions) so the whole fixture is still parsed, not split.
  const big = refFlood(CAP_OWNER, 10000);
  assert.ok(big.src.length <= OWNER_MD_MAX_INPUT, `fixture size ${big.src.length}`);
  const bigRun = timed(big.src);
  note(bigRun.ms, `owner-cap definition flood (${(big.defs / 1024).toFixed(0)} KB of definitions)`);
  assert.ok(bigRun.html.length > 0, "still rendered");
  // Measured 209-243 ms on the dev box (worst of three runs) against the
  // 2,000 ms bound; the fixture took > 10 minutes before the definition cap.
  assert.ok(bigRun.ms < 2000, `owner-cap definition flood took ${bigRun.ms.toFixed(0)} ms`);
  assert.match(bigRun.html, /<em>a<\/em>/);
});

test("definitions past the cap resolve as text, and the first 256 still resolve (owner path)", () => {
  const n = 300;
  assert.ok(n > BOT_MD_MAX_LINK_DEFS);
  const body = Array.from({ length: n }, (_, i) => `a paragraph with [link ${i}][d${i}] in it.`).join("\n\n");
  const defs = Array.from({ length: n }, (_, i) => `[d${i}]: /blog/d${i}`).join("\n");
  const html = renderMarkdown(body + "\n\n" + defs);
  for (const i of [0, 1, 200, BOT_MD_MAX_LINK_DEFS - 1]) {
    assert.ok(html.includes(`href="/blog/d${i}"`), `definition d${i} must resolve`);
  }
  for (const i of [BOT_MD_MAX_LINK_DEFS, n - 1]) {
    assert.ok(!html.includes(`href="/blog/d${i}"`), `definition d${i} was dropped`);
    assert.ok(html.includes(`[link ${i}][d${i}]`), `d${i} renders as its own text`);
  }
});

// --- the `HTTP` run: marked's url EMAIL alternative ------------------------
// A second quadratic in the same lexer, on ordinary-looking text: marked's text
// rule stops at `http` / `https` / `ftp` / `www.`, and at each stop the url
// tokenizer's email alternative scans the rest of the word run looking for an
// `@`. 1 MiB of `HTTP` measured 330 s on the owner path before the guard.
test("a run of `HTTP` at the owner cap renders in < 1000 ms (it was 330 s at 1 MiB)", (t) => {
  const note = tracker(t);
  // Measured 12-14 ms at the owner cap and 6-7 ms at the bot cap (worst of three
  // runs) against the 1,000 ms bound: 1 MiB of `HTTP` was 330 s before the guard.
  for (const unit of ["HTTP", "http", "Http"]) {
    const { html, ms } = timed(rep(unit, CAP_OWNER));
    note(ms, `owner cap of ${JSON.stringify(unit)}`);
    assert.ok(html.length > 0, `${unit}: still rendered`);
    assert.ok(html.includes(unit.repeat(4)), `${unit}: the text is still shown`);
    assert.ok(ms < 1000, `owner cap of ${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
  }
  // The bot path shares the guard, so the 543 ms the old comment recorded at
  // its own cap is gone too.
  const bot = timed(renderBotMarkdown(rep("HTTP", CAP64)) ? rep("HTTP", CAP64) : "");
  note(bot.ms, "64 KB of HTTP on the bot path");
  assert.ok(bot.ms < 1000, `64 KB of HTTP on the bot path took ${bot.ms.toFixed(0)} ms`);
});

// --- the email-autolink run cliff ----------------------------------------
// The same url email alternative, reached WITHOUT a protocol word: marked's
// inline text rule also ends a token at EVERY position of a run of
// `[A-Za-z0-9.!#$%&'*+/=?_`{|}~-]` that `@` follows, and each of those stops
// retries `^[A-Za-z0-9._+-]+@…`, walking the rest of the run and then the
// domain — Σ(run length) per run, i.e. quadratic in the run length. urlScanCost
// cannot see it (it charges protocol-word stops only), so this was a cliff the
// whole-document budget did not cover: measured on the owner path BEFORE the
// run-length guard, `a…@a…` at 64 KB = 1833 ms and `a` runs with an `@` every
// 4,096 characters at 64 KB = 415 ms (~256x that at the 1 MiB cap). The four
// shapes below are that attack in the guises an attacker would actually write.
function aThen(unit, n) {
  // The unit as a run, an `@`, then `a` filler: exact length, one paragraph.
  const local = rep(unit, Math.floor((n - 1) * 4 / 5));
  return local + "@" + "a".repeat(n - 1 - local.length);
}
function aEveryAt(n, gap) {
  // `a` runs separated by a single `@` every `gap` characters.
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
function emailCliffShapes(n) {
  return {
    "`a…@a…`": aThen("a", n),
    "`HTTP…@a…`": aThen("HTTP", n),
    "`HTTP` repeated": rep("HTTP", n),
    "`a` with `@` every 4096": aEveryAt(n, 4096),
  };
}

test("email-autolink runs are flattened: 64 KB and the owner cap render in < 500 ms", (t) => {
  const note = tracker(t);
  for (const [size, label] of [[CAP64, "64 KB"], [CAP_OWNER, "owner cap"]]) {
    for (const [name, src] of Object.entries(emailCliffShapes(size))) {
      assert.equal(src.length, size, `${name}: fixture size`);
      const { html, ms } = timed(src);
      note(ms, `${name} at ${label}`);
      assert.ok(html.length > 0, `${name}: still rendered (never "")`);
      assert.ok(ms < 500, `${name} at ${label} took ${ms.toFixed(0)} ms`);
      // Flattened, not autolinked: the run is on screen as text, inert.
      // (Measured 1-6 ms — worst of three runs — against 500 ms, and 1,833 ms for
      // this shape before the run-length guard.)
      assert.ok(!/<a[\s>]/.test(html), `${name}: nothing was autolinked`);
      assert.ok(html.replace(/<[^>]+>/g, "").length > size * 0.5,
        `${name}: the text is still shown`);
    }
  }
});

test("the email run limits sit above real addresses and below the attack", () => {
  // Just under the local-part and domain limits: still an autolink (nothing is
  // flattened). At/over them: flattened to text. Pins MD_EMAIL_RUN_MAX's
  // semantics on both sides, so a future tweak cannot quietly lower it onto
  // real mail.
  const under = renderMarkdown(
    "x " + "a".repeat(MD_EMAIL_RUN_MAX - 1) + "@" + "b".repeat(MD_EMAIL_RUN_MAX - 8) + ".com y");
  assert.equal((under.match(/<a /g) || []).length, 1, under.slice(0, 200));

  const longLocal = renderMarkdown(
    "x " + "a".repeat(MD_EMAIL_RUN_MAX + 1) + "@example.com y");
  assert.equal((longLocal.match(/<a /g) || []).length, 0, "over-long local part is flattened");

  const longDomain = renderMarkdown(
    "x alex@" + "b".repeat(MD_EMAIL_RUN_MAX - 3) + ".com y");
  assert.equal((longDomain.match(/<a /g) || []).length, 0, "over-long domain run is flattened");

  // A long run with no `@` at all: the `HTTP` family, caught by length alone.
  // Proven by a neighbour: over the cap the whole block is flattened, so the
  // emphasis beside the run shows as its source instead of an <em>.
  const longRun = renderMarkdown("x *hi* " + "a".repeat(MD_EMAIL_RUN_HARD_MAX + 1));
  assert.ok(!longRun.includes("<em>"), "over the hard cap the block is flattened");
  assert.ok(longRun.includes("*hi*"), "…and its text is still on screen");
  const shortRun = renderMarkdown("x *hi* " + "a".repeat(MD_EMAIL_RUN_HARD_MAX - 1));
  assert.match(shortRun, /<em>hi<\/em>/, "under the hard cap nothing is flattened");
});

// Runs JUST UNDER the per-run caps — the hole a length cap alone leaves open.
// A run of 255 (or 127) characters before an `@` is under MD_EMAIL_RUN_MAX, so
// it was ADMITTED, and marked then pays its ~run²/2 scan at EVERY `@` in the
// block; nothing charged that to the document budget, so an `@` every 256 (or
// every 128) characters was quadratic for a whole document while no single run
// ever tripped a cap. emailRunScan now bills Σ(run²) + run × domain per `@`
// to the same pool, so these flatten like any other dense block — at the bot
// cap and at the owner cap — instead of adding up.
function atEvery(n, runLen) {
  const unit = "a".repeat(runLen) + "@";
  return { unit, src: rep(unit, n) };
}

test("email runs just UNDER the per-run cap add up and flatten: < 500 ms at both caps", (t) => {
  const note = tracker(t);
  // 255 = MD_EMAIL_RUN_MAX - 1, 127 = MD_EMAIL_RUN_MAX / 2 - 1: both admitted
  // by the caps, both quadratic in marked without the cost being charged.
  for (const runLen of [MD_EMAIL_RUN_MAX - 1, MD_EMAIL_RUN_MAX / 2 - 1]) {
    const { unit, src } = atEvery(CAP64, runLen);
    assert.equal(unit.length, runLen + 1, "fixture unit size");
    assert.equal(src.length, CAP64, `fixture size at 64 KB (${unit.length}-char unit)`);
    // The bot path, at its own cap (guardAndParse is shared, so this is the
    // same pre-pass the owner path runs).
    const botT0 = cpuMs();
    const bot = renderBotMarkdown(src);
    const botMs = cpuMs() - botT0;
    note(botMs, `\`a\` x${runLen} + \`@\` at 64 KB (bot path)`);
    assert.ok(bot.length > 0, `${runLen}: still rendered (never "")`);
    assert.ok(botMs < 500, `${runLen}: 64 KB on the bot path took ${botMs.toFixed(0)} ms`);
    assert.ok(!/<a[\s>]/.test(bot), `${runLen}: nothing was autolinked`);
    assert.ok(bot.replace(/<[^>]+>/g, "").length > CAP64 * 0.5,
      `${runLen}: the text is still shown on the bot path`);

    // …and the owner path at its cap, where the cost used to arrive 16x larger
    // (at the then-1-MiB cap) while the per-run caps still admitted every run.
    const owner = atEvery(CAP_OWNER, runLen);
    assert.equal(owner.src.length, CAP_OWNER, `fixture size at the owner cap (${owner.unit.length}-char unit)`);
    const { html, ms } = timed(owner.src);
    note(ms, `\`a\` x${runLen} + \`@\` at the owner cap (owner path)`);
    assert.ok(html.length > 0, `${runLen}: still rendered (never "")`);
    assert.ok(ms < 500, `${runLen}: the owner cap on the owner path took ${ms.toFixed(0)} ms`);
    assert.ok(!/<a[\s>]/.test(html), `${runLen}: nothing was autolinked`);
    assert.ok(html.replace(/<[^>]+>/g, "").length > CAP_OWNER * 0.5,
      `${runLen}: the text is still shown on the owner path`);
  }
});

// `@`-separated chains, where a run is one `@`'s DOMAIN and the NEXT `@`'s
// LOCAL PART. The scan used to jump past the domain run (`i = d`), so that run
// — back to back with the following `@` — was never billed run², and the domain
// was billed once per `@` instead of once per stop in the local run that walks
// it. Every other run of a chain therefore escaped, and the per-`@` domain cost
// undercounted by its local run's length. Both shapes below stay under the
// per-run caps (a 256-character run is not over MD_EMAIL_RUN_MAX) while paying
// a `@` every 201 or 257 characters, so they are the chain the report names.
// emailRunScan now resumes just after the `@` (so the domain run is scanned
// again as a candidate local part) and bills run × domain, so these flatten
// like any other dense block at both caps.
function chained(n, unit) {
  // `unit` repeated, then ONE closing `@`: exact length, one paragraph.
  return rep(unit, n - 1) + "@";
}
const CHAIN_UNITS = {
  "`x@` + `a` x255": "x@" + "a".repeat(MD_EMAIL_RUN_MAX - 1),
  "`a` x200 + `@`": "a".repeat(200) + "@",
};

test("`@`-separated chains are flattened: 64 KB bot and the owner cap in < 500 ms", (t) => {
  const note = tracker(t);
  for (const [name, unit] of Object.entries(CHAIN_UNITS)) {
    for (const [size, label, render] of [
      [CAP64, "64 KB (bot path)", renderBotMarkdown],
      [CAP_OWNER, "owner cap (owner path)", renderMarkdown],
    ]) {
      const src = chained(size, unit);
      assert.equal(src.length, size, `${name}: fixture size`);
      const t0 = cpuMs();
      const html = render(src);
      const ms = cpuMs() - t0;
      note(ms, `${name} at ${label}`);
      assert.ok(html.length > 0, `${name} at ${label}: still rendered (never "")`);
      assert.ok(ms < 500, `${name} at ${label} took ${ms.toFixed(0)} ms`);
      // Flattened, not autolinked: the chain is on screen as text, inert.
      // (Measured 2-4 ms — worst of three runs — against 500 ms; before the
      // billing fix every other run of a chain escaped the budget and the shape
      // was quadratic.)
      assert.ok(!/<a[\s>]/.test(html), `${name} at ${label}: nothing was autolinked`);
      assert.ok(html.replace(/<[^>]+>/g, "").length > size * 0.5,
        `${name} at ${label}: the text is still shown`);
    }
  }

  // The billing itself, deterministically (no timing). 190 units of `a` x200 +
  // `@` are 38 KB. Billed as every OTHER run — the domain run skipped past, the
  // domain paid once — that is 95 x (200² + 200) ~ 3.8e6, just UNDER the 4e6
  // budget, so the block was lexed (its `*hi*` neighbour still became an <em>).
  // Billed as every run, plus run x domain per `@`, it is 190 x (200² + 200x200)
  // ~ 1.5e7, over the budget, so the block flattens and the neighbour shows as
  // its source. No run here reaches either per-run cap, so only the billing can
  // decide it.
  const unit = CHAIN_UNITS["`a` x200 + `@`"];
  const src = "*hi* " + unit.repeat(190);
  const html = renderMarkdown(src);
  assert.ok(!html.includes("<em>"), "every run of the chain is billed: the block flattens");
  assert.ok(html.includes("*hi*"), "…and its text is still on screen");
  assert.ok(!/<a[\s>]/.test(html), "…and nothing in it is a link");
});

// --- normal email content is untouched -----------------------------------
// Captured from the renderer BEFORE the run-length guard. An ordinary contacts
// page: bare addresses, a tagged local part on a multi-label domain, a markdown
// mailto link, a `<mailto:…>` autolink, 200 addresses as list items and the same
// 200 comma-separated inside ONE paragraph. No run here is anywhere near either
// limit, so it must render byte-identically — and still autolink.
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

const EMAIL_DOC_SHA = "43087e2761957d24be32886c81556fd04c0e1fe02f57d4640a6c4643279cb251";
const EMAIL_DOC_BOT_SHA = "fb08ca092f668e1055970435d0caa7d60306e668e6602575f53bb01617f84146";

test("normal email content renders byte-identical, and still autolinks", (t) => {
  const doc = emailDoc();
  assert.ok(doc.length > 10000 && doc.length < 11000, `fixture size ${doc.length}`);
  const { html, ms } = timed(doc);
  t.diagnostic(`contacts document: ${ms.toFixed(1)} ms`);
  assert.equal(sha256(html), EMAIL_DOC_SHA,
    "the run-length guard must not touch ordinary email content: " + html.slice(0, 400));
  // …because nothing was flattened: every address is still an autolink. 405 =
  // 5 in the prose and the two mailto forms + 200 list items + 200 inline.
  assert.equal((html.match(/href="mailto:/g) || []).length, 405, html.slice(0, 400));
  assert.match(html, /<a href="mailto:alex@example\.com"/);
  assert.match(html, /<a href="mailto:first\.last\+tag@sub\.example\.co\.uk"/);
  assert.match(html, /<a href="mailto:user199@example\.com"/);
  assert.match(html, /<a href="mailto:u199@example\.com"/);

  // The bot path shares the guard, so pin its render too (same document, its
  // own parser and image/link opt-outs).
  const bot = renderBotMarkdown(doc);
  assert.equal(sha256(bot), EMAIL_DOC_BOT_SHA,
    "the run-length guard must not touch ordinary email content (bot): " + bot.slice(0, 400));
  assert.equal((bot.match(/href="mailto:/g) || []).length, 405);
  assert.match(bot, /<a href="mailto:alex@example\.com"/);
});

// --- the block-nesting cliff is still guarded on this path ----------------
test("container markers at the owner cap render in < 1000 ms, no throw (the nesting guard)", (t) => {
  const note = tracker(t);
  // Measured 49-60 ms (worst of three runs) against the 1,000 ms bound; the
  // unguarded 64 KB parse of `1) ` was ~1.0 s, and 128 KB is worse.
  for (const unit of ["1) ", "> 1) ", "> "]) {
    const { html, ms } = timed(rep(unit, CAP_OWNER));
    note(ms, `owner cap of ${JSON.stringify(unit)}`);
    assert.ok(html.length > 0, `${unit}: still rendered`);
    assert.ok(ms < 1000, `owner cap of ${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
  }
});

// --- random search smoke: 30 seeded 256 KB delimiter soups ----------------
// Deterministic (mulberry32), so a failure is reproducible.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random-search smoke: 30 seeded 256 KB delimiter soups, each < 1000 ms", (t) => {
  const note = tracker(t);
  // Measured 154-166 ms (worst of three runs) against the 1,000 ms bound.
  const ALPHABET = "*_[]()~`<>!\\ a\n";
  const SIZE = 256 * 1024;
  const rnd = mulberry32(0x5eed1e);
  for (let n = 0; n < 30; n++) {
    let s = "";
    for (let i = 0; i < SIZE; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    const { ms } = timed(s);
    note(ms, `random soup #${n}`);
    assert.ok(ms < 1000, `random soup #${n} took ${ms.toFixed(0)} ms`);
  }
});

// --- the linear floor, for the record ------------------------------------
// Not a cliff, and not something the guard's budgets govern: a document made of
// one-word paragraphs costs marked's per-block overhead plus sanitizing the
// output, linearly. The 1 MiB version of it (~500,000 paragraphs, a 3 MB
// output) measured 890 ms on the pre-change renderer and 942 ms through the
// guard (the pre-pass is linear), so the bound here is a regression tripwire,
// not the 1 s target the cliffs are held to. Measured 122-129 ms at the owner
// cap (worst of three runs), so the 3,000 ms bound is ~23x the measurement and
// well under the 890 ms the pre-change 1 MiB version cost.
test("a document of tiny paragraphs at the owner cap stays at its linear floor", (t) => {
  const { html, ms } = timed(rep("a\n\n", CAP_OWNER));
  t.diagnostic(`tiny paragraphs at the owner cap: ${ms.toFixed(0)} ms, ${html.length} chars of output`);
  assert.ok(html.length > 0);
  assert.ok(ms < 3000, `tiny-paragraph floor took ${ms.toFixed(0)} ms (pre-change at 1 MiB: 890 ms)`);
});

// --- normal owner content is untouched -----------------------------------
// Captured from the renderer BEFORE it was routed through the guard (each
// document rendered through the old `ownerMarked.parser(boundedLexer(...).lex
// (src))` path). If one of these changes, the guard altered ordinary owner
// rendering — find out why before updating the pin.
function longPost() {
  const out = [];
  out.push("---");
  out.push('title: "What the flock shipped in Q3"');
  out.push("date: 2026-09-30");
  out.push("tags: [release, reliability]");
  out.push("---");
  out.push("");
  out.push("# What the flock shipped in Q3");
  out.push("");
  out.push("This quarter was about *quiet* wins: fewer pages, **faster** pages, and a");
  out.push("dashboard that finally tells the truth about its own latency.");
  out.push("");
  out.push("## The short version");
  out.push("");
  out.push("- The gateway's event loop stopped stalling on long markdown documents.");
  out.push("- `check-ports` now runs on every commit, so a port collision is a CI failure.");
  out.push("- Backup verification moved from nightly-after-the-fact to hourly.");
  out.push("");
  out.push("![Latency by week](/blog/media/latency-q3.png)");
  out.push("");
  out.push("> Steady state: p95 render time under 40 ms for a 20 KB post, and no");
  out.push("> single document can block the loop for more than a second.");
  out.push("");
  out.push("## Numbers");
  out.push("");
  out.push("| metric | Q2 | Q3 | change |");
  out.push("| --- | --- | --- | --- |");
  out.push("| p95 render | 210 ms | 38 ms | **-82%** |");
  out.push("| p99 render | 1.9 s | 96 ms | **-95%** |");
  out.push("| backups verified | 0 | 24 | new |");
  out.push("");
  out.push("## How we got there");
  out.push("");
  out.push("Three changes did most of the work.");
  out.push("");
  out.push("1. **Bound the parser.** Every rendered surface now runs the same guard:");
  out.push("   a depth counter inside the block lexer, a delimiter budget per inline");
  out.push("   block, and a whole-document budget on top. Ordinary prose is untouched.");
  out.push("2. **Pin the output.** Digests for a handful of real documents are checked in,");
  out.push("   so a parser upgrade that changes rendering fails in CI instead of quietly");
  out.push("   rewording a published post.");
  out.push("3. **Measure, then trust.** The tests record their worst render as a");
  out.push("   diagnostic; the bound is the assertion.");
  out.push("");
  out.push("### A figure, inline");
  out.push("");
  out.push('<figure class="crow-chart" data-section-id="12" data-metric="p95">');
  out.push('  <img src="/blog/figures/12-abcdef12.png" alt="p95 latency by week" width="800">');
  out.push("  <figcaption>p95 render latency, weekly, Q3.</figcaption>");
  out.push("</figure>");
  out.push("");
  out.push("### Code we shipped");
  out.push("");
  out.push("```js");
  out.push("export function renderMarkdown(markdown) {");
  out.push("  if (!markdown) return \"\";");
  out.push("  return sanitize(parse(String(markdown)));");
  out.push("}");
  out.push("```");
  out.push("");
  out.push("### A table with alignment");
  out.push("");
  out.push("| unit | chars | bound |");
  out.push("| :--- | :---: | ---: |");
  out.push("| `_a` | 65535 | 1000 ms |");
  out.push("| `[a](` | 65535 | 1000 ms |");
  out.push("| `*a_` | 65535 | 1000 ms |");
  out.push("");
  out.push("## What's next");
  out.push("");
  out.push("Same guard, one more surface: the file viewer. It already refuses a file");
  out.push("over the cap before reading it, which turned out to be the easy half.");
  out.push("");
  out.push("-- alex");
  out.push("");
  for (let i = 0; i < 40; i++) {
    out.push(`### Section ${i + 1}: notes`);
    out.push("");
    out.push(
      `The *first* pass over phase ${i + 1} landed and _the second_ is queued. ` +
      "We measured `p95` latency and it stayed flat, which *matters* because the " +
      "previous run **stalled** on the event loop. See [the notes](/blog/notes) and " +
      "[the board](/dashboard/board) for details, plus a paragraph's worth of filler " +
      "so the document has the shape of a real post rather than a fixture."
    );
    out.push("");
    out.push("- a bullet with *emphasis* and a `code span`");
    out.push("- another with **strong text** and a [link](https://example.com/x)");
    out.push("- a third mentioning _underscores in prose_ and -- dashes");
    out.push("");
  }
  return out.join("\n");
}

function kbArticle() {
  const out = ["# Replacing the print head on a Canon PRO-1000", ""];
  out.push("The head comes out in one piece, but the ribbon cable is short. Work on a");
  out.push("clean bench and keep the old head in its cap so it does not dry out.");
  out.push("");
  out.push('<img src="/kb/media/0123456789abcdef0123456789abcdef01234567.jpg" alt="Print head access door">');
  out.push("");
  out.push("## Tools");
  out.push("");
  out.push("1. A T10 driver");
  out.push("2. Lint-free wipes");
  out.push("3. Distilled water, 50 ml");
  out.push("");
  out.push("## Steps");
  out.push("");
  out.push("- [ ] Power down and unplug for five minutes");
  out.push("- [ ] Open the top cover and release the carriage lock");
  out.push("- [x] Photograph the cable routing **before** you unplug it");
  out.push("- [ ] Lift the head straight up — do not tilt it");
  out.push("");
  out.push('<img src="/kb/media/fedcba9876543210fedcba9876543210fedcba98.png" alt="Cable routing">');
  out.push("");
  out.push("> If the head resists, stop. The lock is still engaged and forcing it");
  out.push("> bends the carriage rail.");
  out.push("");
  out.push("| symptom | cause | fix |");
  out.push("| --- | --- | --- |");
  out.push("| banding | clogged nozzles | two cleaning cycles |");
  out.push("| missing colour | air in the line | purge 3 ml |");
  out.push("");
  out.push("Reassemble in reverse order and run a nozzle check before printing.");
  return out.join("\n");
}

function memoryDoc() {
  return [
    "# Warp drive notes — weekly",
    "",
    "Decided the *slow* path is acceptable for now: the ingest job can take",
    "45 minutes as long as it finishes before the morning sync.",
    "",
    "## Tasks",
    "",
    "- [x] Move the ingest cron to 02:15",
    "- [x] Add a `check-ports` gate",
    "- [ ] Re-measure the markdown renderer at 1 MiB",
    "- [ ] Decide whether the KB route needs its own cache header",
    "",
    "## Facts",
    "",
    "- The gateway binds `:443` through Caddy's unix socket, not loopback.",
    "- Backup verification runs hourly and fails loudly.",
    "- A 4 MB markdown document used to be an OOM; it is now text.",
    "",
    "## Open questions",
    "",
    "1. Do we need a second worker for the render path?",
    "2. Is anyone actually reading the songbook pages?",
    "",
    "Related: [the incident note](/blog/incident-2026-09-14) and",
    "[the port table](/docs/developers/port-allocation).",
  ].join("\n");
}

function caseStudy() {
  const out = ["# Case study: 40% fewer support tickets in six weeks", ""];
  out.push("A mid-sized print shop ran Crow on one box for a quarter. Here is what");
  out.push("changed after they moved the knowledge base in front of the queue.");
  out.push("");
  out.push('<article class="case-study" itemscope itemtype="https://schema.org/Article">');
  out.push("<h2 itemprop=\"headline\">Before</h2>");
  out.push("<p>Two staff answered the same twelve questions, by hand, every day.</p>");
  out.push("</article>");
  out.push("");
  out.push('<figure class="crow-chart" data-section-id="4" data-backend-id="b7" data-field="tickets">');
  out.push('  <img src="/blog/figures/4-0123abcd.png" alt="tickets per week" width="960" height="480">');
  out.push("  <figcaption>Tickets per week, twelve weeks before and after.</figcaption>");
  out.push("</figure>");
  out.push("");
  out.push("## What they measured");
  out.push("");
  out.push("| week | tickets | self-serve |");
  out.push("| --- | --- | --- |");
  out.push("| 1 | 210 | 12% |");
  out.push("| 6 | 124 | 41% |");
  out.push("");
  out.push("## The three things that mattered");
  out.push("");
  out.push("1. **Search that answers.** A KB article that cannot be found is a ticket.");
  out.push("2. **One inbox.** Support mail and the contact form landed in the same list.");
  out.push("3. **A weekly digest.** The owner read *every* Tuesday summary, which is");
  out.push("   what kept the effort funded.");
  out.push("");
  out.push("> \"The win wasn't the AI. It was writing down what we already knew.\"");
  out.push("> — the shop's operations lead");
  out.push("");
  out.push("```");
  out.push("tickets/week  before: 210  after: 124   (-41%)");
  out.push("self-serve    before:  12%  after:  41%");
  out.push("```");
  out.push("");
  out.push("![Self-serve share](/blog/media/selfserve-4.png)");
  out.push("");
  out.push("Next: a second store, and the same three things.");
  return out.join("\n");
}

const PINS = {
  "long blog post with figures and tables": [longPost, "ea3c0564527f910da8f2ebe83fe71765fcd9efaaf2380786b636a6e02d12e623"],
  "KB article with raw kb-media images": [kbArticle, "9bb6027f16adff4bfd5e1b2a9d5c1d8498bb1c9ade2e82c5349498b82fecdeac"],
  "memory with task lists": [memoryDoc, "8e110de72137721a04bd761ff6f45a56f4690554f51ff55b621050edce809c69"],
  "case-study post with a crow-chart figure": [caseStudy, "68d58442433e8807a22dcfba748a6df887c16a71cf27b5979cc2173f3829cfbd"],
};

test("ordinary owner documents render byte-identical to before the guard", (t) => {
  for (const [name, [make, digest]] of Object.entries(PINS)) {
    const { html, ms } = timed(make());
    t.diagnostic(`${name}: ${ms.toFixed(1)} ms`);
    assert.equal(sha256(html), digest,
      `${name} must not change: ${html.slice(0, 400)}`);
  }
  // …and they really went through the FORMATTING path: nothing was flattened.
  const blog = renderMarkdown(longPost());
  assert.match(blog, /<em>quiet<\/em>/, "emphasis survives");
  assert.match(blog, /<img[^>]*src="\/blog\/media\/latency-q3\.png"/, "the media image survives");
  assert.match(blog, /<figure class="crow-chart" data-section-id="12" data-metric="p95">/, "the figure survives");
  assert.match(blog, /<figcaption>p95 render latency, weekly, Q3\.<\/figcaption>/);
  assert.match(blog, /<div class="table-scroll"><table>/, "the table survives, wrapped for scroll");
  assert.match(blog, /<code class="language-js">/, "the fence survives");
  assert.match(blog, /data-turbo-prefetch="false"/, "links carry the owner's opt-out");
  assert.doesNotMatch(blog, /data-turbo="false"/, "and keep Turbo Drive");
  assert.ok(!blog.includes("\\*") && !blog.includes("\\_"), "no escaped markdown source leaked");

  const kb = renderMarkdown(kbArticle());
  assert.match(kb, /<img[^>]*src="\/kb\/media\/0123456789abcdef0123456789abcdef01234567\.jpg"/);
  assert.match(kb, /<input checked disabled type="checkbox" \/>/, "the task list keeps its boxes");
  assert.equal((kb.match(/type="checkbox"/g) || []).length, 4, "one box per task item");

  const memory = renderMarkdown(memoryDoc());
  assert.equal((memory.match(/<input/g) || []).length, 4, "one checkbox per task item");
});

test("a post at the owner cap renders byte-identical to before the guard", (t) => {
  // The same document repeated to the owner cap: that is the largest input the
  // guard has to stay faithful at, not just 64 KB. The cap is 128 KB since the
  // long-document split (it was 1 MiB when this pin was first taken), so the
  // pinned document is the post repeated to 128 KB; the digest below was
  // re-captured on the guarded renderer at that size, and the structural
  // assertions after it prove the document really went through marked's own
  // inline lexer rather than being flattened or split.
  const base = longPost();
  const parts = [];
  let size = 0;
  while (size < CAP_OWNER) { parts.push(base); size += base.length + 2; }
  const src = parts.join("\n\n").slice(0, CAP_OWNER);
  assert.equal(src.length, CAP_OWNER);
  const { html, ms } = timed(src);
  t.diagnostic(`owner-cap normal post: ${ms.toFixed(0)} ms, ${html.length} chars of HTML`);
  assert.equal(sha256(html), "26a99f32837b1870b7a5ebf05e0fea6d85598571cd543065a6b2e211f462e80b",
    "the owner-cap pinned post must not change: " + html.slice(0, 400));
  assert.ok(!html.includes("md-tail-notice"), "the whole document is parsed, not split");
  assert.match(html, /<em>quiet<\/em>/, "its markdown was really formatted");
  assert.match(html, /<div class="table-scroll"><table>/, "the table is still wrapped for scroll");
  assert.ok(ms < 1000, `a normal owner-cap post took ${ms.toFixed(0)} ms`);
});

test("the guard's budgets stay far above ordinary content", () => {
  // The pinned post (repeated to the owner cap, and repeated to 64 KB by the
  // fixtures above) is thousands of inline blocks of ordinary prose. Count what
  // the guard counts (a superset of the delimiter characters) to prove the
  // pins above render through marked's own inline lexer rather than being
  // flattened: no single block is anywhere near the per-block cap, and the
  // document's Σd² is a small fraction of the budget.
  const blocks = longPost().split(/\n{2,}/);
  const per = blocks.map((b) => (b.match(/[*_[\]~`(<]/g) || []).length);
  const max = Math.max(...per);
  const sumSq = per.reduce((a, d) => a + d * d, 0);
  assert.ok(max < 64, `no block is delimiter-dense (max ${max})`);
  assert.ok(sumSq < BOT_MD_SQ_BUDGET / 100, `Σd² ${sumSq} is far under the budget`);
});

// --- the owner path keeps its OWN parser ----------------------------------
test("the owner path keeps the owner's parser (no math), and the bot path keeps its own", () => {
  // A post about prices keeps its dollar signs; the bot's math extension would
  // have shown `x_1` as a <code> span and `$$…$$` as a display block.
  const prices = "Prices: $5 and $10, then $126$B in revenue.\n\n$$\nx_{1} + y\n$$\n";
  const owner = renderMarkdown(prices);
  assert.ok(!owner.includes('class="math"'), owner);
  assert.match(owner, /\$5 and \$10/, owner);
  assert.match(owner, /\$126\$B/, "the dollar pair stays literal on the owner path: " + owner);

  const bot = renderBotMarkdown(prices);
  assert.match(bot, /<pre class="math"><code>x_\{1\} \+ y<\/code><\/pre>/, bot);
});

test("the owner image rule and link opt-out survive the guarded path", () => {
  // The full matrix lives in tests/owner-markdown-images.test.js; these are the
  // four decisions that would break loudest if the guard had been wired with
  // the BOT instance by mistake.
  const refused = renderMarkdown("![x](/dashboard/logout)");
  assert.doesNotMatch(refused, /<img/i, refused);
  assert.equal(refused.replace(/<[^>]+>/g, "").trim(), "x", "the alt text is left behind");
  assert.match(renderMarkdown("![a](/blog/figures/12-abcdef12.png)"), /<img[^>]*src="\/blog\/figures\/12-abcdef12\.png"/);
  assert.match(renderMarkdown('<img src="/kb/media/abcd1234.png" alt="a">'), /<img[^>]*src="\/kb\/media\/abcd1234\.png"/);
  // The owner-only figure route stays owner-only.
  assert.doesNotMatch(renderBotMarkdown("![a](/blog/figures/12-abcdef12.png)"), /<img/i);
  // Links: prefetch off, Drive on.
  const link = renderMarkdown("[x](/dashboard/board)");
  assert.match(link, /data-turbo-prefetch="false"/, link);
  assert.doesNotMatch(link, /data-turbo="false"/, link);
});

// --- over budget / over cap: escaped text, never "" ----------------------
test("an over-budget document comes back as its text (never \"\"), and a long one is rendered in full", (t) => {
  // Over budget: the block is flattened but shown — a public page always
  // renders what was written.
  const flattened = renderMarkdown(rep("*a_", CAP64));
  assert.ok(flattened.length > 0, "never an empty page");
  assert.ok(flattened.includes("*a_*a_"), "the source is on screen as text: " + flattened.slice(0, 120));

  // Over the chunk size: the document is rendered in CONSECUTIVE CHUNKS now, so
  // the whole text is on the page as formatted markdown — no notice, no
  // plain-text tail — and the author's HTML comment is still dropped by the
  // sanitizer. (The plain-text tail is what the total-time budget and the 8 MiB
  // ceiling produce; tests/md-chunked-render.test.js owns those.)
  const over = "x ".repeat(Math.ceil((OWNER_MD_MAX_INPUT + 1) / 2));
  const { html, ms } = timed("<!-- hidden -->\n" + over);
  t.diagnostic(`over-cap owner input: ${ms.toFixed(0)} ms`);
  assert.ok(!html.includes("md-tail"), "the whole document is formatted: " + html.slice(0, 120));
  assert.ok(html.includes("x x x"), "the text is still shown");
  assert.ok(html.replace(/<[^>]+>/g, "").length >= over.length,
    "every character of the document is on the page");
  assert.ok(!html.includes("hidden"), "the hidden comment is not shown");
  assert.ok(ms < 500, `over-cap input took ${ms.toFixed(0)} ms (bound 500 ms)`);
});

test("a flattened block's neighbours keep their formatting (owner path)", () => {
  const hostile = rep("*a_<img src=x onerror=alert(1)>[l](javascript:alert(1))", CAP64 / 4);
  const html = renderMarkdown("normal *paragraph* one\n\n" + hostile + "\n\nnormal **paragraph** two");
  assert.match(html, /^<p>normal <em>paragraph<\/em> one<\/p>/, html.slice(0, 200));
  assert.match(html, /<p>normal <strong>paragraph<\/strong> two<\/p>\n?$/);
  assert.ok(!/<img/i.test(html), "the flattened block contributed no <img>");
  assert.ok(!/<[^>]*\son\w+=/i.test(html), "no event handler inside any tag");
  assert.ok(!/href="javascript:/i.test(html), "no javascript: link survives");
});