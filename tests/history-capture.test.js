/**
 * Version history, Task 1: the item_versions table and the capture triggers.
 *
 * Every fixture is a real scripts/init-db.js crow.db in its own temp dir (so the
 * FTS triggers and the seeded crow_context sections are the production shape),
 * optionally with scripts/migrations/0024-item-versions.mjs applied. All writes
 * go through a raw better-sqlite3 connection: nothing here relies on the
 * gateway, which is the point — a bot's direct SQL must be recorded too.
 *
 * The migration is NOT registered in init-db.js (no SCHEMA_GENERATION bump): it
 * rides the additive registry, so the tests call its `run()` directly, the same
 * way the other migration tests do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import { COVERED, STORE_TASKS, STAMP_ONLY_TRANSITIONS, guardTriggerSql, triggerSql, typesForMigration } from "../servers/shared/history/covered.js";
import { ensureHistoryTriggers, ensureHistoryTriggersAtBoot } from "../servers/shared/history/ensure.js";
import {
  ITEM_VERSIONS_DDL,
  run,
  id as migrationId,
} from "../scripts/migrations/0024-item-versions.mjs";
import { run as runMore } from "../scripts/migrations/0025-item-versions-more.mjs";
import { run as runSources } from "../scripts/migrations/0026-item-versions-sources.mjs";
import { run as runTasksBase } from "../scripts/migrations/0000-tasks-base.mjs";
import { SYNCED_TABLES } from "../servers/sharing/instance-sync.js";

const REPO = new URL("..", import.meta.url).pathname;

// The never-version-a-secret rule, written out here rather than imported, so a
// loosened regexp in covered.js cannot also loosen this test.
const SECRET_COLUMN = /api_key|token|secret|password/i;

/** Counters, sync clocks, timestamps, orderings and the item key: never stored.
 *  (blog_posts.published_at / nostr_event_id ARE stored — a version must keep the
 *  publishing facts — they are just not changes on their own.) */
const COUNTER_OR_DERIVED =
  /^(id|created_at|updated_at|accessed_at|access_count|lamport_ts|sort_order)$/i;

/** A fresh crow.db from init-db.js, in its own temp dir. */
function initDbFixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  return {
    dir,
    dbPath,
    open({ wal = false } = {}) {
      const db = new Database(dbPath);
      db.pragma("busy_timeout = 10000");
      if (wal) db.pragma("journal_mode = WAL");
      return db;
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** init-db fixture with 0024, 0025 AND 0026 applied (the migrated instance) — the
 *  production shape now that the rest of the covered content is covered (and the
 *  research source after it). Each registry bookkeeping row is recorded too,
 *  exactly as scripts/migrations/runner.mjs writes it: the boot re-ensure only arms
 *  capture for a baselined table, and "the migration is recorded as applied" is one
 *  of the two ways it knows.
 *
 *  A real tasks.db is created for 0025 (0000-tasks-base makes tasks_items), so the
 *  card type is captured too — in that file, never in crow.db. */
function migratedFixture(prefix = "hist-capture-") {
  const fx = initDbFixture(prefix);
  const tasksDbPath = join(fx.dir, "tasks.db");
  runTasksBase({ tasksDbPath, log: () => {} });
  run({ dbPath: fx.dbPath, log: () => {} });
  runMore({ dbPath: fx.dbPath, tasksDbPath, log: () => {} });
  runSources({ dbPath: fx.dbPath, log: () => {} });
  const db = fx.open();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0024-item-versions", "0025-item-versions-more", "0026-item-versions-sources"]) {
    db.prepare("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
      id,
      new Date().toISOString(),
    );
  }
  db.close();
  fx.tasksDbPath = tasksDbPath;
  return fx;
}

const versionCount = (db, itemType, itemId) =>
  db
    .prepare("SELECT COUNT(*) AS n FROM item_versions WHERE item_type = ? AND item_id = ?")
    .get(itemType, String(itemId)).n;

const versionsOf = (db, itemType, itemId) =>
  db
    .prepare(
      `SELECT id, op, snapshot_json, project_ref, author_kind, author_id, job_id, origin_instance,
              redacted, created_at
         FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id`,
    )
    .all(itemType, String(itemId));

test("inserting a memory writes one insert version whose snapshot holds the content", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db
      .prepare(
        `INSERT INTO memories (content, context, tags, source, category, importance)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("a first draft of the memory", "session context", "alpha,beta", "test-suite", "general", 7);

    const rows = versionsOf(db, "memory", info.lastInsertRowid);
    assert.equal(rows.length, 1, "exactly one version per insert");
    assert.equal(rows[0].op, "insert");
    assert.equal(rows[0].author_kind, "unattributed", "no write context yet (Task 2 stamps it)");
    assert.equal(rows[0].redacted, 0);
    assert.equal(rows[0].project_ref, null, "an unfiled memory has no project_ref");
    assert.match(rows[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const snapshot = JSON.parse(rows[0].snapshot_json);
    assert.equal(snapshot.content, "a first draft of the memory");
    assert.equal(snapshot.importance, 7);
    assert.equal(snapshot.tags, "alpha,beta");
    assert.equal(snapshot.category, "general");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("updating the content writes an update version", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("before the edit");
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("after the edit", info.lastInsertRowid);

    const rows = versionsOf(db, "memory", info.lastInsertRowid);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.op), ["insert", "update"]);
    assert.equal(JSON.parse(rows[1].snapshot_json).content, "after the edit");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("UPDATE memories SET access_count=access_count+1, accessed_at=datetime('now') writes NO version (review focus 1)", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const memory = db.prepare("INSERT INTO memories (content) VALUES (?)").run("recalled often");
    const post = db
      .prepare("INSERT INTO blog_posts (slug, title, content) VALUES (?, ?, ?)")
      .run("a-post", "A post", "body text");

    const memoryBefore = versionCount(db, "memory", memory.lastInsertRowid);
    const postBefore = versionCount(db, "blog_post", post.lastInsertRowid);

    // What memory recall does: touch the counters only.
    db.prepare(
      "UPDATE memories SET access_count = access_count + 1, accessed_at = datetime('now') WHERE id = ?",
    ).run(memory.lastInsertRowid);
    // ... and what a save-with-no-change does to a post's timestamp.
    db.prepare("UPDATE blog_posts SET updated_at = datetime('now') WHERE id = ?").run(post.lastInsertRowid);

    assert.equal(versionCount(db, "memory", memory.lastInsertRowid), memoryBefore, "a read is not a change");
    assert.equal(versionCount(db, "blog_post", post.lastInsertRowid), postBefore, "a touch is not a change");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("moving a memory to another project writes a version under the new project", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db
      .prepare("INSERT INTO memories (content, project_id, project_uuid) VALUES (?, ?, ?)")
      .run("filed under the first project", 7, "proj-first");
    // The write path's own filing change: project_id and project_uuid together.
    db.prepare("UPDATE memories SET project_id = 9, project_uuid = 'proj-second' WHERE id = ?").run(
      info.lastInsertRowid,
    );

    const rows = versionsOf(db, "memory", info.lastInsertRowid);
    assert.deepEqual(rows.map((r) => r.op), ["insert", "update"], "a move between projects is a change");
    assert.equal(rows[0].project_ref, "proj-first");
    assert.equal(rows[1].project_ref, "proj-second", "the new version belongs to the project it moved INTO");
    const snapshot = JSON.parse(rows[1].snapshot_json);
    assert.equal(snapshot.project_id, 9);
    assert.equal(snapshot.project_uuid, "proj-second");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("unfiling memories on project delete writes versions", () => {
  // The statement servers/shared/project-lifecycle.js runs inside its delete
  // transaction: memories are unfiled, never deleted.
  const UNFILE_SQL =
    "UPDATE memories SET project_id = NULL, project_uuid = NULL, updated_at = datetime('now') " +
    "WHERE project_id = ? OR (project_uuid IS NOT NULL AND project_uuid = ?)";
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const filed = db
      .prepare("INSERT INTO memories (content, project_id, project_uuid) VALUES (?, ?, ?)")
      .run("a deleted project's memory", 7, "proj-gone");
    const filesById = db
      .prepare("INSERT INTO memories (content, project_id, project_uuid) VALUES (?, ?, ?)")
      .run("filed by the uuid only", null, "proj-gone");
    const kept = db
      .prepare("INSERT INTO memories (content, project_id, project_uuid) VALUES (?, ?, ?)")
      .run("another project's memory", 8, "proj-kept");

    const unfiled = db.prepare(UNFILE_SQL).run(7, "proj-gone");
    assert.equal(unfiled.changes, 2, "both of the deleted project's memories were unfiled");

    for (const info of [filed, filesById]) {
      const rows = versionsOf(db, "memory", info.lastInsertRowid);
      assert.deepEqual(rows.map((r) => r.op), ["insert", "update"], "unfiling is recorded, not silent");
      assert.equal(rows[1].project_ref, null, "the unfiled version has no project scope");
      const snapshot = JSON.parse(rows[1].snapshot_json);
      assert.equal(snapshot.project_id, null);
      assert.equal(snapshot.project_uuid, null);
    }
    assert.equal(versionCount(db, "memory", kept.lastInsertRowid), 1, "another project's memory is untouched");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("a project_uuid stamp on an already-filed memory is not a version (sync noise)", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    // A row filed by its local id only (pre-project_uuid, or a write path that
    // named just the project). The sync layer later stamps the portable uuid onto
    // it while project_id stays exactly the same — see COVERED.memory and
    // STAMP_ONLY_TRANSITIONS in covered.js.
    const info = db
      .prepare("INSERT INTO memories (content, project_id) VALUES (?, ?)")
      .run("filed by id only", 4);
    const before = versionCount(db, "memory", info.lastInsertRowid);
    db.prepare("UPDATE memories SET project_uuid = 'proj-a' WHERE id = ?").run(info.lastInsertRowid);
    assert.equal(
      versionCount(db, "memory", info.lastInsertRowid),
      before,
      "filling the portable id of the SAME project is a stamp, not a move",
    );

    // The stamp does not hide a real change made in the same statement: an edit
    // that also stamps the uuid is recorded, and its snapshot carries both.
    const unstamped = db
      .prepare("INSERT INTO memories (content, project_id) VALUES (?, ?)")
      .run("will be edited", 4);
    db.prepare("UPDATE memories SET content = ?, project_uuid = 'proj-a' WHERE id = ?").run(
      "edited while being stamped",
      unstamped.lastInsertRowid,
    );
    const rows = versionsOf(db, "memory", unstamped.lastInsertRowid);
    assert.deepEqual(rows.map((r) => r.op), ["insert", "update"], "a content edit is still recorded");
    assert.equal(rows.at(-1).project_ref, "proj-a");
    assert.equal(JSON.parse(rows.at(-1).snapshot_json).content, "edited while being stamped");

    // And the exclusion is only for NULL -> value: unfiling (value -> NULL) IS a
    // change, because the memory really left its project.
    db.prepare("UPDATE memories SET project_uuid = NULL WHERE id = ?").run(info.lastInsertRowid);
    assert.equal(
      versionCount(db, "memory", info.lastInsertRowid),
      before + 1,
      "dropping the portable id is a filing change",
    );
    db.close();
  } finally {
    fx.dispose();
  }
});

test("deleting writes a delete version holding the last snapshot", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("draft one");
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("the last words", info.lastInsertRowid);
    db.prepare("DELETE FROM memories WHERE id = ?").run(info.lastInsertRowid);

    const rows = versionsOf(db, "memory", info.lastInsertRowid);
    assert.deepEqual(rows.map((r) => r.op), ["insert", "update", "delete"]);
    assert.equal(JSON.parse(rows[2].snapshot_json).content, "the last words", "a delete keeps what it removed");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
    db.close();
  } finally {
    fx.dispose();
  }
});

test("running the migration twice changes nothing", () => {
  const fx = initDbFixture("hist-twice-");
  try {
    const db = fx.open();
    db.prepare("INSERT INTO memories (content) VALUES (?)").run("row one");
    db.prepare("INSERT INTO memories (content) VALUES (?)").run("row two");
    db.prepare("INSERT INTO blog_posts (slug, title, content) VALUES (?, ?, ?)").run("p1", "P1", "body");
    db.close();

    run({ dbPath: fx.dbPath, log: () => {} });
    const first = fx.open();
    const snapshotOf = (d) => ({
      versions: d
        .prepare(
          `SELECT id, item_type, item_id, op, snapshot_json, project_ref, author_kind, created_at
             FROM item_versions ORDER BY id`,
        )
        .all(),
      erase: d.prepare("SELECT * FROM item_versions_erase").all(),
      triggers: d
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'hist_%' ORDER BY name",
        )
        .all(),
    });
    const before = snapshotOf(first);
    first.close();

    const second = run({ dbPath: fx.dbPath, log: () => {} });
    assert.equal(second.applied, true, "a re-run still reports applied");

    const after = fx.open();
    assert.deepEqual(snapshotOf(after), before, "no new versions, no re-created triggers");
    after.close();
  } finally {
    fx.dispose();
  }
});

test("the baseline counts equal the row counts, one system insert per existing row", () => {
  const fx = initDbFixture("hist-baseline-");
  try {
    const db = fx.open();
    for (const c of ["one", "two", "three"]) db.prepare("INSERT INTO memories (content) VALUES (?)").run(c);
    for (const [slug, title] of [["a", "A"], ["b", "B"]]) {
      db.prepare("INSERT INTO blog_posts (slug, title, content) VALUES (?, ?, ?)").run(slug, title, "body");
    }
    const counts = {
      memory: db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,
      blog_post: db.prepare("SELECT COUNT(*) AS n FROM blog_posts").get().n,
      context_section: db.prepare("SELECT COUNT(*) AS n FROM crow_context").get().n,
    };
    db.close();

    // 0024 runs against a store that already holds rows (an upgraded instance).
    run({ dbPath: fx.dbPath, log: () => {} });

    const after = fx.open();
    for (const [itemType, expected] of Object.entries(counts)) {
      const rows = after
        .prepare("SELECT op, author_kind, item_id FROM item_versions WHERE item_type = ?")
        .all(itemType);
      assert.equal(rows.length, expected, `${itemType}: one baseline version per existing row`);
      assert.deepEqual(new Set(rows.map((r) => r.op)), new Set(["insert"]), `${itemType}: baselines are inserts`);
      assert.deepEqual(
        new Set(rows.map((r) => r.author_kind)),
        new Set(["system"]),
        `${itemType}: a baseline is authored by the migration, never by a person`,
      );
      const table = COVERED[itemType].table;
      const ids = after.prepare(`SELECT CAST(id AS TEXT) AS id FROM ${table} ORDER BY id`).all().map((r) => r.id);
      assert.deepEqual(rows.map((r) => r.item_id).sort(), ids.sort(), `${itemType}: the item ids are the table's keys`);
    }
    // crow_context is seeded by init-db, so it must have a non-empty baseline.
    assert.ok(counts.context_section > 0, "init-db seeds crow_context sections (the fixture is realistic)");
    after.close();
  } finally {
    fx.dispose();
  }
});

test("the migration logs a baseline row count and elapsed ms per covered table", () => {
  const fx = initDbFixture("hist-log-");
  try {
    const db = fx.open();
    db.prepare("INSERT INTO memories (content) VALUES (?)").run("baseline me");
    db.close();

    const lines = [];
    run({ dbPath: fx.dbPath, log: (m) => lines.push(m) });

    // 0024's own types only: the rest of the covered content belongs to 0025 (it
    // runs against two stores, and its per-type lines are asserted in
    // tests/history-coverage.test.js).
    for (const itemType of typesForMigration(migrationId)) {
      const spec = COVERED[itemType];
      const line = lines.find((l) => l.includes(`${spec.table}: triggers ensured`));
      assert.ok(line, `${spec.table}: the migration logs its outcome`);
      assert.match(line, /\d+ baseline version\(s\) in [\d.]+ ms/, `${spec.table}: count and elapsed ms are reported`);
    }
    assert.ok(
      !lines.some((l) => l.includes("pi_bot_defs: triggers ensured")),
      "0024 does not install another migration's triggers",
    );
    const memoryLine = lines.find((l) => l.includes("memories: triggers ensured"));
    assert.match(memoryLine, /1 baseline version\(s\)/, "the count is the real number of rows baselined");

    // The count comes from the INSERT's own `.changes`, not from two COUNT(*) scans
    // of a table that grows with every write on the instance.
    const src = readFileSync(join(REPO, "scripts", "migrations", "0024-item-versions.mjs"), "utf8");
    assert.match(src, /const \{ changes \} = db\.prepare\(baselineSql\(itemType, spec\)\)\.run\(\)/);
    assert.doesNotMatch(src, /COUNT\(\*\) AS n FROM item_versions/);
  } finally {
    fx.dispose();
  }
});

test("a write between trigger creation and baseline cannot skip the baseline", () => {
  // The window this closes: triggers installed, a write lands, THEN the baseline
  // runs. Without a per-item guard that write's own version would make the table
  // look "already baselined", so the row's original value would never be stored.
  // Simulated by pre-creating item_versions with one memory's version already in
  // it — exactly the state that write leaves behind.
  const fx = initDbFixture("hist-atomic-");
  try {
    const db = fx.open();
    const ids = ["first row", "second row", "third row"].map(
      (c) => db.prepare("INSERT INTO memories (content) VALUES (?)").run(c).lastInsertRowid,
    );
    db.exec(ITEM_VERSIONS_DDL);
    db.prepare(
      `INSERT INTO item_versions (item_type, item_id, op, snapshot_json) VALUES ('memory', ?, 'insert', '{}')`,
    ).run(String(ids[0]));
    db.close();

    run({ dbPath: fx.dbPath, log: () => {} });

    const after = fx.open();
    const rows = after
      .prepare("SELECT item_id FROM item_versions WHERE item_type = 'memory' ORDER BY CAST(item_id AS INTEGER)")
      .all();
    assert.deepEqual(
      rows.map((r) => r.item_id),
      ids.map((id) => String(id)),
      "every memory has a version, including the one that already had one",
    );
    assert.equal(
      after.prepare("SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory'").get().n,
      3,
      "the pre-existing version is not duplicated",
    );
    for (const id of ids) {
      assert.equal(versionCount(after, "memory", id), 1, `memory ${id}: exactly one version row`);
    }
    after.close();

    // The invariant is structural too: one transaction per table, triggers and
    // baseline inside it, BEGIN IMMEDIATE (not deferred — a deferred transaction
    // can upgrade to a write lock halfway through and see a competing write).
    const src = readFileSync(join(REPO, "scripts", "migrations", "0024-item-versions.mjs"), "utf8");
    assert.match(src, /const install = db\.transaction\(/, "triggers and baseline share one transaction");
    assert.match(src, /install\.immediate\(\)/, "the transaction takes the write lock up front");
    assert.ok(
      src.indexOf("for (const sql of triggerSql(itemType)) db.exec(sql);") <
        src.indexOf("db.prepare(baselineSql(itemType, spec)).run()"),
      "the baseline runs inside that same transaction, after the triggers",
    );
  } finally {
    fx.dispose();
  }
});

test("a blob in a tracked column neither fails the write nor the migration", () => {
  const fx = initDbFixture("hist-blob-");
  try {
    // blog_posts.author is tracked (so a write to it fires the trigger) and is
    // NOT in the FTS index (FTS5 has its own opinion about blobs).
    const blob = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const db = fx.open();
    db.prepare("INSERT INTO blog_posts (slug, title, content, author) VALUES (?, ?, ?, ?)").run(
      "blob-post",
      "Blob post",
      "body",
      blob,
    );
    db.close();

    // The baseline reads a BLOB through json_object(): must not raise.
    assert.doesNotThrow(() => run({ dbPath: fx.dbPath, log: () => {} }), "the baseline handles a BLOB");

    const after = fx.open();
    const baseline = after
      .prepare("SELECT snapshot_json, project_ref FROM item_versions WHERE item_type = 'blog_post'")
      .get();
    assert.equal(
      JSON.parse(baseline.snapshot_json).author,
      `hex:${blob.toString("hex").toUpperCase()}`,
      "a BLOB is stored as reversible hex, not dropped and not fatal",
    );
    assert.equal(baseline.project_ref, null, "a blog post has no project scope");

    // A live write carrying a BLOB must not be failed by its own trigger.
    assert.doesNotThrow(
      () => after.prepare("UPDATE blog_posts SET author = ? WHERE slug = 'blob-post'").run(Buffer.from([0xde, 0xad])),
      "a BLOB write must not raise from the capture trigger",
    );
    const update = after
      .prepare("SELECT op, snapshot_json FROM item_versions WHERE item_type = 'blog_post' ORDER BY id")
      .all()
      .at(-1);
    assert.equal(update.op, "update");
    assert.equal(JSON.parse(update.snapshot_json).author, "hex:DEAD");
    assert.equal(Buffer.from("DEAD", "hex")[0], 0xde, "hex is reversible (SQLite uppercases it)");
    after.close();
  } finally {
    fx.dispose();
  }
});

test("a deleted memory's version keeps its project", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db
      .prepare("INSERT INTO memories (content, project_id, project_uuid) VALUES (?, ?, ?)")
      .run("a filed memory", 42, "proj-uuid-1");
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("an edited filed memory", info.lastInsertRowid);
    db.prepare("DELETE FROM memories WHERE id = ?").run(info.lastInsertRowid);

    const rows = versionsOf(db, "memory", info.lastInsertRowid);
    assert.deepEqual(rows.map((r) => r.op), ["insert", "update", "delete"]);
    for (const row of rows) {
      assert.equal(row.project_ref, "proj-uuid-1", "every version keeps the item's project after the row is gone");
      const snapshot = JSON.parse(row.snapshot_json);
      assert.equal(snapshot.project_uuid, "proj-uuid-1");
      assert.equal(snapshot.project_id, 42);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
    db.close();
  } finally {
    fx.dispose();
  }
});

test("versions can be found by project", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    // Settled on the portable uuid when there is one ...
    const portable = db
      .prepare("INSERT INTO memories (content, project_id, project_uuid) VALUES (?, ?, ?)")
      .run("portable", 42, "proj-uuid-1");
    // ... and on the local project id when there is not (pre-project_uuid rows).
    const localOnly = db
      .prepare("INSERT INTO memories (content, project_id) VALUES (?, ?)")
      .run("local only", 7);
    // Unfiled content has no scope.
    const unfiled = db.prepare("INSERT INTO memories (content) VALUES (?)").run("unfiled");
    // A project-scoped context section is scoped the same way.
    const section = db
      .prepare("INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES (?, ?, ?, ?)")
      .run("project-note", "Project note", "scoped body", 7);

    const idsFor = (projectRef) =>
      db
        .prepare("SELECT item_id FROM item_versions WHERE project_ref = ? AND item_type = 'memory' ORDER BY id")
        .all(projectRef)
        .map((r) => r.item_id);

    assert.deepEqual(idsFor("proj-uuid-1"), [String(portable.lastInsertRowid)]);
    assert.deepEqual(idsFor("7"), [String(localOnly.lastInsertRowid)], "a project_id-only memory is found by its id");
    assert.equal(versionsOf(db, "memory", unfiled.lastInsertRowid)[0].project_ref, null);
    assert.equal(
      versionsOf(db, "context_section", section.lastInsertRowid)[0].project_ref,
      "7",
      "a section filed by a local id whose project row is absent keys on that id",
    );
    // The scope column is indexed: Task 4's erase is a lookup, not a scan.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'item_versions'")
      .all()
      .map((r) => r.name);
    assert.ok(indexes.includes("idx_item_versions_project"), "project_ref is indexed");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("a project-scoped context section's snapshot carries the project's portable uuid", () => {
  // crow_context has no project_uuid column: project_id is a per-instance integer
  // and project_spaces REUSES it, so a snapshot holding only that id could be
  // restored into a stranger's project (and sync would spread it). The uuid is
  // computed into the snapshot — and into project_ref — when the version is
  // written, so a section version names its project portably.
  const fx = migratedFixture();
  try {
    const db = fx.open();
    db.prepare("INSERT INTO project_spaces (id, uuid, slug, name) VALUES (?, ?, ?, ?)").run(
      7,
      "proj-uuid-1",
      "project-one",
      "Project one",
    );
    const section = db
      .prepare("INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES (?, ?, ?, ?)")
      .run("project-note", "Project note", "scoped body", 7);
    db.prepare("UPDATE crow_context SET content = ? WHERE id = ?").run("scoped body, edited", section.lastInsertRowid);

    const rows = versionsOf(db, "context_section", section.lastInsertRowid);
    assert.deepEqual(rows.map((r) => r.op), ["insert", "update"]);
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot_json);
      assert.equal(snapshot.project_id, 7, "the local id stays in the snapshot (it is what the row holds)");
      assert.equal(snapshot.project_uuid, "proj-uuid-1", "and the project's portable id is computed beside it");
      assert.equal(row.project_ref, "proj-uuid-1", "the uuid is the scope whenever the project is known");
    }

    // A section whose project row is GONE at capture time keeps the local id as
    // its scope: the uuid is unknown, not invented.
    db.prepare("DELETE FROM project_spaces WHERE id = 7").run();
    db.prepare("UPDATE crow_context SET content = ? WHERE id = ?").run("scoped body, orphaned", section.lastInsertRowid);
    const orphaned = versionsOf(db, "context_section", section.lastInsertRowid).at(-1);
    assert.equal(JSON.parse(orphaned.snapshot_json).project_uuid, null, "no project row, no uuid to record");
    assert.equal(orphaned.project_ref, "7", "so the local id is the scope, as before");

    // Unfiled content has neither, exactly like a memory.
    const unfiled = db
      .prepare("INSERT INTO crow_context (section_key, section_title, content) VALUES (?, ?, ?)")
      .run("global-note", "Global note", "global body");
    const unfiledVersion = versionsOf(db, "context_section", unfiled.lastInsertRowid)[0];
    assert.equal(JSON.parse(unfiledVersion.snapshot_json).project_uuid, null);
    assert.equal(unfiledVersion.project_ref, null, "an unfiled section has no scope");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("the migration's baseline records a section's project uuid as well", () => {
  // An upgraded instance: the section and its project predate the triggers, so the
  // BASELINE is the version that must carry the portable id.
  const fx = initDbFixture("hist-section-baseline-");
  try {
    let db = fx.open();
    db.prepare("INSERT INTO project_spaces (id, uuid, slug, name) VALUES (?, ?, ?, ?)").run(
      3,
      "proj-uuid-baseline",
      "baseline-project",
      "Baseline project",
    );
    const section = db
      .prepare("INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES (?, ?, ?, ?)")
      .run("baseline-note", "Baseline note", "baselined body", 3);
    db.close();

    run({ dbPath: fx.dbPath, log: () => {} });

    db = fx.open();
    const row = db
      .prepare(
        `SELECT op, author_kind, snapshot_json, project_ref FROM item_versions
          WHERE item_type = 'context_section' AND item_id = ?`,
      )
      .all(String(section.lastInsertRowid));
    assert.equal(row.length, 1, "one baseline version for the existing section");
    assert.equal(row[0].op, "insert");
    assert.equal(row[0].author_kind, "system");
    assert.equal(JSON.parse(row[0].snapshot_json).project_uuid, "proj-uuid-baseline");
    assert.equal(row[0].project_ref, "proj-uuid-baseline", "the baseline is scoped by the uuid too");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("dropped history triggers come back at the next ensure", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    // An init-db rebuild of a covered table drops its triggers with the table,
    // while 0024 stays recorded — and the guard triggers can be lost the same way.
    db.exec("DROP TRIGGER hist_memories_ai");
    db.exec("DROP TRIGGER hist_crow_context_au");
    db.exec("DROP TRIGGER hist_item_versions_guard_ad");

    const missed = db.prepare("INSERT INTO memories (content) VALUES (?)").run("written while uncovered");
    assert.equal(versionCount(db, "memory", missed.lastInsertRowid), 0, "a dropped trigger captures nothing");

    const restored = ensureHistoryTriggers(db);
    assert.deepEqual(
      restored.restored.sort(),
      ["hist_crow_context_au", "hist_item_versions_guard_ad", "hist_memories_ai"],
      "every missing trigger (capture and guard) comes back",
    );
    assert.deepEqual(restored.skipped, [], "every covered table was ready");

    const covered = db.prepare("INSERT INTO memories (content) VALUES (?)").run("written after ensure");
    assert.equal(versionCount(db, "memory", covered.lastInsertRowid), 1, "capture works again");
    assert.throws(
      () => db.prepare("DELETE FROM item_versions").run(),
      /append-only/,
      "the guard trigger is back too",
    );

    // Idempotent: a second ensure on a healthy store writes nothing.
    assert.deepEqual(ensureHistoryTriggers(db).restored, [], "a healthy store needs no repair");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("the boot entry point is silent on a healthy store and tolerates an absent crow.db", () => {
  const fx = migratedFixture();
  try {
    const logs = [];
    const healthy = ensureHistoryTriggersAtBoot({ dbPath: fx.dbPath, log: (m) => logs.push(m) });
    assert.deepEqual(healthy.restored, [], "a healthy store needs no repair");
    assert.deepEqual(logs, [], "and says nothing on boot");

    const absent = ensureHistoryTriggersAtBoot({ dbPath: join(fx.dir, "no-such.db"), log: () => {} });
    assert.deepEqual(absent.skipped, ["crow.db absent"], "a missing file is skipped, never created");
  } finally {
    fx.dispose();
  }
});

test("history rows refuse update and delete", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("a version to protect");
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("an edited version", info.lastInsertRowid);

    assert.throws(
      () =>
        db
          .prepare("UPDATE item_versions SET redacted = 1, snapshot_json = '{}' WHERE item_type = 'memory'")
          .run(),
      /version history is append-only/,
      "a historical value cannot be rewritten by hand (Task 4's redaction sweep arms the switch)",
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE item_versions SET snapshot_json = '{}' WHERE item_type = 'memory' AND item_id = ?")
          .run(String(info.lastInsertRowid)),
      /version history is append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM item_versions").run(),
      /version history is append-only/,
    );
    assert.equal(versionCount(db, "memory", info.lastInsertRowid), 2, "both versions survive intact");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("attribution can be stamped once", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("whose edit was this?");
    const id = info.lastInsertRowid;

    // Task 2 stamps the author on the row the trigger just wrote. (item_type is
    // in the WHERE because item ids are per table — crow_context's baselines
    // share the numeric ids and those are 'system' rows, which are frozen.)
    assert.doesNotThrow(() =>
      db
        .prepare(
          `UPDATE item_versions SET author_kind = 'bot', author_id = 'bot-7', job_id = 'job-3',
                  origin_instance = 'inst-a' WHERE item_type = 'memory' AND item_id = ?`,
        )
        .run(String(id)),
    );
    const stamped = versionsOf(db, "memory", id)[0];
    assert.equal(stamped.author_kind, "bot");
    assert.equal(stamped.author_id, "bot-7");
    assert.equal(stamped.job_id, "job-3");
    assert.equal(stamped.origin_instance, "inst-a");

    // Once attributed, the row is frozen: no second stamp, no correction.
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE item_versions SET author_kind = 'owner', author_id = 'someone-else'
              WHERE item_type = 'memory' AND item_id = ?`,
          )
          .run(String(id)),
      /version history is append-only/,
    );
    // And an unattributed row still refuses a non-attribution edit in the same
    // statement as the stamp.
    const second = db.prepare("INSERT INTO memories (content) VALUES (?)").run("another");
    assert.throws(
      () =>
        db
          .prepare("UPDATE item_versions SET author_kind = 'owner', snapshot_json = '{\"content\":\"rewritten\"}' WHERE item_id = ?")
          .run(String(second.lastInsertRowid)),
      /version history is append-only/,
      "a stamp may not smuggle a content rewrite",
    );
    db.close();
  } finally {
    fx.dispose();
  }
});

test("an unattributed row cannot be re-stamped while staying unattributed", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("nobody's edit yet");
    const id = String(info.lastInsertRowid);
    const stamp = (sql, args = []) =>
      db.prepare(`${sql} WHERE item_type = 'memory' AND item_id = ?`).run(...args, id);

    // The exemption requires a REAL author: NEW.author_kind must not still be
    // 'unattributed', so "stamping" a row with no author changes nothing and is
    // refused (otherwise the guard's "once" would be a no-op instead).
    assert.throws(
      () => stamp("UPDATE item_versions SET author_kind = 'unattributed'"),
      /version history is append-only/,
      "an unattributed row cannot be updated while it stays unattributed",
    );
    assert.throws(
      () => stamp("UPDATE item_versions SET author_kind = 'unattributed', author_id = 'x'"),
      /version history is append-only/,
      "nor may it acquire attribution columns while claiming no author",
    );
    const untouched = versionsOf(db, "memory", id)[0];
    assert.equal(untouched.author_kind, "unattributed", "the row is unchanged");
    assert.equal(untouched.author_id, null);

    // A real stamp is still allowed exactly once ...
    assert.doesNotThrow(() =>
      stamp("UPDATE item_versions SET author_kind = 'owner', author_id = 'abcd1234'"),
    );
    assert.equal(versionsOf(db, "memory", id)[0].author_kind, "owner");
    // ... and an attributed row cannot be blanked back or re-attributed, even to
    // the SAME author: OLD.author_id is no longer NULL.
    assert.throws(
      () => stamp("UPDATE item_versions SET author_kind = 'unattributed', author_id = NULL"),
      /version history is append-only/,
    );
    assert.throws(
      () => stamp("UPDATE item_versions SET author_kind = 'owner', author_id = 'abcd1234'"),
      /version history is append-only/,
      "a second stamp of the same values is still a second stamp",
    );
    assert.equal(versionsOf(db, "memory", id)[0].author_id, "abcd1234", "the first stamp survives");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("an armed erase can delete", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content, project_uuid) VALUES (?, ?)").run("erase me", "proj-x");
    db.prepare("DELETE FROM memories WHERE id = ?").run(info.lastInsertRowid);
    const before = versionCount(db, "memory", info.lastInsertRowid);
    assert.ok(before > 0);

    // Task 4's shape, in ONE transaction: arm, erase, disarm. The disarm must be
    // inside the same transaction — an erase that commits with the switch still
    // on would leave history rewritable (the boot ensure disarms a stuck one).
    db.transaction(() => {
      db.prepare("UPDATE item_versions_erase SET armed = 1").run();
      db.prepare("DELETE FROM item_versions WHERE project_ref = ?").run("proj-x");
      db.prepare("UPDATE item_versions_erase SET armed = 0").run();
    }).immediate();

    assert.equal(versionCount(db, "memory", info.lastInsertRowid), 0, "the armed erase deleted the versions");
    assert.equal(
      db.prepare("SELECT armed FROM item_versions_erase").get().armed,
      0,
      "the switch is back off in the same transaction",
    );
    assert.throws(
      () => db.prepare("DELETE FROM item_versions").run(),
      /version history is append-only/,
      "disarming closes the door again",
    );
    db.close();
  } finally {
    fx.dispose();
  }
});

test("a switch left armed is disarmed at boot", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content, project_uuid) VALUES (?, ?)").run("erase me", "proj-y");
    // The state an erase that armed the switch and died before committing leaves:
    // armed = 1 is visible to every other connection, so history would be freely
    // rewritable until someone noticed.
    db.prepare("UPDATE item_versions_erase SET armed = 1").run();
    assert.equal(db.prepare("SELECT armed FROM item_versions_erase").get().armed, 1);

    const logs = [];
    const res = ensureHistoryTriggersAtBoot({ dbPath: fx.dbPath, log: (m) => logs.push(m) });
    assert.equal(res.disarmed, 1, "the boot ensure reports the reset");
    assert.ok(logs.some((l) => /disarmed/.test(l)), `the disarm is logged: ${logs.join(" | ")}`);
    assert.equal(db.prepare("SELECT armed FROM item_versions_erase").get().armed, 0, "the switch is off");
    assert.throws(
      () => db.prepare("DELETE FROM item_versions").run(),
      /version history is append-only/,
      "and the append-only door is shut again",
    );
    assert.ok(versionCount(db, "memory", info.lastInsertRowid) > 0, "nothing was erased");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("an existing version cannot be replaced by INSERT OR REPLACE", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("the original words");
    const id = String(info.lastInsertRowid);
    const version = versionsOf(db, "memory", id)[0];

    // SQLite's REPLACE deletes the conflicting row and inserts a new one, so the
    // DELETE guard never sees it — the BEFORE INSERT guard has to refuse it.
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT OR REPLACE INTO item_versions (id, item_type, item_id, op, snapshot_json) " +
              "VALUES (?, 'memory', ?, 'update', '{\"content\":\"rewritten\"}')",
          )
          .run(version.id, id),
      /version history is append-only/,
      "an insert naming an existing id is refused",
    );
    assert.equal(versionCount(db, "memory", id), 1, "still exactly one version");
    assert.equal(
      JSON.parse(versionsOf(db, "memory", id)[0].snapshot_json).content,
      "the original words",
      "the historical value is intact",
    );

    // An armed erase is the one door: Task 4 may replace a row while it holds the
    // switch (a restore/rewrite goes through its audited path).
    db.transaction(() => {
      db.prepare("UPDATE item_versions_erase SET armed = 1").run();
      db.prepare("DELETE FROM item_versions WHERE id = ?").run(version.id);
      db.prepare("UPDATE item_versions_erase SET armed = 0").run();
    }).immediate();
    assert.equal(versionCount(db, "memory", id), 0, "the armed path still works");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("1,000 writes cost less than 5 ms per write more than the same loop with no triggers", () => {
  const N = 1000;
  const plain = initDbFixture("hist-perf-plain-");
  const captured = initDbFixture("hist-perf-captured-");
  try {
    run({ dbPath: captured.dbPath, log: () => {} });

    const timeLoop = (fx, label) => {
      const db = fx.open({ wal: true }); // file-backed WAL, as Crow runs
      try {
        const hasVersions = Boolean(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_versions'")
            .get(),
        );
        const versions = () =>
          hasVersions
            ? db.prepare("SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory'").get().n
            : 0;

        db.prepare("INSERT INTO memories (content) VALUES (?)").run("perf seed");
        const id = db.prepare("SELECT MAX(id) AS id FROM memories").get().id;
        const update = db.prepare("UPDATE memories SET content = ? WHERE id = ?");
        for (let i = 0; i < 20; i++) update.run(`warm-up ${i}`, id); // JIT / page-cache warm-up
        const versionsBefore = versions();
        const t0 = performance.now();
        for (let i = 0; i < N; i++) update.run(`edit number ${i}`, id);
        const elapsed = performance.now() - t0;
        return {
          perWrite: elapsed / N,
          total: elapsed,
          versions: versions() - versionsBefore,
          label,
        };
      } finally {
        db.close();
      }
    };

    const noTriggers = timeLoop(plain, "no history triggers");
    const withTriggers = timeLoop(captured, "with history triggers");
    const overhead = withTriggers.perWrite - noTriggers.perWrite;

    // Both numbers are the report: an absolute floor plus the delta that the
    // budget is about. Printed so a regression shows in the suite log.
    console.log(
      `[history-capture] ${N} writes — no triggers: ${noTriggers.perWrite.toFixed(4)} ms/write, ` +
        `with triggers: ${withTriggers.perWrite.toFixed(4)} ms/write, ` +
        `overhead: ${overhead.toFixed(4)} ms/write ` +
        `(${noTriggers.versions} vs ${withTriggers.versions} new version rows)`,
    );

    assert.equal(withTriggers.versions, N, "every write was captured");
    assert.equal(noTriggers.versions, 0, "the control DB has no versions");
    assert.ok(
      overhead < 5,
      `history overhead must stay under 5 ms/write, measured ${overhead.toFixed(4)} ms/write`,
    );
  } finally {
    plain.dispose();
    captured.dispose();
  }
});

test("item_versions is never a synced table", () => {
  assert.ok(
    !SYNCED_TABLES.includes("item_versions"),
    "item_versions is local-only: it must stay out of instance-sync's SYNCED_TABLES",
  );
  assert.ok(
    !SYNCED_TABLES.some((t) => /item_version|item_versions/.test(t)),
    "no outbound transform may pick item_versions up",
  );
});

test("no secret-like column is ever tracked or snapshotted", () => {
  for (const [itemType, spec] of Object.entries(COVERED)) {
    assert.ok(spec.tracked.length > 0, `${itemType}: tracks at least one column`);
    for (const column of spec.snapshot) {
      assert.doesNotMatch(column, SECRET_COLUMN, `${itemType}: ${column} in the snapshot looks like a credential`);
    }
    for (const column of spec.tracked) {
      assert.doesNotMatch(column, SECRET_COLUMN, `${itemType}: ${column} looks like a credential column`);
      assert.doesNotMatch(column, COUNTER_OR_DERIVED, `${itemType}: ${column} is a counter, clock or timestamp`);
      assert.ok(spec.snapshot.includes(column), `${itemType}: tracked column ${column} is also snapshotted`);
    }
    // A primary key is usually `id`, but pi_bot_defs is keyed by bot_id — the
    // item key is the table's real primary key either way, never a snapshot field.
    assert.ok(["id", "bot_id"].includes(spec.idColumn), `${itemType}: the item id is the table's primary key`);
    assert.ok(!spec.snapshot.includes(spec.idColumn), `${itemType}: the key is never snapshotted`);
  }
});

test("every snapshotted column exists in the real table, and the snapshot is the whole row", () => {
  const fx = initDbFixture("hist-columns-");
  try {
    const db = fx.open();
    try {
      for (const [itemType, spec] of Object.entries(COVERED)) {
        // A bundle-owned table is not here until the bundle runs, and a tasks
        // store type is in the OTHER database whose converged shape only the full
        // migration registry produces — tests/history-coverage.test.js asserts the
        // card's whole-row rule against a real tasks.db built that way.
        if (spec.store === STORE_TASKS) continue;
        const handle = db;
        const tablePresent = handle
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(spec.table);
        if (!tablePresent) {
          assert.ok(spec.bundleOwned, `${itemType}: only a bundle-owned table may be absent here`);
          continue;
        }
        const real = new Set(handle.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name));
        // A DERIVED snapshot field is computed from the row (or from another table),
        // never read from this one: it is snapshotted, it is not a column, and it can
        // be a project ref, but it is never tracked (there is no OLD/NEW value to
        // compare) and no restore writes it back into the row.
        const derived = Object.keys(spec.derived || {});
        for (const column of derived) {
          assert.ok(!real.has(column), `${itemType}: ${column} is derived, so it is NOT a real column`);
          assert.ok(spec.snapshot.includes(column), `${itemType}: derived field ${column} is snapshotted`);
          assert.ok(!spec.tracked.includes(column), `${itemType}: derived field ${column} is not tracked`);
        }
        // A PROJECTED field is the opposite: a real column, stored through a
        // projection (never verbatim) and restorable by a merge into it.
        for (const column of Object.keys(spec.projected || {})) {
          assert.ok(real.has(column), `${itemType}: ${column} is projected from a REAL column`);
          assert.ok(spec.snapshot.includes(column), `${itemType}: projected field ${column} is snapshotted`);
          assert.ok(!derived.includes(column), `${itemType}: projected field ${column} is not derived`);
        }
        for (const column of [spec.idColumn, ...spec.snapshot].filter((c) => !derived.includes(c))) {
          assert.ok(real.has(column), `${itemType}: ${spec.table}.${column} is a real column`);
        }
        // The snapshot is the full row minus counters/derived/secret-named columns,
        // plus the derived fields, so a new content or filing column cannot be
        // silently left out of history. A type that DELIBERATELY leaves a column out
        // names it in `omitted` (a card's data_json, its scheduler bookkeeping,
        // archived_at) — so a decision on record is not mistaken for an oversight.
        const omitted = new Set(spec.omitted || []);
        const expectedSnapshot = [
          ...[...real].filter(
            (c) =>
              c !== spec.idColumn &&
              !SECRET_COLUMN.test(c) &&
              !COUNTER_OR_DERIVED.test(c) &&
              !omitted.has(c),
          ),
          ...derived,
        ];
        assert.deepEqual(
          [...spec.snapshot].sort(),
          expectedSnapshot.sort(),
          `${itemType}: the snapshot is the whole row minus counters/derived/omitted/secret columns`,
        );
        // Every project-ref column must be snapshotted (it is copied per version).
        assert.ok(
          spec.projectRef.length > 0 || ["blog_post", "kb_article", "card"].includes(itemType),
          `${itemType}: has a project scope or none`,
        );
        for (const column of spec.projectRef) {
          assert.ok(
            real.has(column) || derived.includes(column),
            `${itemType}: ${spec.table}.${column} is a real project column (or a derived one)`,
          );
          assert.ok(spec.snapshot.includes(column), `${itemType}: project column ${column} is snapshotted`);
        }
      }
    } finally {
      db.close();
    }
  } finally {
    fx.dispose();
  }
});

test("the migration installs hist_<table>_{ai,au,ad} and leaves the FTS triggers alone", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const names = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name),
    );
    // 0024's own three tables: the rest of the covered content is 0025's, and its
    // triggers are asserted in tests/history-coverage.test.js.
    for (const itemType of typesForMigration(migrationId)) {
      const spec = COVERED[itemType];
      for (const suffix of ["ai", "au", "ad"]) {
        assert.ok(names.has(`hist_${spec.table}_${suffix}`), `hist_${spec.table}_${suffix} must exist`);
      }
    }
    for (const name of ["hist_item_versions_guard_bi", "hist_item_versions_guard_au", "hist_item_versions_guard_ad"]) {
      assert.ok(names.has(name), `the append-only guard ${name} must be installed with the table`);
    }
    for (const name of [
      "memories_ai", "memories_au", "memories_ad",
      "blog_posts_ai", "blog_posts_au", "blog_posts_ad",
    ]) {
      assert.ok(names.has(name), `init-db's FTS trigger ${name} must survive the migration`);
    }
    // A history write does not break the FTS index: the row is still findable.
    db.prepare("INSERT INTO memories (content) VALUES (?)").run("a uniquely searchable phrase");
    const hit = db
      .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'uniquely'")
      .get().n;
    assert.equal(hit, 1, "FTS still indexes after the history triggers fire");
    db.close();
  } finally {
    fx.dispose();
  }
});

test("triggerSql emits the three triggers from COVERED, and the update trigger compares every tracked column", () => {
  for (const [itemType, spec] of Object.entries(COVERED)) {
    const sql = triggerSql(itemType);
    assert.equal(sql.length, 3, `${itemType}: insert, update, delete`);
    for (const stmt of sql) assert.match(stmt, /^CREATE TRIGGER IF NOT EXISTS hist_/);
    const [ai, au, ad] = sql;
    assert.match(ai, /AFTER INSERT ON /);
    assert.match(ad, /AFTER DELETE ON /);
    assert.match(au, /AFTER UPDATE ON /);
    for (const column of spec.tracked) {
      // A tracked column is compared directly, or — when it is PROJECTED (a bot
      // definition, stored as its non-secret keys) — through the same projection
      // the snapshot uses, on both sides.
      if (spec.projected && spec.projected[column]) {
        assert.ok(au.includes(`NEW."${column}"`), `${itemType}: .${column} is compared (NEW side)`);
        assert.ok(au.includes(`OLD."${column}"`), `${itemType}: .${column} is compared (OLD side)`);
        assert.match(au, /json_valid\(/, `${itemType}: .${column} is compared through its projection`);
      } else {
        assert.ok(au.includes(`NEW."${column}" IS NOT OLD."${column}"`), `${itemType}: .${column} is compared`);
      }
    }
    // The WHEN clause compares every tracked column exactly once (a stamp-only
    // exclusion narrows one of those comparisons; it never adds a column).
    const when = au.slice(au.indexOf("WHEN"), au.indexOf("BEGIN"));
    assert.equal((when.match(/IS NOT /g) || []).length >= spec.tracked.length, true, `${itemType}: every tracked column is in the WHEN`);
    const stamp = STAMP_ONLY_TRANSITIONS[itemType];
    if (stamp) {
      assert.ok(when.includes(`OLD."${stamp.column}" IS NULL AND NEW."${stamp.column}" IS NOT NULL`), `${itemType}: the stamp-only transition is named`);
      for (const column of stamp.unchanged) {
        assert.ok(when.includes(`NEW."${column}" IS OLD."${column}"`), `${itemType}: the stamp is scoped to ${column} unchanged`);
      }
    } else {
      assert.ok(!/IS NULL AND NEW\./.test(when), `${itemType}: no stamp exclusion without a stamp-only transition`);
    }

    // The STORED list is the snapshot, not the tracked list: filing columns and
    // the publishing facts are recorded by every trigger.
    for (const stmt of sql) {
      assert.match(stmt, /project_ref\)/, `${itemType}: every trigger fills project_ref`);
      for (const column of spec.snapshot) {
        assert.ok(stmt.includes(`'${column}'`), `${itemType}: the snapshot stores ${column}`);
      }
      assert.match(stmt, /CASE typeof\(/, `${itemType}: values are BLOB-safe`);
      assert.match(stmt, /hex:/, `${itemType}: a BLOB is stored as hex`);
    }
  }
  assert.equal(guardTriggerSql().length, 3, "one guard per mutation kind (insert-in-place, UPDATE, DELETE)");
  assert.throws(() => triggerSql("no_such_item_type"), /unknown item_type/);
});

test("ensure does not arm capture before the baseline", () => {
  const fx = initDbFixture("hist-ensure-nobaseline-");
  try {
    const db = fx.open();
    // The table and its guards exist (an earlier build created them) but 0024 was
    // never recorded and no baseline was ever written — a store whose covered
    // tables only appeared now.
    db.exec(ITEM_VERSIONS_DDL);
    db.exec("DROP TRIGGER hist_item_versions_guard_ad");

    const first = ensureHistoryTriggers(db);
    assert.deepEqual(first.restored, ["hist_item_versions_guard_ad"], "the guard is always ensured");
    // Every crow-store type with a table here and no baseline waits for ITS
    // migration (0024's three — 0025's and 0026's are not recorded either, so they
    // wait too). A bundle-owned table that is absent is simply not reported.
    assert.deepEqual(
      first.awaitingBaseline.sort(),
      ["blog_posts", "crow_context", "memories", "pi_bot_defs", "research_notes", "research_sources"],
      "capture is left to the migration until a baseline exists",
    );
    const names = () =>
      new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));
    for (const spec of Object.values(COVERED)) {
      if (spec.store === STORE_TASKS) continue; // not crow.db's table
      assert.ok(!names().has(`hist_${spec.table}_ai`), `${spec.table}: no capture trigger yet`);
    }
    const missed = db.prepare("INSERT INTO memories (content) VALUES (?)").run("written before the baseline");
    assert.equal(versionCount(db, "memory", missed.lastInsertRowid), 0, "nothing pretends to capture it");
    db.close();

    // The migration baselines the row that predates history and installs capture;
    // the next boot's ensure then finds nothing to do.
    run({ dbPath: fx.dbPath, log: () => {} });
    const after = fx.open();
    const baseline = after
      .prepare("SELECT op, author_kind FROM item_versions WHERE item_type = 'memory'")
      .all();
    assert.deepEqual(baseline, [{ op: "insert", author_kind: "system" }], "the migration baselined the old row");
    const second = ensureHistoryTriggers(after);
    assert.deepEqual(second.restored, [], "the migration already installed capture");
    assert.deepEqual(
      second.awaitingBaseline,
      ["blog_posts", "research_notes", "research_sources", "pi_bot_defs"],      "a table with no rows has no system version to prove a baseline — only the recorded migration can",
    );

    // The registry records the migrations as applied; from then on an empty table
    // counts as baselined too (its first live write is the whole history).
    after.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)",
    );
    for (const id of ["0024-item-versions", "0025-item-versions-more", "0026-item-versions-sources"]) {
      after
        .prepare("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(id, new Date().toISOString());
    }
    assert.deepEqual(ensureHistoryTriggers(after).awaitingBaseline, [], "the recorded migration covers every table");

    const live = after.prepare("INSERT INTO memories (content) VALUES (?)").run("written after the baseline");
    assert.equal(versionCount(after, "memory", live.lastInsertRowid), 1, "capture is live");
    after.close();
  } finally {
    fx.dispose();
  }
});

test("a covered table that is absent is skipped with a reason, and the run defers so a later boot retries", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-absent-"));
  try {
    const dbPath = join(dir, "crow.db");
    new Database(dbPath).close(); // a restored store with no Crow schema yet

    const first = run({ dbPath, log: () => {} });
    assert.equal(first.deferred, true, "nothing to capture yet: retry on a later boot");
    assert.match(first.reason, /memories/, "the reason names what was missing");

    let db = new Database(dbPath);
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_versions'").get(),
      "the table itself is safe to create even when the covered tables are absent",
    );
    db.close();

    // memories appears (init-db ran on a real boot); the retry installs its triggers.
    db = new Database(dbPath);
    db.exec(`CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL, context TEXT, tags TEXT, source TEXT,
      importance INTEGER DEFAULT 5, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT DEFAULT NULL, project_id INTEGER DEFAULT NULL,
      project_uuid TEXT DEFAULT NULL)`);
    db.close();

    const second = run({ dbPath, log: () => {} });
    assert.equal(second.deferred, true, "blog_posts and crow_context are still missing");
    assert.doesNotMatch(second.reason, /memories/, "the reason moved on to what is still missing");

    db = new Database(dbPath);
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("captured on the retry");
    assert.equal(versionCount(db, "memory", info.lastInsertRowid), 1, "the retry installed the triggers");
    // ... and the boot re-ensure tolerates the same partial store. memories has
    // live versions but no baseline (the migration ran against an empty table and
    // is not recorded here), so its capture is the migration's to keep.
    const ensured = ensureHistoryTriggers(db);
    assert.deepEqual(
      ensured.skipped.sort(),
      ["blog_posts", "crow_context", "pi_bot_defs", "research_notes", "research_sources"],
      "ensure reports what it cannot cover yet instead of throwing",
    );
    // memories has versions but no baseline, so its capture belongs to the
    // migration (the other present tables are absent here, so they are skipped).
    assert.deepEqual(ensured.awaitingBaseline, ["memories"], "and what awaits its baseline");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration's id matches its filename", () => {
  assert.equal(migrationId, "0024-item-versions");
});