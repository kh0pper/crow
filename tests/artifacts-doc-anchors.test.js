// D28 (plan rev 2, review M3/M4): a selection on a document becomes a BLOCK
// anchor resolved server-side — the frame names the block id and the quote;
// the block's text comes from the version's stored anchor map, and the quote
// must occur in that block's RENDERED text (plain), else it is a text anchor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { renderVersion } from "../bundles/artifacts/server/render.js";
import { resolveBlockAnchor } from "../bundles/artifacts/server/comments.js";

test("render: every document block stores its rendered plain text beside its markdown text", async () => {
  const r = await renderVersion("document", { markdown: "# Title\n\nHello **bold** and [a link](https://x.example) &amp; more.\n\nSecond   para." }, { markdownBlocks });
  const b = r.anchorMap.blocks;
  assert.equal(b[1].id, "b2");
  assert.match(b[1].text, /\*\*bold\*\*/, "text stays the markdown source (carry-forward compat)");
  assert.equal(b[1].plain, "Hello bold and a link & more.", "plain is the rendered text, entities decoded, whitespace squashed");
  assert.equal(b[2].plain, "Second para.");
});

test("resolveBlockAnchor: map text + a quote found in rendered text → block anchor; else a text anchor; never client-supplied block text", async () => {
  const map = (await renderVersion("document", { markdown: "Hello **bold** world.\n\nOther block here." }, { markdownBlocks })).anchorMap;
  assert.deepEqual(resolveBlockAnchor(map, { kind: "block", id: "b1", quote: "bold world", text: "FORGED TEXT" }),
    { kind: "block", id: "b1", text: map.blocks[0].text, quote: "bold world" }, "text from the map; the client's text ignored");
  assert.deepEqual(resolveBlockAnchor(map, { kind: "block", id: "b1", quote: "Other block" }),
    { kind: "text", quote: "Other block", prefix: "", suffix: "" }, "quote from ANOTHER block → text anchor (no mis-anchoring)");
  assert.deepEqual(resolveBlockAnchor(map, { kind: "block", id: "b99", quote: "bold" }),
    { kind: "text", quote: "bold", prefix: "", suffix: "" }, "unknown block → text anchor");
  assert.equal(resolveBlockAnchor(map, { kind: "block", id: "b99" }), null, "unknown block, no quote → refused");
  assert.deepEqual(resolveBlockAnchor(map, { kind: "block", id: "b2" }), { kind: "block", id: "b2", text: map.blocks[1].text, quote: "" }, "a whole-block anchor (the section list) still works");
  // Older versions stored no plain: the quote is checked against the markdown text.
  const old = { kind: "blocks", blocks: [{ id: "b1", type: "p", text: "plain old words" }] };
  assert.equal(resolveBlockAnchor(old, { kind: "block", id: "b1", quote: "old words" }).kind, "block");
  // Non-block anchors pass through untouched.
  assert.deepEqual(resolveBlockAnchor(map, { kind: "region", x: 0.5, y: 0.5 }), { kind: "region", x: 0.5, y: 0.5 });
  assert.equal(resolveBlockAnchor(null, { kind: "block", id: "b1", quote: "q" }).kind, "text", "no map → text anchor");
});

test("review M1: the renderer is the meta-refresh control for helper-only documents — hostile markdown never yields meta, base, script, iframe, object, form or event handlers", async () => {
  const md = [
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<base href="https://evil.example/">',
    '<script>alert(1)</script>',
    '<iframe srcdoc="<script>x</script>"></iframe>',
    '<object data="https://evil.example/o"></object>',
    '<form action="https://evil.example/f"><button>go</button></form>',
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">j</a>',
    '<svg><script>alert(1)</script></svg>',
    '<style>@import url(https://evil.example/c.css)</style>',
  ].join("\n\n");
  const r = await renderVersion("document", { markdown: md }, { markdownBlocks });
  const html = r.files.find((f) => f.path === "index.html").body.toString("utf8");
  const body = html.slice(html.indexOf("<body>"));
  for (const bad of [/<meta/i, /<base/i, /<script/i, /<iframe/i, /<object/i, /<form/i, /\son\w+\s*=/i, /javascript:/i, /@import/i]) {
    assert.doesNotMatch(body, bad, String(bad));
  }
});

test("review M-1/M-2 + low: inline formatting never splits words; a cross-format selection keeps its block; the fallback keeps context; a section picked from the list keeps its section", async () => {
  const { plainOf } = await import("../bundles/artifacts/server/render.js");
  assert.equal(plainOf("<p>An <strong>un</strong>believable <code>foo()</code>'s day</p>"), "An unbelievable foo()'s day");
  assert.equal(plainOf("<ul><li>one</li><li>two</li></ul>"), "one two", "block tags still separate");
  const map = (await renderVersion("document", { markdown: "An **un**believable `foo()`'s day.\n\nOther." }, { markdownBlocks })).anchorMap;
  assert.equal(resolveBlockAnchor(map, { kind: "block", id: "b1", quote: "unbelievable foo()'s" }).kind, "block");
  assert.deepEqual(resolveBlockAnchor(map, { kind: "block", id: "b2", quote: "unbelievable", prefix: "An ", suffix: " foo" }),
    { kind: "text", quote: "unbelievable", prefix: "An ", suffix: " foo" }, "the fallback keeps the selection's context");
  assert.deepEqual(resolveBlockAnchor(map, { kind: "block", id: "b2", quote: "words I typed", fromList: true }),
    { kind: "block", id: "b2", text: map.blocks[1].text, quote: "words I typed" }, "the owner's section pick stands");
});
