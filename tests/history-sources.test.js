/**
 * Version history, the follow-up to Task 7: RESEARCH SOURCES keep their history.
 *
 * The item type is `research_source` and the table is `research_sources`
 * (scripts/init-db.js, plus the provenance columns 0013/init-db add). Everything
 * here mirrors the research_note cases in tests/history-coverage.test.js and
 * tests/history-jobs-trash.test.js, with the two decisions this table needed:
 *
 *   THE FETCH FACTS ARE A RE-FETCHABLE CACHE. fetched_text and the bookkeeping
 *   beside it (fetch_status, fetched_at, final_url, http_status, content_sha256,
 *   fetch_error) are in NEITHER the tracked nor the snapshot list, so fetching a
 *   page again writes no version, no version stores the page text, and a restored
 *   source comes back unfetched. full_text — what a person supplied — is the
 *   opposite: tracked, snapshotted, uncapped.
 *
 *   A SOURCE DOES NOT SYNC. research_sources is not in instance-sync's
 *   SYNCED_TABLES (only the notes that reference a source ride the feed), so
 *   nothing here is added to a sync list and a restore reports `synced: false`.
 *
 * Every fixture is a real crow.db from scripts/init-db.js in its own temp dir,
 * brought to the production shape by migrations 0024 (item_versions) and 0026
 * (this type) through their own `run()`, with the registry rows recorded the way
 * scripts/migrations/runner.mjs writes them. Writes go through the gateway's
 * client (servers/db.js) inside a write context, so attribution and the stored
 * snapshot are what a real instance produces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createDbClient } from "../servers/db.js";
import { run as runItemVersions, id as MIGRATION_0024 } from "../scripts/migrations/0024-item-versions.mjs";
import {
  ITEM_TYPES as SOURCE_ITEM_TYPES,
  run as runSources,
  id as MIGRATION_0026,
} from "../scripts/migrations/0026-item-versions-sources.mjs";
import {
  COVERED,
  SECRET_COLUMN,
  typesForMigration,
} from "../servers/shared/history/covered.js";
import { ensureHistoryTriggers } from "../servers/shared/history/ensure.js";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import {
  RESTORE_NOT_SYNCED,
  diffVersions,
  listVersions,
  restoreVersion,
} from "../servers/shared/history/api.js";
import { undoJob } from "../servers/shared/history/jobs.js";
import { listTrash, restoreFromTrash } from "../servers/shared/history/trash.js";
import {
  ERASURE_SYNC_TABLES,
  eraseItems,
  erasureSyncTable,
  isErased,
} from "../servers/shared/history/erase.js";
import { sweep } from "../servers/shared/history/sweep.js";
import { SYNCED_TABLES } from "../servers/sharing/instance-sync.js";
import { itemLabel, typeWord } from "../servers/gateway/dashboard/shared/history-view.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const REPO = new URL("..", import.meta.url).pathname;

/* The instance anchor: Crow's own modules (project-lifecycle, project-spaces)
 * resolve their data dir from the environment, so this file gets a private home —
 * never the real ~/.crow. */
const ROOT = mkdtempSync(join(tmpdir(), "hist-sources-home-"));
process.env.CROW_HOME = join(ROOT, "home");
process.env.CROW_DATA_DIR = join(ROOT, "data");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;

/** An AWS-shaped access key, built at runtime so this file carries no literal a
 *  secret scanner would flag (the redaction sweep's own pattern is what we are
 *  testing; the file itself must stay clean for check-public-hygiene). */
const SECRET_CANARY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

/** The owner at their dashboard and a verified bot working a board card. */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };
const BOT = { authorKind: "bot", authorId: "hank", jobId: "card:9" };
const SYSTEM = { authorKind: "system", authorId: "test-scheduler" };

const MS_PER_DAY = 86_400_000;

/* ------------------------------------------------------------------ fixture */

/** A fresh crow.db from init-db.js, in its own temp dir, before any migration. */
function newStore(prefix = "hist-sources-") {
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
    open() {
      return createDbClient(dbPath);
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run the two history migrations this type needs and record them, exactly as the
 *  registry does — the boot re-ensure only arms capture for a baselined table. */
function migrateHistory(fx) {
  runItemVersions({ dbPath: fx.dbPath, log: () => {} });
  const outcome = runSources({ dbPath: fx.dbPath, log: () => {} });
  assert.equal(outcome.applied, true, `0026 applies to a real store: ${JSON.stringify(outcome)}`);
  const book = new Database(fx.dbPath);
  try {
    book.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
    for (const id of [MIGRATION_0024, MIGRATION_0026]) {
      book.prepare("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
    }
  } finally {
    book.close();
  }
  return outcome;
}

/** A migrated store, optionally seeded BEFORE the migration runs (for baselines). */
async function fixture(prefix, seed = null) {
  const fx = newStore(prefix);
  if (seed) {
    const db = fx.open();
    try {
      await seed(db);
    } finally {
      db.close();
    }
  }
  fx.migration = migrateHistory(fx);
  return fx;
}

/* ------------------------------------------------------------ write helpers */

/** The required columns of a source, plus whatever the caller wants. */
function sourceRow(fields = {}) {
  return {
    title: "A source",
    source_type: "web_article",
    citation_apa: "Someone (2026). A source. Example Press.",
    tags: "tag-a,tag-b",
    ...fields,
  };
}

/** INSERT a source as `ctx`; returns its id. */
async function insertSource(db, ctx, fields = {}) {
  const row = sourceRow(fields);
  const columns = Object.keys(row);
  const info = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO research_sources (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(info.lastInsertRowid);
}

/** UPDATE one source as `ctx`. */
const updateSource = (db, ctx, id, fields) => {
  const columns = Object.keys(fields);
  return withWriteContext(ctx, () =>
    db.execute({
      sql: `UPDATE research_sources SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      args: [...columns.map((c) => fields[c]), id],
    }),
  );
};

const deleteSource = (db, ctx, id) =>
  withWriteContext(ctx, () => db.execute({ sql: "DELETE FROM research_sources WHERE id = ?", args: [id] }));

/** The live row, or undefined. */
async function sourceRowOf(db, id) {
  return (
    await db.execute({ sql: "SELECT * FROM research_sources WHERE id = ?", args: [id] })
  ).rows[0];
}

async function versionsOf(db, itemType, itemId) {
  return (
    await db.execute({
      sql: "SELECT id, op, snapshot_json, project_ref, author_kind FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id",
      args: [itemType, String(itemId)],
    })
  ).rows;
}

/** How many sources the full-text index finds for a term. */
async function ftsHits(db, term) {
  return Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM sources_fts WHERE sources_fts MATCH ?",
        args: [term],
      })
    ).rows[0].n,
  );
}

/* -------------------------------------------------------- capture + baseline */

test("a source is captured on insert, update and delete", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "The first title",
      content_summary: "the first summary",
      full_text: "the full text a person pasted",
      project_id: null,
    });
    let versions = await versionsOf(db, "research_source", id);
    assert.equal(versions.length, 1, "one version per insert");
    assert.equal(versions[0].op, "insert");
    assert.equal(versions[0].project_ref, null, "an unfiled source has no project_ref");
    const snapshot = JSON.parse(versions[0].snapshot_json);
    assert.equal(snapshot.title, "The first title");
    assert.equal(snapshot.content_summary, "the first summary");
    assert.equal(snapshot.full_text, "the full text a person pasted", "full_text is content: it is versioned");
    assert.equal(snapshot.source_type, "web_article");
    assert.equal(snapshot.citation_apa, "Someone (2026). A source. Example Press.");

    await updateSource(db, OWNER, id, { content_summary: "the second summary" });
    versions = await versionsOf(db, "research_source", id);
    assert.deepEqual(
      versions.map((v) => v.op),
      ["insert", "update"],
      "a content edit is a version",
    );
    assert.equal(JSON.parse(versions[1].snapshot_json).content_summary, "the second summary");

    await deleteSource(db, OWNER, id);
    versions = await versionsOf(db, "research_source", id);
    assert.deepEqual(versions.map((v) => v.op), ["insert", "update", "delete"]);
    assert.equal(
      JSON.parse(versions[2].snapshot_json).content_summary,
      "the second summary",
      "a delete keeps what it removed",
    );
    assert.equal(await sourceRowOf(db, id), undefined);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the migration baselines sources that predate history, and a re-run writes nothing", async () => {
  let seededId = null;
  let otherId = null;
  const fx = await fixture("hist-sources-baseline-", async (db) => {
    seededId = await insertSource(db, OWNER, { title: "Before history", content_summary: "old summary" });
    otherId = await insertSource(db, OWNER, { title: "Also before history" });
  });
  const db = fx.open();
  try {
    for (const id of [seededId, otherId]) {
      const versions = await versionsOf(db, "research_source", id);
      assert.equal(versions.length, 1, `source ${id}: exactly one baseline version`);
      assert.equal(versions[0].op, "insert");
      assert.equal(versions[0].author_kind, "system", "a baseline is authored by the installer");
    }
    assert.equal(
      JSON.parse((await versionsOf(db, "research_source", seededId))[0].snapshot_json).content_summary,
      "old summary",
      "the baseline holds the source's PRE-history value",
    );

    // A live write after the install is recorded, and its previous state exists.
    await updateSource(db, OWNER, seededId, { content_summary: "new summary" });
    assert.equal((await versionsOf(db, "research_source", seededId)).length, 2, "baseline + the edit");

    // Idempotent in its own right, which matters because a database restored from
    // a backup can lose its schema_migrations row: the table DDL, the guards, the
    // triggers and the per-item baseline are all re-runnable.
    const snapshot = async () => ({
      versions: (await db.execute("SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'research_source'")).rows[0].n,
      triggers: (await db.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'hist_research_sources%'")).rows[0].n,
    });
    const before = await snapshot();
    const again = runSources({ dbPath: fx.dbPath, log: () => {} });
    assert.equal(again.applied, true, "a re-run still reports applied");
    assert.deepEqual(await snapshot(), before, "and writes no version and no second baseline");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the migration defers, rather than throwing, when research_sources is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-sources-absent-"));
  try {
    const dbPath = join(dir, "crow.db");
    new Database(dbPath).close(); // a restored store with no Crow schema yet

    const first = runSources({ dbPath, log: () => {} });
    assert.equal(first.deferred, true, "nothing to capture yet: retry on a later boot");
    assert.match(first.reason, /research_sources absent/, "the reason names what was missing");

    const db = new Database(dbPath);
    try {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_versions'").get(),
        "the history table itself is safe to create even with no covered table",
      );
    } finally {
      db.close();
    }
    // Still deferred, still no throw: the registry keeps retrying.
    assert.equal(runSources({ dbPath, log: () => {} }).deferred, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dropped source trigger comes back at the next boot ensure", async () => {
  const fx = await fixture();
  const raw = new Database(fx.dbPath);
  try {
    raw.exec("DROP TRIGGER hist_research_sources_ai");
    const result = ensureHistoryTriggers(raw);
    assert.ok(result.restored.includes("hist_research_sources_ai"), "the missing capture trigger is re-created");
    assert.ok(
      !result.awaitingBaseline.includes("research_sources"),
      "the recorded 0026 row is enough: capture is armed",
    );
    // And capture works again.
    const info = raw.prepare("INSERT INTO research_sources (title, source_type, citation_apa) VALUES ('T', 'other', 'C')").run();
    assert.equal(
      raw.prepare("SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'research_source' AND item_id = ?").get(String(info.lastInsertRowid)).n,
      1,
    );
  } finally {
    raw.close();
    fx.dispose();
  }
});

/* --------------------------------------------------------------- restores */

test("restoring an edited and a deleted source puts the content back and keeps the search index in step", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "An indexable source",
      content_summary: "the uniquelyoriginal phrase",
    });
    await updateSource(db, OWNER, id, { content_summary: "the uniquereplacement phrase" });
    assert.equal(await ftsHits(db, "uniquelyoriginal"), 0, "the replaced text is not findable yet");
    assert.equal(await ftsHits(db, "uniquereplacement"), 1);

    // 1. An EDIT, restored: the source's own UPDATE trigger (sources_au, init-db's)
    // keeps sources_fts in step, so the restored text is searchable and the
    // replaced text is gone from the index.
    let versions = await versionsOf(db, "research_source", id);
    await restoreVersion(db, { versionId: Number(versions[0].id) }, OWNER);
    assert.equal((await sourceRowOf(db, id)).content_summary, "the uniquelyoriginal phrase");
    assert.equal(await ftsHits(db, "uniquelyoriginal"), 1, "the restored text is searchable");
    assert.equal(await ftsHits(db, "uniquereplacement"), 0, "and the replaced text left the index");
    assert.equal((await versionsOf(db, "research_source", id)).length, 3, "the restore is itself a version");

    // 2. A DELETE, restored through the Trash: the row comes back as ITSELF (same
    // id) and the re-insert is indexed by sources_ai — the FTS row follows the
    // re-insert exactly as it followed the original insert.
    await deleteSource(db, OWNER, id);
    assert.equal(await ftsHits(db, "uniquelyoriginal"), 0, "a deleted source is out of the index");
    const restored = await restoreFromTrash(db, { itemType: "research_source", itemId: id }, OWNER);
    assert.ok(restored.newVersionId, "the restore wrote a version");
    assert.equal(restored.synced, false, "a source never rides instance sync (see the sync test below)");
    const back = await sourceRowOf(db, id);
    assert.equal(Number(back.id), id, "the same id: a restored source is the same source");
    assert.equal(back.content_summary, "the uniquelyoriginal phrase");
    assert.equal(await ftsHits(db, "uniquelyoriginal"), 1, "and it is searchable again");
    versions = await versionsOf(db, "research_source", id);
    assert.equal(versions[versions.length - 1].op, "insert", "an un-delete is recorded as an insert");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ---------------------------------------------- the fetch cache is not content */

test("a change to fetched_text or the fetch bookkeeping writes NO version, and no version stores it", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "A page Crow fetched",
      url: "https://example.com/page",
      fetched_text: "the page text Crow fetched the first time",
      fetch_status: "fetched",
      fetched_at: new Date().toISOString(),
      final_url: "https://example.com/page",
      http_status: 200,
      content_sha256: "0".repeat(64),
      fetch_error: null,
    });
    assert.equal((await versionsOf(db, "research_source", id)).length, 1);

    // What a re-fetch does: the page text and its bookkeeping move, nothing else.
    await updateSource(db, OWNER, id, {
      fetched_text: "a completely rewritten page about something else",
      fetch_status: "fetched",
      fetched_at: new Date().toISOString(),
      final_url: "https://example.com/page?moved=1",
      http_status: 201,
      content_sha256: "1".repeat(64),
      fetch_error: "a transient warning",
    });
    assert.equal(
      (await versionsOf(db, "research_source", id)).length,
      1,
      "the fetch cache is re-fetchable: pulling the page again is not a change to the source",
    );

    // A real content change still records, and the snapshot still holds none of it.
    await updateSource(db, OWNER, id, { content_summary: "a person's own summary" });
    const versions = await versionsOf(db, "research_source", id);
    assert.equal(versions.length, 2, "the summary edit is a version");
    for (const row of versions) {
      const snapshot = JSON.parse(row.snapshot_json);
      for (const column of ["fetched_text", "fetch_status", "fetched_at", "final_url", "http_status", "content_sha256", "fetch_error"]) {
        assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, column), `${column} is never in a snapshot`);
      }
      assert.ok(!row.snapshot_json.includes("the page text Crow fetched"), "the page text is never stored");
      assert.ok(!row.snapshot_json.includes("a completely rewritten page"), "nor the re-fetched one");
    }
    // full_text is the opposite decision: a person supplied it, so it IS kept.
    await updateSource(db, OWNER, id, { full_text: "text a person pasted" });
    const withFullText = (await versionsOf(db, "research_source", id)).at(-1);
    assert.equal(JSON.parse(withFullText.snapshot_json).full_text, "text a person pasted", "full_text is versioned");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restored source comes back unfetched — the fetch columns are the row's, not the version's", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "Fetched then deleted",
      fetched_text: "the page as it was",
      fetch_status: "fetched",
      fetched_at: new Date().toISOString(),
      http_status: 200,
      content_sha256: "a".repeat(64),
    });
    const versions = await versionsOf(db, "research_source", id);
    await deleteSource(db, OWNER, id);
    await restoreVersion(db, { versionId: Number(versions[0].id) }, OWNER);
    const row = await sourceRowOf(db, id);
    assert.ok(row, "the source is back");
    for (const column of ["fetched_text", "fetch_status", "fetched_at", "final_url", "http_status", "content_sha256", "fetch_error"]) {
      assert.equal(row[column] ?? null, null, `${column} came back empty, so the page can be fetched again`);
    }
    assert.equal(row.title, "Fetched then deleted", "and its content came back");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore keeps the table's own constraints: a good source_type comes back, a bad one is refused", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, { source_type: "academic_paper", title: "A paper" });
    await updateSource(db, OWNER, id, { source_type: "book" });
    const versions = await versionsOf(db, "research_source", id);
    await restoreVersion(db, { versionId: Number(versions[0].id) }, OWNER);
    assert.equal((await sourceRowOf(db, id)).source_type, "academic_paper", "the CHECK column comes back valid");

    // A hand-built snapshot that violates the table's CHECK cannot be written
    // back, and that is reported as a conflict rather than as a raw SQL failure.
    const deleted = await insertSource(db, OWNER, { title: "Never a valid type" });
    await deleteSource(db, OWNER, deleted);
    const bad = (await versionsOf(db, "research_source", deleted)).at(-1);
    const badSnapshot = { ...JSON.parse(bad.snapshot_json), source_type: "not_a_source_type" };
    const rewritten = await db.execute({
      sql: "INSERT INTO item_versions (item_type, item_id, op, snapshot_json, created_at) VALUES ('research_source', ?, 'delete', ?, ?)",
      args: [String(deleted), JSON.stringify(badSnapshot), new Date(Date.now() + 1000).toISOString()],
    });
    await assert.rejects(
      () => restoreVersion(db, { versionId: Number(rewritten.lastInsertRowid) }, OWNER),
      (err) => err.code === "conflict",
      "the table's CHECK holds through a restore",
    );
    assert.equal(await sourceRowOf(db, deleted), undefined, "and nothing invalid was written");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------------- secret canary */

test("a secret-shaped token in a source never survives in snapshot_json, listVersions, diffVersions or a restore", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "A source with a key in it",
      url: `https://example.com/${SECRET_CANARY}`,
      abstract: `the abstract mentions ${SECRET_CANARY}`,
      content_summary: `the summary mentions ${SECRET_CANARY}`,
      full_text: `the full text mentions ${SECRET_CANARY}`,
    });

    // 1. The capture is real: the version holds what the row held (the redaction
    //    sweep, not the trigger, is what scrubs it — see covered.js).
    const stored = await versionsOf(db, "research_source", id);
    assert.equal(stored.length, 1);
    assert.ok(stored[0].snapshot_json.includes(SECRET_CANARY), "the version captured the text as written");

    // 2. The existing snapshot scrub — the same pass every other type gets.
    await withWriteContext(SYSTEM, () => sweep(db, { batchSize: 500 }));
    const scrubbed = (await db.execute({
      sql: "SELECT snapshot_json, redacted FROM item_versions WHERE item_type = 'research_source' AND item_id = ?",
      args: [String(id)],
    })).rows[0];
    assert.equal(Number(scrubbed.redacted), 1, "the version is marked redacted");
    assert.ok(!scrubbed.snapshot_json.includes(SECRET_CANARY), "and the key is gone from the stored snapshot");
    assert.ok(scrubbed.snapshot_json.includes("[redacted]"), "replaced with the placeholder");
    // LIVE DATA IS NOT HISTORY'S BUSINESS: the source row itself is untouched.
    assert.equal((await sourceRowOf(db, id)).content_summary, `the summary mentions ${SECRET_CANARY}`);

    // 3. A later, clean edit.
    await updateSource(db, OWNER, id, {
      url: "https://example.com/clean",
      abstract: "a clean abstract",
      content_summary: "a clean summary",
      full_text: "clean full text",
    });

    // 4. The History API's own output never carries it.
    const listed = await listVersions(db, { itemType: "research_source", itemId: id });
    assert.ok(!JSON.stringify(listed).includes(SECRET_CANARY), "listVersions never returns the key");
    const diff = diffVersions(listed[1], listed[0]);
    assert.ok(diff.length > 0, "the edit is visible as a change");
    assert.ok(!JSON.stringify(diff).includes(SECRET_CANARY), "diffVersions never returns the key");

    // 5. A restore result never carries it, and the redacted version is refused
    //    rather than pasting the placeholder into live content.
    const restored = await restoreVersion(db, { versionId: Number(listed[0].id) }, OWNER);
    assert.ok(!JSON.stringify(restored).includes(SECRET_CANARY), "a restore result never carries the key");
    await assert.rejects(
      () => restoreVersion(db, { versionId: Number(listed[1].id) }, OWNER),
      (err) => err.code === "redacted",
      "the redacted version no longer holds the source's value",
    );
    assert.equal(await ftsHits(db, "clean"), 1, "and the clean text is what the index holds");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------------------- Trash */

test("the Trash lists a deleted source and restores it", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, { title: "A source to bin", url: "https://example.com/bin" });
    await deleteSource(db, OWNER, id);

    const entries = (await listTrash(db)).filter((e) => e.itemType === "research_source");
    assert.equal(entries.length, 1, "the deleted source is in the Trash");
    assert.equal(entries[0].itemId, String(id));
    assert.equal(entries[0].deletedBy.authorKind, "owner");
    assert.equal(entries[0].snapshot.title, "A source to bin", "with the snapshot it removed");
    assert.equal(itemLabel("research_source", entries[0].snapshot), "A source to bin", "and the page can label it");

    const restored = await restoreFromTrash(db, { itemType: "research_source", itemId: id }, OWNER);
    assert.ok(restored.newVersionId);
    assert.equal((await sourceRowOf(db, id)).title, "A source to bin", "the source is back");
    assert.deepEqual(
      (await listTrash(db)).filter((e) => e.itemType === "research_source"),
      [],
      "and it left the Trash",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

/* -------------------------------------------------------------- job undo */

test("undoing a job restores the source it edited and removes the source it created", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    // Before the job: a source the bot is about to edit.
    const edited = await insertSource(db, OWNER, { title: "Before the bot", content_summary: "the owner's summary" });
    // The bot's unit of work: one edit and one new source.
    await updateSource(db, BOT, edited, { content_summary: "the bot's summary" });
    const created = await insertSource(db, BOT, { title: "A source the bot added" });

    const result = await undoJob(db, { jobId: BOT.jobId }, OWNER);
    assert.deepEqual(
      result.restored.map((r) => ({ itemType: r.itemType, itemId: r.itemId, action: r.action })),
      [
        { itemType: "research_source", itemId: String(edited), action: "restored" },
        { itemType: "research_source", itemId: String(created), action: "deleted" },
      ],
      "both of the job's sources are undone",
    );
    assert.deepEqual(result.skipped, []);
    assert.equal(
      (await sourceRowOf(db, edited)).content_summary,
      "the owner's summary",
      "the edit is put back",
    );
    // The created one went through a real DELETE, so it is in the Trash — undoable
    // again, never gone.
    assert.equal(await sourceRowOf(db, created), undefined, "the created source is removed");
    const trashed = (await listTrash(db)).filter((e) => e.itemType === "research_source");
    assert.deepEqual(trashed.map((e) => e.itemId), [String(created)], "and it waits in the Trash");
    // The undo is itself attributed (never to the job being undone).
    const last = (await versionsOf(db, "research_source", edited)).at(-1);
    assert.equal(last.author_kind, "owner");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* --------------------------------------------------------------- erase */

test("an erased source does not come back, and its tombstone refuses a pre-erase version", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, { title: "Forget this source" });
    await deleteSource(db, OWNER, id);
    const versions = await versionsOf(db, "research_source", id);
    const erased = await eraseItems(db, [{ itemType: "research_source", itemId: id }], SYSTEM);
    assert.equal(erased.versions, versions.length, "every version went");
    assert.equal(await isErased(db, "research_source", String(id)), true, "the erase left a tombstone");
    assert.deepEqual(await versionsOf(db, "research_source", id), [], "and no versions");

    // The Trash refuses it, with 'erased' rather than 'not_found'.
    await assert.rejects(
      () => restoreFromTrash(db, { itemType: "research_source", itemId: id }, OWNER),
      (err) => err.code === "erased",
    );
    assert.equal(await sourceRowOf(db, id), undefined, "nothing came back");

    // A version that outlived the erase (a stale reader, a foreign writer) is not a
    // loophole: a version created at or before the tombstone's erased_at is the
    // erased item's own value.
    const erasedAt = (await db.execute({
      sql: "SELECT erased_at FROM item_erasures WHERE item_type = 'research_source' AND item_id = ?",
      args: [String(id)],
    })).rows[0].erased_at;
    const stale = await db.execute({
      sql: "INSERT INTO item_versions (item_type, item_id, op, snapshot_json, created_at) VALUES ('research_source', ?, 'insert', ?, ?)",
      args: [
        String(id),
        JSON.stringify(sourceRow({ title: "Forget this source" })),
        new Date(Date.parse(erasedAt) - 60_000).toISOString(),
      ],
    });
    await assert.rejects(
      () => restoreVersion(db, { versionId: Number(stale.lastInsertRowid) }, OWNER),
      (err) => err.code === "erased",
    );
    assert.equal(await sourceRowOf(db, id), undefined, "still nothing came back");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the sweep erases a source that has been in the Trash longer than the period, and not before", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, { title: "A source in the bin" });
    await deleteSource(db, OWNER, id);
    const versions = (await versionsOf(db, "research_source", id)).length;
    assert.equal(versions, 2, "insert + delete");

    // Inside the period: nothing is erased.
    const early = await sweep(db, { now: new Date(Date.now() + 10 * MS_PER_DAY), trashDays: 30, syncManager: null });
    assert.deepEqual(early.erased.filter((e) => e.itemType === "research_source"), [], "still inside the Trash period");
    assert.equal((await versionsOf(db, "research_source", id)).length, versions);

    // Past it: the item and its whole history go, with a tombstone.
    const late = await sweep(db, { now: new Date(Date.now() + 31 * MS_PER_DAY), trashDays: 30, syncManager: null });
    assert.deepEqual(
      late.erased.filter((e) => e.itemType === "research_source").map((e) => e.itemId),
      [String(id)],
      "the aged source is erased",
    );
    assert.deepEqual(await versionsOf(db, "research_source", id), []);
    assert.equal(await isErased(db, "research_source", String(id)), true, "and tombstoned");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("purging a project erases its sources' history at once, and leaves an unfiled source alone", async () => {
  const dataDir = join(ROOT, "sources-purge-instance");
  const fx = await fixture("hist-sources-purge-", null);
  const db = fx.open();
  const tasksDir = mkdtempSync(join(tmpdir(), "hist-sources-purge-tasks-"));
  try {
    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const L = await import("../servers/shared/project-lifecycle.js");

    const project = await createProjectSpace(db, { name: "Sources purge me" });
    const projectId = Number(project.id);
    const filed = await insertSource(db, OWNER, { title: "A filed source", project_id: projectId });
    const unfiled = await insertSource(db, OWNER, { title: "An unfiled source" });
    const filedVersions = (await versionsOf(db, "research_source", filed)).length;
    assert.equal(filedVersions, 1);

    const outcome = await L.deleteProject(db, projectId, {
      confirmName: "Sources purge me",
      dataDir,
      tasksDbPath: join(tasksDir, "tasks.db"),
      storageDelete: async () => {},
      disconnectBackend: async () => true,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));

    assert.deepEqual(
      await versionsOf(db, "research_source", filed),
      [],
      "the source the purge DELETED has no history left (the delete version included)",
    );
    assert.equal(await isErased(db, "research_source", String(filed)), true, "with its tombstone");
    assert.equal(
      (await versionsOf(db, "research_source", unfiled)).length,
      1,
      "an unfiled source is not the purge's to erase",
    );
  } finally {
    db.close();
    rmSync(tasksDir, { recursive: true, force: true });
    fx.dispose();
  }
});

/* ------------------------------------------------------------ sync posture */

test("research_sources is not a synced table, and a restored source reports synced:false", async () => {
  // The rows are local: only the notes that reference a source ride the feed, so
  // this migration must add NOTHING to any sync list (see the 0026 header and
  // instance-sync's "research_sources rows are not synced" comment).
  assert.ok(!SYNCED_TABLES.includes("research_sources"), "research_sources is never in SYNCED_TABLES");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(ERASURE_SYNC_TABLES, "research_sources"),
    "nor does an erased source's erase ride an erase event",
  );
  assert.equal(erasureSyncTable("research_source"), null, "no item type maps a source's erasures to a table");
  assert.ok(
    !Object.values(ERASURE_SYNC_TABLES).includes("research_source"),
    "and no erasure-sync entry names the source item type",
  );
  assert.ok(RESTORE_NOT_SYNCED.includes("research_source"), "a source's restore is a local write");

  const src = readFileSync(join(REPO, "scripts", "migrations", "0026-item-versions-sources.mjs"), "utf8");
  assert.doesNotMatch(
    src,
    /SYNCED_TABLES\.(push|unshift|splice)|ERASURE_SYNC_TABLES\[|OUTBOUND_TRANSFORMS\[/,
    "the migration has no code path that adds anything to sync",
  );

  // And the API says so: a restore with a live-looking manager still emits nothing.
  const fx = await fixture();
  const db = fx.open();
  try {
    const calls = [];
    const syncManager = {
      emitChange: (...args) => calls.push(args),
      emitOrQueue: (...args) => calls.push(args),
    };
    const id = await insertSource(db, OWNER, { title: "A local source", content_summary: "first" });
    const versions = await versionsOf(db, "research_source", id);
    await updateSource(db, OWNER, id, { content_summary: "second" });
    const result = await restoreVersion(db, { versionId: Number(versions[0].id), syncManager }, OWNER);
    assert.equal(result.newVersionId !== null, true, "the restore wrote");
    assert.equal(result.synced, false, "but nothing was sent to peers");
    assert.deepEqual(calls, [], "the sync layer was never touched");
    assert.equal((await sourceRowOf(db, id)).content_summary, "first", "and the value is back");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------- the covered rules */

test("the research_source entry follows the COVERED rules and owns its migration", () => {
  const spec = COVERED.research_source;
  assert.ok(spec, "the type is covered");
  assert.equal(spec.table, "research_sources");
  assert.equal(spec.idColumn, "id");
  assert.equal(spec.migration, MIGRATION_0026);
  assert.deepEqual(typesForMigration(MIGRATION_0026), ["research_source"], "0026 owns exactly this type");
  assert.deepEqual([...SOURCE_ITEM_TYPES], ["research_source"]);
  assert.deepEqual([...spec.projectRef], ["project_id"], "filed by the local project id, like a note");

  // Every tracked column is snapshotted, and no credential-shaped column is in
  // either list (the import rules that make item_versions safe run at load).
  for (const column of spec.tracked) {
    assert.ok(spec.snapshot.includes(column), `${column} is tracked AND snapshotted`);
    assert.doesNotMatch(column, SECRET_COLUMN, `${column} looks like a credential`);
  }
  for (const column of spec.snapshot) {
    assert.doesNotMatch(column, SECRET_COLUMN, `${column} looks like a credential`);
  }

  // The decision the operator made for this table: the fetch cache and the two
  // legacy host-local pointers are out of both content lists, named in `omitted`
  // (see the comment above `snapshot` in covered.js), and full_text is in both.
  for (const column of [
    "fetched_text",
    "fetch_status",
    "fetched_at",
    "final_url",
    "http_status",
    "content_sha256",
    "fetch_error",
    "file_path",
    "s3_key",
  ]) {
    assert.ok(!spec.tracked.includes(column), `${column} is not a change`);
    assert.ok(!spec.snapshot.includes(column), `${column} is not stored`);
    assert.ok(spec.omitted.includes(column), `${column} is left out by name, not by oversight`);
  }
  assert.ok(spec.tracked.includes("full_text"), "full_text is content and IS a change");
  assert.ok(spec.snapshot.includes("full_text"), "and it is stored, uncapped");

  // The user-facing words exist in both languages, and neither says anything
  // about how the history is stored.
  assert.equal(t("history.type.research_source", "en"), "Research source");
  assert.equal(t("history.type.research_source", "es"), "Fuente de investigación");
  assert.equal(typeWord("research_source", "en"), "Research source");
  assert.equal(typeWord("research_source", "es"), "Fuente de investigación");
  for (const word of [typeWord("research_source", "en"), typeWord("research_source", "es")]) {
    assert.doesNotMatch(word, /\b(git|commit|branch|repo|repository|diff|revert)\b/i, `${word}: no git words`);
  }
  // The label falls back the way a source a person added by URL alone needs.
  assert.equal(itemLabel("research_source", { title: "T" }), "T");
  assert.equal(itemLabel("research_source", { title: "", url: "https://example.com/x" }), "https://example.com/x");
  assert.equal(itemLabel("research_source", { citation_apa: "Someone (2026)." }), "Someone (2026).");
  assert.equal(itemLabel("research_source", {}), "—");
});