/**
 * Version history, Task 4: job undo, Trash, erase, retention, redaction and the
 * coalescing sweep — plus the operator's 2026-11-10 ruling that a PERMANENT
 * delete erases history at once instead of waiting for the Trash period.
 *
 * Every fixture is a real scripts/init-db.js crow.db in its own temp dir with the
 * additive 0024 migration applied (the production shape: FTS triggers, seeded
 * crow_context, the append-only guards), as in tests/history-api.test.js. Writes
 * go through the gateway's client (servers/db.js) inside a write context, so the
 * versions they produce are stamped the way a real write's are.
 *
 * The two ruling tests drive the real flows, not a re-implementation of them:
 * `maker_delete_learner` through an in-memory MCP client, and
 * servers/shared/project-lifecycle.js's deleteProject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createDbClient } from "../servers/db.js";
import { run as migrate } from "../scripts/migrations/0024-item-versions.mjs";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import { undoJob, UNDO_REASONS } from "../servers/shared/history/jobs.js";
import { listVersions, restoreVersion } from "../servers/shared/history/api.js";
import { emptyTrash, listTrash, restoreFromTrash, trashEntriesSql } from "../servers/shared/history/trash.js";
import { eraseItems, isErased } from "../servers/shared/history/erase.js";
import { sweep, COALESCE_WINDOW_MS } from "../servers/shared/history/sweep.js";

const REPO = new URL("..", import.meta.url).pathname;

/* The instance anchor this file runs under. Crow's own modules resolve their data
 * dir from the environment (project-lifecycle, project-spaces), so the whole file
 * gets one private home — never the real ~/.crow. */
const ROOT = mkdtempSync(join(tmpdir(), "hist-jobs-home-"));
process.env.CROW_HOME = join(ROOT, "home");
process.env.CROW_DATA_DIR = join(ROOT, "data");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;

/** An AWS-shaped access key, built at runtime so this file carries no literal a
 *  secret scanner would flag (the redaction sweep's own patterns are what we are
 *  testing; the file itself must stay clean for check-public-hygiene). */
const AWS_KEY = ["AKIA", "Q7T2", "MN4P", "R8SZ", "WX9K"].join("");
/** The same trick for a private key: its header is a secret pattern too. */
const PEM_BEGIN = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
const PEM_END = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");
const PEM_BODY = ["MIIEowIBAAKCAQEA", "fakebodyfakebody", "notarealkeynotarealkey"].join("");

/** The owner at their dashboard, a verified bot working a board card, a schedule. */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };
const BOT = { authorKind: "bot", authorId: "hank", jobId: "card:7" };
const SYSTEM = { authorKind: "system", authorId: "test-scheduler" };

/** A fresh crow.db (init-db.js) with 0024 applied. `dir` lets one test own the
 *  instance data dir itself (the project delete resolves workspaces under it). */
function fixture(prefix, dir = null) {
  const root = dir || mkdtempSync(join(tmpdir(), prefix));
  if (dir) mkdirSync(dir, { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: root, CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(root, "crow.db");
  migrate({ dbPath, log: () => {} });
  return {
    dir: root,
    dbPath,
    open() {
      return createDbClient(dbPath);
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------- write helpers */

async function insertMemory(db, ctx, fields = {}) {
  const row = { content: "a memory", category: "general", ...fields };
  const columns = Object.keys(row);
  const { lastInsertRowid } = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO memories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(lastInsertRowid);
}

const updateMemory = (db, ctx, id, fields) => {
  const columns = Object.keys(fields);
  return withWriteContext(ctx, () =>
    db.execute({
      sql: `UPDATE memories SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      args: [...columns.map((c) => fields[c]), id],
    }),
  );
};

const deleteMemory = (db, ctx, id) =>
  withWriteContext(ctx, () => db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] }));

async function insertPost(db, ctx, fields = {}) {
  const row = { slug: "a-post", title: "A post", content: "body text", ...fields };
  const columns = Object.keys(row);
  const { lastInsertRowid } = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO blog_posts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(lastInsertRowid);
}

const updatePost = (db, ctx, id, fields) => {
  const columns = Object.keys(fields);
  return withWriteContext(ctx, () =>
    db.execute({
      sql: `UPDATE blog_posts SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      args: [...columns.map((c) => fields[c]), id],
    }),
  );
};

const memoryRow = async (db, id, columns = "id, content") =>
  (await db.execute({ sql: `SELECT ${columns} FROM memories WHERE id = ?`, args: [id] })).rows[0];

const versionsOf = async (db, itemType, itemId) =>
  (await db.execute({
    sql: `SELECT id, op, snapshot_json, redacted, created_at, author_id, job_id
            FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id`,
    args: [itemType, String(itemId)],
  })).rows;

const versionCount = async (db, itemType, itemId) =>
  Number((await db.execute({
    sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = ? AND item_id = ?",
    args: [itemType, String(itemId)],
  })).rows[0].n);

const armed = async (db) =>
  Number((await db.execute({ sql: "SELECT armed FROM item_versions_erase", args: [] })).rows[0].armed);

/* ------------------------------------------------------------- job undo */

test("a job editing 2 memories and 1 post, then undo, restores all 3", async () => {
  const fx = fixture("hist-job-undo-");
  const db = fx.open();
  try {
    const m1 = await insertMemory(db, OWNER, { content: "first memory, before the job" });
    const m2 = await insertMemory(db, OWNER, { content: "second memory, before the job" });
    const post = await insertPost(db, OWNER, { slug: "job-post", title: "Job post", content: "before the job" });

    // One bot, one card: every write below is stamped card:7.
    await updateMemory(db, BOT, m1, { content: "first memory, after the job" });
    await updateMemory(db, BOT, m2, { content: "second memory, after the job" });
    await updatePost(db, BOT, post, { content: "after the job" });

    const undo = await undoJob(db, { jobId: "card:7" }, OWNER);
    assert.deepEqual(undo.skipped, [], "nothing was edited after the job, so nothing is skipped");
    assert.deepEqual(
      undo.restored.map((r) => `${r.itemType}/${r.itemId}`).sort(),
      [`blog_post/${post}`, `memory/${m1}`, `memory/${m2}`].sort(),
      "all three items the job touched",
    );
    assert.deepEqual(new Set(undo.restored.map((r) => r.action)), new Set(["restored"]));

    assert.equal((await memoryRow(db, m1)).content, "first memory, before the job");
    assert.equal((await memoryRow(db, m2)).content, "second memory, before the job");
    const postRow = (await db.execute({ sql: "SELECT content FROM blog_posts WHERE id = ?", args: [post] })).rows[0];
    assert.equal(postRow.content, "before the job");

    // The undo is itself a version, attributed to whoever undid it (review focus 3).
    const m1Versions = await versionsOf(db, "memory", m1);
    assert.deepEqual(m1Versions.map((v) => v.op), ["insert", "update", "update"]);
    assert.equal(m1Versions.at(-1).author_id, OWNER.authorId, "the undo is stamped with its own author");
    assert.equal(m1Versions.at(-1).job_id, "undo:card:7", "the undo is its own job, never the undone job's id");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("an owner edit to one of them after the job leaves skipped holding exactly that one", async () => {
  const fx = fixture("hist-job-skip-");
  const db = fx.open();
  try {
    const m1 = await insertMemory(db, OWNER, { content: "m1 before" });
    const m2 = await insertMemory(db, OWNER, { content: "m2 before" });
    const post = await insertPost(db, OWNER, { slug: "skip-post", content: "post before" });

    await updateMemory(db, BOT, m1, { content: "m1 the job wrote" });
    await updateMemory(db, BOT, m2, { content: "m2 the job wrote" });
    await updatePost(db, BOT, post, { content: "post the job wrote" });

    // The owner works on m1 afterwards: their edit must never be overwritten.
    await updateMemory(db, OWNER, m1, { content: "m1 the owner wrote afterwards" });

    const undo = await undoJob(db, { jobId: "card:7" }, OWNER);
    assert.deepEqual(
      undo.skipped,
      [{ itemType: "memory", itemId: String(m1), reason: UNDO_REASONS.EDITED_AFTER }],
      "exactly the item edited after the job is skipped",
    );
    assert.deepEqual(
      undo.restored.map((r) => `${r.itemType}/${r.itemId}`).sort(),
      [`blog_post/${post}`, `memory/${m2}`].sort(),
      "undo is partial: it restores what nothing touched",
    );

    assert.equal((await memoryRow(db, m1)).content, "m1 the owner wrote afterwards", "the later edit stands");
    assert.equal((await memoryRow(db, m2)).content, "m2 before");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the Trash listing runs on the partial delete index (idx_item_versions_deletes)", async () => {
  const fx = fixture("hist-trash-index-");
  const db = fx.open();
  try {
    // The index migration 0024 adds: exactly the rows the listing groups (a delete is
    // the Trash entry), so the per-item "newest delete" is an index-only scan instead
    // of a full table walk every time the Trash page opens.
    const indexes = (await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'item_versions'",
      args: [],
    })).rows.map((row) => row.name);
    assert.ok(indexes.includes("idx_item_versions_deletes"), "the partial delete index is part of the migration");

    // And the statement the page runs is planned onto it — both with and without the
    // sweep's age filter (the index does not carry created_at, so the filter stays in
    // the outer query).
    for (const before of [null, new Date().toISOString()]) {
      const plan = (await db.execute({
        sql: `EXPLAIN QUERY PLAN ${trashEntriesSql({ before })}`,
        args: before ? [before, 5] : [5],
      })).rows.map((row) => row.detail).join(" | ");
      assert.match(plan, /idx_item_versions_deletes/, `the Trash listing uses the delete index (before=${before}): ${plan}`);
    }
  } finally {
    db.close();
    fx.dispose();
  }
});

test("undoing a job that CREATED an item sends it to the Trash, and a Trash restore brings it back", async () => {
  const fx = fixture("hist-trash-");
  const db = fx.open();
  try {
    const created = await insertMemory(db, BOT, { content: "a memory the job created" });
    assert.equal(await versionCount(db, "memory", created), 1);

    const undo = await undoJob(db, { jobId: "card:7" }, OWNER);
    assert.deepEqual(undo.skipped, []);
    assert.equal(undo.restored.length, 1);
    assert.equal(undo.restored[0].action, "deleted", "undoing a creation is a delete");
    assert.equal(await memoryRow(db, created), undefined, "the row is gone");

    // ... and it waited in the Trash instead of vanishing mid-undo.
    const trash = await listTrash(db);
    assert.deepEqual(
      trash.map((t) => `${t.itemType}/${t.itemId}`),
      [`memory/${created}`],
    );
    const entry = trash[0];
    assert.equal(entry.snapshot.content, "a memory the job created", "the Trash holds what was removed");
    assert.ok(entry.deletedAt, "a deletion has a time (the Trash period is counted from it)");
    assert.deepEqual(entry.deletedBy, { authorKind: "owner", authorId: OWNER.authorId });

    const back = await restoreFromTrash(db, { itemType: "memory", itemId: created }, OWNER);
    assert.ok(back.newVersionId, "a Trash restore is a new version");
    assert.equal((await memoryRow(db, created)).content, "a memory the job created");
    assert.deepEqual(await listTrash(db), [], "a restored item is not in the Trash by definition");

    // Nothing to restore a second time, and an unknown item is its own refusal.
    await assert.rejects(
      () => restoreFromTrash(db, { itemType: "memory", itemId: created }, OWNER),
      (err) => err.code === "not_in_trash",
    );
    await assert.rejects(
      () => restoreFromTrash(db, { itemType: "memory", itemId: 999999 }, OWNER),
      (err) => err.code === "not_found",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------------- redaction */

test("an AWS-shaped key in a memory is [redacted] in its versions after one sweep, but stays live in the memory itself", async () => {
  const fx = fixture("hist-redact-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: `deploy with ${AWS_KEY} please` });
    await updateMemory(db, OWNER, id, { content: `still here: ${AWS_KEY}` });

    const result = await sweep(db);
    assert.ok(result.redacted >= 2, `both versions matched (got ${result.redacted})`);

    const versions = await versionsOf(db, "memory", id);
    assert.equal(versions.length, 2);
    for (const v of versions) {
      assert.equal(Number(v.redacted), 1, "a rewritten version is marked as redacted");
      assert.doesNotMatch(v.snapshot_json, /AKIA/, "the key is gone from the version table");
      assert.match(v.snapshot_json, /\[redacted\]/, "and the placeholder says so");
    }

    // Live data is not History's business: the memory itself keeps its text.
    const live = await memoryRow(db, id);
    assert.equal(live.content, `still here: ${AWS_KEY}`);

    // A second sweep has nothing left to do (the rows are redacted = 1).
    const again = await sweep(db);
    assert.equal(again.redacted, 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the redaction scan remembers how far it got, so the newest rows are not re-scanned every 5 minutes", async () => {
  const fx = fixture("hist-redact-mark-");
  const db = fx.open();
  try {
    const readMark = async () => {
      const { rows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'history.redact_scanned_to'",
        args: [],
      });
      return rows[0] ? Number(rows[0].value) : null;
    };
    const maxVersionId = async () =>
      Number((await db.execute({ sql: "SELECT MAX(id) AS top FROM item_versions", args: [] })).rows[0].top);

    // A clean store: nothing to redact, but the pass still records the mark — the
    // point is that one pass scans each row once, not once per interval.
    const id = await insertMemory(db, OWNER, { content: "no secrets here" });
    await sweep(db);
    assert.equal(await readMark(), await maxVersionId(), "the mark is the highest version scanned");

    // A secret written AFTER the mark is the fresh window's job: caught by the next
    // pass, without walking the rows below again.
    await updateMemory(db, OWNER, id, { content: `a leaked key: ${AWS_KEY}` });
    const after = await maxVersionId();
    assert.ok(after > (await readMark()), "the new version sits above the mark");
    const swept = await sweep(db);
    assert.ok(swept.redacted >= 1, "the fresh window caught the new version");
    assert.equal(await readMark(), after, "and moved the mark up to it");
    const rows = await versionsOf(db, "memory", id);
    assert.ok(rows.every((row) => !/AKIA/.test(row.snapshot_json)), "no version holds the key now");

    // A row that matched nothing is never marked redacted, which is exactly why the
    // mark has to exist: without it those rows would be decoded again every pass.
    assert.equal(Number(rows[0].redacted), 0, "a clean version stays redacted = 0, so the mark is what stops the re-scan");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a key after a newline is redacted", async () => {
  const fx = fixture("hist-redact-newline-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: `deploy notes\n${AWS_KEY}\nend of notes` });
    const result = await sweep(db);
    assert.ok(result.redacted >= 1);

    const versions = await versionsOf(db, "memory", id);
    assert.doesNotMatch(versions[0].snapshot_json, /AKIA/, "the key after the escaped newline is gone");
    assert.equal(
      JSON.parse(versions[0].snapshot_json).content,
      "deploy notes\n[redacted]\nend of notes",
      "the decoded value is what was rewritten",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a PEM private key's body is redacted, not just its header", async () => {
  const fx = fixture("hist-redact-pem-");
  const db = fx.open();
  try {
    const pem = `${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}`;
    const id = await insertMemory(db, OWNER, { content: `the key was:\n${pem}\n(the end)` });
    const result = await sweep(db);
    assert.ok(result.redacted >= 1);

    const snapshot = (await versionsOf(db, "memory", id))[0].snapshot_json;
    assert.doesNotMatch(snapshot, /fakebodyfakebody|notarealkey/, "the body is gone, not just the header");
    assert.doesNotMatch(snapshot, /BEGIN RSA|END RSA/, "and the whole block, END included, is gone");
    assert.match(snapshot, /\[redacted\]/);
    assert.equal(
      JSON.parse(snapshot).content,
      "the key was:\n[redacted]\n(the end)",
      "only the block is replaced; the surrounding text survives",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a sweep redacts in bounded batches", async () => {
  const fx = fixture("hist-redact-batch-");
  const db = fx.open();
  try {
    // Ten versions, each carrying the secret, each written by a DIFFERENT author so
    // the coalescing pass cannot remove any of them (this test is about the bound).
    const id = await insertMemory(db, { authorKind: "bot", authorId: "bot-0", jobId: "card:0" }, {
      content: `first ${AWS_KEY}`,
    });
    for (let i = 1; i <= 9; i++) {
      await updateMemory(db, { authorKind: "bot", authorId: `bot-${i}`, jobId: `card:${i}` }, id, {
        content: `edit ${i} ${AWS_KEY}`,
      });
    }
    const total = await versionCount(db, "memory", id);
    assert.equal(total, 10);

    const first = await sweep(db, { batchSize: 2 });
    assert.ok(first.redacted > 0, "the pass redacts");
    assert.ok(
      first.redacted <= 4,
      `one run is bounded to a batch (backlog + newest page of 2): got ${first.redacted}`,
    );

    // Bounded per run, complete over runs: keep sweeping until nothing matches.
    let unredacted = total - Number(
      (await db.execute({
        sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory' AND item_id = ? AND redacted = 1",
        args: [String(id)],
      })).rows[0].n,
    );
    for (let run = 0; run < 20 && unredacted > 0; run++) {
      const r = await sweep(db, { batchSize: 2 });
      unredacted -= r.redacted;
    }
    assert.equal(unredacted, 0, "every version is eventually redacted");
    const rows = await versionsOf(db, "memory", id);
    for (const row of rows) assert.doesNotMatch(row.snapshot_json, /AKIA/);
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------------- coalescing */

test("three saves 30 s apart by the same author coalesce to one version", async () => {
  const fx = fixture("hist-coalesce-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "start" });
    const t0 = Date.now();
    await updateMemory(db, OWNER, id, { content: "save 1" });
    await updateMemory(db, OWNER, id, { content: "save 2" });
    await updateMemory(db, OWNER, id, { content: "save 3" });
    assert.equal(await versionCount(db, "memory", id), 4, "insert + three saves");

    // Space the three saves 30 s apart (the trigger's own clock is the write time;
    // the armed switch is the only way to move a stored version's clock, and this
    // is a test seeding timestamps, exactly as tests/history-api.test.js does).
    const versions = await versionsOf(db, "memory", id);
    const saves = versions.filter((v) => v.op === "update");
    await db.execute("BEGIN IMMEDIATE");
    await db.execute("UPDATE item_versions_erase SET armed = 1");
    for (const [i, save] of saves.entries()) {
      const at = new Date(t0 - (saves.length - i) * 30_000).toISOString();
      await db.execute({ sql: "UPDATE item_versions SET created_at = ? WHERE id = ?", args: [at, save.id] });
    }
    await db.execute("UPDATE item_versions_erase SET armed = 0");
    await db.execute("COMMIT");

    const result = await sweep(db);
    assert.equal(result.coalesced, 2, "two of the three saves go");

    const after = await versionsOf(db, "memory", id);
    assert.deepEqual(after.map((v) => v.op), ["insert", "update"], "the insert and the newest save remain");
    assert.equal(JSON.parse(after.at(-1).snapshot_json).content, "save 3");
    assert.equal((await memoryRow(db, id)).content, "save 3", "the live content is untouched");

    // Two saves further apart than the window are NOT one save.
    const other = await insertMemory(db, OWNER, { content: "far apart" });
    await updateMemory(db, OWNER, other, { content: "far save 1" });
    await updateMemory(db, OWNER, other, { content: "far save 2" });
    const farVersions = (await versionsOf(db, "memory", other)).filter((v) => v.op === "update");
    await db.execute("BEGIN IMMEDIATE");
    await db.execute("UPDATE item_versions_erase SET armed = 1");
    await db.execute({
      sql: "UPDATE item_versions SET created_at = ? WHERE id = ?",
      args: [new Date(Date.now() - 10 * COALESCE_WINDOW_MS).toISOString(), farVersions[0].id],
    });
    await db.execute("UPDATE item_versions_erase SET armed = 0");
    await db.execute("COMMIT");

    const second = await sweep(db);
    assert.equal(second.coalesced, 0, `${COALESCE_WINDOW_MS} ms apart is not one save`);
    assert.equal(await versionCount(db, "memory", other), 3);
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ----------------------------------------------------------------- erase */

test("an hour of saves 30 s apart keeps one version per two minutes", async () => {
  const fx = fixture("hist-coalesce-anchor-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "start" });
    const t0 = Date.now();
    const saves = [];
    for (let i = 0; i < 121; i++) {
      await updateMemory(db, OWNER, id, { content: `save ${i}` });
    }
    const versions = (await versionsOf(db, "memory", id)).filter((v) => v.op === "update");
    saves.push(...versions);

    // One 30 s cadence over an hour, seeded the same way the other coalescing
    // tests seed an age (moving a stored version's clock is a history edit).
    await db.batch([
      { sql: "UPDATE item_versions_erase SET armed = 1", args: [] },
      ...saves.map((save, i) => ({
        sql: "UPDATE item_versions SET created_at = ? WHERE id = ?",
        args: [new Date(t0 + i * 30_000).toISOString(), save.id],
      })),
      { sql: "UPDATE item_versions_erase SET armed = 0", args: [] },
    ]);

    const result = await sweep(db);
    const after = (await versionsOf(db, "memory", id)).filter((v) => v.op === "update");
    // Runs (anchored on their first save): [0..90]s keeps 90, [120..210] keeps
    // 210, ... plus the final save. That is 31 versions across the hour.
    assert.equal(after.length, 31, `expected one version per two minutes, got ${after.length}`);
    assert.equal(result.coalesced, 121 - 31);
    for (let i = 1; i < after.length; i++) {
      const gap = Date.parse(after[i].created_at) - Date.parse(after[i - 1].created_at);
      assert.ok(gap <= COALESCE_WINDOW_MS, `kept versions are at most two minutes apart (got ${gap} ms)`);
    }
    assert.equal((await memoryRow(db, id)).content, "save 120", "the live content is untouched");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore between listing and erasing keeps the item's history", async () => {
  const fx = fixture("hist-trash-restore-race-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "restore me, do not erase me" });
    await deleteMemory(db, OWNER, id);

    // The sweep would list this item as old enough...
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    const listed = await listTrash(db, { before: cutoff });
    assert.deepEqual(listed.map((e) => e.itemId), [String(id)]);

    // ...but a restore lands before its erase runs.
    await restoreFromTrash(db, { itemType: "memory", itemId: id }, OWNER);

    // The conditional DELETE sees a newer version (the restore), so it matches nothing.
    const result = await eraseItems(
      db,
      listed.map((e) => ({ itemType: e.itemType, itemId: e.itemId })),
      OWNER,
      { deletedBefore: cutoff },
    );
    assert.equal(result.versions, 0, "nothing was erased");
    assert.ok((await versionCount(db, "memory", id)) >= 3, "the delete and the restore are still history");
    assert.equal((await memoryRow(db, id)).content, "restore me, do not erase me");
    assert.deepEqual(await listTrash(db), [], "and it is not back in the Trash");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a Trash item older than 30 days has zero versions after the sweep", async () => {
  const fx = fixture("hist-trash-age-");
  const db = fx.open();
  try {
    const old = await insertMemory(db, OWNER, { content: "deleted long ago" });
    await deleteMemory(db, OWNER, old);
    const fresh = await insertMemory(db, OWNER, { content: "deleted just now" });
    await deleteMemory(db, OWNER, fresh);

    // Age the older item's DELETION by 40 days. The capture trigger's clock is the
    // write time, and moving a version's clock is a history edit, so this goes
    // through the armed switch exactly as a redaction does (a test seeding an age).
    const oldDelete = (await versionsOf(db, "memory", old)).find((v) => v.op === "delete");
    await db.execute("BEGIN IMMEDIATE");
    await db.execute("UPDATE item_versions_erase SET armed = 1");
    await db.execute({
      sql: "UPDATE item_versions SET created_at = ? WHERE id = ?",
      args: [new Date(Date.now() - 40 * 86_400_000).toISOString(), oldDelete.id],
    });
    await db.execute("UPDATE item_versions_erase SET armed = 0");
    await db.execute("COMMIT");

    const result = await sweep(db, { trashDays: 30, retention: "forever" });
    assert.deepEqual(result.erased.map((e) => e.itemId), [String(old)]);
    assert.equal(await versionCount(db, "memory", old), 0, "every version of the aged item is gone");
    assert.equal(await versionCount(db, "memory", fresh), 2, "the newer Trash item is untouched (insert + delete)");
    assert.deepEqual(
      (await listTrash(db)).map((t) => t.itemId),
      [String(fresh)],
      "and it is still in the Trash",
    );
    assert.deepEqual(result.retention, { value: "forever", applied: true });
    assert.equal(await armed(db), 0, "the erase switch is shut again");

    // Nothing left to erase on a second run: erasing is idempotent by definition.
    const again = await sweep(db, { trashDays: 30 });
    assert.deepEqual(again.erased, []);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("retention accepts only forever: any other value is reported and changes nothing", async () => {
  const fx = fixture("hist-retention-");
  const db = fx.open();
  try {
    // A different author per save, so the coalescing pass cannot remove any of them:
    // this test is about retention, and one rule at a time.
    const id = await insertMemory(db, OWNER, { content: "kept" });
    for (let i = 0; i < 3; i++) {
      await updateMemory(db, { authorKind: "bot", authorId: `bot-${i}`, jobId: `card:${i}` }, id, {
        content: `kept ${i}`,
      });
    }
    const before = await versionCount(db, "memory", id);
    assert.equal(before, 4);

    const result = await sweep(db, { retention: "365" });
    assert.deepEqual(result.retention, { value: "365", applied: false }, "a thinning value is not applied yet");
    assert.equal(await versionCount(db, "memory", id), before, "no version was thrown away");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("emptyTrash refuses a non-owner ctx", async () => {
  const fx = fixture("hist-empty-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "to be erased early" });
    await deleteMemory(db, OWNER, id);

    for (const ctx of [BOT, SYSTEM, null, undefined, { authorKind: "peer", authorId: "inst-a" }, { authorKind: "unattributed" }]) {
      await assert.rejects(
        () => emptyTrash(db, {}, ctx),
        (err) => {
          assert.equal(err.code, "not_owner", `${JSON.stringify(ctx)} must not empty the Trash`);
          return true;
        },
      );
    }
    assert.ok((await versionCount(db, "memory", id)) > 0, "nothing was erased");

    const result = await emptyTrash(db, {}, OWNER);
    assert.equal(result.count, 1);
    assert.equal(await versionCount(db, "memory", id), 0, "the owner empties it");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("erasing is owner/system only, and erases through the armed path", async () => {
  const fx = fixture("hist-erase-actor-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "erase me" });
    const items = [{ itemType: "memory", itemId: id }];

    for (const ctx of [BOT, { authorKind: "peer", authorId: "inst-a" }, null, {}, { authorKind: "unattributed" }]) {
      await assert.rejects(
        () => eraseItems(db, items, ctx),
        (err) => err.code === "forbidden",
        `${JSON.stringify(ctx)} must not erase history`,
      );
    }
    assert.ok((await versionCount(db, "memory", id)) > 0);
    assert.equal(await armed(db), 0, "a refused erase never armed anything");

    const result = await eraseItems(db, items, SYSTEM);
    assert.equal(result.versions, 1);
    assert.equal(await versionCount(db, "memory", id), 0);
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("an erase leaves the guard disarmed even when it fails", async () => {
  const fx = fixture("hist-erase-fail-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "stay" });

    // A store that fails the DELETE itself: the failure happens AFTER the switch is
    // armed, which is exactly the case that must not leave history rewritable.
    const failing = {
      execute: async (arg) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        if (/^\s*DELETE\s+FROM\s+item_versions/i.test(sql)) throw new Error("simulated store failure");
        return db.execute(arg);
      },
    };

    await assert.rejects(
      () => eraseItems(failing, [{ itemType: "memory", itemId: id }], OWNER),
      /simulated store failure/,
    );

    assert.equal(await armed(db), 0, "the switch is shut after the failure");
    assert.ok((await versionCount(db, "memory", id)) > 0, "the versions survived the rolled-back erase");
    await assert.rejects(
      () => db.execute({ sql: "DELETE FROM item_versions", args: [] }),
      /version history is append-only/,
      "and history is append-only again",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore of an erased item is refused", async () => {
  const fx = fixture("hist-erased-restore-");
  const db = fx.open();
  try {
    const id = await insertMemory(db, OWNER, { content: "forget me for good" });
    await deleteMemory(db, OWNER, id);
    const erased = await eraseItems(db, [{ itemType: "memory", itemId: id }], SYSTEM);
    assert.equal(erased.versions, 2, "insert + delete went");
    assert.equal(await isErased(db, "memory", String(id)), true, "the erase left a tombstone");

    // The Trash restore: an erased item is not restorable, and the answer is
    // 'erased', not 'not_found' (the item did exist; it was deliberately forgotten).
    await assert.rejects(
      () => restoreFromTrash(db, { itemType: "memory", itemId: id }, OWNER),
      (err) => err.code === "erased",
    );
    assert.equal(await memoryRow(db, id), undefined, "nothing came back");

    // A version that outlived the erase (a stale reader, a foreign writer) is not a
    // loophole either — but the refusal is VERSIONED now: it applies to a version
    // created at or before the tombstone's erased_at, i.e. to the erased item's
    // OWN values. This version is stamped before the erase, so restoring it would
    // be the resurrection the tombstone forbids.
    const erasedAt = (await db.execute({
      sql: "SELECT erased_at FROM item_erasures WHERE item_type = 'memory' AND item_id = ?",
      args: [String(id)],
    })).rows[0].erased_at;
    const stale = await db.execute({
      sql: "INSERT INTO item_versions (item_type, item_id, op, snapshot_json, created_at) VALUES ('memory', ?, 'insert', ?, ?)",
      args: [String(id), JSON.stringify({ content: "forget me for good" }), new Date(Date.parse(erasedAt) - 60_000).toISOString()],
    });
    await assert.rejects(
      () => restoreVersion(db, { versionId: Number(stale.lastInsertRowid) }, OWNER),
      (err) => err.code === "erased",
    );
    assert.equal(await memoryRow(db, id), undefined, "still nothing came back");

    // A version written AFTER the erase is a new life of that id — the operator's
    // "a genuinely new item that reuses a name/id later is accepted" — and the
    // tombstone has nothing to say about it. (Its timestamp is explicit so the
    // assertion does not depend on the test running slower than the erase.)
    const fresh = await db.execute({
      sql: "INSERT INTO item_versions (item_type, item_id, op, snapshot_json, created_at) VALUES ('memory', ?, 'insert', ?, ?)",
      args: [
        String(id),
        JSON.stringify({ content: "a new memory that reuses the id" }),
        new Date(Date.parse(erasedAt) + 60_000).toISOString(),
      ],
    });
    const back = await restoreVersion(db, { versionId: Number(fresh.lastInsertRowid) }, OWNER);
    assert.equal(back.unchanged, false, "the post-erase version restored");
    assert.equal((await memoryRow(db, id)).content, "a new memory that reuses the id");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a tombstone survives a restart", async () => {
  const fx = fixture("hist-tomb-restart-");
  const first = fx.open();
  let id;
  try {
    id = await insertMemory(first, OWNER, { content: "gone after the restart too" });
    await deleteMemory(first, OWNER, id);
    await eraseItems(first, [{ itemType: "memory", itemId: id }], SYSTEM);
  } finally {
    first.close();
  }

  // A new process, a new client, the same store.
  const db = fx.open();
  try {
    assert.equal(await isErased(db, "memory", String(id)), true, "the tombstone is on disk, not in memory");
    assert.deepEqual(await listVersions(db, { itemType: "memory", itemId: id }), [], "and no versions came back with it");
    await assert.rejects(
      () => restoreFromTrash(db, { itemType: "memory", itemId: id }, OWNER),
      (err) => err.code === "erased",
      "still refused after the restart",
    );

    // Erasing again is idempotent: nothing to take, no second tombstone, no error.
    const again = await eraseItems(db, [{ itemType: "memory", itemId: id }], SYSTEM);
    assert.equal(again.versions, 0);
    const tombs = (await db.execute({
      sql: "SELECT item_type, item_id, erased_by FROM item_erasures WHERE item_type = 'memory' AND item_id = ?",
      args: [String(id)],
    })).rows;
    assert.equal(tombs.length, 1, "one tombstone, unchanged by the repeat");
    assert.equal(tombs[0].erased_by, "system:test-scheduler", "and it still names who erased it");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("an unannounced erase of an item that syncs is unbounded; a local-only item keeps its counter bound", async () => {
  const fx = fixture("hist-tomb-bound-");
  const db = fx.open();
  try {
    const tombstone = async (itemId) =>
      (await db.execute({
        sql: `SELECT erased_at, erase_lamport FROM item_erasures WHERE item_type = 'memory' AND item_id = ?`,
        args: [String(itemId)],
      })).rows[0];

    // The counter instance-sync mints from (no instance-id file in this scratch
    // store, so the greatest sync_state row is the series this host has reached).
    await db.execute("INSERT INTO sync_state (instance_id, local_counter) VALUES ('inst-bound', 5)");

    // 1. AN ITEM THAT SYNCS, ERASED WITHOUT AN ANNOUNCEMENT (emission off here). The
    // operator's ruling of 2026-11-10: the peers were told nothing, so the tombstone
    // refuses EVERY later write for that id — "erased stays erased" — which is the
    // unbounded shape (erase_lamport NULL).
    const id = await insertMemory(db, OWNER, { content: "the first life of this id" });
    await deleteMemory(db, OWNER, id);
    const first = await eraseItems(db, [{ itemType: "memory", itemId: id }], SYSTEM, { syncManager: null });
    assert.equal(first.emitted, 0, "nothing was announced (no sync manager, emission off)");
    assert.equal(first.eraseLamport, null, "nothing to report as an event lamport");
    const one = await tombstone(id);
    assert.equal(one.erase_lamport, null, "the tombstone is unbounded — no peer was ever told about the erase");

    // ... and NULL is sticky: a later, higher counter never bounds it again. The
    // erase sync being off when it mattered is not undone by turning it on later
    // (nothing is re-emitted retroactively).
    await db.execute("UPDATE sync_state SET local_counter = 42 WHERE instance_id = 'inst-bound'");
    await insertMemory(db, OWNER, { id, content: "another life of this id" });
    await eraseItems(db, [{ itemType: "memory", itemId: id }], SYSTEM, { syncManager: null });
    assert.equal((await tombstone(id)).erase_lamport, null, "a re-erase never bounds an unbounded tombstone");

    // 2. AN ITEM THAT NEVER SYNCS (a starter memory) may stay counter-bounded: there
    // is no peer write to refuse, so the tight bound costs nothing — and a re-erase
    // moves it FORWARD (a re-erase never lowers what this store already refuses
    // below), with the newest erased_at as the restore gate's window.
    const starter = await insertMemory(db, OWNER, { content: "a starter demo", source: "starter" });
    await deleteMemory(db, OWNER, starter);
    await eraseItems(db, [{ itemType: "memory", itemId: starter }], SYSTEM, { syncManager: null });
    const bounded = await tombstone(starter);
    assert.equal(Number(bounded.erase_lamport), 42, "a never-synced item's tombstone keeps this instance's counter");

    await db.execute("UPDATE sync_state SET local_counter = 77 WHERE instance_id = 'inst-bound'");
    await insertMemory(db, OWNER, { id: starter, content: "the second life of this id", source: "starter" });
    await deleteMemory(db, OWNER, starter);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await eraseItems(db, [{ itemType: "memory", itemId: starter }], SYSTEM, { syncManager: null });
    const two = await tombstone(starter);
    assert.equal(Number(two.erase_lamport), 77, "the bound moved forward to the newer erase's counter");
    assert.ok(String(two.erased_at) >= String(bounded.erased_at), "and erased_at is the newer erase's");
    assert.equal(
      Number((await db.execute({
        sql: "SELECT COUNT(*) AS n FROM item_erasures WHERE item_type = 'memory' AND item_id = ?",
        args: [String(starter)],
      })).rows[0].n),
      1,
      "still one tombstone for the item, not a second row",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------ the operator's ruling: permanent deletes */

test("deleting a learner erases their memories' history at once (Maker Lab's right to be forgotten)", async () => {
  const fx = fixture("hist-learner-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type) VALUES ('learner-1', 'Kid', 'learner_profile')",
      args: [],
    })).lastInsertRowid);
    const other = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name) VALUES ('other-project', 'Other')",
      args: [],
    })).lastInsertRowid);

    const childMemory = await insertMemory(db, OWNER, { content: "the child's progress", project_id: learner, source: "maker-lab" });
    await updateMemory(db, OWNER, childMemory, { content: "the child's progress, edited" });
    const keptMemory = await insertMemory(db, OWNER, { content: "another project's memory", project_id: other });
    assert.equal(await versionCount(db, "memory", childMemory), 2);
    assert.equal(await versionCount(db, "memory", keptMemory), 1);

    const client = new Client({ name: "history-jobs", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    const reply = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    const text = (reply.content || []).map((c) => c.text || "").join("\n");
    assert.match(text, /"deleted": true/, text);
    await client.close();

    assert.equal(await memoryRow(db, childMemory), undefined, "the learner's memories are deleted");
    assert.equal(
      await versionCount(db, "memory", childMemory),
      0,
      "and their history is erased AT ONCE, not after a Trash period",
    );
    assert.equal(await versionCount(db, "memory", keptMemory), 1, "another project's history is untouched");
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a learner with 1500 memories is erased completely", async () => {
  const fx = fixture("hist-learner-1500-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type) VALUES ('learner-big', 'Big', 'learner_profile')",
      args: [],
    })).lastInsertRowid);
    await db.batch(
      Array.from({ length: 1500 }, (_, i) => ({
        sql: "INSERT INTO memories (content, project_id, source) VALUES (?, ?, 'maker-lab')",
        args: [`progress ${i}`, learner],
      })),
    );
    const before = Number((await db.execute({
      sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory'",
      args: [],
    })).rows[0].n);
    assert.equal(before, 1500);

    const client = new Client({ name: "history-jobs-big", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    const reply = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    await client.close();
    const text = (reply.content || []).map((c) => c.text || "").join("\n");
    assert.equal(reply.isError, undefined, text);
    assert.match(text, /"deleted": true/, text);

    assert.equal(Number((await db.execute({
      sql: "SELECT COUNT(*) AS n FROM memories WHERE project_id = ?",
      args: [learner],
    })).rows[0].n), 0);
    assert.equal(Number((await db.execute({
      sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = 'memory'",
      args: [],
    })).rows[0].n), 0, "all 1500 memories' history is gone, not just the first 1000");
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a learner's memory already in the Trash is erased at once", async () => {
  const fx = fixture("hist-learner-trash-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type) VALUES ('learner-trash', 'Kid', 'learner_profile')",
      args: [],
    })).lastInsertRowid);
    const memory = await insertMemory(db, OWNER, { content: "already deleted", project_id: learner, source: "maker-lab" });
    await updateMemory(db, OWNER, memory, { content: "already deleted, edited" });
    await deleteMemory(db, OWNER, memory);
    assert.ok((await versionCount(db, "memory", memory)) >= 2, "it is in the Trash with its history");

    const client = new Client({ name: "history-jobs-trash", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    const reply = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    await client.close();
    const text = (reply.content || []).map((c) => c.text || "").join("\n");
    assert.equal(reply.isError, undefined, text);

    assert.equal(
      await versionCount(db, "memory", memory),
      0,
      "eraseByProject catches the memory the initial DELETE could not see because it was already gone",
    );
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a failed erase is reported, never \"deleted\"", async () => {
  const fx = fixture("hist-learner-fail-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type) VALUES ('learner-fail', 'Kid', 'learner_profile')",
      args: [],
    })).lastInsertRowid);
    const memory = await insertMemory(db, OWNER, { content: "cannot be erased", project_id: learner, source: "maker-lab" });

    // Arm the switch, but make that write fail: the erase door itself is broken.
    await db.execute(`CREATE TRIGGER test_block_history_erase
      BEFORE UPDATE ON item_versions_erase
      WHEN NEW.armed = 1
      BEGIN SELECT RAISE(ABORT, 'simulated history erase failure'); END`);

    const client = new Client({ name: "history-jobs-fail", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    const reply = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    await client.close();
    await db.execute("DROP TRIGGER test_block_history_erase");

    const text = (reply.content || []).map((c) => c.text || "").join("\n");
    assert.equal(reply.isError, true, text);
    assert.match(text, /could not be fully erased; nothing was reported as deleted/i, text);
    assert.doesNotMatch(text, /"deleted": true/, "never a success with history left behind");
    assert.ok((await versionCount(db, "memory", memory)) > 0, "the history really was left behind");
    assert.equal(await armed(db), 0, "the failed armed transaction rolled the switch back shut");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a learner delete whose erase failed is completed by a retry", async () => {
  const fx = fixture("hist-learner-retry-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type) VALUES ('learner-retry', 'Kid', 'learner_profile')",
      args: [],
    })).lastInsertRowid);
    const memory = await insertMemory(db, OWNER, { content: "still here after the failure", project_id: learner, source: "maker-lab" });

    // The erase door itself is broken: arming the switch aborts. The CASCADE is
    // untouched, so it commits — which is exactly the case a retry must finish.
    await db.execute(`CREATE TRIGGER test_block_history_erase
      BEFORE UPDATE ON item_versions_erase
      WHEN NEW.armed = 1
      BEGIN SELECT RAISE(ABORT, 'simulated history erase failure'); END`);

    const client = new Client({ name: "history-jobs-retry", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    const first = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    const firstText = (first.content || []).map((c) => c.text || "").join("\n");
    assert.equal(first.isError, true, firstText);

    // The cascade committed: the profile and the memory row are gone, the history is
    // not, and the marker is durable.
    assert.equal(await memoryRow(db, memory), undefined, "the cascade committed");
    assert.equal(Number((await db.execute({
      sql: "SELECT COUNT(*) AS n FROM project_spaces WHERE id = ?",
      args: [learner],
    })).rows[0].n), 0, "the profile row is already gone");
    assert.ok((await versionCount(db, "memory", memory)) > 0, "the history is what is left behind");
    const markers = (await db.execute({ sql: "SELECT * FROM pending_erasures", args: [] })).rows;
    assert.equal(markers.length, 1, "a durable pending-erase marker was left");
    assert.equal(Number(markers[0].learner_id), learner);
    assert.deepEqual(
      JSON.parse(markers[0].memory_ids_json),
      [String(memory)],
      "and it names the memories the cascade read before it deleted them",
    );

    await db.execute("DROP TRIGGER test_block_history_erase");

    // A retry with the SAME learner_id, even though the profile row is gone.
    const second = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    await client.close();
    const secondText = (second.content || []).map((c) => c.text || "").join("\n");
    assert.equal(second.isError, undefined, secondText);
    assert.match(secondText, /"deleted": true/, secondText);

    assert.equal(await versionCount(db, "memory", memory), 0, "the retry finished the erase");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM pending_erasures", args: [] })).rows[0].n), 0, "and cleared the marker");
    assert.equal(await isErased(db, "memory", String(memory)), true, "the erase left its tombstone");
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a retry after the project id was reused never touches the new project", async () => {
  const fx = fixture("hist-learner-reuse-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type, uuid) VALUES ('learner-reuse', 'Kid', 'learner_profile', 'uuid-old-kid')",
      args: [],
    })).lastInsertRowid);
    const memory = await insertMemory(db, OWNER, { content: "the first kid's record", project_id: learner, source: "maker-lab" });

    // The erase door is broken, so the cascade commits and the marker is left.
    await db.execute(`CREATE TRIGGER test_block_history_erase
      BEFORE UPDATE ON item_versions_erase
      WHEN NEW.armed = 1
      BEGIN SELECT RAISE(ABORT, 'simulated history erase failure'); END`);
    const client = new Client({ name: "history-jobs-reuse", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    const first = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    assert.equal(first.isError, true, "the failed erase is reported, never \"deleted\"");
    await db.execute("DROP TRIGGER test_block_history_erase");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM pending_erasures", args: [] })).rows[0].n), 1);

    // The id is REUSED: a different learner now holds it (with no uuid of its own,
    // so its items' project_ref is the bare id — the exact collision this guards
    // against), with their own sessions, memories, settings and a deleted section
    // sitting in their Trash.
    await db.execute({
      sql: "INSERT INTO project_spaces (id, slug, name, type) VALUES (?, 'learner-new', 'New Kid', 'learner_profile')",
      args: [learner],
    });
    const newMemory = await insertMemory(db, OWNER, { content: "the new kid's record", project_id: learner, source: "maker-lab" });
    const newSection = Number((await withWriteContext(OWNER, () => db.execute({
      sql: "INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES ('new-kid-note', 'Note', 'their own notes', ?)",
      args: [learner],
    }))).lastInsertRowid);
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM crow_context WHERE id = ?", args: [newSection] }));
    assert.equal(await versionCount(db, "context_section", newSection), 2, "the new learner's section is in THEIR Trash");
    await db.execute({
      sql: "INSERT INTO maker_sessions (token, learner_id, expires_at) VALUES ('reuse-session', ?, datetime('now','+1 hour'))",
      args: [learner],
    });
    await db.execute({
      sql: "INSERT INTO maker_learner_settings (learner_id, age) VALUES (?, 9)",
      args: [learner],
    });

    // A retry with the same learner_id: it must finish the RECORDED erase only.
    const second = await client.callTool({
      name: "maker_delete_learner",
      arguments: { learner_id: learner, confirm: "DELETE" },
    });
    await client.close();
    const text = (second.content || []).map((c) => c.text || "").join("\n");
    assert.equal(second.isError, undefined, text);
    assert.match(text, /"resumed": true/, text);
    // The id now belongs to a DIFFERENT learner: the tool must never claim it
    // deleted them. It says plainly what it did and what it did not.
    assert.match(text, /"deleted": false/, text);
    assert.match(text, /"name": null/, text);
    assert.match(text, /An earlier deletion was finished\. This learner was not deleted; call again to delete them\./, text);

    // The old learner's history is finished ...
    assert.equal(await versionCount(db, "memory", memory), 0, "the recorded erase finished");
    assert.equal(await isErased(db, "memory", String(memory)), true, "with its tombstone");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM pending_erasures", args: [] })).rows[0].n), 0);

    // ... and the new learner at that id is untouched, row for row.
    assert.equal(
      Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM project_spaces WHERE id = ?", args: [learner] })).rows[0].n),
      1,
      "the new learner's profile is still here",
    );
    assert.ok(await memoryRow(db, newMemory), "the new learner's memory is still here");
    assert.equal(
      await versionCount(db, "context_section", newSection),
      2,
      "and the deleted section in THEIR Trash keeps its history — the retry never ran the id-keyed cascade",
    );
    assert.equal(
      Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM maker_sessions WHERE learner_id = ?", args: [learner] })).rows[0].n),
      1,
      "and their sessions",
    );
    assert.equal(
      Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM maker_learner_settings WHERE learner_id = ?", args: [learner] })).rows[0].n),
      1,
      "and their settings",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("the sweep completes a pending learner erase", async () => {
  const fx = fixture("hist-learner-sweep-");
  const db = fx.open();
  try {
    const { initMakerLabTables } = await import("../bundles/maker-lab/server/init-tables.js");
    await initMakerLabTables(db);
    const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");
    const { sweepNow } = await import("../bundles/maker-lab/server/retention-sweep.js");

    const learner = Number((await db.execute({
      sql: "INSERT INTO project_spaces (slug, name, type) VALUES ('learner-sweep', 'Kid', 'learner_profile')",
      args: [],
    })).lastInsertRowid);
    const memory = await insertMemory(db, OWNER, { content: "swept away", project_id: learner, source: "maker-lab" });

    await db.execute(`CREATE TRIGGER test_block_history_erase
      BEFORE UPDATE ON item_versions_erase
      WHEN NEW.armed = 1
      BEGIN SELECT RAISE(ABORT, 'simulated history erase failure'); END`);
    const client = new Client({ name: "history-jobs-sweep", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createMakerLabServer(db, {}).connect(st);
    await client.connect(ct);
    await client.callTool({ name: "maker_delete_learner", arguments: { learner_id: learner, confirm: "DELETE" } });
    await client.close();
    await db.execute("DROP TRIGGER test_block_history_erase");
    assert.ok((await versionCount(db, "memory", memory)) > 0, "the erase failed, so the marker is still owed");

    // Nobody presses delete again: the 5-minute sweep finishes it.
    await sweepNow(db);

    assert.equal(await versionCount(db, "memory", memory), 0, "the sweep completed the erase");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM pending_erasures", args: [] })).rows[0].n), 0, "and cleared the marker");
    assert.equal(await armed(db), 0, "with the switch shut again");

    // Idempotent: a second tick has nothing to do.
    await sweepNow(db);
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM pending_erasures", args: [] })).rows[0].n), 0);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("purging a project erases the history of what it deleted but not of memories it only unfiled", async () => {
  const dataDir = join(ROOT, "purge-instance");
  const fx = fixture("hist-purge-", dataDir);
  const db = fx.open();
  const dir = mkdtempSync(join(tmpdir(), "hist-purge-tasks-"));
  try {
    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const L = await import("../servers/shared/project-lifecycle.js");

    const project = await createProjectSpace(db, { name: "Purge me" });
    const id = Number(project.id);

    const section = Number((await withWriteContext(OWNER, () => db.execute({
      sql: "INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES ('purge-note', 'Note', 'scoped body', ?)",
      args: [id],
    }))).lastInsertRowid);
    await withWriteContext(OWNER, () =>
      db.execute({ sql: "UPDATE crow_context SET content = 'scoped body, edited' WHERE id = ?", args: [section] }),
    );

    const memory = await insertMemory(db, OWNER, {
      content: "a filed memory the purge will only unfile",
      project_id: id,
      project_uuid: project.uuid,
    });
    assert.equal(await versionCount(db, "context_section", section), 2);
    assert.equal(await versionCount(db, "memory", memory), 1);

    const outcome = await L.deleteProject(db, id, {
      confirmName: "Purge me",
      dataDir,
      tasksDbPath: join(dir, "tasks.db"),
      storageDelete: async () => {},
      disconnectBackend: async () => true,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));

    assert.equal(
      await versionCount(db, "context_section", section),
      0,
      "the section the purge DELETED has no history left",
    );
    assert.equal(await versionCount(db, "memory", memory), 2, "the unfiled memory keeps its history...");
    const versions = await versionsOf(db, "memory", memory);
    assert.equal(versions[0].snapshot_json.includes("a filed memory"), true, "...including its project-scoped version");
    const row = await memoryRow(db, memory, "id, content, project_id, project_uuid");
    assert.equal(row.project_id, null, "the memory itself is unfiled, not deleted");
    assert.equal(row.project_uuid, null);
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    fx.dispose();
  }
});

test("a failed history erase is partial and the finish path re-runs it", async () => {
  const dataDir = join(ROOT, "purge-resume-instance");
  const fx = fixture("hist-purge-resume-", dataDir);
  const db = fx.open();
  const dir = mkdtempSync(join(tmpdir(), "hist-purge-resume-tasks-"));
  try {
    const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
    const L = await import("../servers/shared/project-lifecycle.js");

    const project = await createProjectSpace(db, { name: "Erase later" });
    const id = Number(project.id);
    const section = Number((await withWriteContext(OWNER, () => db.execute({
      sql: "INSERT INTO crow_context (section_key, section_title, content, project_id) VALUES ('erase-later', 'Note', 'scoped', ?)",
      args: [id],
    }))).lastInsertRowid);
    await withWriteContext(OWNER, () =>
      db.execute({ sql: "UPDATE crow_context SET content = 'scoped, edited' WHERE id = ?", args: [section] }),
    );
    assert.equal(await versionCount(db, "context_section", section), 2);

    const outcome = await L.deleteProject(db, id, {
      confirmName: "Erase later",
      dataDir,
      tasksDbPath: join(dir, "tasks.db"),
      storageDelete: async () => {},
      disconnectBackend: async () => true,
      // The delete succeeded but its history erase did not.
      _eraseHistory: async () => { throw new Error("simulated history erase failure"); },
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.ok(outcome.partial.includes("history-erase"), "the failed step is reported, not swallowed");
    assert.equal(
      await versionCount(db, "context_section", section),
      3,
      "the history is still there (insert + edit + the purge's delete)",
    );

    const resumed = await L.resumeProjectDelete(db, id, {
      dataDir,
      tasksDbPath: join(dir, "tasks.db"),
      storageDelete: async () => {},
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.partial, [], "the finish path re-ran the history erase");
    assert.equal(await versionCount(db, "context_section", section), 0);
    assert.equal(await armed(db), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    fx.dispose();
  }
});