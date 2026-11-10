/**
 * The two tables migration 0024 adds beside item_versions, and the boot ensure
 * that keeps one of them alive:
 *
 *   item_erasures    the permanent tombstone an erase leaves (never purged);
 *   pending_erasures the Maker Lab learner delete's durable "finish this" marker.
 *
 * Both are additive and IF NOT EXISTS, so they are asserted through the real
 * migration and through the real boot ensure rather than by checking the DDL text.
 * The ensure case matters because 0024 is unreleased on this branch: a dev store
 * that already recorded it will never run it again, and an erase that could not
 * write its tombstone would silently reopen the door the tombstone closes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createDbClient } from "../servers/db.js";
import { run as migrate } from "../scripts/migrations/0024-item-versions.mjs";
import { ensureHistoryTriggers } from "../servers/shared/history/ensure.js";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import { eraseItems, isErased } from "../servers/shared/history/erase.js";
import { readPendingErasure, pendingErasureStatement } from "../bundles/maker-lab/server/pending-erasures.js";

const ROOT = new URL("..", import.meta.url).pathname;
const OWNER = { authorKind: "owner", authorId: "abcd1234" };
const SYSTEM = { authorKind: "system", authorId: "test-scheduler" };

function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    cwd: ROOT,
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  migrate({ dbPath, log: () => {} });
  return {
    dir,
    dbPath,
    open: () => createDbClient(dbPath),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const tableNames = async (db) =>
  (await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table'", args: [] })).rows.map((r) => r.name);

const count = async (db, sql, args = []) => Number((await db.execute({ sql, args })).rows[0].n);

test("migration 0024 creates item_erasures and pending_erasures", async () => {
  const fx = fixture("hist-tables-");
  const db = fx.open();
  try {
    const names = await tableNames(db);
    assert.ok(names.includes("item_erasures"), "the tombstones table is part of the history migration");
    assert.ok(names.includes("pending_erasures"), "and the learner-delete marker table too");

    // The marker round-trips through the bundle's own helpers (the shape the
    // learner delete and the sweep rely on).
    await db.execute(pendingErasureStatement({ learnerId: 12, projectUuid: "uuid-12", memoryIds: [7, 8] }));
    const marker = await readPendingErasure(db, 12);
    assert.deepEqual(marker, {
      learner_id: 12,
      project_uuid: "uuid-12",
      memory_ids: ["7", "8"],
      created_at: marker.created_at,
    });
    assert.match(marker.created_at, /^\d{4}-\d\d-\d\d[ T]/, "stamped when the marker was written");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the boot ensure re-creates item_erasures, so an erase can tombstone again", async () => {
  const fx = fixture("hist-tables-ensure-");
  const first = fx.open();
  let id;
  try {
    id = Number((await withWriteContext(OWNER, () =>
      first.execute({ sql: "INSERT INTO memories (content) VALUES ('erase after the repair')", args: [] }),
    )).lastInsertRowid);
    await withWriteContext(OWNER, () => first.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));
  } finally {
    first.close();
  }

  // The state a dev store from an earlier build of 0024 is in: history recorded as
  // applied, the tombstone table gone.
  const raw = new Database(fx.dbPath);
  raw.exec("DROP TABLE item_erasures");
  raw.close();

  const ensured = new Database(fx.dbPath);
  try {
    const result = ensureHistoryTriggers(ensured);
    assert.deepEqual(result.skipped, [], "a whole store needs nothing skipped");
    assert.ok(
      ensured.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_erasures'").get(),
      "the tombstones table is back",
    );
  } finally {
    ensured.close();
  }

  const db = fx.open();
  try {
    const erased = await eraseItems(db, [{ itemType: "memory", itemId: id }], SYSTEM);
    assert.equal(erased.versions, 2, "the erase ran");
    assert.equal(await isErased(db, "memory", String(id)), true, "and its tombstone landed in the repaired table");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM item_erasures", []), 1);
  } finally {
    db.close();
    fx.dispose();
  }
});