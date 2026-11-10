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

import { COVERED, guardTriggerSql, triggerSql } from "../servers/shared/history/covered.js";
import { ensureHistoryTriggers, ensureHistoryTriggersAtBoot } from "../servers/shared/history/ensure.js";
import {
  ITEM_VERSIONS_DDL,
  run,
  id as migrationId,
} from "../scripts/migrations/0024-item-versions.mjs";
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

/** init-db fixture with 0024 applied (the migrated instance). */
function migratedFixture(prefix = "hist-capture-") {
  const fx = initDbFixture(prefix);
  run({ dbPath: fx.dbPath, log: () => {} });
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

test("a filing change is not a version on its own, but the snapshot still carries the filing", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("filed later");
    const before = versionCount(db, "memory", info.lastInsertRowid);
    // project_id / project_uuid are PLACEMENT pointers: not tracked (see COVERED),
    // so filing an existing memory is not a content change ...
    db.prepare("UPDATE memories SET project_id = 4, project_uuid = 'proj-a' WHERE id = ?").run(
      info.lastInsertRowid,
    );
    assert.equal(versionCount(db, "memory", info.lastInsertRowid), before, "filing is not a change");
    // ... but a later real edit records the new filing in its snapshot, so a
    // version is never left pointing at the wrong project.
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("filed and edited", info.lastInsertRowid);
    const rows = versionsOf(db, "memory", info.lastInsertRowid);
    assert.equal(rows.at(-1).op, "update");
    assert.equal(rows.at(-1).project_ref, "proj-a");
    const snapshot = JSON.parse(rows.at(-1).snapshot_json);
    assert.equal(snapshot.project_id, 4);
    assert.equal(snapshot.project_uuid, "proj-a");
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

    for (const spec of Object.values(COVERED)) {
      const line = lines.find((l) => l.includes(`${spec.table}: triggers ensured`));
      assert.ok(line, `${spec.table}: the migration logs its outcome`);
      assert.match(line, /\d+ baseline version\(s\) in [\d.]+ ms/, `${spec.table}: count and elapsed ms are reported`);
    }
    const memoryLine = lines.find((l) => l.includes("memories: triggers ensured"));
    assert.match(memoryLine, /1 baseline version\(s\)/, "the count is the real number of rows baselined");
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
        src.indexOf("db.exec(baselineSql(itemType, spec));"),
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
      "a project-scoped context section carries the project",
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

test("an armed erase can delete", () => {
  const fx = migratedFixture();
  try {
    const db = fx.open();
    const info = db.prepare("INSERT INTO memories (content, project_uuid) VALUES (?, ?)").run("erase me", "proj-x");
    db.prepare("DELETE FROM memories WHERE id = ?").run(info.lastInsertRowid);
    const before = versionCount(db, "memory", info.lastInsertRowid);
    assert.ok(before > 0);

    // Task 4's shape: arm inside its own transaction, erase, disarm.
    db.transaction(() => {
      db.prepare("UPDATE item_versions_erase SET armed = 1").run();
      db.prepare("DELETE FROM item_versions WHERE project_ref = ?").run("proj-x");
    }).immediate();
    db.prepare("UPDATE item_versions_erase SET armed = 0").run();

    assert.equal(versionCount(db, "memory", info.lastInsertRowid), 0, "the armed erase deleted the versions");
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
    assert.equal(spec.idColumn, "id", `${itemType}: the item id is the table's primary key`);
  }
});

test("every snapshotted column exists in the real table, and the snapshot is the whole row", () => {
  const fx = initDbFixture("hist-columns-");
  try {
    const db = fx.open();
    for (const [itemType, spec] of Object.entries(COVERED)) {
      const real = new Set(db.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name));
      assert.ok(real.size > 0, `${itemType}: ${spec.table} exists (init-db owns it)`);
      for (const column of [spec.idColumn, ...spec.snapshot]) {
        assert.ok(real.has(column), `${itemType}: ${spec.table}.${column} is a real column`);
      }
      // The snapshot is the full row minus counters/derived/secret-named columns,
      // so a new content or filing column cannot be silently left out of history.
      const expectedSnapshot = [...real].filter(
        (c) => !SECRET_COLUMN.test(c) && !COUNTER_OR_DERIVED.test(c),
      );
      assert.deepEqual(
        [...spec.snapshot].sort(),
        expectedSnapshot.sort(),
        `${itemType}: the snapshot is the whole row minus counters/derived/secret columns`,
      );
      // Every project-ref column must be snapshotted (it is copied per version).
      assert.ok(spec.projectRef.length > 0 || itemType === "blog_post", `${itemType}: has a project scope or none`);
      for (const column of spec.projectRef) {
        assert.ok(real.has(column), `${itemType}: ${spec.table}.${column} is a real project column`);
        assert.ok(spec.snapshot.includes(column), `${itemType}: project column ${column} is snapshotted`);
      }
    }
    db.close();
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
    for (const spec of Object.values(COVERED)) {
      for (const suffix of ["ai", "au", "ad"]) {
        assert.ok(names.has(`hist_${spec.table}_${suffix}`), `hist_${spec.table}_${suffix} must exist`);
      }
    }
    for (const name of ["hist_item_versions_guard_au", "hist_item_versions_guard_ad"]) {
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
      assert.ok(au.includes(`NEW."${column}" IS NOT OLD."${column}"`), `${itemType}: .${column} is compared`);
    }
    // The WHEN clause names every tracked column, and nothing untracked.
    const when = au.slice(au.indexOf("WHEN"), au.indexOf("BEGIN"));
    assert.equal((when.match(/IS NOT/g) || []).length, spec.tracked.length);

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
  assert.equal(guardTriggerSql().length, 2, "one guard per mutation kind (UPDATE, DELETE)");
  assert.throws(() => triggerSql("no_such_item_type"), /unknown item_type/);
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
    // ... and the boot re-ensure tolerates the same partial store.
    assert.deepEqual(
      ensureHistoryTriggers(db).skipped.sort(),
      ["blog_posts", "crow_context"],
      "ensure reports what it cannot cover yet instead of throwing",
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration's id matches its filename", () => {
  assert.equal(migrationId, "0024-item-versions");
});