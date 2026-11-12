/**
 * Version history: the CARD STORE (tasks.db) as a store of its own.
 *
 * Board cards live in the instance-global tasks.db, a separate database with its
 * OWN item_versions, its own append-only guards and its own erase switch (a SQLite
 * trigger cannot write across databases), so everything history does to crow.db has
 * to be done to that file too — and must never mix the two:
 *
 *   R1a  the sweep is store-aware: a pass against tasks.db redacts, coalesces and
 *        Trash-erases ONLY the card type, and a pass against crow.db never touches a
 *        card's versions. The redaction scan mark is per store (two keys in crow.db's
 *        dashboard_settings), which these tests read back.
 *   R1b  a permanent project delete erases its cards' versions in the same step, and
 *        leaves the tombstones; a card outside the project keeps its history.
 *   R1c  a card a JOB created is deleted by undo (a `delete` version = the card
 *        Trash), and the card sweep erases it after the Trash period — not before.
 *   R2   the boot ensure covers tasks.db: a dropped card trigger comes back and a
 *        stuck erase switch is disarmed, with "0025 has applied" read from crow.db's
 *        schema_migrations.
 *   R3   a card restore restores CONTENT ONLY, through the board's own provenance
 *        write (a board_mutations row, updated_at moved the way updateCard does).
 *
 * Every fixture is a real crow.db from scripts/init-db.js plus a real tasks.db
 * brought to the production shape by the board migrations, then 0024 and 0025 — the
 * same rail a boot runs.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createDbClient } from "../servers/db.js";
import { run as runTasksBase } from "../scripts/migrations/0000-tasks-base.mjs";
import { run as runBoardStages } from "../scripts/migrations/0001-board-stages.mjs";
import { run as runTrackerConvergence } from "../scripts/migrations/0003-tracker-convergence.mjs";
import { run as runCardModel } from "../scripts/migrations/0004-track1-card-model.mjs";
import { run as runItemVersions, id as MIGRATION_0024 } from "../scripts/migrations/0024-item-versions.mjs";
import { run as runMore, id as MIGRATION_0025 } from "../scripts/migrations/0025-item-versions-more.mjs";
import { run as runSources, id as MIGRATION_0026 } from "../scripts/migrations/0026-item-versions-sources.mjs";
import { erasureItemType, isErased } from "../servers/shared/history/erase.js";
import { ensureHistoryTriggersAtBoot } from "../servers/shared/history/ensure.js";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import { listVersions, restoreVersion } from "../servers/shared/history/api.js";
import { sweep, redactScanSetting } from "../servers/shared/history/sweep.js";
import { undoJob } from "../servers/shared/history/jobs.js";
import { SYNCED_TABLES } from "../servers/sharing/instance-sync.js";

const REPO = new URL("..", import.meta.url).pathname;

/* The instance anchor this file runs under. Crow's own modules (project-spaces,
 * project-lifecycle) resolve their data dir from the environment, so the whole
 * file gets one private home — never the real ~/.crow. */
const HOME_ROOT = mkdtempSync(join(tmpdir(), "hist-tasks-home-"));
const INSTANCE_DATA = join(HOME_ROOT, "data");
process.env.CROW_HOME = join(HOME_ROOT, "home");
process.env.CROW_DATA_DIR = INSTANCE_DATA;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;

after(() => {
  rmSync(HOME_ROOT, { recursive: true, force: true });
});

/** The owner at their dashboard, and a verified bot working a board card. */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };
const BOT = { authorKind: "bot", authorId: "hank", jobId: "card:9" };

/** An AWS-shaped access key, built at runtime so this file carries no literal a
 *  secret scanner would flag (the redaction sweep is what is being tested). */
const AWS_KEY = ["AKIA", "Q7T2", "MN4P", "R8SZ", "WX9K"].join("");

/** A fresh crow.db + a real tasks.db in the production shape, with 0024 and 0025. */
async function fixture(prefix = "hist-tasks-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_INSTANCE_SYNC: "1" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  const tasksDbPath = join(dir, "tasks.db");
  const quiet = () => {};
  runTasksBase({ tasksDbPath, log: quiet });
  runBoardStages({ dbPath, tasksDbPath, log: quiet });
  await runTrackerConvergence({ dbPath, tasksDbPath, log: quiet });
  await runCardModel({ dbPath, tasksDbPath, log: quiet });
  runItemVersions({ dbPath, log: quiet });
  runMore({ dbPath, tasksDbPath, log: quiet });
  runSources({ dbPath, log: quiet });
  // The registry's bookkeeping lives in crow.db even for the migrations that write
  // tasks.db, so "0025 has applied" is a row HERE — that is what the boot ensure
  // reads for the card store.
  const book = new Database(dbPath);
  book.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of [MIGRATION_0024, MIGRATION_0025, MIGRATION_0026]) {
    book.prepare("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
  }
  book.close();
  const db = createDbClient(dbPath);
  const tdb = createDbClient(tasksDbPath);
  return {
    dir,
    dbPath,
    tasksDbPath,
    db,
    tdb,
    async dispose() {
      db.close();
      tdb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** INSERT a row as `ctx`; returns its id. */
async function insert(db, ctx, table, row) {
  const columns = Object.keys(row);
  const info = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(info.lastInsertRowid);
}

/** UPDATE one row as `ctx`. */
const update = (db, ctx, table, keyColumn, key, fields) => {
  const columns = Object.keys(fields);
  return withWriteContext(ctx, () =>
    db.execute({
      sql: `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE ${keyColumn} = ?`,
      args: [...columns.map((c) => fields[c]), key],
    }),
  );
};

const versionsOf = async (db, itemType, itemId) =>
  (
    await db.execute({
      sql: "SELECT id, op, snapshot_json, redacted FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id",
      args: [itemType, String(itemId)],
    })
  ).rows;

const countVersions = async (db, itemType) =>
  Number(
    (await db.execute({ sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = ?", args: [itemType] }))
      .rows[0].n,
  );

const setting = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;

/* ------------------------------------------- R1a: the sweep is store-aware */

test("a card-store sweep redacts a secret in a card's versions, leaves the live card alone and never touches crow.db's types", async () => {
  const f = await fixture();
  try {
    // A token pasted into a card's description: the version table is where it
    // would live forever, so the sweep has to reach it in tasks.db.
    const cardId = await insert(f.tdb, BOT, "tasks_items", {
      title: "Rotate the key",
      description: `the key is ${AWS_KEY}`,
      project_id: 3,
    });
    await update(f.tdb, BOT, "tasks_items", "id", cardId, { title: "Rotate the key, now" });
    // And the same shape in crow.db, so "only this store" is observable.
    const memoryId = await insert(f.db, OWNER, "memories", { content: `a memory holding ${AWS_KEY}` });

    const cardBefore = await versionsOf(f.tdb, "card", cardId);
    assert.equal(cardBefore.length, 2);
    assert.ok(cardBefore.some((v) => v.snapshot_json.includes(AWS_KEY)), "the secret IS in the stored version before the sweep");

    const cardSweep = await sweep(f.tdb, { store: "tasks", settingsDb: f.db, batchSize: 500 });
    assert.equal(cardSweep.store, "tasks");
    assert.ok(cardSweep.redacted >= 1, `the card sweep redacted something: ${JSON.stringify(cardSweep)}`);

    const cardAfter = await versionsOf(f.tdb, "card", cardId);
    assert.ok(
      cardAfter.some((v) => Number(v.redacted) === 1 && v.snapshot_json.includes("[redacted]")),
      `the version holding the key was redacted: ${JSON.stringify(cardAfter)}`,
    );
    assert.ok(!cardAfter.some((v) => v.snapshot_json.includes(AWS_KEY)), "and no stored card version still holds it");

    // LIVE DATA IS NOT HISTORY'S BUSINESS: the card's own description still has it.
    const live = (await f.tdb.execute({ sql: "SELECT description FROM tasks_items WHERE id = ?", args: [cardId] })).rows[0];
    assert.equal(live.description, `the key is ${AWS_KEY}`, "the card itself is untouched");

    // THE OTHER STORE IS NOT THIS PASS'S BUSINESS.
    const memoryVersions = (await f.db.execute({
      sql: "SELECT snapshot_json, redacted FROM item_versions WHERE item_type = 'memory'",
      args: [],
    })).rows;
    assert.ok(memoryVersions.length >= 1);
    assert.ok(
      memoryVersions.some((v) => v.snapshot_json.includes(AWS_KEY) && Number(v.redacted) === 0),
      "a tasks.db sweep redacted nothing in crow.db",
    );

    // The scan mark is PER STORE, both kept in crow.db's dashboard_settings: the
    // card pass moved its own key and left the crow store's alone.
    const tasksMark = await setting(f.db, redactScanSetting("tasks"));
    const crowMark = await setting(f.db, redactScanSetting("crow"));
    assert.equal(redactScanSetting("crow"), "history.redact_scanned_to", "the crow store keeps the original key");
    assert.equal(redactScanSetting("tasks"), "history.redact_scanned_to.tasks", "the card store has its own");
    assert.ok(Number(tasksMark) >= Math.max(...cardAfter.map((v) => Number(v.id))), `the card mark is at the newest card version: ${tasksMark}`);
    assert.equal(crowMark, null, "the crow store's mark was not written by a card pass");

    // A crow.db pass then reaches the memory, and leaves the card rows as they are.
    const crowSweep = await sweep(f.db, { batchSize: 500 });
    assert.equal(crowSweep.store, "crow");
    assert.ok(
      (await f.db.execute("SELECT snapshot_json, redacted FROM item_versions WHERE item_type = 'memory'")).rows
        .some((v) => Number(v.redacted) === 1 && v.snapshot_json.includes("[redacted]")),
      "the crow pass redacted the memory's version",
    );
    assert.deepEqual(await versionsOf(f.tdb, "card", cardId), cardAfter, "and the card's versions are exactly as they were");
  } finally {
    await f.dispose();
  }
});

test("a card-store sweep coalesces and Trash-erases only cards, and refuses an unknown store", async () => {
  const f = await fixture();
  try {
    // Two rapid saves by the same author on one card coalesce; a memory edited the
    // same way in crow.db is NOT touched by the card pass.
    const cardId = await insert(f.tdb, BOT, "tasks_items", { title: "c1", project_id: 4 });
    await update(f.tdb, BOT, "tasks_items", "id", cardId, { title: "c2" });
    await update(f.tdb, BOT, "tasks_items", "id", cardId, { title: "c3" });
    const memoryId = await insert(f.db, BOT, "memories", { content: "m1" });
    await update(f.db, BOT, "memories", "id", memoryId, { content: "m2" });
    await update(f.db, BOT, "memories", "id", memoryId, { content: "m3" });

    const result = await sweep(f.tdb, { store: "tasks", settingsDb: f.db, batchSize: 500 });
    assert.ok(result.coalesced >= 1, `the card pass coalesced the rapid saves: ${JSON.stringify(result)}`);
    assert.equal(await countVersions(f.tdb, "card"), 2, "insert + the last update");
    assert.equal((await versionsOf(f.db, "memory", memoryId)).length, 3, "crow.db's memory versions are untouched by the card pass");

    // A store name that is not one of the two is a refusal, not a silent crow pass.
    await assert.rejects(() => sweep(f.tdb, { store: "elsewhere" }), /sweep store must be/);
  } finally {
    await f.dispose();
  }
});

/* ------------------------------- R1b: a purge erases the cards' versions */

test("a purged project leaves no card versions (and keeps the tombstones) in tasks.db, and another project's cards keep theirs", async () => {
  const f = await fixture();
  try {
    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const L = await import("../servers/shared/project-lifecycle.js");
    const project = await createProjectSpace(f.db, { name: "Card purge" });
    const other = await createProjectSpace(f.db, { name: "Keep my cards" });
    const projectId = Number(project.id);
    const keepId = Number(other.id);

    // Cards are created through the board service, so their `create` mutation and
    // their versions are what a real card has.
    const { createCard, updateCard } = await import("../servers/gateway/board/card-service.js");
    const gone = [];
    for (let i = 0; i < 2; i++) {
      const { id } = await createCard(f.tdb, { title: `purged ${i}`, project_id: projectId }, BOT);
      await updateCard(f.tdb, id, { description: `edited ${i}` }, BOT);
      gone.push(Number(id));
    }
    const kept = Number((await createCard(f.tdb, { title: "kept", project_id: keepId }, BOT)).id);
    await updateCard(f.tdb, kept, { title: "kept, edited" }, BOT);
    assert.equal((await versionsOf(f.tdb, "card", gone[0])).length, 2, "each card has insert + edit");
    assert.equal((await versionsOf(f.tdb, "card", kept)).length, 2);

    const outcome = await L.deleteProject(f.db, projectId, {
      confirmName: "Card purge",
      tasksDbPath: f.tasksDbPath,
      dataDir: INSTANCE_DATA,
      storageDelete: async () => {},
      disconnectBackend: async () => true,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.partial, undefined, "the card history erase is part of the cards step, and it succeeded");

    for (const id of gone) {
      assert.equal((await f.tdb.execute({ sql: "SELECT 1 FROM tasks_items WHERE id = ?", args: [id] })).rows.length, 0, "the card row is gone");
      assert.deepEqual(await versionsOf(f.tdb, "card", id), [], "and NO item_versions rows are left for it");
      // A tombstone is what makes "erased" stick, written by the same armed door
      // crow.db's erase uses.
      assert.equal(await isErased(f.tdb, "card", String(id)), true, "the card's tombstone exists");
    }
    const tombstones = (await f.tdb.execute({
      sql: "SELECT item_id, erased_by FROM item_erasures WHERE item_type = 'card' ORDER BY item_id",
      args: [],
    })).rows;
    assert.deepEqual(
      tombstones.map((t) => ({ id: String(t.item_id), by: t.erased_by })),
      gone.map((id) => ({ id: String(id), by: "system:project-delete" })),
      "one tombstone per purged card, recorded as the project delete's own consequence",
    );
    // The armed switch is shut again after the erase.
    assert.equal(Number((await f.tdb.execute("SELECT armed FROM item_versions_erase")).rows[0].armed), 0);

    // A card that was NOT in that project keeps its whole history.
    assert.equal((await versionsOf(f.tdb, "card", kept)).length, 2, "the other project's card keeps its versions");

    // AND THE ERASE NEVER REACHES SYNC: tasks_items is not an erasure-propagating
    // table (it is not in SYNCED_TABLES at all), so a card erase emits nothing.
    assert.equal(erasureItemType("tasks_items"), null, "tasks_items has no erasure-sync mapping");
    assert.ok(!SYNCED_TABLES.includes("tasks_items"), "and it is not a synced table");
  } finally {
    await f.dispose();
  }
});

test("a failed card-history erase is the same recorded partial step, and the finish path re-runs it", async () => {
  const f = await fixture();
  try {
    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const L = await import("../servers/shared/project-lifecycle.js");
    const { createCard, updateCard } = await import("../servers/gateway/board/card-service.js");
    const project = await createProjectSpace(f.db, { name: "Card erase later" });
    const projectId = Number(project.id);
    const { id: cardId } = await createCard(f.tdb, { title: "a purged card", project_id: projectId }, BOT);
    await updateCard(f.tdb, Number(cardId), { description: "edited" }, BOT);
    assert.equal((await versionsOf(f.tdb, "card", cardId)).length, 2);

    // The card erase fails (the armed erase switch is refused, the way a lock or a
    // damaged store would refuse it) while the row delete and the tombstone commit.
    await f.tdb.execute(`CREATE TRIGGER test_block_card_erase
      BEFORE UPDATE ON item_versions_erase
      WHEN NEW.armed = 1
      BEGIN SELECT RAISE(ABORT, 'simulated card history erase failure'); END`);

    const outcome = await L.deleteProject(f.db, projectId, {
      confirmName: "Card erase later",
      tasksDbPath: f.tasksDbPath,
      dataDir: INSTANCE_DATA,
      storageDelete: async () => {},
      disconnectBackend: async () => true,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(outcome.partial, ["history-erase"], "the failed card erase is recorded as the history-erase step");
    assert.equal((await f.tdb.execute({ sql: "SELECT 1 FROM tasks_items WHERE id = ?", args: [cardId] })).rows.length, 0);
    assert.equal((await versionsOf(f.tdb, "card", cardId)).length, 3, "the versions are still there (the erase did not land)");
    assert.equal(Number((await f.tdb.execute("SELECT armed FROM item_versions_erase")).rows[0].armed), 0, "and the switch was rolled back shut");

    await f.tdb.execute("DROP TRIGGER test_block_card_erase");
    const resumed = await L.resumeProjectDelete(f.db, projectId, {
      dataDir: INSTANCE_DATA,
      tasksDbPath: f.tasksDbPath,
      storageDelete: async () => {},
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.partial, [], "the finish path re-ran the card half of the erase");
    assert.deepEqual(await versionsOf(f.tdb, "card", cardId), [], "the card's versions are gone");
    assert.equal(await isErased(f.tdb, "card", String(cardId)), true, "and its tombstone exists");
  } finally {
    await f.dispose();
  }
});

/* ----------- R7: a purge erases exactly the cards it removed, never a moved one */

for (const failFirst of [false, true]) {
  test(`a purge ${failFirst ? "whose card erase fails, then resumes," : ""} erases only the project's own cards, and keeps a card that moved on and was deleted`, async () => {
    const f = await fixture();
    try {
      const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
      const L = await import("../servers/shared/project-lifecycle.js");
      const { createCard, updateCard } = await import("../servers/gateway/board/card-service.js");
      const x = Number((await createProjectSpace(f.db, { name: "Purge X" })).id);
      const y = Number((await createProjectSpace(f.db, { name: "Keep Y" })).id);
      // Moved X -> Y, then deleted normally while it lived in Y: it sits in Trash.
      const movedId = Number((await createCard(f.tdb, { title: "moved on", project_id: x }, BOT)).id);
      await f.tdb.execute({ sql: "UPDATE tasks_items SET project_id = ? WHERE id = ?", args: [y, movedId] });
      await f.tdb.execute({ sql: "DELETE FROM tasks_items WHERE id = ?", args: [movedId] });
      const movedBefore = (await versionsOf(f.tdb, "card", movedId)).length;
      assert.ok(movedBefore >= 3, "insert, move and delete versions exist");
      // X's own card, and one already in X's Trash.
      const ownId = Number((await createCard(f.tdb, { title: "own", project_id: x }, BOT)).id);
      await updateCard(f.tdb, ownId, { description: "edited" }, BOT);

      if (failFirst) {
        await f.tdb.execute(`CREATE TRIGGER test_block_card_erase2
          BEFORE UPDATE ON item_versions_erase
          WHEN NEW.armed = 1
          BEGIN SELECT RAISE(ABORT, 'simulated card history erase failure'); END`);
      }
      const outcome = await L.deleteProject(f.db, x, {
        confirmName: "Purge X",
        tasksDbPath: f.tasksDbPath,
        dataDir: INSTANCE_DATA,
        storageDelete: async () => {},
        disconnectBackend: async () => true,
      });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      if (failFirst) {
        assert.deepEqual(outcome.partial, ["history-erase"]);
        assert.ok((await versionsOf(f.tdb, "card", ownId)).length > 0, "the failed erase left the versions");
        await f.tdb.execute("DROP TRIGGER test_block_card_erase2");
        const resumed = await L.resumeProjectDelete(f.db, x, {
          dataDir: INSTANCE_DATA,
          tasksDbPath: f.tasksDbPath,
          storageDelete: async () => {},
        });
        assert.equal(resumed.ok, true, JSON.stringify(resumed));
        assert.deepEqual(resumed.partial, []);
      } else {
        assert.equal(outcome.partial, undefined);
      }
      assert.deepEqual(await versionsOf(f.tdb, "card", ownId), [], "X's own purged card is erased");
      assert.equal(await isErased(f.tdb, "card", String(ownId)), true);
      assert.equal((await versionsOf(f.tdb, "card", movedId)).length, movedBefore, "the moved card keeps its whole history");
      assert.equal(await isErased(f.tdb, "card", String(movedId)), false, "and has no tombstone");
    } finally {
      await f.dispose();
    }
  });
}

test("a resumed card erase skips a recorded card that was restored in between, and erases the rest", async () => {
  const f = await fixture();
  try {
    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const L = await import("../servers/shared/project-lifecycle.js");
    const { createCard } = await import("../servers/gateway/board/card-service.js");
    const x = Number((await createProjectSpace(f.db, { name: "Race X" })).id);
    const a = Number((await createCard(f.tdb, { title: "a", project_id: x }, BOT)).id);
    const b = Number((await createCard(f.tdb, { title: "b", project_id: x }, BOT)).id);
    await f.tdb.execute(`CREATE TRIGGER test_block_card_erase3
      BEFORE UPDATE ON item_versions_erase
      WHEN NEW.armed = 1
      BEGIN SELECT RAISE(ABORT, 'simulated card history erase failure'); END`);
    const outcome = await L.deleteProject(f.db, x, {
      confirmName: "Race X",
      tasksDbPath: f.tasksDbPath,
      dataDir: INSTANCE_DATA,
      storageDelete: async () => {},
      disconnectBackend: async () => true,
    });
    assert.deepEqual(outcome.partial, ["history-erase"]);
    await f.tdb.execute("DROP TRIGGER test_block_card_erase3");
    // Between the purge and the resume, card `a` is brought back (same id, newest version
    // is no longer a delete).
    // (Re-inserting its row is what the capture trigger records as a newer, non-delete version.)
    await f.tdb.execute({ sql: "INSERT INTO tasks_items (id, title, project_id) VALUES (?, 'a back', ?)", args: [a, x] });
    const before = (await versionsOf(f.tdb, "card", a)).length;
    const resumed = await L.resumeProjectDelete(f.db, x, {
      dataDir: INSTANCE_DATA,
      tasksDbPath: f.tasksDbPath,
      storageDelete: async () => {},
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal((await versionsOf(f.tdb, "card", a)).length, before, "the restored card keeps its history");
    assert.equal(await isErased(f.tdb, "card", String(a)), false, "and gets no tombstone");
    assert.deepEqual(await versionsOf(f.tdb, "card", b), [], "the other card is erased");
    assert.equal(await isErased(f.tdb, "card", String(b)), true);
  } finally {
    await f.dispose();
  }
});

/* ---------------------- R1c: a job's card goes to the Trash, then is erased */

test("a card deleted by a job undo keeps its versions until a card sweep past the Trash period erases them", async () => {
  const f = await fixture();
  try {
    // The job creates the card (its first version is the insert), so the undo
    // DELETEs the row — which is a Trash-like state, not a disappearance.
    const cardId = await insert(f.tdb, BOT, "tasks_items", { title: "made by the job", project_id: 5 });
    const undo = await undoJob(f.tdb, { jobId: BOT.jobId }, OWNER);
    assert.deepEqual(
      undo.restored.map((r) => ({ type: r.itemType, action: r.action })),
      [{ type: "card", action: "deleted" }],
      "the undo removed the card the job created",
    );
    assert.equal((await f.tdb.execute({ sql: "SELECT 1 FROM tasks_items WHERE id = ?", args: [cardId] })).rows.length, 0);
    const afterUndo = await versionsOf(f.tdb, "card", cardId);
    assert.deepEqual(afterUndo.map((v) => v.op), ["insert", "delete"], "the delete is a version: the card waits in the Trash");
    assert.equal((await f.tdb.execute({
      sql: "SELECT json_extract(snapshot_json, '$.title') AS title FROM item_versions WHERE item_type = 'card' AND item_id = ? AND op = 'delete'",
      args: [String(cardId)],
    })).rows[0].title, "made by the job", "and it holds what was removed");

    // NOT BEFORE the Trash period: a card pass 10 days later keeps it.
    const early = await sweep(f.tdb, { store: "tasks", settingsDb: f.db, now: new Date(Date.now() + 10 * 86_400_000), trashDays: 30 });
    assert.deepEqual(early.erased, [], "a young Trash entry is not erased");
    assert.equal((await versionsOf(f.tdb, "card", cardId)).length, 2);

    // PAST it: the card sweep erases every version, and leaves the tombstone.
    const late = await sweep(f.tdb, { store: "tasks", settingsDb: f.db, now: new Date(Date.now() + 40 * 86_400_000), trashDays: 30 });
    assert.deepEqual(late.erased.map((e) => e.itemId), [String(cardId)], "the aged card was erased");
    assert.deepEqual(await versionsOf(f.tdb, "card", cardId), []);
    assert.equal(await isErased(f.tdb, "card", String(cardId)), true);
    assert.equal(late.eraseEvents, 0, "a card erase never emits a sync event");
  } finally {
    await f.dispose();
  }
});

/* --------------------------------------- R2: the boot ensure covers tasks.db */

test("the boot ensure re-creates a dropped card trigger and disarms a stuck erase switch in tasks.db", async () => {
  const f = await fixture();
  const raw = new Database(f.tasksDbPath);
  try {
    // The shape a rebuilt tasks_items (or a hand-edited store) leaves behind: the
    // capture triggers are gone while 0025 stays recorded in crow.db, and an erase
    // transaction left its switch armed.
    for (const suffix of ["ai", "au", "ad"]) raw.exec(`DROP TRIGGER hist_tasks_items_${suffix}`);
    raw.exec("UPDATE item_versions_erase SET armed = 1");
    assert.deepEqual(
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'hist_tasks_items%'").all(),
      [],
      "the card triggers are really gone",
    );
  } finally {
    raw.close();
  }

  const lines = [];
  const result = ensureHistoryTriggersAtBoot({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: (m) => lines.push(m) });
  // The crow.db pass runs first and is healthy: nothing restored there.
  assert.deepEqual(result.restored, [], "crow.db needed nothing");

  const after = new Database(f.tasksDbPath);
  try {
    const triggers = after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
    for (const suffix of ["ai", "au", "ad"]) {
      assert.ok(triggers.includes(`hist_tasks_items_${suffix}`), `hist_tasks_items_${suffix} is back`);
    }
    assert.equal(Number(after.prepare("SELECT armed FROM item_versions_erase").get().armed), 0, "the stuck switch is disarmed");
  } finally {
    after.close();
  }
  assert.ok(
    lines.some((l) => l.includes("tasks.db") && l.includes("re-created") && l.includes("hist_tasks_items_ai")),
    `the card-store repair is reported: ${JSON.stringify(lines)}`,
  );

  // And capture works again: a card edit after the repair writes a version.
  const cardId = await insert(f.tdb, BOT, "tasks_items", { title: "after the repair", project_id: 6 });
  assert.equal((await versionsOf(f.tdb, "card", cardId)).length, 1);
});

test("the boot ensure leaves tasks.db's card capture alone while crow.db has no 0025 record and no card baseline", async () => {
  const f = await fixture();
  try {
    // A tasks.db whose card triggers were dropped AND whose crow.db has never
    // recorded 0025: arming capture there would record versions of rows whose
    // pre-history was never baselined, so the card store is left to the migration.
    const raw = new Database(f.tasksDbPath);
    for (const suffix of ["ai", "au", "ad"]) raw.exec(`DROP TRIGGER hist_tasks_items_${suffix}`);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'card'").get().n, 0);
    raw.close();
    const book = new Database(f.dbPath);
    book.prepare("DELETE FROM schema_migrations WHERE id = ?").run(MIGRATION_0025);
    book.close();

    ensureHistoryTriggersAtBoot({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    const after = new Database(f.tasksDbPath);
    try {
      assert.deepEqual(
        after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'hist_tasks_items%'").all(),
        [],
        "no card trigger without a baseline",
      );
    } finally {
      after.close();
    }
  } finally {
    await f.dispose();
  }
});

/* ------------------------------------------ R3: a card restores CONTENT ONLY */

test("restoring an old version of a done, assigned, auto card keeps its status, bot and autonomy", async () => {
  const f = await fixture();
  try {
    const cardId = await insert(f.tdb, OWNER, "tasks_items", {
      title: "first title",
      description: "first body",
      project_id: 7,
      status: "pending",
      priority: 3,
    });
    const first = (await versionsOf(f.tdb, "card", cardId))[0];
    // The card then moves on: it is being worked by a bot with autonomy, is
    // assigned, and finishes.
    await update(f.tdb, BOT, "tasks_items", "id", cardId, {
      status: "done",
      assigned_bot: "hank",
      bot_id: "hank",
      autonomy: "auto",
      priority: 1,
      project_id: 8,
    });

    const restored = await restoreVersion(f.tdb, { versionId: Number(first.id) }, OWNER);
    assert.equal(restored.unchanged, false);
    const card = (await f.tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id = ?", args: [cardId] })).rows[0];
    // Content and the plan fields come back...
    assert.equal(card.title, "first title");
    assert.equal(card.description, "first body");
    assert.equal(Number(card.priority), 3, "priority is a plan field: restored");
    // ...and everything that says what the card IS stays as it is.
    assert.equal(card.status, "done", "a restored title does not reopen a finished card");
    assert.equal(card.assigned_bot, "hank", "the assignment stays");
    assert.equal(card.bot_id, "hank");
    assert.equal(card.autonomy, "auto", "and so does the autonomy it was given");
    assert.equal(Number(card.project_id), 8, "the card is not dragged back to the project it left");

    // The version the restore wrote still CARRIES the live values in its snapshot,
    // so History can show who was assigned and where the card was.
    const newest = (await listVersions(f.tdb, { itemType: "card", itemId: cardId }))[0];
    assert.equal(newest.snapshot.status, "done");
    assert.equal(newest.snapshot.assigned_bot, "hank");
    assert.equal(newest.snapshot.autonomy, "auto");
    assert.equal(newest.snapshot.project_id, 8);
  } finally {
    await f.dispose();
  }
});

test("a card restore writes one board_mutations row with what changed, and none when nothing does", async () => {
  const f = await fixture();
  try {
    const cardId = await insert(f.tdb, OWNER, "tasks_items", { title: "original title", project_id: 9, priority: 5 });
    const first = (await versionsOf(f.tdb, "card", cardId))[0];
    await update(f.tdb, OWNER, "tasks_items", "id", cardId, { title: "edited title", priority: 2 });
    // A clock the restore must move, the way updateCard does.
    await f.tdb.execute({ sql: "UPDATE tasks_items SET updated_at = '2020-01-01 00:00:00' WHERE id = ?", args: [cardId] });

    const before = Number((await f.tdb.execute("SELECT COUNT(*) AS n FROM board_mutations")).rows[0].n);
    const restored = await restoreVersion(f.tdb, { versionId: Number(first.id) }, OWNER);
    assert.equal(restored.synced, false, "a card restore is not a synced write");
    const rows = (await f.tdb.execute({
      sql: "SELECT item_id, verb, actor_kind, actor_id, job_id, detail_json FROM board_mutations ORDER BY id DESC LIMIT 1",
      args: [],
    })).rows;
    assert.equal(Number((await f.tdb.execute("SELECT COUNT(*) AS n FROM board_mutations")).rows[0].n), before + 1, "exactly one provenance row");
    assert.deepEqual(
      { ...rows[0] },
      {
        item_id: cardId,
        verb: "update",
        actor_kind: "human",
        actor_id: "abcd1234",
        job_id: "session:abcd1234",
        detail_json: JSON.stringify({
          restored_from_version: Number(first.id),
          fields: { title: ["edited title", "original title"], priority: [2, 5] },
        }),
      },
      "the board's own recordMutation shape, for the fields that really changed",
    );
    // updated_at moved, as updateCard's own write does.
    const stamped = (await f.tdb.execute({ sql: "SELECT updated_at FROM tasks_items WHERE id = ?", args: [cardId] })).rows[0];
    assert.notEqual(stamped.updated_at, "2020-01-01 00:00:00", "the restore stamped updated_at");

    // A restore of what is already there changes nothing — and records nothing.
    const newest = (await versionsOf(f.tdb, "card", cardId)).at(-1);
    const mutations = Number((await f.tdb.execute("SELECT COUNT(*) AS n FROM board_mutations")).rows[0].n);
    const noop = await restoreVersion(f.tdb, { versionId: Number(newest.id) }, OWNER);
    assert.equal(noop.unchanged, true);
    assert.equal(Number((await f.tdb.execute("SELECT COUNT(*) AS n FROM board_mutations")).rows[0].n), mutations, "no provenance row for a no-op");
  } finally {
    await f.dispose();
  }
});

test("a card restore keeps an archived card archived", async () => {
  const f = await fixture();
  try {
    const cardId = await insert(f.tdb, OWNER, "tasks_items", { title: "first title", project_id: 10 });
    const first = (await versionsOf(f.tdb, "card", cardId))[0];
    await update(f.tdb, OWNER, "tasks_items", "id", cardId, { title: "second title" });
    // archived_at is in NEITHER the tracked list nor the snapshot: a restore can
    // never unarchive a card.
    await f.tdb.execute({ sql: "UPDATE tasks_items SET archived_at = '2026-11-04T10:00:00.000Z' WHERE id = ?", args: [cardId] });
    await restoreVersion(f.tdb, { versionId: Number(first.id) }, OWNER);
    const card = (await f.tdb.execute({ sql: "SELECT title, archived_at FROM tasks_items WHERE id = ?", args: [cardId] })).rows[0];
    assert.equal(card.title, "first title");
    assert.equal(card.archived_at, "2026-11-04T10:00:00.000Z");
  } finally {
    await f.dispose();
  }
});
test("a deleted card restored from nothing comes back unassigned, gated and on the board's first status, with a create row", async () => {
  const f = await fixture();
  try {
    const cardId = await insert(f.tdb, BOT, "tasks_items", {
      title: "auto card",
      description: "a body",
      project_id: 11,
      status: "in_progress",
      assigned_bot: "hank",
      bot_id: "hank",
      autonomy: "auto",
    });
    await withWriteContext(OWNER, () => f.tdb.execute({ sql: "DELETE FROM tasks_items WHERE id = ?", args: [cardId] }));
    const versions = await versionsOf(f.tdb, "card", cardId);
    const deleteVersion = versions.at(-1);
    assert.equal(deleteVersion.op, "delete");
    assert.equal(
      Number((await f.tdb.execute({ sql: "SELECT COUNT(*) AS n FROM tasks_items WHERE id = ?", args: [cardId] })).rows[0].n),
      0,
    );

    const before = Number((await f.tdb.execute("SELECT COUNT(*) AS n FROM board_mutations")).rows[0].n);
    await restoreVersion(f.tdb, { versionId: Number(deleteVersion.id) }, OWNER);
    const card = (await f.tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id = ?", args: [cardId] })).rows[0];
    assert.equal(card.title, "auto card", "the content comes back");
    assert.equal(card.description, "a body");
    assert.equal(card.assigned_bot, null, "unassigned");
    assert.equal(card.bot_id, null);
    assert.equal(card.autonomy, "gated", "and gated, so no bot starts on it");
    // This fixture's tasks.db has no board_defs table, so the plain default applies.
    const expected = "pending";
    assert.equal(card.status, expected, "the board's first status");
    assert.notEqual(card.status, "in_progress");

    const rows = (await f.tdb.execute({
      sql: "SELECT verb, actor_kind, detail_json FROM board_mutations WHERE item_id = ? ORDER BY id DESC LIMIT 1",
      args: [cardId],
    })).rows;
    assert.equal(Number((await f.tdb.execute("SELECT COUNT(*) AS n FROM board_mutations")).rows[0].n), before + 1);
    assert.equal(rows[0].verb, "create");
    assert.equal(rows[0].actor_kind, "human");
    assert.equal(JSON.parse(rows[0].detail_json).restored_from_version, Number(deleteVersion.id));
  } finally {
    await f.dispose();
  }
});
