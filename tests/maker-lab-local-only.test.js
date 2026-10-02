/**
 * Maker Lab learner memories are local-only (bundles/maker-lab/DATA-HANDLING.md:
 * learner data "does not leave your host").
 *
 * Two doors:
 *  - out: shouldSyncRow drops a source='maker-lab' row on emit and on apply;
 *  - in (review I1): memory ids are per-instance AUTOINCREMENT, so a peer's
 *    update/delete for ITS unrelated memory N used to overwrite or delete the
 *    local child's record N (and the overwrite dropped its maker-lab source,
 *    so it then synced onward). The apply path now refuses an inbound
 *    update/delete whose LOCAL target is protected.
 *
 * Mutual: each side holds a protected row whose id collides with the other
 * side's ordinary memory, and both sides update + delete theirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSyncRowForTest } from "../servers/sharing/instance-sync.js";
import { makeFleet, linkPeers, until, sleep } from "./fixtures/sync-fleet.mjs";

test("out door: maker-lab (and starter) memories never sync; other memories do", () => {
  assert.equal(shouldSyncRowForTest("memories", { id: 1, content: "x", source: "maker-lab" }), false);
  assert.equal(shouldSyncRowForTest("memories", { id: 1, content: "x", source: "starter" }), false);
  assert.equal(shouldSyncRowForTest("memories", { id: 2, content: "x", source: "chat" }), true);
});

async function row(db, id) {
  return (await db.execute({ sql: "SELECT content, source FROM memories WHERE id = ?", args: [id] })).rows[0] || null;
}

test("in door, MUTUAL: colliding-id updates and deletes from a peer never touch a local maker-lab record", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    // A: child's record at 50, ordinary memory at 60. B: the mirror image.
    await a.db.execute("INSERT INTO memories (id, content, source) VALUES (50, 'A child progress', 'maker-lab'), (60, 'A ordinary', 'chat')");
    await b.db.execute("INSERT INTO memories (id, content, source) VALUES (50, 'B ordinary', 'chat'), (60, 'B child progress', 'maker-lab')");
    // A non-protected colliding id on both sides proves the link applies updates.
    await a.db.execute("INSERT INTO memories (id, content, source) VALUES (70, 'A seventy', 'chat')");
    await b.db.execute("INSERT INTO memories (id, content, source) VALUES (70, 'B seventy', 'chat')");
    link = await linkPeers(a, b);

    // Baseline: an ordinary colliding update DOES apply across the link.
    await b.mgr.emitChange("memories", "update", { id: 70, content: "B seventy edited", source: "chat" });
    assert.ok(await until(async () => (await row(a.db, 70))?.content === "B seventy edited"), "baseline update flows");

    // Each side edits its ordinary memory whose id collides with the other's child record.
    await b.mgr.emitChange("memories", "update", { id: 50, content: "B ordinary edited", source: "chat" });
    await a.mgr.emitChange("memories", "update", { id: 60, content: "A ordinary edited", source: "chat" });
    // ...and then deletes it.
    await b.mgr.emitChange("memories", "delete", { id: 50 });
    await a.mgr.emitChange("memories", "delete", { id: 60 });
    // A trailing ordinary update proves both feeds were drained past the ops above.
    await a.mgr.emitChange("memories", "update", { id: 70, content: "A seventy final", source: "chat" });
    await b.mgr.emitChange("memories", "update", { id: 70, content: "B seventy final", source: "chat" });
    assert.ok(await until(async () => (await row(b.db, 70))?.content === "A seventy final" || (await row(b.db, 70))?.content === "B seventy final"));
    await sleep(300);

    assert.deepEqual(await row(a.db, 50), { content: "A child progress", source: "maker-lab" }, "A's child record survives B's update+delete");
    assert.deepEqual(await row(b.db, 60), { content: "B child progress", source: "maker-lab" }, "B's child record survives A's update+delete");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});
