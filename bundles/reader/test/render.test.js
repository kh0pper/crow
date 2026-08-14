import { test } from "node:test";
import assert from "node:assert/strict";
import { renderParagraph, readerPage } from "../server/render.js";

test("plain paragraph renders escaped text in an er-para div", () => {
  const html = renderParagraph("Design <thinking> & empathy", 3);
  assert.ok(html.includes('data-para="3"'));
  assert.ok(html.includes("Design &lt;thinking&gt; &amp; empathy"));
});

test("[TABLE] paragraph renders an HTML table", () => {
  const md = "[TABLE]\n| A | B |\n|---|---|\n| 1 | 2 |";
  const html = renderParagraph(md, 0);
  assert.ok(html.includes("<table"));
  assert.ok(html.includes("<td>1</td>"));
  assert.ok(!html.includes("[TABLE]"));
});

test("readerPage embeds document data and forces a full Turbo reload", () => {
  const html = readerPage({
    document: { id: 7, title: "Guide <b>", extraction_status: "ok" },
    section: { section_number: 1, title: null },
    sections: [{ section_number: 1, title: null, paragraph_count: 2 }],
    paragraphs: ["One.", "Two."],
    progress: { paragraph: 1 },
  });
  assert.ok(html.includes('name="turbo-visit-control" content="reload"'));
  assert.ok(html.includes("Guide &lt;b&gt;"));
  assert.ok(html.includes('id="reader-data"'));
  const m = html.match(/<script type="application\/json" id="reader-data">(.*?)<\/script>/s);
  const data = JSON.parse(m[1]);
  assert.equal(data.documentId, 7);
  assert.equal(data.totalParagraphs, 2);
  assert.equal(data.resumeParagraph, 1);
});
