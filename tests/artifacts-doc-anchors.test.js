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

test("D28 low: a pre-D28 version (no plain) matches a selection against its markdown with the markup stripped, still never another block's words", () => {
  // What a pre-D28 anchor map holds: markdown text only, no plain.
  const old = { kind: "blocks", blocks: [
    { id: "b1", type: "p", text: "Hello **bold** and _italic_ with `code` and [a link](https://x.example) here." },
    { id: "b2", type: "h2", text: "## A heading" },
    { id: "b3", type: "p", text: "Another block entirely." },
    { id: "b4", type: "p", text: "Name it snake_case or 2*3*4." },
  ] };
  for (const [id, quote] of [["b1", "bold and italic"], ["b1", "with code and a link here"], ["b2", "A heading"], ["b4", "snake_case or 2*3*4"]]) {
    assert.deepEqual(resolveBlockAnchor(old, { kind: "block", id, quote }), { kind: "block", id, text: old.blocks.find((b) => b.id === id).text, quote }, `${id}: "${quote}"`);
  }
  assert.equal(resolveBlockAnchor(old, { kind: "block", id: "b1", quote: "snake_case" }).kind, "text", "words not in the block still demote");
  assert.equal(resolveBlockAnchor(old, { kind: "block", id: "b1", quote: "Another block" }).kind, "text", "another block's words still demote");
  assert.equal(resolveBlockAnchor(old, { kind: "block", id: "b1", quote: "x.example" }).kind, "text", "a link's URL is markup, not rendered words");
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

// ── S1 (step-6 smoke, plan Rev 3 M1/M2): the quote's position, server-side ──
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import * as comments from "../bundles/artifacts/server/comments.js";

const LIST_MD = "# Grind\n\n1. Use a medium grind.\n2. Rinse the filter.\n3. Keep the medium heat steady.\n\n| Size | Grind |\n| --- | --- |\n| Cup | Medium-fine |";

async function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-span-"));
  const db = createDbClient(join(dir, "crow.db"));
  await initArtifactsTables(db);
  const blobs = createLocalBlobStore(join(dir, "blobs"));
  return { db, blobs, close: () => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("S1: blockSpan finds the quote in the block's plain text (whitespace-insensitive) and maps it back to plain offsets", () => {
  const plain = "Use a medium grind. Rinse the filter. Keep the medium heat steady.";
  const sp = comments.blockSpan(plain, "medium  grind", "", "");
  assert.deepEqual(sp, { start: plain.indexOf("medium grind"), end: plain.indexOf("medium grind") + "medium grind".length, nth: 0 });
  assert.equal(comments.blockSpan(plain, "not here", "", ""), null, "no match → no span");
  assert.equal(comments.blockSpan("", "x", "", ""), null);
});

test("S1/M2: a repeated phrase in one block picks the occurrence by its prefix/suffix (nth)", () => {
  const plain = "Use a medium grind. Rinse the filter. Keep the medium heat steady.";
  const third = comments.blockSpan(plain, "medium", "Keep the ", " heat steady.");
  assert.equal(third.nth, 1, "item 3's 'medium'");
  assert.equal(plain.slice(third.start, third.end), "medium");
  assert.equal(third.start, plain.lastIndexOf("medium"));
  const first = comments.blockSpan(plain, "medium", "Use a ", " grind");
  assert.equal(first.nth, 0);
  assert.equal(comments.blockSpan(plain, "medium", "", "").nth, 0, "no context → the first");
});

test("S1: addThread stores span on a block anchor whose quote is in plain; a non-verbatim quote gets none; input span is stripped", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "Guide", type: "document", source: { markdown: LIST_MD }, actor: { kind: "bot", id: "bobby" } }, { markdownBlocks });
    const v = (await s.db.execute({ sql: "SELECT anchor_map_json FROM artifact_versions WHERE artifact_id=? AND n=1", args: [art.id] })).rows[0];
    const map = JSON.parse(v.anchor_map_json);
    const list = map.blocks.find((b) => b.type === "list");
    const a3 = comments.resolveBlockAnchor(map, { kind: "block", id: list.id, quote: "medium", prefix: "Keep the ", suffix: " heat" });
    assert.equal(a3.prefix, "Keep the ", "resolveBlockAnchor keeps the context");
    assert.equal(a3.suffix, " heat");
    const t3 = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: a3, text: "lower", author: { kind: "owner" } });
    const row = async (id) => JSON.parse((await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE id=?", args: [id] })).rows[0].anchor_json);
    const got = await row(t3.threadId);
    assert.equal(got.span.nth, 1);
    assert.equal(list.plain.slice(got.span.start, got.span.end), "medium");
    // A section picked from the list with typed, non-verbatim words: no span.
    const typed = comments.resolveBlockAnchor(map, { kind: "block", id: list.id, quote: "the second item please", fromList: true });
    const tt = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: typed, text: "x", author: { kind: "owner" } });
    assert.equal((await row(tt.threadId)).span, undefined, "not verbatim → no span");
    // Input span is never trusted: stripped by validAnchor, recomputed by the server.
    assert.equal(comments.validAnchor({ kind: "block", id: "b2", text: "", quote: "Rinse", span: { start: 0, end: 3, nth: 9 } }).span, undefined);
    const forged = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "block", id: list.id, text: "", quote: "Rinse", span: { start: 0, end: 99, nth: 7 } }, text: "y", author: { kind: "owner" } });
    const f = await row(forged.threadId);
    assert.deepEqual(f.span, { start: list.plain.indexOf("Rinse"), end: list.plain.indexOf("Rinse") + 5, nth: 0 }, "the server's span, not the input's");
  } finally { s.close(); }
});

test("S1/M1: carryForward recomputes the span when the block moves and drops it when the quote is gone", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "Guide", type: "document", source: { markdown: LIST_MD }, actor: { kind: "bot", id: "bobby" } }, { markdownBlocks });
    const map = JSON.parse((await s.db.execute({ sql: "SELECT anchor_map_json FROM artifact_versions WHERE artifact_id=? AND n=1", args: [art.id] })).rows[0].anchor_map_json);
    const list = map.blocks.find((b) => b.type === "list");
    const keep = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: comments.resolveBlockAnchor(map, { kind: "block", id: list.id, quote: "Rinse the filter" }), text: "a", author: { kind: "owner" } });
    const gone = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: comments.resolveBlockAnchor(map, { kind: "block", id: list.id, quote: "medium heat" }), text: "b", author: { kind: "owner" } });
    // v2: a new paragraph first (the list moves to b3), item 3 rewritten.
    const md2 = "# Grind\n\nA new intro.\n\n1. Use a medium grind.\n2. Rinse the filter well.\n3. Keep it steady.\n\n| Size | Grind |\n| --- | --- |\n| Cup | Medium-fine |";
    await store.addVersion(s.db, s.blobs, { artifactId: art.id, source: { markdown: md2 }, actor: { kind: "bot", id: "bobby" } }, { markdownBlocks });
    await comments.carryForwardTo(s.db, s.blobs, art.id, 2);
    const map2 = JSON.parse((await s.db.execute({ sql: "SELECT anchor_map_json FROM artifact_versions WHERE artifact_id=? AND n=2", args: [art.id] })).rows[0].anchor_map_json);
    const list2 = map2.blocks.find((b) => b.type === "list");
    const row = async (id) => (await s.db.execute({ sql: "SELECT anchor_json, version_n FROM artifact_threads WHERE id=?", args: [id] })).rows[0];
    const k = await row(keep.threadId);
    assert.equal(Number(k.version_n), 2);
    const ka = JSON.parse(k.anchor_json);
    assert.equal(ka.id, list2.id, "moved to the list's new id");
    assert.equal(list2.plain.slice(ka.span.start, ka.span.end), "Rinse the filter", "span recomputed against v2's plain");
    const ga = JSON.parse((await row(gone.threadId)).anchor_json);
    assert.equal(ga.span, undefined, "the quote is no longer in the block: no span crosses");
  } finally { s.close(); }
});
