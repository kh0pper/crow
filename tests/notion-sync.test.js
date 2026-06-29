import { test } from "node:test";
import assert from "node:assert/strict";
import {
  richTextToPlain,
  blockToMarkdown,
  blocksToMarkdown,
  extractTitle,
  decideAction,
  buildContent,
  buildContext,
} from "../scripts/sync-notion.js";

test("richTextToPlain joins plain_text segments and tolerates empties", () => {
  assert.equal(richTextToPlain([{ plain_text: "Hello " }, { plain_text: "world" }]), "Hello world");
  assert.equal(richTextToPlain([{ text: { content: "fallback" } }]), "fallback");
  assert.equal(richTextToPlain([]), "");
  assert.equal(richTextToPlain(undefined), "");
});

test("blocksToMarkdown renders the common block types", () => {
  const blocks = [
    { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "A paragraph." }] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "item" }] } },
    { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "first" }] } },
    { type: "to_do", to_do: { rich_text: [{ plain_text: "task" }], checked: true } },
    { type: "quote", quote: { rich_text: [{ plain_text: "wisdom" }] } },
    { type: "code", code: { rich_text: [{ plain_text: "x = 1" }], language: "python" } },
    { type: "divider", divider: {} },
  ];
  const md = blocksToMarkdown(blocks);
  assert.match(md, /^# Title/m);
  assert.match(md, /A paragraph\./);
  assert.match(md, /^- item$/m);
  assert.match(md, /^1\. first$/m);
  assert.match(md, /^- \[x\] task$/m);
  assert.match(md, /^> wisdom$/m);
  assert.match(md, /```python\nx = 1\n```/);
  assert.match(md, /^---$/m);
});

test("blockToMarkdown indents nested children", () => {
  const blocks = [
    {
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [{ plain_text: "parent" }] },
      children: [
        { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "child" }] } },
      ],
    },
  ];
  const md = blocksToMarkdown(blocks);
  assert.match(md, /^- parent$/m);
  assert.match(md, /^ {2}- child$/m);
});

test("blockToMarkdown skips empty/unknown blocks gracefully", () => {
  assert.equal(blockToMarkdown({ type: "paragraph", paragraph: { rich_text: [] } }), "");
  assert.equal(blockToMarkdown({ type: "unsupported_widget", unsupported_widget: {} }), "");
});

test("extractTitle reads the title-type property", () => {
  const page = { properties: { Name: { type: "title", title: [{ plain_text: "My Page" }] } } };
  assert.equal(extractTitle(page), "My Page");
  assert.equal(extractTitle({ properties: {} }), "Untitled");
  assert.equal(extractTitle({}), "Untitled");
});

test("decideAction: insert when there is no existing row", () => {
  assert.equal(decideAction(null, { last_edited_time: "t1" }), "insert");
});

test("decideAction: skip when last_edited_time is unchanged", () => {
  const existing = { id: 1, context: JSON.stringify({ last_edited_time: "t1" }) };
  assert.equal(decideAction(existing, { last_edited_time: "t1" }), "skip");
});

test("decideAction: update when last_edited_time changed", () => {
  const existing = { id: 1, context: JSON.stringify({ last_edited_time: "t1" }) };
  assert.equal(decideAction(existing, { last_edited_time: "t2" }), "update");
});

test("decideAction: force always updates; bad context updates", () => {
  const existing = { id: 1, context: JSON.stringify({ last_edited_time: "t1" }) };
  assert.equal(decideAction(existing, { last_edited_time: "t1" }, { force: true }), "update");
  assert.equal(decideAction({ id: 2, context: "not-json" }, { last_edited_time: "t1" }), "update");
});

test("buildContent caps length and prefixes the title", () => {
  const content = buildContent("Title", "body");
  assert.equal(content, "# Title\n\nbody");
  assert.ok(buildContent("T", "x".repeat(60000)).length <= 50000);
});

test("buildContext records provenance for dedup/change detection", () => {
  const ctx = JSON.parse(buildContext({ id: "abc", url: "https://n/abc", last_edited_time: "t1" }, "Title"));
  assert.equal(ctx.notion_page_id, "abc");
  assert.equal(ctx.last_edited_time, "t1");
  assert.equal(ctx.title, "Title");
  assert.equal(ctx.chunk, 0);
});
