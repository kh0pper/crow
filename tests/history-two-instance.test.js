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
 *      delete, A's Trash period passes and A erases it. With erase sync switched
 *      on at both ends (the operator's fleet-wide decision — it is opt-in on the
 *      sender AND the receiver), the erase reaches B, so B's copy and Trash go
 *      too and neither instance can bring the item back. The operator's ruling of
 *      2026-11-10 is that an erase leaves a permanent TOMBSTONE and sync refuses
 *      to re-create a tombstoned item on either instance.
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
import { run as migrateMore } from "../scripts/migrations/0025-item-versions-more.mjs";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import { listVersions, restoreVersion } from "../servers/shared/history/api.js";
import { listTrash, restoreFromTrash } from "../servers/shared/history/trash.js";
import { sweep } from "../servers/shared/history/sweep.js";
import { isErased, eraseItems } from "../servers/shared/history/erase.js";

/** The owner's dashboard session on either machine (each instance has its own). */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };

/**
 * Both history migrations on one side's store, so its writes are captured from now
 * on: 0024 owns memories/posts/sections, 0025 owns the rest of the covered content
 * (research notes among them). 0025 with no `tasksDbPath` installs the crow.db types
 * and defers the card half, which is all this file needs — the card store is another
 * database and is covered by tests/history-tasks-store.test.js.
 */
function migrateSide(side) {
  const dbPath = join(side.dir, "crow.db");
  migrate({ dbPath, log: () => {} });
  migrateMore({ dbPath, log: () => {} });
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

    // ERASE SYNC IS THE OPERATOR'S FLEET-WIDE DECISION, TAKEN ON BOTH SIDES: an
    // erase only travels when the sender emits it AND the receiver applies it, so
    // both instances are opted in here.
    await enableEraseSync(a.db);
    await enableEraseSync(b.db);

    // The Trash period passes on A: the item AND its history are erased for good —
    // and the erase leaves a TOMBSTONE (the operator's ruling, 2026-11-10) and
    // travels to B, whose copy and Trash go too.
    const swept = await sweep(a.db, {
      now: new Date(Date.now() + 40 * 86_400_000),
      trashDays: 30,
      syncManager: a.mgr,
    });
    assert.deepEqual(swept.erased.map((e) => e.itemId), ["71"], "A erased the aged Trash item");
    assert.equal(swept.eraseEvents, 1, "the erase reached the sync layer");
    assert.equal(await versionCount(a.db, 71), 0);
    assert.deepEqual(await listVersions(a.db, { itemType: "memory", itemId: 71 }), []);
    assert.equal(await isErased(a.db, "memory", "71"), true, "A recorded the tombstone");
    assert.ok(
      await until(async () => (await versionCount(b.db, 71)) === 0),
      "the peer erased its own history for the item",
    );
    assert.equal(await isErased(b.db, "memory", "71"), true, "the peer recorded the tombstone too");

    // B cannot bring it back: its own tombstone refuses the Trash restore, so the
    // "peer that still has it" no longer does — and nothing it sends can re-create
    // the item here either.
    await assert.rejects(
      () => restoreFromTrash(b.db, { itemType: "memory", itemId: 71 }, OWNER, { syncManager: b.mgr }),
      (err) => err.code === "erased",
      "the erased item is not restorable on the peer either",
    );

    // A re-delivery of B's old copy (a stale entry, at or below the erase's lamport)
    // is refused by A's tombstone.
    await b.mgr.emitChange("memories", "insert", { id: 71, content: "a stale copy", lamport_ts: null }, { lamportTs: 3 });
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [72, "trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 72, content: "trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 72)) !== null), "the trailing entry reached B");
    await sleep(300);

    assert.equal(await hasMemory(a.db, 71), null, "A does not resurrect the erased item");
    assert.equal(await versionCount(a.db, 71), 0, "and it wrote no history for it either");
    assert.equal(await hasMemory(b.db, 71), null, "nor does the peer re-create its own copy");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
  },
);

/* ------------ a RESEARCH NOTE's erase travels and sticks (its sync uuid) ---- */

/** One note row on a side, by its sync uuid (the key it is deleted by on the wire). */
async function noteByUuid(db, uuid) {
  const { rows } = await db.execute({ sql: "SELECT * FROM research_notes WHERE uuid = ?", args: [uuid] });
  return rows[0] || null;
}

const noteVersionCount = async (db, id) =>
  Number((await db.execute({
    sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'research_note' AND item_id = ?",
    args: [String(id)],
  })).rows[0].n);

test("an erased research note stays erased against the peer, keyed by its sync uuid", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    // A note syncs by its own uuid on the delete path (DELETE_KEY_POLICY), so that is
    // the identity a peer's later write for it arrives under — and therefore the key
    // the tombstone has to carry.
    const NOTE_UUID = "0123456789abcdef0123456789abcdef";
    const wire = (content) => ({
      id: 91,
      uuid: NOTE_UUID,
      title: "A note",
      content,
      note_type: "note",
      lamport_ts: null,
    });
    await writeLocal(a.db, "INSERT INTO research_notes (id, uuid, title, content) VALUES (?, ?, 'A note', ?)", [
      91,
      NOTE_UUID,
      "the first body",
    ]);
    await a.mgr.emitChange("research_notes", "insert", wire("the first body"));
    assert.ok(await until(async () => (await noteByUuid(b.db, NOTE_UUID)) !== null), "the peer received the note");

    // Both machines delete it (each keeps its own Trash), and A's Trash period passes.
    await writeLocal(a.db, "DELETE FROM research_notes WHERE id = ?", [91]);
    await a.mgr.emitChange("research_notes", "delete", { uuid: NOTE_UUID });
    assert.ok(await until(async () => (await noteByUuid(b.db, NOTE_UUID)) === null), "the peer received the delete");
    assert.equal(await noteVersionCount(a.db, 91), 2, "A's history: insert + delete");
    assert.equal(await noteVersionCount(b.db, 91), 2, "B's own history too");

    // Erase sync is the operator's fleet-wide decision, taken on BOTH sides.
    await enableEraseSync(a.db);
    await enableEraseSync(b.db);
    const swept = await sweep(a.db, {
      now: new Date(Date.now() + 40 * 86_400_000),
      trashDays: 30,
      syncManager: a.mgr,
    });
    assert.deepEqual(swept.erased.map((e) => e.itemType), ["research_note"], "A erased the aged note");
    assert.equal(swept.eraseEvents, 1, "the erase reached the sync layer");
    assert.equal(await noteVersionCount(a.db, 91), 0);
    // The tombstone is keyed by the note's SYNC UUID as well as its local id, which is
    // what makes a peer write that names the note by uuid refusable.
    assert.equal(await isErased(a.db, "research_note", NOTE_UUID), true, "A tombstoned the note under its uuid");
    assert.equal(await isErased(a.db, "research_note", "91"), true, "and under its local id");

    // The peer applied the erase: its own copy and Trash go, and it records its own
    // tombstone (keyed the same way).
    assert.ok(
      await until(async () => (await noteVersionCount(b.db, 91)) === 0),
      "the peer erased its own history for the note",
    );
    assert.equal(await isErased(b.db, "research_note", NOTE_UUID), true, "the peer recorded the uuid tombstone too");
    await assert.rejects(
      () => restoreFromTrash(b.db, { itemType: "research_note", itemId: 91 }, OWNER, { syncManager: b.mgr }),
      (err) => err.code === "erased",
      "and a Trash restore of it is refused on the peer",
    );

    // The peer then sends the note again — under a DIFFERENT local id, but the same
    // uuid (its portable identity), and at a STALE lamport (the entry a peer that
    // still holds its copy re-delivers). A must not re-create it: the tombstone is
    // keyed by the uuid, not only by the rowid the two instances happened to share.
    await b.mgr.emitChange("research_notes", "insert", { ...wire("the peer's stale copy"), id: 99 }, { lamportTs: 3 });
    // A trailing entry on another item proves the feed was drained past it.
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [95, "trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 95, content: "trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 95)) !== null), "the trailing entry reached the peer");
    await sleep(300);

    assert.equal(await noteByUuid(a.db, NOTE_UUID), null, "A does not re-create the erased note");
    assert.equal(await noteVersionCount(a.db, 99), 0, "and it wrote no history for it either");
    assert.equal(await noteVersionCount(a.db, 91), 0);

    // AND WITH EMISSION OFF (the default) THE TOMBSTONE IS UNBOUNDED, exactly as for a
    // memory: a genuinely LATER write from the peer for that uuid is refused too,
    // because nothing was ever announced (the operator's ruling, 2026-11-10).
    const SECOND_UUID = "fedcba9876543210fedcba9876543210";
    await writeLocal(a.db, "INSERT INTO research_notes (id, uuid, title, content) VALUES (?, ?, 'Another note', ?)", [
      92,
      SECOND_UUID,
      "the second note",
    ]);
    await a.mgr.emitChange("research_notes", "insert", {
      id: 92,
      uuid: SECOND_UUID,
      title: "Another note",
      content: "the second note",
      note_type: "note",
      lamport_ts: null,
    });
    assert.ok(await until(async () => (await noteByUuid(b.db, SECOND_UUID)) !== null), "the peer has the second note too");
    await writeLocal(a.db, "DELETE FROM research_notes WHERE id = ?", [92]);
    await a.mgr.emitChange("research_notes", "delete", { uuid: SECOND_UUID });
    assert.ok(await until(async () => (await noteByUuid(b.db, SECOND_UUID)) === null), "and applied the delete");
    await setEraseSync(a.db, "0");
    const gated = await sweep(a.db, {
      now: new Date(Date.now() + 40 * 86_400_000),
      trashDays: 30,
      syncManager: a.mgr,
    });
    assert.deepEqual(gated.erased.map((e) => e.itemId), ["92"], "with erase sync off, A still erases its own copy");
    assert.equal(gated.eraseEvents, 0, "but announces nothing");
    assert.equal(await isErased(a.db, "research_note", SECOND_UUID), true);

    // The peer's copy comes back with a FRESH lamport (a genuinely later write). An
    // unbounded tombstone refuses it: the peers were told nothing, so "erased" means
    // erased here for good.
    await writeLocal(b.db, "INSERT INTO research_notes (id, uuid, title, content) VALUES (?, ?, 'Another note', ?)", [
      100,
      SECOND_UUID,
      "the peer's new copy",
    ]);
    await b.mgr.emitChange("research_notes", "insert", {
      id: 100,
      uuid: SECOND_UUID,
      title: "Another note",
      content: "the peer's new copy",
      note_type: "note",
      lamport_ts: null,
    });
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [96, "another trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 96, content: "another trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 96)) !== null), "the feed drained past it");
    await sleep(300);

    assert.equal(await noteByUuid(a.db, SECOND_UUID), null, "an unannounced erase refuses a genuinely later peer write");
    assert.equal(await noteVersionCount(a.db, 100), 0);
    assert.equal((await noteByUuid(b.db, SECOND_UUID))?.content, "the peer's new copy", "the peer's copy stays on the peer");

    // A DIFFERENT note (another uuid) from the peer that merely carries the erased
    // note's numeric id is a different note: the id is local to its sender, so a note
    // that has a uuid is matched by the uuid alone and this one is accepted.
    const THIRD_UUID = "aaaabbbbccccddddeeeeffff00001111";
    await writeLocal(b.db, "INSERT INTO research_notes (id, uuid, title, content) VALUES (?, ?, 'Third note', ?)", [
      101,
      THIRD_UUID,
      "same id, other note",
    ]);
    await b.mgr.emitChange("research_notes", "insert", {
      id: 92,
      uuid: THIRD_UUID,
      title: "Third note",
      content: "same id, other note",
      note_type: "note",
      lamport_ts: null,
    });
    assert.ok(
      await until(async () => (await noteByUuid(a.db, THIRD_UUID)) !== null),
      "a peer note with another uuid but an erased note's id is accepted",
    );
    assert.equal(await noteByUuid(a.db, SECOND_UUID), null, "while the erased uuid stays refused");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

/** Set one instance's erase-emission setting (the local `history.erase_sync`). */
async function setEraseSync(db, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES ('history.erase_sync', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [String(value)],
  });
}

/** Turn erase emission ON for one instance (the local `history.erase_sync` setting). */
async function enableEraseSync(db) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES ('history.erase_sync', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [],
  });
}

/** One global (device-less, project-less) context section's content on a side, or null. */
async function sectionContent(db, sectionKey) {
  const { rows } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
    args: [sectionKey],
  });
  return rows[0] ? rows[0].content : null;
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
    assert.equal(gated.eraseLamport, null, "and there is no event lamport to report");
    // The item SYNCS and nothing was announced, so its tombstone is UNBOUNDED (the
    // operator's ruling, 2026-11-10): erased stays erased here, and the peer's copy
    // simply stays on the peer.
    const boundOf = async (itemId) =>
      (await a.db.execute({
        sql: "SELECT erase_lamport FROM item_erasures WHERE item_type = 'memory' AND item_id = ?",
        args: [String(itemId)],
      })).rows[0]?.erase_lamport;
    assert.equal(await boundOf(98), null, "the unannounced erase of a syncing item is unbounded");
    await writeLocal(a.db, "INSERT INTO memories (id, content) VALUES (?, ?)", [99, "a trailing marker"]);
    await a.mgr.emitChange("memories", "insert", { id: 99, content: "a trailing marker", lamport_ts: null });
    assert.ok(await until(async () => (await hasMemory(b.db, 99)) !== null), "the feed drained past it");
    assert.ok(await hasMemory(b.db, 98), "the peer's copy is untouched when emission is off");
    assert.deepEqual(await tombstoneKeys(b.db), [], "and nothing is tombstoned there");

    // 2. ON: only the item that actually syncs is announced. (Erase sync is opt-in
    // on the RECEIVER too, so B turns it on as well.)
    await enableEraseSync(a.db);
    await enableEraseSync(b.db);
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
    // Neither of those ever syncs, so there is no peer write to refuse and their
    // tombstones may stay counter-bounded (the tight bound).
    for (const id of [95, 96]) {
      const bound = await boundOf(id);
      assert.ok(Number.isFinite(Number(bound)), `memory/${id} never syncs, so its tombstone keeps the counter (got ${bound})`);
    }

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
    assert.equal(await boundOf(97), null, "and its tombstone is unbounded: the item syncs and nothing was announced");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("an erase reaches the peer and erases its copy and Trash", async () => {  const fleet = await makeFleet();
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
    // peer capability to gate on yet), and the RECEIVER requires it too, so the
    // operator turns it on at BOTH ends.
    await enableEraseSync(a.db);
    await enableEraseSync(b.db);
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

/* ------------ an UNANNOUNCED erase is UNBOUNDED (the operator's ruling) ----- */

test("with erase sync off, an erased section refuses later peer writes for that name", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    migrateSide(a);
    migrateSide(b);
    link = await linkPeers(a, b);

    // A writes a global section and edits it; both reach B, so both machines hold it
    // and A's own Trash later holds its history.
    const wire = (content) => ({
      section_key: "reborn-section", section_title: "Section", content,
      sort_order: 1, enabled: 1, device_id: null, lamport_ts: null,
    });
    await writeLocal(a.db, "INSERT INTO crow_context (section_key, section_title, content) VALUES ('reborn-section', 'Section', 'first body')");
    await a.mgr.emitChange("crow_context", "insert", wire("first body"));
    assert.ok(
      await until(async () => (await sectionContent(b.db, "reborn-section")) === "first body"),
      "the peer received the section",
    );

    // A deletes it (its own Trash) and the delete reaches B (B's own Trash).
    await writeLocal(a.db, "DELETE FROM crow_context WHERE section_key = 'reborn-section'");
    await a.mgr.emitChange("crow_context", "delete", { section_key: "reborn-section", device_id: null, lamport_ts: null });
    assert.ok(
      await until(async () => (await sectionContent(b.db, "reborn-section")) === null),
      "the peer received the delete",
    );

    // A's Trash period passes. Erase emission is OFF (the default), so no erase
    // event leaves A — and THE ITEM SYNCS, so its tombstone is UNBOUNDED (the
    // operator's ruling, 2026-11-10): the peers were told nothing, so "erased" has
    // to mean erased here for good.
    const swept = await sweep(a.db, {
      now: new Date(Date.now() + 40 * 86_400_000),
      trashDays: 30,
      syncManager: a.mgr,
    });
    assert.deepEqual(swept.erased.map((e) => e.itemType), ["context_section"], "A erased the aged Trash section");
    assert.equal(swept.eraseEvents, 0, "with erase sync off, no erase event leaves the host");
    const bound = (await a.db.execute({
      sql: "SELECT erase_lamport FROM item_erasures WHERE item_type = 'context_section'",
      args: [],
    })).rows[0];
    assert.ok(bound, "the tombstone is there");
    assert.equal(bound.erase_lamport, null, "and it is UNBOUNDED: an unannounced erase refuses every later write");

    // B writes a section under that name, AFTER the erase. A refuses it: the erased
    // name stays erased here, and B's copy simply stays on B (the accepted cost of
    // the ruling). This is the case that used to sync in, when an unannounced erase
    // was bounded to the local counter.
    await writeLocal(b.db, "INSERT INTO crow_context (section_key, section_title, content) VALUES ('reborn-section', 'A new section', 'new body')");
    await b.mgr.emitChange("crow_context", "insert", wire("new body"));
    await writeLocal(b.db, "INSERT INTO crow_context (section_key, section_title, content) VALUES ('marker-section', 'Marker', 'the feed drained')");
    await b.mgr.emitChange("crow_context", "insert", {
      section_key: "marker-section", section_title: "Marker", content: "the feed drained",
      sort_order: 2, enabled: 1, device_id: null, lamport_ts: null,
    });
    assert.ok(
      await until(async () => (await sectionContent(a.db, "marker-section")) === "the feed drained"),
      "the feed drained past the re-created section",
    );
    await sleep(300);

    assert.equal(
      await sectionContent(a.db, "reborn-section"),
      null,
      "with erase sync off, an erased section refuses later peer writes for that name",
    );
    assert.equal(await sectionContent(b.db, "reborn-section"), "new body", "the peer's copy stays on the peer");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});