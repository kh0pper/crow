// Perch bot markdown: headings, backslash escapes and TeX math, rendered once
// and sanitized. Kevin's screenshot (2026-10-02, hank session
// perchlive-9e2b9bf3) showed literal "#####", "126126B" and "10001000\-step".
//
// ROOT CAUSE, measured from the session file: that bubble was NOT bot prose.
// It was a toolResult message (crow_browser_extract_article on arXiv
// 2608.30320) which the history path drew as a plain-text 'bot' row — so no
// markdown rendering at all, hence "#####" and "\-". The doubled numbers were
// already in the tool's output: Turndown kept BOTH the MathML presentation
// text and the TeX annotation of each <math> element. Fixed at the source
// (bundles/browser/server/article-markdown.js) and in the client (history
// draws a tool result as a finished chip, as the live stream does).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderBotMarkdown } from "../servers/blog/renderer.js";
import { mathRule, mathTex } from "../bundles/browser/server/article-markdown.js";

/** The exact bytes from the session file (toolResult, line 25), unedited. */
const OFFENDING =
  "The shaded band corresponds to the learning-rate warmup. The inset in (a) resolves the last " +
  "126126B tokens of the window; the inset in (b) is the standard deviation of the gradient norm " +
  "inside a rolling 10001000\\-step window.\n\n##### Verification at the Production Run.\n\n" +
  "While the stress test amplifies instabilities by leaving the shipped configuration, we also verify";

/** The same passage as the fixed extractor now emits it. */
const FIXED_EXTRACT =
  "The inset in (a) resolves the last $126$B tokens of the window; the inset in (b) is the " +
  "standard deviation of the gradient norm inside a rolling $1000$\\-step window.\n\n" +
  "##### Verification at the Production Run.";

const text = (html) => html.replace(/<[^>]+>/g, "");

test("the offending snippet: h5 is a heading and \\- is an escape, not literal text", () => {
  const html = renderBotMarkdown(OFFENDING);
  assert.match(html, /<h5>Verification at the Production Run\.<\/h5>/);
  assert.ok(!html.includes("#####"), html);
  assert.ok(!html.includes("\\-"), "the backslash escape is consumed: " + html);
  assert.match(html, /10001000-step/, "the renderer cannot undo data that is already doubled");
});

test("the fixed extractor's output renders every number ONCE", () => {
  const html = renderBotMarkdown(FIXED_EXTRACT);
  const t = text(html);
  assert.match(t, /the last 126B tokens/);
  assert.match(t, /rolling 1000-step window/);
  assert.ok(!/126126|10001000|\$/.test(t), t);
  assert.match(html, /<h5>/);
});

test("h1 through h6 all render", () => {
  const md = [1, 2, 3, 4, 5, 6].map((n) => "#".repeat(n) + " Level " + n).join("\n\n");
  const html = renderBotMarkdown(md);
  for (let n = 1; n <= 6; n++) assert.match(html, new RegExp(`<h${n}>Level ${n}</h${n}>`));
});

test("standard backslash escapes are consumed", () => {
  const html = renderBotMarkdown("\\*not em\\* \\_x\\_ \\# \\- \\[a\\] \\` \\\\ \\$5");
  assert.equal(text(html).trim(), "*not em* _x_ # - [a] ` \\ $5");
});

test("inline math: plain bodies read as text, TeX bodies as code, delimiters dropped", () => {
  const html = renderBotMarkdown("a $126$B b $x$ c $\\{x\\}$ d $a_1 + b_1$ e \\(\\alpha^2\\) f $$x^2$$");
  assert.match(html, /<span class="math">126<\/span>B/);
  assert.match(html, /<span class="math">x<\/span>/);
  assert.match(html, /<code>\\\{x\\\}<\/code>/, "TeX braces keep their backslashes");
  assert.match(html, /<code>a_1 \+ b_1<\/code>/, "underscores are not emphasis");
  assert.match(html, /<code>\\alpha\^2<\/code>/);
  assert.match(html, /<code>x\^2<\/code>/);
  assert.ok(!text(html).includes("$"), html);
});

test("display math renders as one block, both $$ and \\[ \\] forms", () => {
  const a = renderBotMarkdown("before\n\n$$\n\\sum_{i=1}^n x_i\n$$\n\nafter");
  assert.match(a, /<pre class="math"><code>\\sum_\{i=1\}\^n x_i<\/code><\/pre>/);
  assert.match(a, /<p>after<\/p>/);
  const b = renderBotMarkdown("\\[ E = mc^2 \\]");
  assert.match(b, /<pre class="math"><code>E = mc\^2<\/code><\/pre>/);
});

test("currency and code spans are left alone", () => {
  assert.equal(text(renderBotMarkdown("costs $5 and $10, or $5-$10.")).trim(), "costs $5 and $10, or $5-$10.");
  assert.equal(text(renderBotMarkdown("lone $ sign and $ another")).trim(), "lone $ sign and $ another");
  assert.match(renderBotMarkdown("`$x$` in code"), /<code>\$x\$<\/code>/);
  assert.equal(text(renderBotMarkdown("escaped \\$x\\$")).trim(), "escaped $x$");
});

test("XSS: nothing executable survives, including HTML smuggled inside math", () => {
  const hostile = [
    "<img src=x onerror=\"window.__pwned=1\">",
    "<script>window.__pwned=1</script>",
    "[click](javascript:window.__pwned=1)",
    "$<img src=x onerror=alert(1)>$",
    "$</code><script>alert(1)</script>$",
    "\\(<svg onload=alert(1)>\\)",
    "$$\n</pre><script>alert(1)</script><iframe src=x></iframe>\n$$",
    "##### <img src=x onerror=alert(1)>",
  ].join("\n\n");
  const html = renderBotMarkdown(hostile);
  assert.ok(!/<script/i.test(html), html);
  assert.ok(!/<iframe/i.test(html), html);
  assert.ok(!/<svg/i.test(html), html);
  assert.ok(!/<[^>]*\son\w+=/i.test(html), "no event handler inside any tag: " + html);
  assert.ok(!/javascript:/i.test(html), html);
  assert.match(html, /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/, "math source shows as escaped text");
});

test("the public blog renderer is unchanged: no math parsing, same sanitizer", () => {
  // Blog posts (behind Funnel) keep their dollar signs exactly as before.
  assert.equal(renderMarkdown("price $126$B and $x$").trim(), "<p>price $126$B and $x$</p>");
  assert.equal(renderMarkdown("##### h5\n\n\\-").trim(), "<h5>h5</h5>\n<p>-</p>");
  const html = renderMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>");
  assert.ok(!/<script|onerror/i.test(html), html);
});

// --- the extractor rule, against node-shaped fakes (the bundle's turndown /
// linkedom are not root dependencies; the real-library run is in the report).
function fakeMath({ alttext = null, display = null, presentation, tex }) {
  const ann = { nodeName: "annotation", textContent: tex,
    getAttribute: (k) => (k === "encoding" ? "application/x-tex" : null) };
  return {
    nodeName: "math",
    textContent: presentation + (tex == null ? "" : tex),
    getAttribute: (k) => (k === "alttext" ? alttext : k === "display" ? display : null),
    getElementsByTagName: (n) => (n === "annotation" && tex != null ? [ann] : []),
  };
}

test("extractor: a LaTeXML <math> yields its TeX once, not presentation+annotation", () => {
  assert.equal(mathRule.filter(fakeMath({ presentation: "126", tex: "126" })), true);
  assert.equal(mathRule.filter({ nodeName: "P" }), false);
  assert.equal(mathRule.replacement("126126", fakeMath({ alttext: "126", presentation: "126", tex: "126" })), "$126$");
  assert.equal(mathRule.replacement("", fakeMath({ presentation: "1000", tex: "1000" })), "$1000$",
    "no alttext: the x-tex annotation");
  assert.equal(mathTex(fakeMath({ presentation: "x+y", tex: null })), "x+y", "no TeX at all: presentation text");
  assert.equal(mathRule.replacement("", fakeMath({ alttext: "\\sum_i x_i", display: "block", presentation: "∑", tex: "\\sum_i x_i" })),
    "\n\n$$\n\\sum_i x_i\n$$\n\n");
});
