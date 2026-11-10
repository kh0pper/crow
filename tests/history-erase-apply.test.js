/**
 * Inbound erases (instance-sync's `op: "erase"`): how applyRemoteErasure lands
 * one.
 *
 * Three properties, from the review of the first cut of the erase design:
 *
 *   1. ONE TRANSACTION. The live-row delete, the version erase and the tombstone
 *      commit together. A failure leaves none of them — and the entry is not
 *      silently consumed: the tombstone is written on its own (it is the part
 *      that must never be lost) plus a marker in pending_remote_erasures, which
 *      the 5-minute history sweep finishes.
 *   2. THE TRASH CONDITION. With no live row here (the item is already in this
 *      instance's Trash), only versions created at or before the erase's own time
 *      go: a newer local delete survives for the local sweep.
 *   3. A STORE WITHOUT HISTORY still records the tombstone (and still deletes the
 *      live row), so "the item may not come back" holds on an un-migrated peer.
 *
 * The two-instance behaviour (who emits, who refuses) is in
 * tests/history-two-instance.test.js and tests/instance-sync.test.js; this file
 * is only the apply primitive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDbClient } from "../servers/db.js";
import { run as migrate } from "../scripts/migrations/0024-item-versions.mjs";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import {
  applyRemoteErasure,
  isErased,
  PENDING_REMOTE_ERASURES_TABLE,
} from "../servers/shared/history/erase.js";
import { sweep } from "../servers/shared/history/sweep.js";

const REPO = new URL("..", import.meta.url).pathname;
const ROOT = mkdtempSync(join(tmpdir(), "hist-erase-apply-"));
process.env.CROW_HOME = join(ROOT, "home");
process.env.CROW_DATA_DIR = join(ROOT, "data");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;

const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };

/** A real crow.db; `history` applies the additive 0024 migration. */
function fixture(prefix, { history = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: root, CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(root, "crow.db");
  if (history) migrate({ dbPath, log: () => {} });
  return { db: createDbClient(dbPath), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const insertMemory = (db, content) =>
  withWriteContext(OWNER, () =>
    db.execute({ sql: "INSERT INTO memories (content) VALUES (?)", args: [content] }),
  ).then((result) => Number(result.lastInsertRowid));

const memoryRow = async (db, id) =>
  (await db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] })).rows[0];

const versionCount = async (db, id) =>
  Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory' AND item_id = ?",
        args: [String(id)],
      })
    ).rows[0].n,
  );

const markerCount = async (db) => {
  try {
    return Number(
      (await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${PENDING_REMOTE_ERASURES_TABLE}`, args: [] })).rows[0].n,
    );
  } catch (err) {
    if (/no such table/i.test(String(err?.message || ""))) return 0; // never created = nothing queued
    throw err;
  }
};

const ERASE_META = {
  originInstance: "remote-instance",
  erasedBy: "owner:remote-owner",
  eraseLamport: 500,
};

test("the live-row delete, the version erase and the tombstone are ONE transaction, and a failure is finished by the sweep", async () => {
  const fx = fixture("hist-erase-atomic-");
  const { db } = fx;
  try {
    const id = await insertMemory(db, "erase me atomically");
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
    // Deleted locally: the live row is gone, the history is in this instance's Trash.
    await withWriteContext(OWNER, () => db.execute({ sql: "INSERT INTO memories (id, content) VALUES (?, ?)", args: [id, "back again"] }));
    assert.equal(await versionCount(db, id), 3, "insert + delete + the re-create");

    // Make the version erase fail: the whole transaction must roll back, so the
    // live row survives too — nothing half-applied.
    await db.execute(`CREATE TRIGGER test_block_version_erase BEFORE DELETE ON item_versions
      BEGIN SELECT RAISE(ABORT, 'simulated version erase failure'); END`);
    const first = await applyRemoteErasure(
      db,
      {
        itemType: "memory",
        keys: [String(id)],
        items: [{ itemId: String(id), deleteRow: { sql: "DELETE FROM memories WHERE id = ?", args: [id] } }],
      },
      ERASE_META,
    );
    assert.equal(first.pending, true, "the apply reported that it did not finish");
    assert.ok(await memoryRow(db, id), "the failed transaction rolled the live-row delete back too");
    assert.ok((await versionCount(db, id)) > 0, "and left the history alone");
    assert.equal(await isErased(db, "memory", String(id)), true, "the tombstone was written on its own — it must not be lost");
    assert.equal(await markerCount(db), 1, "and a pending marker names the rest of the work");

    // The 5-minute sweep finishes it once the store is healthy again.
    await db.execute("DROP TRIGGER test_block_version_erase");
    const swept = await sweep(db, { syncManager: null });
    assert.equal(swept.pendingErased, 1, "the sweep completed the failed inbound erase");
    assert.equal(await markerCount(db), 0, "and cleared the marker");
    assert.equal(await memoryRow(db, id), undefined, "the live row is gone");
    assert.equal(await versionCount(db, id), 0, "and so is its history");

    // Idempotent: the same erase again changes nothing and queues nothing.
    const again = await applyRemoteErasure(
      db,
      { itemType: "memory", keys: [String(id)], items: [{ itemId: String(id) }] },
      ERASE_META,
    );
    assert.equal(again.pending, false);
    assert.equal(again.versions, 0);
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM item_erasures", args: [] })).rows[0].n, 1);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("an item already in this instance's Trash loses only the versions at or before the erase", async () => {
  const fx = fixture("hist-erase-trash-");
  const { db } = fx;
  try {
    const id = await insertMemory(db, "deleted here, erased there");
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
    const before = await versionCount(db, id);
    assert.equal(before, 2, "insert + delete");

    // A version written AFTER the erase's time (a newer local delete) must survive
    // the peer's erase: the item is in the Trash, so only the older versions go.
    await db.execute({
      sql: `INSERT INTO item_versions (item_type, item_id, op, snapshot_json, created_at)
            VALUES ('memory', ?, 'delete', '{}', ?)`,
      args: [String(id), new Date(Date.now() + 60_000).toISOString()],
    });
    const result = await applyRemoteErasure(
      db,
      { itemType: "memory", keys: [String(id)], items: [{ itemId: String(id) }] },
      ERASE_META,
    );
    assert.equal(result.versions, 2, "only the versions at or before the erase went");
    assert.equal(await versionCount(db, id), 1, "the newer local delete stays for the local sweep");
    assert.equal(await isErased(db, "memory", String(id)), true, "and the item is tombstoned");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("on a store with no history the tombstone is still written (and the live row still goes)", async () => {
  const fx = fixture("hist-erase-nohistory-", { history: false });
  const { db } = fx;
  try {
    const result = await db.execute({ sql: "INSERT INTO memories (content) VALUES (?)", args: ["no history here"] });
    const id = Number(result.lastInsertRowid);
    const outcome = await applyRemoteErasure(
      db,
      {
        itemType: "memory",
        keys: [String(id)],
        items: [{ itemId: String(id), deleteRow: { sql: "DELETE FROM memories WHERE id = ?", args: [id] } }],
      },
      ERASE_META,
    );
    assert.equal(outcome.tombstones, 1);
    assert.equal(await memoryRow(db, id), undefined, "the live row is deleted even without history");
    const tombs = (await db.execute({
      sql: "SELECT item_id, erase_lamport FROM item_erasures WHERE item_type = 'memory'",
      args: [],
    })).rows;
    assert.equal(tombs.length, 1, "the tombstone table was created on the spot");
    assert.equal(Number(tombs[0].erase_lamport), 500, "with the erase event's bound");
    assert.equal(await markerCount(db), 0, "and nothing queued: there are no versions to finish");
  } finally {
    db.close();
    fx.dispose();
  }
});