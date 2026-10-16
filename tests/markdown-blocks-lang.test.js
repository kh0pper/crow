// markdownBlocks (servers/blog/renderer.js): code blocks carry their language
// and raw code so Artifacts can render ```vega-lite / ```mermaid / ```d2 fences
// (design kit spec §4.2). Other blocks are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownBlocks } from "../servers/blog/renderer.js";

test("fenced code blocks carry lang and raw code", () => {
  const b = markdownBlocks("# Title\n\n```Mermaid extra words\nflowchart LR\n  A --> B\n```\n\n```\nplain\n```\n\nText.");
  assert.deepEqual(b.map((x) => x.type), ["heading", "code", "code", "paragraph"]);
  assert.equal(b[1].lang, "mermaid");
  assert.equal(b[1].code, "flowchart LR\n  A --> B");
  assert.equal(b[2].lang, "");
  assert.equal(b[2].code, "plain");
  assert.equal("lang" in b[0], false);
  assert.equal("code" in b[3], false);
});
