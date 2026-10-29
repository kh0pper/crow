// A project delete must not reach a paired instance's unrelated rows (spec §15 amendment).
// Two real instances (tests/fixtures/sync-fleet.mjs: init-db scratch DBs, real
// InstanceSyncManagers, real Hypercore feeds over a NoiseSecretStream pair). A's sync outbox is
// drained through the real drain (drainOnce) to B. B holds notes, project-scoped context rows and
// memories that share A's ids and A's project id. Positive controls on the same link first: a
// queued insert and a queued note delete do reach B, so B staying unchanged is the delete's doing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "crow-pld-peer-"));
process.env.CROW_DATA_DIR = dir; // A's project workspace paths and the local instance id live here
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db"); // never created: no cards

const { makeFleet, linkPeers, until, hasMemory } = await import("./fixtures/sync-fleet.mjs");
const { drainOnce } = await import("../servers/sharing/sync-outbox-drain.js");
const { emitOrQueue, _setEligibilityForTest } = await import("../servers/shared/sync-emit.js");
const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
const L = await import("../servers/shared/project-lifecycle.js");

const rows = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

/** Queue a memory on A (the stdio door), drain it, and wait for B to have it. */
async function markerReaches(a, b, id) {
  await a.db.execute({ sql: "INSERT INTO memories (id, content) VALUES (?, ?)", args: [id, `marker ${id}`] });
  const q = await emitOrQueue(null, a.db, "memories", "insert", { id, content: `marker ${id}` });
  assert.ok(q && q.queued, "the marker was queued in A's outbox");
  await drainOnce(a.mgr, a.db, {});
  return until(() => hasMemory(b.db, id), 15_000);
}

test("a delete on A drains nothing that changes B's notes, context or memories, and B's edits never refile into the tombstone", { timeout: 90_000 }, async () => {
  _setEligibilityForTest(() => true); // the suite env disables sync; a queued emit must really queue
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  try {
    link = await linkPeers(a, b);

    // A's project and its contents.
    const pid = Number((await createProjectSpace(a.db, { name: "Peer Safe" })).id);
    const uuid = (await rows(a.db, "SELECT uuid FROM project_spaces WHERE id = ?", [pid]))[0].uuid;
    const noteIds = [];
    for (const c of ["a note 1", "a note 2"]) {
      noteIds.push(Number((await a.db.execute({ sql: "INSERT INTO research_notes (project_id, content) VALUES (?, ?)", args: [pid, c] })).lastInsertRowid));
    }
    await a.db.execute({ sql: "INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES ('brief', 'Brief', 'A', ?)", args: [pid] });
    const memId = Number((await a.db.execute({ sql: "INSERT INTO memories (content, project_id) VALUES ('a memory', ?)", args: [pid] })).lastInsertRowid);

    // B's UNRELATED rows under the same ids and the same (to B, foreign) project id.
    for (const id of noteIds) await b.db.execute({ sql: "INSERT INTO research_notes (id, content) VALUES (?, ?)", args: [id, `b note ${id}`] });
    await b.db.execute({ sql: "INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES ('brief', 'Brief', 'B own', ?)", args: [pid] });
    await b.db.execute({ sql: "INSERT INTO memories (id, content, project_id) VALUES (?, 'b memory', ?)", args: [memId, pid] });

    // Positive controls: the queued path reaches B, inserts and deletes alike.
    assert.ok(await markerReaches(a, b, 900001), "control: a queued insert reaches B");
    await b.db.execute("INSERT INTO research_notes (id, content) VALUES (990001, 'control victim')");
    await emitOrQueue(null, a.db, "research_notes", "delete", { id: 990001 });
    await drainOnce(a.mgr, a.db, {});
    // Since #647 the receiver refuses a generic delete keyed by a per-instance id, so the old
    // hazard is closed at both ends: a marker sent after it lands, and B's row is still there.
    assert.ok(await markerReaches(a, b, 900077), "control: a marker after the delete reaches B (the delete was processed)");
    assert.equal((await rows(b.db, "SELECT id FROM research_notes WHERE id = 990001")).length, 1,
      "control: a note delete keyed by a per-instance id no longer removes B's unrelated row (#647)");

    const snapshot = async () => ({
      notes: await rows(b.db, "SELECT * FROM research_notes ORDER BY id"),
      context: await rows(b.db, "SELECT * FROM crow_context WHERE project_id IS NOT NULL ORDER BY id"),
      memories: await rows(b.db, "SELECT id, content, project_id FROM memories ORDER BY id"),
    });
    const before = await snapshot();
    const outboxMax = Number((await rows(a.db, "SELECT COALESCE(MAX(id), 0) AS m FROM sync_outbox"))[0].m);

    const r = await L.deleteProject(a.db, pid, {
      confirmName: "Peer Safe", storageDelete: async () => {}, disconnectBackend: () => true, dataDir: dir,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await rows(a.db, "SELECT id FROM research_notes WHERE project_id = ?", [pid])).length, 0, "A's notes are gone");

    const queued = await rows(a.db,
      "SELECT table_name, op FROM sync_outbox WHERE id > ? AND table_name IN ('research_notes','crow_context','memories')", [outboxMax]);
    assert.deepEqual(queued, [], "the delete queued nothing for notes, context or memories");

    // Drain whatever A has, then a marker after it: the feed is ordered, so once the marker lands
    // on B everything the delete could have sent has been applied.
    await drainOnce(a.mgr, a.db, {});
    assert.ok(await markerReaches(a, b, 900002), "the post-delete marker reaches B");
    const after = await snapshot();
    after.memories = after.memories.filter((m) => m.id !== 900002);
    assert.deepEqual(after, before, "B's notes, context and memories are unchanged");

    // The other direction: B edits the memory and still names the deleted project's uuid. A applies
    // it through the real feed, and the memory lands unfiled, never back under the tombstone.
    await b.mgr.emitChange("memories", "update", { id: memId, content: "edited on B", project_uuid: uuid, source: null });
    assert.ok(await until(async () => (await rows(a.db, "SELECT content FROM memories WHERE id = ?", [memId]))[0]?.content === "edited on B", 15_000),
      "B's edit reached A");
    assert.equal((await rows(a.db, "SELECT project_id FROM memories WHERE id = ?", [memId]))[0].project_id, null, "unfiled, not refiled into the tombstone");
  } finally {
    _setEligibilityForTest(null);
    try { link && link.close(); } catch {}
    await fleet.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
