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
 *   2. THE GATE IS IN THE STATEMENTS. The live-row delete carries the erase's own
 *      lamport predicate, so a row edited after the erase is never deleted — not
 *      on the first attempt (a read that went stale before the transaction) and
 *      not on a sweep retry of the queued work. An item with no live row of ours
 *      is touched only when it is already in this instance's Trash with a `delete`
 *      version at or before the erase; a newer local fact means the erase loses
 *      entirely (nothing erased, nothing tombstoned).
 *   3. A STORE WITHOUT HISTORY still records the tombstone (and still deletes the
 *      live row), so "the item may not come back" holds on an un-migrated peer —
 *      and a trashed STARTER / Maker Lab / summary memory is never erased by a
 *      peer at all (its newest snapshot says so, read inside the transaction).
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
  clampPeerEraseLamport,
  eraseLiveRowStatements,
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

const insertMemory = (db, content, { source = null } = {}) =>
  withWriteContext(OWNER, () =>
    db.execute({ sql: "INSERT INTO memories (content, source) VALUES (?, ?)", args: [content, source] }),
  ).then((result) => Number(result.lastInsertRowid));

/** A global (device_id/project NULL) context section, edited once, so it has history. */
const insertSection = async (db, sectionKey, content = "body one") => {
  const id = Number(
    (await withWriteContext(OWNER, () =>
      db.execute({
        sql: "INSERT INTO crow_context (section_key, section_title, content) VALUES (?, 'Section', ?)",
        args: [sectionKey, content],
      }),
    )).lastInsertRowid,
  );
  await withWriteContext(OWNER, () =>
    db.execute({ sql: "UPDATE crow_context SET content = 'body two' WHERE id = ?", args: [id] }),
  );
  return id;
};

const sectionVersions = async (db, id) =>
  Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'context_section' AND item_id = ?",
        args: [String(id)],
      })
    ).rows[0].n,
  );

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

test("an item already in this instance's Trash loses its history when its delete predates the erase", async () => {
  const fx = fixture("hist-erase-trash-");
  const { db } = fx;
  try {
    const id = await insertMemory(db, "deleted here, erased there");
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
    assert.equal(await versionCount(db, id), 2, "insert + delete");

    const result = await applyRemoteErasure(
      db,
      { itemType: "memory", keys: [String(id)], items: [{ itemId: String(id) }] },
      ERASE_META,
    );
    assert.equal(result.kept, false);
    assert.equal(result.versions, 2, "the whole history of an item already in the Trash goes");
    assert.equal(await versionCount(db, id), 0);
    assert.equal(await isErased(db, "memory", String(id)), true, "and the item is tombstoned");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a newer local delete is not the erase's to take: nothing is erased and nothing is tombstoned", async () => {
  const fx = fixture("hist-erase-newer-delete-");
  const { db } = fx;
  try {
    const id = await insertMemory(db, "deleted here twice");
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
    // A delete version written AFTER the erase (the local sweep's clock keeps
    // running): the item is in the Trash, but on this instance's newer terms.
    await db.execute({
      sql: `INSERT INTO item_versions (item_type, item_id, op, snapshot_json, created_at)
            VALUES ('memory', ?, 'delete', '{}', ?)`,
      args: [String(id), new Date(Date.now() + 60_000).toISOString()],
    });
    assert.equal(await versionCount(db, id), 3);

    const result = await applyRemoteErasure(
      db,
      { itemType: "memory", keys: [String(id)], items: [{ itemId: String(id) }] },
      ERASE_META,
    );
    assert.equal(result.kept, true, "the newer local delete is a newer local fact: the erase loses");
    assert.equal(result.versions, 0);
    assert.equal(await versionCount(db, id), 3, "the history stays with the local Trash");
    assert.equal(await isErased(db, "memory", String(id)), false, "and nothing is tombstoned for it");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a trashed local-only memory is never erased by a peer", async () => {
  const fx = fixture("hist-erase-local-only-");
  const { db } = fx;
  try {
    for (const source of ["starter", "maker-lab"]) {
      const id = await insertMemory(db, `a ${source} memory`, { source });
      await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
      assert.equal(await versionCount(db, id), 2, `${source}: insert + delete in this instance's Trash`);

      // The peer's erase names this id (memory ids are per-instance AUTOINCREMENT),
      // and there is no live row to protect — only the snapshot's own source is left
      // to say what this is.
      const result = await applyRemoteErasure(
        db,
        { itemType: "memory", keys: [String(id)], items: [{ itemId: String(id) }] },
        ERASE_META,
      );
      assert.equal(result.kept, true, `${source}: the local-only memory is not the peer's to erase`);
      assert.equal(result.versions, 0);
      assert.equal(await versionCount(db, id), 2, `${source}: its history is intact`);
      assert.equal(await isErased(db, "memory", String(id)), false, `${source}: and it is not tombstoned`);
    }
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

/** The scope key a context section's tombstone is recorded under (erasureKeys). */
const scopeKey = (sectionKey, { deviceId = null, projectUuid = null } = {}) =>
  JSON.stringify({ section_key: sectionKey, device_id: deviceId, project_uuid: projectUuid });

test("a peer-supplied erase lamport is clamped to what this instance has seen from that peer", async () => {
  const fx = fixture("hist-erase-clamp-");
  const { db } = fx;
  try {
    // This store's counter is at 10, and it has seen lamport 30 written by the peer.
    await db.execute("INSERT INTO sync_state (instance_id, local_counter) VALUES ('inst-clamp', 10)");
    await db.execute({
      sql: "INSERT INTO memories (content, instance_id, lamport_ts) VALUES ('from the peer', 'remote-clamp', 30)",
      args: [],
    });

    // A peer may not assert a bound beyond the furthest moment this instance has
    // seen it reach (+1): otherwise an erase carrying lamport 9e6 would refuse
    // every future write for that id, from everyone, forever.
    assert.equal(await clampPeerEraseLamport(db, 9_000_000, "remote-clamp"), 31);
    // A value at or below the ceiling is kept as sent.
    assert.equal(await clampPeerEraseLamport(db, 12, "remote-clamp"), 12);

    // The apply writes the CLAMPED value into erase_lamport.
    const outcome = await applyRemoteErasure(
      db,
      { itemType: "memory", keys: ["77"], items: [{ itemId: null }] },
      { ...ERASE_META, originInstance: "remote-clamp", eraseLamport: 9_000_000 },
    );
    assert.equal(outcome.tombstones, 1);
    const bound = (await db.execute({
      sql: "SELECT erase_lamport FROM item_erasures WHERE item_type = 'memory' AND item_id = '77'",
      args: [],
    })).rows[0].erase_lamport;
    assert.equal(Number(bound), 31, "the tombstone carries the clamp, not the peer's claim");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a queued inbound erase carries only the tombstone keys and the lamport, and the sweep re-resolves it with the same protection", async () => {
  const fx = fixture("hist-erase-queue-shape-");
  const { db } = fx;
  try {
    // A starter memory in this instance's Trash: a peer's erase names its id (memory
    // ids are per-instance AUTOINCREMENT), and the protection must hold on the retry
    // too — the queue is not allowed to be a weaker door than the apply.
    const starter = await insertMemory(db, "a starter demo", { source: "starter" });
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [starter] }));
    assert.equal(await versionCount(db, starter), 2, "insert + delete, in this instance's Trash");

    // The state a failed apply leaves behind: a tombstone and a marker holding the
    // KEYS and the LAMPORT only.
    await db.execute(`CREATE TABLE IF NOT EXISTS ${PENDING_REMOTE_ERASURES_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    await db.execute({
      sql: `INSERT INTO ${PENDING_REMOTE_ERASURES_TABLE} (item_type, payload_json) VALUES (?, ?)`,
      args: [
        "memory",
        JSON.stringify({
          itemType: "memory",
          keys: [String(starter)],
          originInstance: "remote-queued",
          by: "owner:remote-owner",
          lamport: 500,
          at: new Date().toISOString(),
        }),
      ],
    });
    assert.equal(await markerCount(db), 1);

    // The sweep resolves the keys again, sees the local-only source, and does
    // nothing: no version erased, no tombstone written for the protected item.
    const swept = await sweep(db, { syncManager: null });
    assert.equal(swept.pendingErased, 1, "the marker was finished (there was nothing legitimate to do)");
    assert.equal(await markerCount(db), 0, "and cleared");
    assert.equal(await versionCount(db, starter), 2, "the local-only item keeps its history");
    assert.equal(await isErased(db, "memory", String(starter)), false, "and it is not tombstoned by the queue");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a retried inbound erase never deletes a section edited after the erase", async () => {
  const fx = fixture("hist-erase-retry-newer-");
  const { db } = fx;
  try {
    const id = await insertSection(db, "retry-section");
    assert.equal(await sectionVersions(db, id), 2, "insert + edit captured locally");

    // The first attempt cannot finish (the store refuses to let versions go), so the
    // tombstone is written and the work queued — the state the sweep retries from.
    await db.execute(`CREATE TRIGGER test_block_version_erase BEFORE DELETE ON item_versions
      BEGIN SELECT RAISE(ABORT, 'simulated version erase failure'); END`);
    const first = await applyRemoteErasure(
      db,
      {
        itemType: "context_section",
        keys: [scopeKey("retry-section")],
        items: [{ itemId: String(id), ...eraseLiveRowStatements("crow_context", "id = ?", [String(id)], 500) }],
      },
      ERASE_META,
    );
    assert.equal(first.pending, true);
    assert.equal(await markerCount(db), 1, "the rest of the work is queued for the sweep");
    await db.execute("DROP TRIGGER test_block_version_erase");

    // The section is edited AFTER the erase: a newer local version, lamport 900
    // against the erase's 500. (A different job, so the sweep's 2-minute coalescing
    // cannot merge it with the earlier edit and hide what this asserts.)
    await withWriteContext(
      { authorKind: "owner", authorId: "abcd1234", jobId: "session:later" },
      () =>
        db.execute({
          sql: "UPDATE crow_context SET content = 'edited after the erase', lamport_ts = 900 WHERE id = ?",
          args: [id],
        }),
    );
    assert.equal(await sectionVersions(db, id), 3, "the newer local edit is versioned here");

    // The retry (the 5-minute history sweep) must not delete it, and must not erase
    // its history either: the local version is newer than the erase.
    const swept = await sweep(db, { syncManager: null });
    assert.equal(swept.pendingErased, 1, "the sweep finished the queued erase");
    assert.equal(await markerCount(db), 0, "and cleared the marker");
    const row = (await db.execute({ sql: "SELECT content FROM crow_context WHERE id = ?", args: [id] })).rows[0];
    assert.ok(row, "the section is still here");
    assert.equal(row.content, "edited after the erase", "with the newer local edit");
    assert.equal(await sectionVersions(db, id), 3, "and its history is untouched");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the first-attempt race cannot delete a newer row", async () => {
  const fx = fixture("hist-erase-race-");
  const { db } = fx;
  try {
    const id = await insertSection(db, "race-section");
    // Between the caller's lookup and the apply, the section is edited: its own
    // lamport (900) now post-dates the erase (500). The caller's statements were
    // built for the old state, which is exactly the race the SQL gate closes.
    await withWriteContext(OWNER, () =>
      db.execute({ sql: "UPDATE crow_context SET lamport_ts = 900 WHERE id = ?", args: [id] }),
    );

    const outcome = await applyRemoteErasure(
      db,
      {
        itemType: "context_section",
        keys: [scopeKey("race-section")],
        items: [{ itemId: String(id), ...eraseLiveRowStatements("crow_context", "id = ?", [String(id)], 500) }],
      },
      ERASE_META,
    );
    assert.equal(outcome.kept, true, "the local version wins");
    assert.ok(
      (await db.execute({ sql: "SELECT id FROM crow_context WHERE id = ?", args: [id] })).rows.length === 1,
      "the newer row survives the gated delete",
    );
    assert.equal(await sectionVersions(db, id), 2, "and so does its history");
    assert.equal(await isErased(db, "context_section", scopeKey("race-section")), false, "nothing is tombstoned");
  } finally {
    db.close();
    fx.dispose();
  }
});