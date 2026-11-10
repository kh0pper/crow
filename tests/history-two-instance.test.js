/**
 * Version history, Task 4: the two-instance cases (review focus 4).
 *
 * The real two-instance harness — tests/fixtures/sync-fleet.mjs — gives each side
 * a real init-db store, a real InstanceSyncManager and real Hypercore feeds over a
 * real Noise stream, with migration 0024 applied so each instance records the
 * versions of what it applies.
 *
 * Two questions, and only these two:
 *
 *   1. AN ERASED ITEM IS NOT RESURRECTED. A deletes a memory, B receives the
 *      delete, A's Trash period passes and A erases it. B later brings its own
 *      copy back (B still holds the history) and syncs an edit: A must stay empty.
 *
 *   2. A TRASH RESTORE IS NOT SILENTLY UNDONE. Both machines delete the item; A
 *      restores it from its Trash, then B's delete (which was in flight) arrives.
 *
 * Case 2 is marked `todo` when sync's own delete-wins rule removes the restored
 * row again — see the note on the test. Changing sync rules is NOT part of this
 * task: the version history design §8.3 says the sync protocol does not change,
 * and a mutual-case ruling belongs to the operator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makeFleet, linkPeers, until, sleep } from "./fixtures/sync-fleet.mjs";
import { run as migrate } from "../scripts/migrations/0024-item-versions.mjs";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import { listVersions, restoreVersion } from "../servers/shared/history/api.js";
import { listTrash, restoreFromTrash } from "../servers/shared/history/trash.js";
import { sweep } from "../servers/shared/history/sweep.js";

/** The owner's dashboard session on either machine (each instance has its own). */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };

/** Migration 0024 on one side's store, so its writes are captured from now on. */
function migrateSide(side) {
  migrate({ dbPath: join(side.dir, "crow.db"), log: () => {} });
}

const hasMemory = async (db, id) =>
  (await db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] })).rows[0] || null;

const versionCount = async (db, id) =>
  Number((await db.execute({
    sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory' AND item_id = ?",
    args: [String(id)],
  })).rows[0].n);

/** A local write inside the owner's context (so its version is attributed). */
async function writeLocal(db, sql, args = []) {
  return withWriteContext(OWNER, () => db.execute({ sql, args }));
}

/* ---------------------------------------- a restore is a normal synced write */

test("a restored memory reaches the paired instance and a later peer edit does not silently undo it", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    // A writes v1 and then v2; both reach B, so both machines hold "draft two".
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [81, "draft one"]);
    await a.mgr.emitChange("memories", "insert", { id: 81, content: "draft one", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 81)) !== null), "the peer received the insert");
    await writeLocal(a.db, "UPDATE memories SET content = ? WHERE id = ?", ["draft two", 81]);
    await a.mgr.emitChange("memories", "update", { id: 81, content: "draft two", lamport_ts: null });
    assert.ok(
      await until(async () => (await hasMemory(b.db, 81))?.content === "draft two"),
      "the peer received the edit",
    );

    // A restores v1. A restore is a normal write now, so it emits — and mints the
    // fresh lamport_ts the row needs to out-rank B's stale copy.
    const v1 = (await listVersions(a.db, { itemType: "memory", itemId: 81 })).at(-1);
    assert.equal(v1.snapshot.content, "draft one");
    const res = await restoreVersion(a.db, { versionId: v1.id, syncManager: a.mgr }, OWNER);
    assert.equal(res.unchanged, false);
    assert.ok(
      await until(async () => (await hasMemory(b.db, 81))?.content === "draft one"),
      "the peer received the restore",
    );
    assert.equal(res.synced, true, "the restore was emitted, not just written locally");

    // B then edits the memory. The emit is a FULL row — what a peer that never saw
    // the restore sends: its own copy, which would carry "draft two" back over it.
    const { lamport_ts: _ignored, ...bRow } = (
      await b.db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [81] })
    ).rows[0];
    assert.equal(bRow.content, "draft one", "B's copy already holds the restored value");
    await writeLocal(b.db, "UPDATE memories SET tags = ? WHERE id = ?", ["tagged-on-b", 81]);
    await b.mgr.emitChange("memories", "update", { ...bRow, tags: "tagged-on-b" });
    const reached = await until(async () => (await hasMemory(a.db, 81))?.tags === "tagged-on-b");
    assert.ok(reached, "the peer's later edit reached A");

    const aRow = await hasMemory(a.db, 81);
    assert.equal(aRow.content, "draft one", "the peer's later edit did not carry the pre-restore value back");
    assert.equal(aRow.tags, "tagged-on-b", "the later edit itself did apply");
    assert.equal(
      await versionCount(a.db, 81),
      4,
      "A's history: insert + edit + the restore + the peer's edit (as its own version)",
    );
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("restoring a deleted memory recreates it on the peer", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [82, "restore me"]);
    await a.mgr.emitChange("memories", "insert", { id: 82, content: "restore me", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 82)) !== null), "the peer received the insert");

    // A deletes it and the delete reaches B: the row is gone on both machines.
    await writeLocal(a.db, "DELETE FROM memories WHERE id = ?", [82]);
    await a.mgr.emitChange("memories", "delete", { id: 82 });
    assert.ok(await until(async () => (await hasMemory(b.db, 82)) === null), "the peer received the delete");

    // A restores it from its own Trash. Emitted as an INSERT, so the peer recreates
    // the row instead of staying empty until someone edits it there.
    const back = await restoreFromTrash(a.db, { itemType: "memory", itemId: 82 }, OWNER, { syncManager: a.mgr });
    assert.ok(back.newVersionId, "the restore is a new version");
    assert.ok(await hasMemory(a.db, 82), "the row is back here");

    assert.ok(
      await until(async () => (await hasMemory(b.db, 82))?.content === "restore me"),
      "and the peer has it again, with the value the delete removed",
    );
    assert.equal(back.synced, true, "the un-delete was emitted");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("an erased item is not resurrected by a later sync from the peer that still has it", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    // A writes the memory and syncs it: both machines hold id 71.
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [71, "the first draft"]);
    await a.mgr.emitChange("memories", "insert", { id: 71, content: "the first draft", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 71)) !== null), "the peer received the insert");

    // A deletes it; the delete reaches B (each machine keeps its own Trash).
    await writeLocal(a.db, "DELETE FROM memories WHERE id = ?", [71]);
    await a.mgr.emitChange("memories", "delete", { id: 71 });
    assert.ok(await until(async () => (await hasMemory(b.db, 71)) === null), "the peer received the delete");
    assert.equal(await versionCount(a.db, 71), 2, "A's own history: insert + delete");
    assert.equal(await versionCount(b.db, 71), 2, "B's own history too: the delete it applied is a version");

    // The Trash period passes on A: the item AND its history are erased for good.
    const swept = await sweep(a.db, { now: new Date(Date.now() + 40 * 86_400_000), trashDays: 30 });
    assert.deepEqual(swept.erased.map((e) => e.itemId), ["71"], "A erased the aged Trash item");
    assert.equal(await versionCount(a.db, 71), 0);
    assert.deepEqual(await listVersions(a.db, { itemType: "memory", itemId: 71 }), []);

    // B still has the item's history (its own Trash), and brings the memory back:
    // a Trash restore plus an edit, then a sync. Whatever sync's tombstone rule is
    // today, A must not resurrect it.
    const restored = await restoreFromTrash(b.db, { itemType: "memory", itemId: 71 }, OWNER);
    assert.ok(restored.newVersionId, "B restored its copy");
    await writeLocal(b.db, "UPDATE memories SET content = ? WHERE id = ?", ["edited after the erase", 71]);
    await b.mgr.emitChange("memories", "update", { id: 71, content: "edited after the erase", lamport_ts: null });

    // A trailing unrelated entry proves A drained B's feed past that update.
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [72, "trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 72, content: "trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 72)) !== null), "the trailing entry reached B");
    await sleep(300);

    assert.equal(await hasMemory(a.db, 71), null, "A does not resurrect the erased item");
    assert.equal(await versionCount(a.db, 71), 0, "and it wrote no history for it either");

    // B's copy is a different story: it exists there, with its history. (History is
    // local-only, so the two instances legitimately disagree after an erase.)
    assert.ok(await hasMemory(b.db, 71), "B still has its own copy");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

// Rising: the delete is already in flight when A restores. Expected today: A's
// restored row comes back with lamport_ts 0 (a restore writes the snapshot, and
// lamport_ts is a counter, not content), so B's delete — a higher Lamport — wins
// and removes it again. That is sync's delete-wins rule doing exactly what it is
// specified to do (§8.3: the protocol does not change in this task), which is why
// this test is a `todo` rather than a fix: closing it is the operator's call.
test(
  "both delete, A restores from Trash, and B's in-flight delete does not undo it (review focus 4)",
  { todo: "sync applies a peer's outstanding delete over the restored row: a restore re-inserts the snapshot columns only, so the row carries lamport_ts 0 and the peer's delete (a higher Lamport) wins and removes it again — the delete-wins rule this task may not change" },
  async () => {
    const fleet = await makeFleet();
    let link;
    try {
      const { a, b } = fleet;
      migrateSide(a);
      migrateSide(b);

      // The same memory on both machines (each instance wrote its own copy).
      await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [77, "shared draft"]);
      await writeLocal(b.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [77, "shared draft"]);

      // Both delete it — while the peers are NOT linked, so nothing is delivered yet.
      await writeLocal(a.db, "DELETE FROM memories WHERE id = ?", [77]);
      await writeLocal(b.db, "DELETE FROM memories WHERE id = ?", [77]);
      // B announces its delete now: with no peer armed, the entry parks and drains
      // when the link comes up (the boot-window path, 2c C3).
      await b.mgr.emitChange("memories", "delete", { id: 77 });

      // A restores its copy from the Trash before it has heard from B at all.
      const restored = await restoreFromTrash(a.db, { itemType: "memory", itemId: 77 }, OWNER);
      assert.ok(restored.newVersionId);
      assert.ok(await hasMemory(a.db, 77), "A's restore put the row back");

      // Now the link comes up and B's delete arrives.
      link = await linkPeers(a, b);
      await sleep(500);

      assert.ok(await hasMemory(a.db, 77), "A's restore is not silently undone by B's delete");
      assert.deepEqual(await listTrash(a.db), [], "and the item is not back in A's Trash");
    } finally {
      link?.close();
      await fleet.cleanup();
    }
  },
);