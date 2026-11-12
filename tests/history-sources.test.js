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
 *   A RESTORE DOES NOT REPLAY STANDING. The verification workflow's verdict
 *   (verified, verification_method, verified_by, verification_notes) is bound to
 *   the fetched text the source holds TODAY, and backend_id is a host-local
 *   pointer to a data backend. Both are snapshotted so History still SHOWS them,
 *   but they are kept current: an edit restore leaves them as they are now, and a
 *   Trash restore writes them empty (unverified, no dead backend), so no source
 *   comes back citable without the evidence a verdict claims.
 *
 *   A URL-LESS SOURCE COMES BACK 'not_applicable' from the Trash, the way
 *   add_source files one. Only a source with a URL can be fetched again.
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
      url: "https://example.com/refetchable",
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

/* ------------------------------------------- the standing is not replayed */

test("an edit restore never brings a cleared verification back, and the old verdict stays visible", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "A source with quotes",
      url: "https://example.com/quotes",
      content_summary: "the owner's summary",
    });
    // The owner verifies it against the page Crow holds (the research server's
    // verify_source write: verified, the method, who checked, and the note).
    await updateSource(db, OWNER, id, {
      verified: 1,
      verification_method: "quotes_checked",
      verified_by: "owner",
      verification_notes: "every quote found on the page",
    });
    // A bot job re-fetches the page; the quotes no longer match, so the re-check
    // CLEARS the verification (the same UPDATE servers/research/server.js runs).
    await updateSource(db, BOT, id, {
      content_summary: "the bot's re-fetched summary",
      verified: 0,
      verification_method: null,
      verified_by: null,
      verification_notes: null,
    });
    assert.equal(Number((await sourceRowOf(db, id)).verified), 0, "the re-check cleared it");

    // Undo the job: the job's content edit goes back, the verification does NOT.
    const undo = await undoJob(db, { jobId: BOT.jobId }, OWNER);
    assert.deepEqual(undo.skipped, []);
    assert.equal(undo.restored[0]?.action, "restored");
    let row = await sourceRowOf(db, id);
    assert.equal(row.content_summary, "the owner's summary", "the job's content edit is undone");
    assert.equal(Number(row.verified), 0, "the cleared verification stays cleared");
    assert.equal(row.verification_method, null, "and no method is replayed");
    assert.equal(row.verified_by, null);
    assert.equal(row.verification_notes, null);

    // The verdict is still IN history (tracked and snapshotted), so the person can
    // see the source was once verified — a restore just never replays it.
    const versions = await versionsOf(db, "research_source", id);
    const verifiedVersion = versions.find((v) => JSON.parse(v.snapshot_json).verified === 1);
    assert.ok(verifiedVersion, "the verified version is still in History");
    assert.equal(JSON.parse(verifiedVersion.snapshot_json).verification_method, "quotes_checked");

    // Restoring that version directly, after a later edit, still leaves the
    // standing alone while the content comes back.
    await updateSource(db, OWNER, id, { title: "A later title" });
    await restoreVersion(db, { versionId: Number(verifiedVersion.id) }, OWNER);
    row = await sourceRowOf(db, id);
    assert.equal(row.title, "A source with quotes", "the content is restored");
    assert.equal(Number(row.verified), 0, "and the source stays unverified");
    assert.equal(row.verification_method, null);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a source restored from the Trash comes back unverified, and a row with a URL stays unfetched", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const id = await insertSource(db, OWNER, {
      title: "Verified before the bin",
      url: "https://example.com/verified",
      verified: 1,
      verification_method: "manual_owner",
      verified_by: "owner",
      verification_notes: "checked by hand",
    });
    await deleteSource(db, OWNER, id);
    const trashed = (await versionsOf(db, "research_source", id)).at(-1);
    assert.equal(
      Number(JSON.parse(trashed.snapshot_json).verified),
      1,
      "the Trash keeps the verdict it removed",
    );

    const restored = await restoreFromTrash(db, { itemType: "research_source", itemId: id }, OWNER);
    assert.ok(restored.newVersionId);
    const row = await sourceRowOf(db, id);
    assert.equal(row.title, "Verified before the bin", "the content is back");
    assert.equal(Number(row.verified), 0, "an un-delete comes back unverified");
    assert.equal(row.verification_method, null);
    assert.equal(row.verified_by, null);
    assert.equal(row.verification_notes, null);
    assert.equal(row.fetch_status, null, "a source with a URL is simply unfetched, so it can be fetched again");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a URL-less source restored from the Trash is fetch_status 'not_applicable', the way add_source files one", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    // A book a person typed in (no URL), one cited with only whitespace, and one
    // that really has a page behind it.
    const noUrl = await insertSource(db, OWNER, { title: "A book on the shelf", source_type: "book" });
    const emptyUrl = await insertSource(db, OWNER, { title: "A typed citation", url: "   " });
    const withUrl = await insertSource(db, OWNER, { title: "A real page", url: "https://example.com/page" });
    for (const id of [noUrl, emptyUrl, withUrl]) await deleteSource(db, OWNER, id);

    for (const id of [noUrl, emptyUrl]) {
      await restoreFromTrash(db, { itemType: "research_source", itemId: id }, OWNER);
      assert.equal(
        (await sourceRowOf(db, id)).fetch_status,
        "not_applicable",
        `source ${id}: there is nothing to fetch, so it is not left looking like another instance's copy`,
      );
    }
    await restoreFromTrash(db, { itemType: "research_source", itemId: withUrl }, OWNER);
    assert.equal(
      (await sourceRowOf(db, withUrl)).fetch_status,
      null,
      "a source with a URL comes back unfetched (NULL), not 'not_applicable'",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("backend_id is kept current on an edit restore, and a removed backend leaves the source unplaced", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    const { rows: fk } = await db.execute("PRAGMA foreign_keys");
    assert.equal(Number(fk[0].foreign_keys), 1, "the gateway's connections enforce foreign keys");

    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const project = await createProjectSpace(db, { name: "Sources with backends" });
    const newBackend = async (name) => {
      const info = await withWriteContext(OWNER, () =>
        db.execute({
          sql: "INSERT INTO data_backends (project_id, name, connection_ref) VALUES (?, ?, ?)",
          args: [Number(project.id), name, `mcp://example.invalid/${name}`],
        }),
      );
      return Number(info.lastInsertRowid);
    };
    const dropBackend = (backendId) =>
      withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM data_backends WHERE id = ?", args: [backendId] }));

    // 1. AN EDIT RESTORE keeps the live value: the version named a backend that
    //    has since been removed, and replaying it would fail the foreign key (or
    //    point at a backend this host no longer has).
    const editBackend = await newBackend("edit-arm");
    const edited = await insertSource(db, OWNER, { title: "On a backend", backend_id: editBackend });
    await updateSource(db, OWNER, edited, { title: "On a backend, v2" });
    await updateSource(db, OWNER, edited, { title: "On a backend, v3" });
    const editVersions = await versionsOf(db, "research_source", edited);
    const v2 = editVersions.find((v) => JSON.parse(v.snapshot_json).title === "On a backend, v2");
    assert.equal(JSON.parse(v2.snapshot_json).backend_id, editBackend, "the version records the backend");

    await dropBackend(editBackend);
    assert.equal((await sourceRowOf(db, edited)).backend_id, null, "removing the backend unplaces the source");
    await restoreVersion(db, { versionId: Number(v2.id) }, OWNER);
    let row = await sourceRowOf(db, edited);
    assert.equal(row.title, "On a backend, v2", "the content comes back");
    assert.equal(row.backend_id, null, "but not the backend the version named");

    // 2. A TRASH RESTORE writes the pointer only when the backend still exists:
    //    here the source was binned while it had one, and the backend went while
    //    the source waited, so the re-insert would fail on the foreign key.
    const trashBackend = await newBackend("trash-arm");
    const binned = await insertSource(db, OWNER, { title: "Binned with a backend", backend_id: trashBackend });
    await deleteSource(db, OWNER, binned);
    const deleteVersion = (await versionsOf(db, "research_source", binned)).at(-1);
    assert.equal(
      JSON.parse(deleteVersion.snapshot_json).backend_id,
      trashBackend,
      "the Trash version records the backend it removed",
    );
    await dropBackend(trashBackend);

    const restored = await restoreFromTrash(db, { itemType: "research_source", itemId: binned }, OWNER);
    assert.ok(restored.newVersionId, "the restore succeeded with foreign keys ON");
    row = await sourceRowOf(db, binned);
    assert.equal(row.title, "Binned with a backend");
    assert.equal(row.backend_id, null, "a backend that no longer exists is not written back");

    // 3. THE OTHER HALF OF THAT BRANCH: the backend is still there, so the Trash
    //    restore writes the pointer back and the source stays where it was placed.
    const liveBackend = await newBackend("trash-arm-live");
    const binnedWithLive = await insertSource(db, OWNER, {
      title: "Binned, backend still here",
      backend_id: liveBackend,
    });
    await deleteSource(db, OWNER, binnedWithLive);
    await restoreFromTrash(db, { itemType: "research_source", itemId: binnedWithLive }, OWNER);
    row = await sourceRowOf(db, binnedWithLive);
    assert.equal(row.title, "Binned, backend still here");
    assert.equal(row.backend_id, liveBackend, "a backend that still exists IS written back, so the source stays placed");
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

test("a credential in a source's URL query string is scrubbed from snapshot_json, listVersions and diffVersions", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    // Three shapes a pasted link carries a key in. The values are obviously fake
    // (this file is tracked in a public repository) but long enough that they are
    // not a placeholder.
    const credentials = {
      api_key: "q7FakeValueForAnApiKey001",
      token: "tokFakeValue000000002",
      access_token: "accFakeValue00000003",
    };
    const ids = [];
    for (const [param, value] of Object.entries(credentials)) {
      ids.push(
        await insertSource(db, OWNER, {
          title: `A source behind ${param}`,
          url: `https://example.com/private/report?${param}=${value}&page=2`,
        }),
      );
    }

    // 1. The capture is real: the trigger stores the URL as the row held it (the
    //    redaction sweep, not the trigger, is what scrubs it).
    for (let i = 0; i < ids.length; i++) {
      const value = Object.values(credentials)[i];
      const stored = (await versionsOf(db, "research_source", ids[i])).at(-1);
      assert.ok(stored.snapshot_json.includes(value), "the version captured the URL as written");
    }

    // 2. The sweep's scrub — no SECRET_PATTERN matches `?api_key=<value>`, so a
    //    URL query credential is its own shape (see sweep.js).
    await withWriteContext(SYSTEM, () => sweep(db, { batchSize: 500 }));
    const stored = (await db.execute({
      sql: "SELECT id, snapshot_json, redacted FROM item_versions WHERE item_type = 'research_source' ORDER BY id",
      args: [],
    })).rows;
    assert.equal(stored.length, ids.length);
    for (const row of stored) {
      for (const value of Object.values(credentials)) {
        assert.ok(!row.snapshot_json.includes(value), "the key is gone from the stored snapshot");
      }
      assert.equal(Number(row.redacted), 1, "the version is marked redacted");
      assert.ok(row.snapshot_json.includes("[redacted]"), "replaced with the placeholder");
      assert.ok(row.snapshot_json.includes("page=2"), "the harmless part of the query is kept");
    }
    // LIVE DATA IS NOT HISTORY'S BUSINESS: the source rows still hold their URLs.
    assert.match((await sourceRowOf(db, ids[0])).url, /api_key=q7FakeValueForAnApiKey001/);

    // 3. The History API's own output never carries them: a later clean edit gives
    //    listVersions and diffVersions a second version to compare against. That
    //    edit's own version captured the URL as the row held it, so one more sweep
    //    scrubs it — the same pass every other type gets.
    await updateSource(db, OWNER, ids[0], {
      url: "https://example.com/public/report?page=2",
      content_summary: "a later, clean summary",
    });
    await withWriteContext(SYSTEM, () => sweep(db, { batchSize: 500 }));
    const listed = await listVersions(db, { itemType: "research_source", itemId: ids[0] });
    assert.ok(listed.length >= 2, "the edit is a second version");
    const diff = diffVersions(listed[1], listed[0]);
    assert.ok(diff.length > 0, "the edit is visible as a change");
    for (const value of Object.values(credentials)) {
      assert.ok(!JSON.stringify(listed).includes(value), "listVersions never returns the key");
      assert.ok(!JSON.stringify(diff).includes(value), "diffVersions never returns the key");
    }
    // And the redacted version is refused rather than pasting the placeholder into
    // a URL someone would click.
    await assert.rejects(
      () => restoreVersion(db, { versionId: Number(listed[1].id) }, OWNER),
      (err) => err.code === "redacted",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a credential in a URL fragment or behind percent-encoding is scrubbed from a source's url", async () => {
  const fx = await fixture();
  const db = fx.open();
  try {
    // Two shapes a query-string scrub also has to see. An OAuth implicit-flow
    // callback carries its token in the FRAGMENT (`#access_token=…`), and a base64
    // token whose first character is `/` or `+` arrives percent-encoded, so its
    // first character in the URL is `%`.
    const cases = [
      {
        secret: "fragFakeValue000000004",
        kept: "expires_in=3600",
        url: "https://example.com/callback#access_token=fragFakeValue000000004&expires_in=3600",
      },
      {
        secret: "%2FFakeValueForAnEncodedToken5",
        kept: "page=2",
        url: "https://example.com/private/report?token=%2FFakeValueForAnEncodedToken5&page=2",
      },
    ];
    const ids = [];
    for (const [i, shape] of cases.entries()) {
      ids.push(await insertSource(db, OWNER, { title: `An encoded link ${i}`, url: shape.url }));
    }

    // 1. The trigger stores the URL as the row held it (the sweep, not the
    //    trigger, is what scrubs it).
    for (const [i, id] of ids.entries()) {
      const stored = (await versionsOf(db, "research_source", id)).at(-1);
      assert.ok(stored.snapshot_json.includes(cases[i].secret), "the version captured the URL as written");
    }

    // 2. The sweep's scrub catches both.
    await withWriteContext(SYSTEM, () => sweep(db, { batchSize: 500 }));
    const stored = (
      await db.execute({
        sql: "SELECT item_id, snapshot_json, redacted FROM item_versions WHERE item_type = 'research_source' ORDER BY id",
        args: [],
      })
    ).rows;
    assert.equal(stored.length, ids.length);
    for (const [i, row] of stored.entries()) {
      assert.ok(!row.snapshot_json.includes(cases[i].secret), "the token is gone from the stored snapshot");
      assert.equal(Number(row.redacted), 1, "the version is marked redacted");
      assert.ok(row.snapshot_json.includes(cases[i].kept), "the harmless part of the URL is kept");
    }
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

  // The controller's ruling under the version history design (large re-fetchable
  // fields stay out): the fetch cache and the two legacy host-local pointers are
  // out of both content lists, named in `omitted` (see the comment above
  // `snapshot` in covered.js), and full_text is in both.
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