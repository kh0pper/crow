/**
 * Studio store: the bundle tables, the update log, snapshots and the shared
 * history. Every test runs against its own scratch crow.db in a temp dir, so
 * nothing here can touch a real instance database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import {
  appendHistory,
  appendUpdate,
  createSongRow,
  getSongRow,
  listHistory,
  listSongs,
  loadUpdates,
  markUndone,
  writeSnapshot,
} from "../bundles/studio/server/store.js";

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/** A fake Yjs update blob. */
const bytes = (...values) => new Uint8Array(values);

/** Blob contents as a plain array, for deepEqual. */
const toArray = (blob) => Array.from(blob);

test("initStudioTables twice is a no-op", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);
  const { id } = await createSongRow(db, { project_id: 12, title: "First light" });

  await initStudioTables(db); // must not throw, must not wipe anything

  const songs = await listSongs(db, { project_ids: [12] });
  assert.equal(songs.length, 1);
  assert.equal(songs[0].id, id);
  assert.equal(songs[0].title, "First light");
  assert.deepEqual(await loadUpdates(db, id), []);
  assert.deepEqual(await listHistory(db, id), []);
});

test("appendUpdate assigns increasing seq per song", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);
  const first = await createSongRow(db, { project_id: 3, title: "Draft one" });
  const second = await createSongRow(db, { project_id: 3, title: "Draft two" });

  assert.equal(await appendUpdate(db, first.id, bytes(1)), 1);
  assert.equal(await appendUpdate(db, first.id, bytes(2)), 2);
  assert.equal(await appendUpdate(db, first.id, bytes(3)), 3);
  assert.equal(await appendUpdate(db, second.id, bytes(9)), 1, "seq is per song, not global");

  assert.deepEqual((await loadUpdates(db, first.id)).map(toArray), [[1], [2], [3]]);
  assert.deepEqual((await loadUpdates(db, second.id)).map(toArray), [[9]]);

  const row = await getSongRow(db, first.id);
  assert.equal(row.snapshot, null);
  assert.equal(row.snapshot_seq, 0);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("loadUpdates returns only updates after snapshot_seq", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);
  const { id } = await createSongRow(db, { project_id: 4, title: "Loop" });

  await appendUpdate(db, id, bytes(1));
  await appendUpdate(db, id, bytes(2));
  await appendUpdate(db, id, bytes(3));

  await writeSnapshot(db, id, bytes(1, 1), 1);
  assert.deepEqual((await loadUpdates(db, id)).map(toArray), [[2], [3]]);

  await writeSnapshot(db, id, bytes(2, 2), 3);
  assert.deepEqual(await loadUpdates(db, id), [], "nothing newer than a snapshot that covers it all");
});

test("createSongRow refuses the 501st song in a project", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);

  for (let i = 0; i < 500; i++) {
    await createSongRow(db, { project_id: 7, title: `Song ${i + 1}` });
  }

  await assert.rejects(
    () => createSongRow(db, { project_id: 7, title: "One too many" }),
    /500 songs/,
  );
  assert.equal((await listSongs(db, { project_ids: [7] })).length, 500);

  // The limit is per project, not per instance.
  const { id } = await createSongRow(db, { project_id: 8, title: "Another project" });
  assert.ok(id);
});

test("writeSnapshot then loadUpdates returns only later updates", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);
  const { id } = await createSongRow(db, { project_id: 5, title: "Sketch" });

  await appendUpdate(db, id, bytes(10));
  await appendUpdate(db, id, bytes(20));
  await appendUpdate(db, id, bytes(30));

  const state = bytes(0xaa, 0xbb);
  await writeSnapshot(db, id, state, 2);

  const row = await getSongRow(db, id);
  assert.deepEqual(toArray(row.snapshot), [0xaa, 0xbb]);
  assert.equal(row.snapshot_seq, 2);

  await appendUpdate(db, id, bytes(40));
  assert.deepEqual((await loadUpdates(db, id)).map(toArray), [[30], [40]]);
});

test("markUndone sets undone_by", async (t) => {
  const db = scratchDb(t);
  await initStudioTables(db);
  const { id } = await createSongRow(db, { project_id: 6, title: "Take" });
  const human = { kind: "human", id: "local", label: "You" };

  const written = await appendHistory(db, {
    song_id: id,
    seq: 1,
    command: "clip.write",
    args: { clip_id: "clip-1", notes: [] },
    author: human,
    summary: "Wrote an empty clip",
    touched: ["clip:clip-1"],
    before: { "clip:clip-1.notes": undefined },
    after: { "clip:clip-1.notes": [] },
  });
  const undone = await appendHistory(db, {
    song_id: id,
    seq: 2,
    command: "history.undo",
    args: { entry_id: written },
    author: human,
    summary: "Undid \"Wrote an empty clip\"",
    touched: ["clip:clip-1"],
    inverse: { before: { "clip:clip-1.notes": [] }, after: { "clip:clip-1.notes": undefined } },
    undo_of: written,
  });

  await markUndone(db, written, undone);

  const entries = await listHistory(db, id);
  assert.deepEqual(entries.map((e) => e.id), [undone, written], "newest first");
  const target = entries.find((e) => e.id === written);
  assert.equal(target.undone_by, undone);
  assert.equal(target.undo_of, null);
  assert.equal(entries.find((e) => e.id === undone).undo_of, written);
  assert.deepEqual(target.args, { clip_id: "clip-1", notes: [] });
  assert.deepEqual(target.author, human);
  assert.deepEqual(target.touched, ["clip:clip-1"]);
  assert.deepEqual(target.inverse.after, { "clip:clip-1.notes": [] });
});