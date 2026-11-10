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
 *      The operator's ruling of 2026-11-10 is that an erase leaves a permanent
 *      TOMBSTONE and sync refuses to re-create a tombstoned item on either
 *      instance, so this is a hard assertion now (it was a `todo` while history
 *      was local-only and sync had no tombstone to consult).
 *
 *   2. A TRASH RESTORE IS NOT SILENTLY UNDONE. Both machines delete the item; A
 *      restores it from its Trash, then B's delete (which was in flight) arrives.
 *
 * Plus the other half of the erase ruling: THE ERASE ITSELF REACHES THE PEER —
 * the peer's copy and its Trash go too, not just this instance's.
 *
 * Case 2's MUTUAL variant stays `todo`: which side wins with a delete still in
 * flight is the operator's call, and sync's delete-wins rule is unchanged by
 * this task (the tombstone above is about erasure, not delete-vs-restore).
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
import { isErased, eraseItems } from "../servers/shared/history/erase.js";

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

test(
  "an erased item is not resurrected by a later sync from the peer that still has it",
  async () => {
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

    // The Trash period passes on A: the item AND its history are erased for good —
    // and the erase leaves a TOMBSTONE (the operator's ruling, 2026-11-10).
    const swept = await sweep(a.db, { now: new Date(Date.now() + 40 * 86_400_000), trashDays: 30 });
    assert.deepEqual(swept.erased.map((e) => e.itemId), ["71"], "A erased the aged Trash item");
    assert.equal(await versionCount(a.db, 71), 0);
    assert.deepEqual(await listVersions(a.db, { itemType: "memory", itemId: 71 }), []);
    assert.equal(await isErased(a.db, "memory", "71"), true, "A recorded the tombstone");

    // B still has the item's history (its own Trash), and brings the memory back:
    // a Trash restore plus an edit, then a sync. A restore is a NORMAL write now,
    // so it emits — the real path passes B's manager. The tombstone refuses both. Whatever sync's tombstone
    // rule is today, A must not resurrect it.
    const restored = await restoreFromTrash(b.db, { itemType: "memory", itemId: 71 }, OWNER, { syncManager: b.mgr });
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
    // local-only, so the two instances legitimately disagree after an erase — until
    // the erasing instance's event reaches the peer; see the test below.)
    assert.ok(await hasMemory(b.db, 71), "B still has its own copy");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
  },
);

/** Turn erase emission ON for one instance (the local `history.erase_sync` setting). */
async function enableEraseSync(db) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES ('history.erase_sync', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [],
  });
}

const tombstoneKeys = async (db) =>
  (await db.execute({ sql: "SELECT item_type, item_id FROM item_erasures", args: [] })).rows
    .map((row) => `${row.item_type}:${row.item_id}`)
    .sort();

test("erasing a starter or maker-lab memory sends nothing to the peer", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    const insert = async (id, content, source = null) => {
      await writeLocal(a.db, "INSERT INTO memories (id, content, source) VALUES (?, ?, ?)", [id, content, source]);
      await a.mgr.emitChange("memories", "insert", { id, content, source, lamport_ts: null });
    };
    await insert(94, "an ordinary memory");
    await insert(95, "a starter demo", "starter");
    await insert(96, "a learner record", "maker-lab");
    await insert(98, "the gate's control");
    assert.ok(await until(async () => (await hasMemory(b.db, 94)) !== null), "the ordinary memory reached the peer");
    assert.ok(await until(async () => (await hasMemory(b.db, 98)) !== null), "and so did the control");
    assert.equal(await hasMemory(b.db, 95), null, "a starter memory never syncs");
    assert.equal(await hasMemory(b.db, 96), null, "nor a Maker Lab one");

    // 1. DEFAULT OFF: erase emission is the operator's switch (history.erase_sync).
    const gated = await eraseItems(
      a.db,
      [{ itemType: "memory", itemId: 98 }],
      OWNER,
      { syncManager: a.mgr },
    );
    assert.equal(gated.emitted, 0, "with the setting off, no erase event leaves the host");
    assert.equal(gated.eraseLamport, null, "and the tombstone is unbounded");
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [99, "a trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 99, content: "a trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 99)) !== null), "the feed drained past it");
    assert.ok(await hasMemory(b.db, 98), "the peer's copy is untouched when emission is off");
    assert.deepEqual(await tombstoneKeys(b.db), [], "and nothing is tombstoned there");

    // 2. ON: only the item that actually syncs is announced.
    await enableEraseSync(a.db);
    const result = await eraseItems(
      a.db,
      [
        { itemType: "memory", itemId: 94 },
        { itemType: "memory", itemId: 95 },
        { itemType: "memory", itemId: 96 },
      ],
      OWNER,
      { syncManager: a.mgr },
    );
    assert.equal(result.versions, 3, "all three were erased HERE");
    assert.equal(result.emitted, 1, "only the memory that syncs at all is announced");
    assert.ok(Number.isFinite(result.eraseLamport), "the erase event's lamport bounds the tombstones");

    assert.ok(
      await until(async () => (await hasMemory(b.db, 94)) === null),
      "the peer applied the erase of the ordinary memory",
    );
    assert.ok(await isErased(b.db, "memory", "94"), "it recorded its own tombstone for it");
    assert.deepEqual(
      await tombstoneKeys(b.db),
      ["memory:94"],
      "and NOTHING for the starter or Maker Lab memory — those erases never left the host",
    );
    assert.ok(await isErased(a.db, "memory", "95"), "locally, the starter erase is still tombstoned");
    assert.ok(await isErased(a.db, "memory", "96"), "and the Maker Lab one too");

    // 3. And a Maker Lab LEARNER erase is never announced, whatever the item says.
    await insert(97, "a memory a learner erase takes");
    assert.ok(await until(async () => (await hasMemory(b.db, 97)) !== null), "the peer has its copy first");
    const learnerErase = await eraseItems(
      a.db,
      [{ itemType: "memory", itemId: 97 }],
      { authorKind: "system", authorId: "maker-lab" },
      { syncManager: a.mgr },
    );
    assert.equal(learnerErase.emitted, 0, "a learner erasure never leaves the host (DATA-HANDLING)");
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [100, "another trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 100, content: "another trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 100)) !== null), "the feed drained past it");
    assert.ok(await hasMemory(b.db, 97), "the peer's copy of the learner's memory is untouched");
    assert.deepEqual(await tombstoneKeys(b.db), ["memory:94"], "and no tombstone was learned for it");
    assert.equal(await isErased(a.db, "memory", "97"), true, "while it IS erased (and tombstoned) here");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("an erase reaches the peer and erases its copy and Trash", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    // Both machines hold memory 73; then both deleted it, so both have it in their
    // own Trash (each instance keeps its own history).
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [73, "erase me everywhere"]);
    await a.mgr.emitChange("memories", "insert", { id: 73, content: "erase me everywhere", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 73)) !== null), "the peer received the insert");
    await writeLocal(a.db, "DELETE FROM memories WHERE id = ?", [73]);
    await a.mgr.emitChange("memories", "delete", { id: 73 });
    assert.ok(await until(async () => (await hasMemory(b.db, 73)) === null), "the peer received the delete");
    assert.equal(await versionCount(b.db, 73), 2, "B's own Trash holds the item's history");
    assert.deepEqual((await listTrash(b.db)).map((e) => e.itemId), ["73"]);

    // A's Trash period passes. The erase emits an `erase` event on the item's own
    // table, through A's real manager (the path the gateway's sweep uses). Erase
    // emission is behind the local `history.erase_sync` setting (default OFF — no
    // peer capability to gate on yet), so the operator turns it on here.
    await enableEraseSync(a.db);
    const swept = await sweep(a.db, {
      now: new Date(Date.now() + 40 * 86_400_000),
      trashDays: 30,
      syncManager: a.mgr,
    });
    assert.deepEqual(swept.erased.map((e) => e.itemId), ["73"]);
    assert.equal(swept.eraseEvents, 1, "the erase reached the sync layer");

    // B deletes its live row (none left) and erases its own versions, and writes
    // its own tombstone: the item is gone from B's Trash too, not just from A's.
    assert.ok(
      await until(async () => (await versionCount(b.db, 73)) === 0),
      "the peer erased its own history for the item",
    );
    assert.deepEqual(await listTrash(b.db), [], "and its Trash no longer lists it");
    assert.equal(await isErased(b.db, "memory", "73"), true, "the peer recorded the tombstone too");

    // Both tombstones name who erased what, and where it came from.
    const aTomb = (await a.db.execute({ sql: "SELECT * FROM item_erasures", args: [] })).rows;
    const bTomb = (await b.db.execute({ sql: "SELECT * FROM item_erasures", args: [] })).rows;
    assert.equal(aTomb.length, 1);
    assert.equal(aTomb[0].item_type, "memory");
    assert.equal(aTomb[0].item_id, "73");
    assert.equal(aTomb[0].erased_by, "system:history-sweep");
    assert.equal(bTomb.length, 1, "the peer's tombstone is its own row");
    assert.equal(bTomb[0].item_id, "73");
    assert.equal(bTomb[0].origin_instance, a.mgr.localInstanceId, "and records which instance erased it");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("both deletes are exchanged, then A restores from Trash, and B's next (stale) sync does not delete it again (review focus 4, sequential)", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);

    // The same memory on both machines (each instance wrote its own copy).
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [78, "shared draft"]);
    await writeLocal(b.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [78, "shared draft"]);
    link = await linkPeers(a, b);

    // Both delete. A's delete reaches B and B's reaches A — the deletes are
    // exchanged BEFORE A restores anything.
    await writeLocal(a.db, "DELETE FROM memories WHERE id = ?", [78]);
    await a.mgr.emitChange("memories", "delete", { id: 78 });
    await writeLocal(b.db, "DELETE FROM memories WHERE id = ?", [78]);
    const bDeleteLamport = await b.mgr.emitChange("memories", "delete", { id: 78 });
    assert.ok(
      await until(async () => (await hasMemory(a.db, 78)) === null && (await hasMemory(b.db, 78)) === null),
      "both deletes were applied on both machines",
    );

    // A restores from its Trash. The restore is a normal write, so it emits and
    // mints a fresh lamport that out-ranks the delete both sides already hold.
    const restored = await restoreFromTrash(a.db, { itemType: "memory", itemId: 78 }, OWNER, { syncManager: a.mgr });
    assert.ok(restored.newVersionId);
    assert.equal(restored.synced, true);
    assert.ok(
      await until(async () => (await hasMemory(b.db, 78))?.content === "shared draft"),
      "the peer received the restore as an insert",
    );

    // B's next sync re-delivers its old delete (preserved lamport, as a delayed
    // entry would). It must lose to the restore's fresh lamport.
    await b.mgr.emitChange("memories", "delete", { id: 78 }, { lamportTs: Number(bDeleteLamport) });
    await writeLocal(b.db, "UPDATE memories SET content = ? WHERE id = ?", ["B's later edit", 78]);
    await b.mgr.emitChange("memories", "update", { id: 78, content: "B's later edit", lamport_ts: null });
    assert.ok(
      await until(async () => (await hasMemory(a.db, 78))?.content === "B's later edit"),
      "B's later edit reached A, so the feed was drained past the stale delete",
    );

    assert.ok(await hasMemory(a.db, 78), "A's restore is not silently undone by B's stale delete");
    assert.deepEqual(await listTrash(a.db), [], "and the item is not back in A's Trash");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

// The MUTUAL case, where both deletes are issued and A restores while one of them
// is still in flight, remains the operator's call. The sequential case above is
// the one this task can promise: once both deletes have been applied, the restore
// mints a lamport above them. With one still outstanding, which side wins depends
// on counter order and on sync's delete-wins conflict rule (§8.3: the protocol
// does not change in this task), so it is kept as a `todo` rather than asserted.
test(
  "both delete, A restores from Trash, and B's in-flight delete does not undo it (review focus 4, concurrent)",
  { todo: "the operator's ruling (2026-11-10) covers ERASURE, not concurrent delete-vs-restore: which side wins while B's delete is still in flight depends on counter order, and sync's delete-wins rule is NOT changed by this task. The sequential case above proves a restore out-ranks deletes it has already seen; the mutual ordering is the operator's call" },
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