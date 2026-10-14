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
