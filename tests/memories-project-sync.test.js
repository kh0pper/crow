/**
 * A memory keeps its project across instance sync (session summaries, R1.2 PR 4).
 *
 * memories.project_id is a LOCAL FK: project_spaces ids are per-instance, so the
 * same project is id 10 on one Crow and id 40 on another. The portable id is
 * project_spaces.uuid, carried on the memory as project_uuid:
 *   - outbound: OUTBOUND_TRANSFORMS.memories nulls project_id; project_uuid rides;
 *   - inbound: project_id is dropped from the wire (an un-upgraded peer still
 *     sends its own id) and re-derived from project_uuid against the local
 *     project_spaces — or NULL (unfiled) when this Crow has no such project.
 *
 * Two real InstanceSyncManagers on real init-db stores linked over real
 * Hypercore replication (tests/fixtures/sync-fleet.mjs). Mutual: both sides
 * author, both sides receive, both sides update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceSyncManager, mapInboundMemoryProject, INBOUND_DROPPED_COLUMNS } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { makeFleet, linkPeers, until, sleep } from "./fixtures/sync-fleet.mjs";

const U_SHARED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const U_SECOND = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const U_ONLY_A = "cccccccccccccccccccccccccccccccc";

async function addProject(db, id, uuid, slug) {
  await db.execute({ sql: "INSERT INTO project_spaces (id, uuid, slug, name) VALUES (?, ?, ?, ?)", args: [id, uuid, slug, slug] });
}

async function mem(db, id) {
  const { rows } = await db.execute({ sql: "SELECT id, content, project_id, project_uuid FROM memories WHERE id = ?", args: [id] });
  return rows[0] ? { id: Number(rows[0].id), content: rows[0].content, project_id: rows[0].project_id == null ? null : Number(rows[0].project_id), project_uuid: rows[0].project_uuid ?? null } : null;
}

async function conflicts(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_conflicts WHERE table_name = 'memories'");
  return Number(rows[0].n);
}

/** Write a memory locally, then emit the stored row (as the memory server does). */
async function writeMemory(side, { id, content, projectId = null, projectUuid = null }) {
  await side.db.execute({
    sql: "INSERT INTO memories (id, content, source, project_id, project_uuid) VALUES (?, ?, 'session-summary', ?, ?)",
    args: [id, content, projectId, projectUuid],
  });
  const { rows } = await side.db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] });
  await side.mgr.emitChange("memories", "insert", { ...rows[0] });
}

/** Same ids on purpose differ per side: one project, two local ids. */
async function seedProjects(a, b) {
  await addProject(a.db, 10, U_SHARED, "shared");
  await addProject(a.db, 11, U_SECOND, "second");
  await addProject(a.db, 12, U_ONLY_A, "only-a");
  await addProject(b.db, 40, U_SHARED, "shared");
  await addProject(b.db, 41, U_SECOND, "second");
  // B's id 10 is an UNRELATED project: a raw project_id 10 from A must never file here.
  await addProject(b.db, 10, "dddddddddddddddddddddddddddddddd", "b-unrelated");
}

test("outbound nulls project_id and carries project_uuid; the transform is pure", async () => {
  const fleet = await makeFleet();
  try {
    const { a, identity } = fleet;
    const probe = new InstanceSyncManager(identity, a.db, "outbound-probe");
    probe.feedsDisabled = false;
    const captured = [];
    probe.outFeeds.set("probe-peer", { append: async (e) => captured.push(e) });
    const row = { id: 7, content: "summary", project_id: 10, project_uuid: U_SHARED };
    await a.db.execute({ sql: "INSERT INTO memories (id, content, project_id, project_uuid) VALUES (7, 'summary', 10, ?)", args: [U_SHARED] });
    await probe.emitChange("memories", "insert", row);
    const sent = captured.find((e) => e.table === "memories");
    assert.ok(sent, "the memory reached the probe feed");
    assert.ok(!("project_id" in sent.row), "project_id is local: never on the wire");
    assert.equal(sent.row.project_uuid, U_SHARED, "project_uuid rides as is");
    assert.equal(row.project_id, 10, "the caller's row is not mutated");

    // A null-uuid memory (every ordinary memory) carries no project_uuid key.
    const plain = { id: 8, content: "plain", project_id: null, project_uuid: null };
    await a.db.execute("INSERT INTO memories (id, content) VALUES (8, 'plain')");
    await probe.emitChange("memories", "insert", plain);
    await probe.emitChange("memories", "update", { id: 8, content: "plain edited" });
    const plainSent = captured.filter((e) => e.table === "memories" && e.row.id === 8);
    assert.equal(plainSent.length, 2);
    for (const e of plainSent) {
      assert.ok(!("project_uuid" in e.row), `${e.op}: no project_uuid key on the wire`);
      assert.ok(!("project_id" in e.row), `${e.op}: no project_id key on the wire`);
    }
    assert.ok("project_uuid" in plain, "the caller's row is not mutated");
    assert.equal((await mem(a.db, 7)).project_id, 10, "the local row keeps its project");
    try { await probe.close(); } catch {}
  } finally {
    await fleet.cleanup();
  }
});

test("mapInboundMemoryProject: maps a known uuid, unfiles an unknown or null one, leaves a key-less row alone", async () => {
  const fleet = await makeFleet();
  try {
    const { b } = fleet;
    await addProject(b.db, 40, U_SHARED, "shared");
    const known = { id: 1, content: "x", project_uuid: U_SHARED };
    assert.deepEqual(await mapInboundMemoryProject(b.db, known), { ...known, project_id: 40 });
    assert.equal(known.project_id, undefined, "pure: input untouched");
    assert.deepEqual(await mapInboundMemoryProject(b.db, { id: 1, project_uuid: U_ONLY_A }), { id: 1, project_uuid: U_ONLY_A, project_id: null });
    assert.deepEqual(await mapInboundMemoryProject(b.db, { id: 1, project_uuid: null }), { id: 1, project_uuid: null, project_id: null });
    assert.deepEqual(await mapInboundMemoryProject(b.db, { id: 1, content: "y" }), { id: 1, content: "y" }, "no project_uuid key: unchanged");
    assert.deepEqual(INBOUND_DROPPED_COLUMNS.memories, ["project_id"]);
  } finally {
    await fleet.cleanup();
  }
});

test("summary memory keeps its project across sync (MUTUAL), an unknown uuid lands unfiled, and updates re-map", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    await seedProjects(a, b);
    link = await linkPeers(a, b);

    // A -> B: filed under the shared project (A id 10, B id 40).
    await writeMemory(a, { id: 101, content: "A summary", projectId: 10, projectUuid: U_SHARED });
    // B -> A: filed under the second project (B id 41, A id 11).
    await writeMemory(b, { id: 201, content: "B summary", projectId: 41, projectUuid: U_SECOND });
    // A -> B: a project B does not have lands unfiled, uuid kept.
    await writeMemory(a, { id: 102, content: "A only-a summary", projectId: 12, projectUuid: U_ONLY_A });
    // A -> B and B -> A: an unfiled memory stays unfiled.
    await writeMemory(a, { id: 103, content: "A plain", projectId: null, projectUuid: null });

    assert.ok(await until(async () => (await mem(b.db, 101)) && (await mem(b.db, 102)) && (await mem(b.db, 103))), "A's memories reach B");
    assert.ok(await until(async () => !!(await mem(a.db, 201))), "B's memory reaches A");

    assert.deepEqual(await mem(b.db, 101), { id: 101, content: "A summary", project_id: 40, project_uuid: U_SHARED }, "B files it under ITS id for the project");
    assert.deepEqual(await mem(a.db, 201), { id: 201, content: "B summary", project_id: 11, project_uuid: U_SECOND }, "A files it under ITS id for the project");
    assert.deepEqual(await mem(b.db, 102), { id: 102, content: "A only-a summary", project_id: null, project_uuid: U_ONLY_A }, "unknown uuid: unfiled, uuid kept");
    assert.deepEqual(await mem(b.db, 103), { id: 103, content: "A plain", project_id: null, project_uuid: null });
    // The authors keep their own local filing.
    assert.equal((await mem(a.db, 101)).project_id, 10);
    assert.equal((await mem(b.db, 201)).project_id, 41);

    // UPDATE of the same row id re-maps: A moves 101 to the second project...
    await a.db.execute({ sql: "UPDATE memories SET project_id = 11, project_uuid = ? WHERE id = 101", args: [U_SECOND] });
    await a.mgr.emitChange("memories", "update", { id: 101, content: "A summary", project_id: 11, project_uuid: U_SECOND });
    // ...and B moves 201 to the shared project, both directions at once.
    await b.db.execute({ sql: "UPDATE memories SET project_id = 40, project_uuid = ? WHERE id = 201", args: [U_SHARED] });
    await b.mgr.emitChange("memories", "update", { id: 201, content: "B summary", project_id: 40, project_uuid: U_SHARED });
    assert.ok(await until(async () => (await mem(b.db, 101)).project_id === 41), "B re-maps 101 to its id for the second project");
    assert.ok(await until(async () => (await mem(a.db, 201)).project_id === 10), "A re-maps 201 to its id for the shared project");
    assert.equal((await mem(b.db, 101)).project_uuid, U_SECOND);
    assert.equal((await mem(a.db, 201)).project_uuid, U_SHARED);

    // An update that does not name the project leaves the filing as it is.
    await a.mgr.emitChange("memories", "update", { id: 101, content: "A summary edited" });
    assert.ok(await until(async () => (await mem(b.db, 101)).content === "A summary edited"));
    assert.equal((await mem(b.db, 101)).project_id, 41, "content-only update keeps the project");

    // Clearing the project (project_uuid: null) does NOT propagate: a null
    // project_uuid never rides the wire (so older peers never see the key).
    // Accepted cost. The rest of the update still applies.
    await a.mgr.emitChange("memories", "update", { id: 101, content: "A summary cleared", project_uuid: null });
    assert.ok(await until(async () => (await mem(b.db, 101)).content === "A summary cleared"));
    assert.deepEqual(await mem(b.db, 101), { id: 101, content: "A summary cleared", project_id: 41, project_uuid: U_SECOND },
      "the peer keeps its filing");

    // Re-delivery of an insert B already holds is noise, not a conflict.
    const { rows } = await a.db.execute("SELECT * FROM memories WHERE id = 102");
    await a.mgr.emitChange("memories", "insert", { ...rows[0] });
    await a.mgr.emitChange("memories", "update", { id: 103, content: "A plain tail" });
    assert.ok(await until(async () => (await mem(b.db, 103)).content === "A plain tail"), "feed drained past the re-delivery");
    await sleep(200);
    assert.equal(await conflicts(a.db), 0, "no conflict rows on A");
    assert.equal(await conflicts(b.db), 0, "no conflict rows on B");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("a mixed-version peer that sends no project_uuid leaves it null and breaks nothing", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b, identity } = fleet;
    await seedProjects(a, b);

    // The un-upgraded wire shape, applied through the real inbound path: the
    // peer's OWN project_id (10) and no project_uuid. B's id 10 is an unrelated
    // project, so applying it verbatim would misfile the memory.
    const signed = (entry) => ({ ...entry, signature: sign(JSON.stringify(entry), identity.ed25519Priv) });
    await b.mgr._applyEntry(a.id, signed({
      table: "memories", op: "insert",
      row: { id: 301, content: "old peer memory", category: "general", project_id: 10 },
      lamport_ts: 5, instance_id: a.id,
    }));
    assert.deepEqual(await mem(b.db, 301), { id: 301, content: "old peer memory", project_id: null, project_uuid: null },
      "a foreign project_id is never applied; no project_uuid stays null");
    await b.mgr._applyEntry(a.id, signed({
      table: "memories", op: "update",
      row: { id: 301, content: "old peer edit", project_id: 10 },
      lamport_ts: 6, instance_id: a.id,
    }));
    assert.deepEqual(await mem(b.db, 301), { id: 301, content: "old peer edit", project_id: null, project_uuid: null });

    // A locally-filed memory on B is not unfiled by an old-shape update from A.
    await b.db.execute({ sql: "INSERT INTO memories (id, content, project_id, project_uuid) VALUES (302, 'B filed', 40, ?)", args: [U_SHARED] });
    await b.mgr._applyEntry(a.id, signed({
      table: "memories", op: "update",
      row: { id: 302, content: "B filed, edited by old peer" },
      lamport_ts: 50, instance_id: a.id,
    }));
    assert.deepEqual(await mem(b.db, 302), { id: 302, content: "B filed, edited by old peer", project_id: 40, project_uuid: U_SHARED });

    // _checkConflict compares like with like: the local row loses project_id
    // (and nothing else here) under the transform, exactly as the wire row does.
    // An equal-lamport re-delivery naming the same project is noise...
    await b.db.execute("UPDATE memories SET lamport_ts = 60 WHERE id = 302");
    await b.mgr._applyEntry(a.id, signed({
      table: "memories", op: "update",
      row: { id: 302, content: "B filed, edited by old peer", project_uuid: U_SHARED },
      lamport_ts: 60, instance_id: a.id,
    }));
    assert.equal(await conflicts(b.db), 0, "equivalent re-delivery: no conflict despite the local project_id");
    // ...while a real difference at the same lamport is still a conflict, and local wins.
    await b.mgr._applyEntry(a.id, signed({
      table: "memories", op: "update",
      row: { id: 302, content: "different", project_uuid: U_SHARED },
      lamport_ts: 60, instance_id: a.id,
    }));
    assert.equal(await conflicts(b.db), 1, "a real stale edit is still caught");
    assert.equal((await mem(b.db, 302)).content, "B filed, edited by old peer");
    await b.db.execute("DELETE FROM sync_conflicts");

    // And over the real link, memories written without project_uuid (every
    // existing writer) still sync both ways exactly as before.
    link = await linkPeers(a, b);
    await a.db.execute("INSERT INTO memories (id, content) VALUES (401, 'A legacy writer')");
    await a.mgr.emitChange("memories", "insert", { id: 401, content: "A legacy writer", category: "general", source: null, project_id: null });
    await b.db.execute("INSERT INTO memories (id, content) VALUES (402, 'B legacy writer')");
    await b.mgr.emitChange("memories", "insert", { id: 402, content: "B legacy writer", category: "general", source: null, project_id: null });
    assert.ok(await until(async () => !!(await mem(b.db, 401)) && !!(await mem(a.db, 402))), "legacy-shape memories sync both ways");
    assert.deepEqual(await mem(b.db, 401), { id: 401, content: "A legacy writer", project_id: null, project_uuid: null });
    assert.deepEqual(await mem(a.db, 402), { id: 402, content: "B legacy writer", project_id: null, project_uuid: null });
    assert.equal(await conflicts(a.db), 0);
    assert.equal(await conflicts(b.db), 0);
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});


test("a peer's insert with a session-summary source this instance already holds is skipped, not a crash", async () => {
  // idx_memories_session_summary_source (0020): one memory per summary source.
  // Thread ids are per-instance, so in practice the same source is the same
  // memory and arrives as an update; a stray insert must still never wedge the feed.
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    link = await linkPeers(a, b);
    const SRC = "session-summary:perchlive-shared";
    await b.db.execute({ sql: "INSERT INTO memories (id, content, source) VALUES (300, 'B local summary', ?)", args: [SRC] });
    await a.db.execute({ sql: "INSERT INTO memories (id, content, source) VALUES (301, 'A summary', ?)", args: [SRC] });
    const { rows } = await a.db.execute("SELECT * FROM memories WHERE id = 301");
    await a.mgr.emitChange("memories", "insert", { ...rows[0] });
    // A later entry on the same feed still applies: the apply loop moved on.
    await writeMemory(a, { id: 302, content: "after the collision" });
    assert.ok(await until(async () => !!(await mem(b.db, 302))), "the feed drained past the skipped insert");
    const { rows: same } = await b.db.execute({ sql: "SELECT id, content FROM memories WHERE source = ?", args: [SRC] });
    assert.deepEqual(same.map((r) => [Number(r.id), r.content]), [[300, "B local summary"]], "B keeps its one row for the source");
    assert.equal(await conflicts(b.db), 0, "a secondary-constraint skip is not a conflict row");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});
