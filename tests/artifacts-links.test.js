// Crow Artifacts — artifact_links (spec v1.6 D25 §4.1; plan PR-3 Task 3.2):
// one-time backfill from origin_session, the origin link written in the SAME
// batch as the artifact (review M3), bound to the signed actor's own thread
// and to Perch actors only (round-2 B6); fan-out reads the table.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import { linkedThreads } from "../bundles/artifacts/server/links.js";
import { notifyHub } from "../bundles/artifacts/server/notify-hub.js";

const s = {};
const deps = { markdownBlocks };
const doc = { type: "document", source: { markdown: "# x" } };
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-links-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

const active = async (id) => (await s.db.execute({ sql: "SELECT bot_id, thread_id, linked_by FROM artifact_links WHERE artifact_id=? AND unlinked_at IS NULL ORDER BY id", args: [id] })).rows.map((r) => ({ ...r }));

test("backfill: once, from origin_session, Perch threads only, live artifacts only; a second init is a no-op", async () => {
  const ins = (id, bot, origin, deleted = null) => s.db.execute({ sql: "INSERT INTO artifacts (id,title,type,created_by_bot,origin_session,current_version,received,deleted_at) VALUES (?,?,?,?,?,1,0,?)", args: [id, "t", "document", bot, origin, deleted] });
  // An install upgrading from 0.4.x: rows exist, the links table and its marker do not.
  await s.db.execute({ sql: "DROP TABLE artifact_links", args: [] });
  await s.db.execute({ sql: "DELETE FROM artifact_store_meta WHERE key='links_backfill'", args: [] });
  await ins("art_bf_perch1", "bobby", "perchlive-aaaa0001");
  await ins("art_bf_mail01", "bobby", "gmail-thread-1");      // a channel thread: no link (B6)
  await ins("art_bf_nobot1", null, "perchlive-aaaa0002");     // operator-made: no bot, no link
  await ins("art_bf_gone01", "bobby", "perchlive-aaaa0003", "2026-10-01");
  await ins("art_bf_noorg1", "bobby", null);
  await initArtifactsTables(s.db);
  assert.deepEqual(await active("art_bf_perch1"), [{ bot_id: "bobby", thread_id: "perchlive-aaaa0001", linked_by: "origin" }]);
  for (const id of ["art_bf_mail01", "art_bf_nobot1", "art_bf_gone01", "art_bf_noorg1"]) assert.deepEqual(await active(id), [], id);
  // Unlinked after the backfill: a second init must not bring it back.
  await s.db.execute({ sql: "UPDATE artifact_links SET unlinked_at=datetime('now') WHERE artifact_id='art_bf_perch1'", args: [] });
  await initArtifactsTables(s.db);
  assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_links WHERE artifact_id='art_bf_perch1'", args: [] })).rows[0].n, 1);
  assert.deepEqual(await active("art_bf_perch1"), []);
});

test("M3/B6: createArtifact writes exactly one origin link — the signed creating chat, Perch actors only", async () => {
  const perch = await store.createArtifact(s.db, s.blobs, { title: "P", ...doc, actor: { kind: "bot", id: "bobby", thread: "perchlive-cr000001", gateway: "perch" } }, deps);
  assert.deepEqual(await active(perch.id), [{ bot_id: "bobby", thread_id: "perchlive-cr000001", linked_by: "origin" }]);
  // origin.session never redirects the link (B6): it links actor.thread itself.
  const other = await store.createArtifact(s.db, s.blobs, { title: "O", ...doc, origin: { session: "perchlive-elsewhere" }, actor: { kind: "bot", id: "bobby", thread: "perchlive-cr000002", gateway: "perch" } }, deps);
  assert.deepEqual((await active(other.id)).map((l) => l.thread_id), ["perchlive-cr000002"]);
  const mail = await store.createArtifact(s.db, s.blobs, { title: "M", ...doc, actor: { kind: "bot", id: "bobby", thread: "gmail-7", gateway: "gmail" } }, deps);
  assert.deepEqual(await active(mail.id), [], "a channel turn's thread gets no link");
  const noThread = await store.createArtifact(s.db, s.blobs, { title: "N", ...doc, actor: { kind: "bot", id: "bobby", thread: null, gateway: "perch" } }, deps);
  assert.deepEqual(await active(noThread.id), []);
  const owner = await store.createArtifact(s.db, s.blobs, { title: "S", ...doc, actor: { kind: "session" } }, deps);
  assert.deepEqual(await active(owner.id), []);
  // A failed create leaves no link behind (same batch as the artifact row).
  const before = (await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_links", args: [] })).rows[0].n;
  await assert.rejects(store.createArtifact(s.db, s.blobs, { title: "", ...doc, actor: { kind: "bot", id: "bobby", thread: "perchlive-cr000003", gateway: "perch" } }, deps));
  assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_links", args: [] })).rows[0].n, before);
});

test("linkedThreads + fan-out: every ACTIVE link, most recent first; unlinked chats get nothing", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "F", ...doc, actor: { kind: "bot", id: "bobby", thread: "perchlive-fo000001", gateway: "perch" } }, deps);
  await s.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by,linked_at) VALUES (?,?,?,?,datetime('now','+1 minute'))", args: [a.id, "bobby", "perchlive-fo000002", "owner-yes"] });
  await s.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by,unlinked_at) VALUES (?,?,?,?,datetime('now'))", args: [a.id, "bobby", "perchlive-fo000003", "owner-yes"] });
  assert.deepEqual((await linkedThreads(s.db, a.id)).map((l) => l.threadId), ["perchlive-fo000002", "perchlive-fo000001"]);
  const sent = [];
  const out = await notifyHub({ db: s.db, artifactId: a.id, n: 1, event: "update", emitExternal: async (thread, frame, o) => { sent.push([thread, o.botId]); return { delivered: true }; } });
  assert.equal(out.fanned, 2);
  assert.deepEqual(sent.map((x) => x[0]).sort(), ["perchlive-fo000001", "perchlive-fo000002"]);
  await s.db.execute({ sql: "UPDATE artifacts SET deleted_at=datetime('now') WHERE id=?", args: [a.id] });
  assert.deepEqual(await linkedThreads(s.db, a.id), [], "a deleted artifact links nowhere");
});

test("one active link per (artifact, chat): a duplicate insert is refused by the index", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "U", ...doc, actor: { kind: "bot", id: "bobby", thread: "perchlive-uq000001", gateway: "perch" } }, deps);
  await assert.rejects(s.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by) VALUES (?,?,?,?)", args: [a.id, "bobby", "perchlive-uq000001", "owner-yes"] }), /UNIQUE/i);
});
