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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import { COVERED, triggerSql } from "../servers/shared/history/covered.js";
import { run, id as migrationId } from "../scripts/migrations/0024-item-versions.mjs";
import { SYNCED_TABLES } from "../servers/sharing/instance-sync.js";

const REPO = new URL("..", import.meta.url).pathname;

// The never-version-a-secret rule, written out here rather than imported, so a
// loosened regexp in covered.js cannot also loosen this test.
const SECRET_COLUMN = /api_key|token|secret|password/i;

/** Counters, sync clocks, timestamps and derived ids: never snapshotted. */
const NOT_CONTENT_COLUMN =
  /^(id|created_at|updated_at|accessed_at|access_count|lamport_ts|nostr_event_id|published_at|sort_order)$/i;

/** Placement/ownership pointers stamped by the write or sync path, not content.
 *  crow_context is the exception (a section's scope keys ARE its identity, so
 *  the tracked list carries device_id/project_id); these never count as an
 *  "unclassified content column" either way. */
const SCOPE_COLUMN = /^(instance_id|project_id|project_uuid|device_id)$/i;

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
      `SELECT id, op, snapshot_json, author_kind, author_id, job_id, origin_instance, redacted, created_at
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
          `SELECT id, item_type, item_id, op, snapshot_json, author_kind, created_at
             FROM item_versions ORDER BY id`,
        )
        .all(),
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

test("no secret-like column is ever tracked", () => {
  for (const [itemType, spec] of Object.entries(COVERED)) {
    assert.ok(spec.tracked.length > 0, `${itemType}: tracks at least one column`);
    for (const column of spec.tracked) {
      assert.doesNotMatch(column, SECRET_COLUMN, `${itemType}: ${column} looks like a credential column`);
      assert.doesNotMatch(column, NOT_CONTENT_COLUMN, `${itemType}: ${column} is a counter, clock or timestamp`);
    }
    assert.equal(spec.idColumn, "id", `${itemType}: the item id is the table's primary key`);
  }
});

test("every tracked column exists in the real table", () => {
  const fx = initDbFixture("hist-columns-");
  try {
    const db = fx.open();
    for (const [itemType, spec] of Object.entries(COVERED)) {
      const real = new Set(db.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name));
      assert.ok(real.size > 0, `${itemType}: ${spec.table} exists (init-db owns it)`);
      for (const column of [spec.idColumn, ...spec.tracked]) {
        assert.ok(real.has(column), `${itemType}: ${spec.table}.${column} is a real column`);
      }
      // Content columns are all covered: the plan's lists, checked against the
      // real shape, so a new content column cannot be silently left behind.
      const missing = [...real].filter(
        (c) =>
          !spec.tracked.includes(c) &&
          !SECRET_COLUMN.test(c) &&
          !NOT_CONTENT_COLUMN.test(c) &&
          !SCOPE_COLUMN.test(c),
      );
      assert.deepEqual(missing, [], `${itemType}: ${spec.table} has no unclassified content column`);
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
  }
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
      importance INTEGER DEFAULT 5, lamport_ts INTEGER DEFAULT 0)`);
    db.close();

    const second = run({ dbPath, log: () => {} });
    assert.equal(second.deferred, true, "blog_posts and crow_context are still missing");
    assert.doesNotMatch(second.reason, /memories/, "the reason moved on to what is still missing");

    db = new Database(dbPath);
    const info = db.prepare("INSERT INTO memories (content) VALUES (?)").run("captured on the retry");
    assert.equal(versionCount(db, "memory", info.lastInsertRowid), 1, "the retry installed the triggers");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration's id matches its filename", () => {
  assert.equal(migrationId, "0024-item-versions");
});