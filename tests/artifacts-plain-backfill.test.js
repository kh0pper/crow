// D28 leftover (doc-highlight review L-6): document versions saved before D28
// store no rendered `plain` per block, so their block anchors never get a
// `span` (pins and highlights fall back to the whole block) and the quote
// check runs against the 400-char markdown `text`. The backfill recomputes
// `plain` from the version's own stored markdown — only when the re-render
// matches the stored blocks exactly — and gives that version's open block
// threads their span. Scratch DB only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import { plainBackfill } from "../bundles/artifacts/server/render.js";
import { rmScratch } from "./helpers/safe-rm.js";

const MD = "# Grind\n\n1. Use a medium grind.\n2. Rinse the filter.\n3. Keep the medium heat steady.\n\nA long paragraph " + "with many words ".repeat(40) + "and **bold** words at the end.";
const bot = { kind: "bot", id: "bobby" };

async function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-plain-backfill-"));
  const db = createDbClient(join(dir, "crow.db"));
  await initArtifactsTables(db);
  const blobs = createLocalBlobStore(join(dir, "blobs"));
  return { db, blobs, close: () => { try { db.close(); } catch {} rmScratch(dir); } };
}
/** Make version n look as if it was saved before D28: no `plain` anywhere. */
async function makePreD28(db, artifactId, n) {
  const v = (await db.execute({ sql: "SELECT anchor_map_json FROM artifact_versions WHERE artifact_id=? AND n=?", args: [artifactId, n] })).rows[0];
  const map = JSON.parse(v.anchor_map_json);
  const old = { ...map, blocks: map.blocks.map(({ plain: _p, ...b }) => b) };
  await db.execute({ sql: "UPDATE artifact_versions SET anchor_map_json=? WHERE artifact_id=? AND n=?", args: [JSON.stringify(old), artifactId, n] });
  return { now: map, old };
}
const mapOf = async (db, id, n) => JSON.parse((await db.execute({ sql: "SELECT anchor_map_json FROM artifact_versions WHERE artifact_id=? AND n=?", args: [id, n] })).rows[0].anchor_map_json);

test("plainBackfill: recomputes plain only when the re-render matches the stored blocks; otherwise null", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    const { now, old } = await makePreD28(s.db, art.id, 1);
    assert.deepEqual(plainBackfill(old, { markdown: MD }, markdownBlocks), now, "exactly what a save today stores");
    assert.equal(plainBackfill(now, { markdown: MD }, markdownBlocks), null, "nothing to do when plain is present");
    assert.equal(plainBackfill(old, { markdown: MD + "\n\nExtra block." }, markdownBlocks), null, "a different block count → untouched");
    const edited = { ...old, blocks: old.blocks.map((b, i) => (i === 1 ? { ...b, text: b.text + " changed" } : b)) };
    assert.equal(plainBackfill(edited, { markdown: MD }, markdownBlocks), null, "any stored text that differs → untouched");
    assert.equal(plainBackfill({ kind: "diagram", elements: [] }, { markdown: MD }, markdownBlocks), null);
    assert.equal(plainBackfill(old, { svg: "<svg/>" }, markdownBlocks), null, "no markdown → untouched");
    assert.equal(plainBackfill(old, { markdown: MD }, () => { throw new Error("boom"); }), null, "a renderer failure → untouched");
  } finally { s.close(); }
});

test("backfillPlain: writes plain into pre-D28 versions and gives their open block threads a span; idempotent; leaves current maps alone", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    const { now, old } = await makePreD28(s.db, art.id, 1);
    const list = old.blocks.find((b) => b.type === "list");
    const longP = old.blocks.at(-1);
    // A thread made on the pre-D28 version: no span (withSpan needs plain).
    const t1 = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: comments.resolveBlockAnchor(old, { kind: "block", id: list.id, quote: "Rinse the filter" }), text: "a", author: { kind: "owner" } });
    const anchorOf = async (id) => JSON.parse((await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE id=?", args: [id] })).rows[0].anchor_json);
    assert.equal((await anchorOf(t1.threadId)).span, undefined, "pre-backfill: no span");
    // Past the 400-char markdown cap, a selection demotes to a text anchor today.
    assert.equal(comments.resolveBlockAnchor(old, { kind: "block", id: longP.id, quote: "and bold words at the end" }).kind, "text");

    const r = await comments.backfillPlain(s.db, s.blobs, markdownBlocks);
    assert.deepEqual(r, { versions: 1, threads: 1, skipped: 0 });
    assert.deepEqual(await mapOf(s.db, art.id, 1), now);
    const a = await anchorOf(t1.threadId);
    assert.equal(now.blocks.find((b) => b.id === list.id).plain.slice(a.span.start, a.span.end), "Rinse the filter");
    assert.equal(comments.resolveBlockAnchor(await mapOf(s.db, art.id, 1), { kind: "block", id: longP.id, quote: "and bold words at the end" }).kind, "block", "the long block now keeps its block anchor");

    assert.deepEqual(await comments.backfillPlain(s.db, s.blobs, markdownBlocks), { versions: 0, threads: 0, skipped: 0 }, "idempotent");
  } finally { s.close(); }
});

test("backfillPlain: a version whose re-render does not match is left exactly as it was; non-document artifacts are skipped", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    const { old } = await makePreD28(s.db, art.id, 1);
    const tampered = { ...old, blocks: old.blocks.map((b, i) => (i === 0 ? { ...b, text: "# Something else" } : b)) };
    await s.db.execute({ sql: "UPDATE artifact_versions SET anchor_map_json=? WHERE artifact_id=? AND n=1", args: [JSON.stringify(tampered), art.id] });
    let calls = 0;
    const counting = (md) => { calls++; return markdownBlocks(md); };
    assert.deepEqual(await comments.backfillPlain(s.db, s.blobs, counting), { versions: 0, threads: 0, skipped: 1 });
    assert.deepEqual(await mapOf(s.db, art.id, 1), { ...tampered, plain_backfill: "skipped" }, "only the marker is added");
    const before = calls;
    assert.deepEqual(await comments.backfillPlain(s.db, s.blobs, counting), { versions: 0, threads: 0, skipped: 0 });
    assert.equal(calls, before, "a skipped version is never re-rendered again");
    // A diagram is never a candidate.
    await store.createArtifact(s.db, s.blobs, { title: "D", type: "diagram", source: { svg: '<svg viewBox="0 0 1 1"><g id="a"/></svg>' }, actor: bot }, { markdownBlocks });
    assert.deepEqual(await comments.backfillPlain(s.db, s.blobs, markdownBlocks), { versions: 0, threads: 0, skipped: 0 });
  } finally { s.close(); }
});

test("backfillPlain: compare-and-set — a map changed between the read and the write is not overwritten", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    await makePreD28(s.db, art.id, 1);
    const racer = { kind: "blocks", blocks: [{ id: "b1", type: "heading", text: "# Grind", plain: "RACED" }] };
    // A db whose first anchor-map UPDATE is preceded by another writer's change.
    let raced = false;
    const db = { execute: async (q) => {
      if (!raced && /^UPDATE artifact_versions SET anchor_map_json/.test(q.sql)) {
        raced = true;
        await s.db.execute({ sql: "UPDATE artifact_versions SET anchor_map_json=? WHERE artifact_id=? AND n=1", args: [JSON.stringify(racer), art.id] });
      }
      return s.db.execute(q);
    } };
    assert.deepEqual(await comments.backfillPlain(db, s.blobs, markdownBlocks), { versions: 0, threads: 0, skipped: 0 });
    assert.equal(raced, true);
    assert.deepEqual(await mapOf(s.db, art.id, 1), racer, "the concurrent write wins");
  } finally { s.close(); }
});

test("backfillPlain: the recomputed plain must equal the block text of the STORED index.html (the page the reader sees), else skipped", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    const { old } = await makePreD28(s.db, art.id, 1);
    // Same ids, types and markdown text, but today's renderer would show other words (renderer drift).
    const drifted = (md) => markdownBlocks(md).map((b, i) => (i === 1 ? { ...b, html: b.html.replace("medium", "coarse") } : b));
    assert.deepEqual(await comments.backfillPlain(s.db, s.blobs, drifted), { versions: 0, threads: 0, skipped: 1 });
    assert.deepEqual(await mapOf(s.db, art.id, 1), { ...old, plain_backfill: "skipped" });
    // The stored page's blocks, in order, by the renderer's own shape.
    const html = (await s.blobs.get(JSON.parse((await s.db.execute({ sql: "SELECT files_json FROM artifact_versions WHERE artifact_id=? AND n=1", args: [art.id] })).rows[0].files_json).find((f) => f.path === "index.html").key)).toString("utf8");
    const blocks = comments.indexBlocks(html, old.blocks.length);
    assert.equal(blocks.length, old.blocks.length);
    assert.match(blocks[0], /^<h1[^>]*>Grind<\/h1>\s*$/);
    assert.equal(comments.indexBlocks(html, old.blocks.length + 1), null, "a different block count → null");
  } finally { s.close(); }
});

test("backfillPlain: a thread carried forward to another version meanwhile is not given the old version's span", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    const { old } = await makePreD28(s.db, art.id, 1);
    const list = old.blocks.find((b) => b.type === "list");
    const t1 = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: comments.resolveBlockAnchor(old, { kind: "block", id: list.id, quote: "Rinse the filter" }), text: "a", author: { kind: "owner" } });
    let moved = false;
    const db = { execute: async (q) => {
      if (!moved && /^UPDATE artifact_threads SET anchor_json/.test(q.sql)) {
        moved = true;   // a carry-forward lands first: same anchor JSON, new version
        await s.db.execute({ sql: "UPDATE artifact_threads SET version_n=2 WHERE id=?", args: [t1.threadId] });
      }
      return s.db.execute(q);
    } };
    assert.deepEqual(await comments.backfillPlain(db, s.blobs, markdownBlocks), { versions: 1, threads: 0, skipped: 0 });
    assert.equal(moved, true);
    const a = JSON.parse((await s.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE id=?", args: [t1.threadId] })).rows[0].anchor_json);
    assert.equal(a.span, undefined);
  } finally { s.close(); }
});

test("backfillPlain: a storage error is not a mismatch — nothing is marked, the pass stops, and the next run tries again", async () => {
  const s = await scratch();
  try {
    const art = await store.createArtifact(s.db, s.blobs, { title: "G", type: "document", source: { markdown: MD }, actor: bot }, { markdownBlocks });
    const { now, old } = await makePreD28(s.db, art.id, 1);
    const down = { get: async () => { throw Object.assign(new Error("timeout"), { code: "busy" }); } };
    assert.deepEqual(await comments.backfillPlain(s.db, down, markdownBlocks), { versions: 0, threads: 0, skipped: 0, stopped: true });
    assert.deepEqual(await mapOf(s.db, art.id, 1), old, "unmarked");
    const empty = { get: async () => null };
    assert.equal((await comments.backfillPlain(s.db, empty, markdownBlocks)).stopped, true);
    assert.deepEqual(await mapOf(s.db, art.id, 1), old, "a missing blob is not a mismatch either");
    assert.equal((await comments.backfillPlain(s.db, s.blobs, null)).stopped, true, "no renderer: nothing judged");
    assert.deepEqual(await comments.backfillPlain(s.db, s.blobs, markdownBlocks), { versions: 1, threads: 0, skipped: 0 }, "the store is back: done");
    assert.deepEqual(await mapOf(s.db, art.id, 1), now);
  } finally { s.close(); }
});
