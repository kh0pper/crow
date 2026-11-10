/**
 * Version history, Task 3: the History API — list, diff, restore.
 *
 * Every fixture is a real scripts/init-db.js crow.db in its own temp dir with the
 * additive 0024 migration applied (the production shape: FTS triggers, seeded
 * crow_context, the append-only guards), as in tests/history-capture.test.js and
 * tests/history-attribution.test.js. Writes go through the gateway's client
 * (servers/db.js) inside a write context, so the versions a restore produces are
 * stamped the way a real one is.
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
  DEFAULT_LIMIT,
  MAX_LIMIT,
  diffVersions,
  listVersions,
  restoreVersion,
} from "../servers/shared/history/api.js";

const REPO = new URL("..", import.meta.url).pathname;

/** The owner at their dashboard, and a verified bot working a board card. */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };
const BOT = { authorKind: "bot", authorId: "hank", jobId: "card:7" };

/** A fresh crow.db (init-db.js) in its own temp dir, with 0024 applied. */
function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  migrate({ dbPath, log: () => {} });
  return {
    dir,
    dbPath,
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** INSERT a memory as `ctx`; returns its id. */
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

/** UPDATE a memory as `ctx`. */
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

const memoryRow = async (db, id, columns = "id, content") =>
  (await db.execute({ sql: `SELECT ${columns} FROM memories WHERE id = ?`, args: [id] })).rows[0];

/* ------------------------------------------------------- restore */

test("three edits, then restoring version 1, gives the content of v1 and a 5th version stamped with ctx, and listVersions still returns all 5 (review focus 3)", async () => {
  const fx = fixture("hist-api-five-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "draft one" });
    for (const text of ["draft two", "draft three", "draft four"]) {
      await updateMemory(db, OWNER, id, { content: text, updated_at: "2030-01-01 00:00:00" });
    }

    const before = await listVersions(db, { itemType: "memory", itemId: id });
    assert.deepEqual(before.map((v) => v.op), ["update", "update", "update", "insert"]);
    assert.equal(before.length, 4);
    const v1 = before.at(-1);
    assert.equal(v1.snapshot.content, "draft one", "v1 is the first value");

    const res = await restoreVersion(db, { versionId: v1.id }, BOT);
    assert.equal(res.unchanged, false);
    assert.ok(res.newVersionId, "a restore is a write, so it has a version");

    assert.equal((await memoryRow(db, id)).content, "draft one", "the live row is v1's value again");

    // Review focus 3: restoring appends. Nothing that came after is deleted, and
    // the list still shows every one of the versions.
    const after = await listVersions(db, { itemType: "memory", itemId: id });
    assert.equal(after.length, 5, "all 5 versions are still there");
    assert.deepEqual(after.map((v) => v.op), ["update", "update", "update", "update", "insert"]);

    const fifth = after[0];
    assert.equal(fifth.id, Number(res.newVersionId), "the restore IS the new version");
    assert.equal(fifth.authorKind, "bot", "stamped with the restoring context");
    assert.equal(fifth.authorId, "hank");
    assert.equal(fifth.jobId, "card:7");
    assert.equal(fifth.originInstance, null);
    assert.equal(fifth.snapshot.content, "draft one");
    assert.match(fifth.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    assert.deepEqual(
      after.slice(1).map((v) => v.snapshot.content),
      ["draft four", "draft three", "draft two", "draft one"],
      "the versions written after v1 are untouched",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("restoring a delete version re-creates the row with its id", async () => {
  const fx = fixture("hist-api-undelete-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "draft one" });
    await updateMemory(db, OWNER, id, { content: "the last words" });
    await deleteMemory(db, OWNER, id);
    assert.equal(await memoryRow(db, id), undefined, "the row is gone");

    const versions = await listVersions(db, { itemType: "memory", itemId: id });
    assert.deepEqual(versions.map((v) => v.op), ["delete", "update", "insert"]);
    const deleted = versions[0];
    assert.equal(deleted.snapshot.content, "the last words");

    const res = await restoreVersion(db, { versionId: deleted.id }, OWNER);
    assert.equal(res.unchanged, false);

    const row = await memoryRow(db, id);
    assert.ok(row, "the row is back");
    assert.equal(Number(row.id), id, "with its own id, not a fresh one");
    assert.equal(row.content, "the last words", "holding the value the delete removed");

    const after = await listVersions(db, { itemType: "memory", itemId: id });
    assert.equal(after.length, 4, "the deletion and everything before it stay in the list");
    assert.equal(after[0].op, "insert", "the re-creation is an insert version");
    assert.equal(after[0].id, Number(res.newVersionId));
    assert.equal(after[0].authorKind, "owner");
    assert.equal(after[0].authorId, OWNER.authorId);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("an untracked column is untouched by a restore", async () => {
  const fx = fixture("hist-api-untracked-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "alpha" });
    // A counter and two timestamps: outside the snapshot, so outside history's
    // business. (A restore writes the SNAPSHOT — content and filing — never the
    // counters, clocks or orderings.)
    await db.execute({
      sql: `UPDATE memories
               SET content = 'beta', access_count = 9,
                   accessed_at = '2020-01-01T00:00:00Z', updated_at = '2020-01-01T00:00:00Z'
             WHERE id = ?`,
      args: [id],
    });

    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
    await restoreVersion(db, { versionId: v1.id }, BOT);

    const row = await memoryRow(db, id, "content, access_count, accessed_at, updated_at");
    assert.equal(row.content, "alpha", "the tracked content is back");
    assert.equal(row.access_count, 9, "a recall counter is not rewound");
    assert.equal(row.accessed_at, "2020-01-01T00:00:00Z", "nor is the last-access time");
    assert.equal(row.updated_at, "2020-01-01T00:00:00Z", "nor the row's own timestamp");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restored deleted memory returns to its project", async () => {
  const fx = fixture("hist-api-project-");
  const db = createDbClient(fx.dbPath);
  try {
    // Filed under a project by both ids: the portable uuid and the local id.
    const id = await insertMemory(db, OWNER, {
      content: "filed under the first project",
      project_id: 42,
      project_uuid: "proj-uuid-1",
      instance_id: "inst-placement",
    });
    await updateMemory(db, OWNER, id, { content: "an edited filed memory" });
    await deleteMemory(db, OWNER, id);

    const deleted = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    const res = await restoreVersion(db, { versionId: deleted.id }, OWNER);
    assert.ok(res.newVersionId);

    const row = await memoryRow(db, id, "content, project_id, project_uuid");
    assert.equal(row.content, "an edited filed memory");
    assert.equal(row.project_id, 42, "the filing is part of the value, so it comes back too");
    assert.equal(row.project_uuid, "proj-uuid-1");

    // And the version the restore wrote is scoped to that project, so the item is
    // findable by project again (Task 4's erase scope reads the same column).
    const { rows } = await db.execute({
      sql: `SELECT project_ref FROM item_versions
             WHERE item_type = 'memory' AND item_id = ? ORDER BY id DESC LIMIT 1`,
      args: [String(id)],
    });
    assert.equal(rows[0].project_ref, "proj-uuid-1");

    // A snapshotted column that is NOT tracked comes back too: the snapshot is
    // the row, not just the change list the trigger watches. memories.instance_id
    // is a placement pointer — it never triggers a version on its own, and a
    // restore still puts it back where the version had it.
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
    assert.equal(v1.snapshot.instance_id, "inst-placement");
    await db.execute({ sql: "UPDATE memories SET instance_id = 'inst-moved' WHERE id = ?", args: [id] });
    const second = await restoreVersion(db, { versionId: v1.id }, OWNER);
    assert.ok(second.newVersionId, "the content changed back, so this restore is a version");
    const again = await memoryRow(db, id, "content, instance_id, project_id");
    assert.equal(again.content, "filed under the first project");
    assert.equal(again.instance_id, "inst-placement", "an untracked but snapshotted column is restored");
    assert.equal(again.project_id, 42, "and the filing stays");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore of an identical version writes nothing", async () => {
  const fx = fixture("hist-api-noop-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "the only value", importance: 6 });
    // A read: the counters move, the content does not.
    await db.execute({ sql: "UPDATE memories SET access_count = access_count + 1 WHERE id = ?", args: [id] });
    const newest = (await listVersions(db, { itemType: "memory", itemId: id }))[0];

    const res = await restoreVersion(db, { versionId: newest.id }, BOT);
    assert.deepEqual(res, { newVersionId: null, unchanged: true }, "nothing to put back, so nothing is written");

    const versions = await listVersions(db, { itemType: "memory", itemId: id });
    assert.equal(versions.length, 1, "no fifth wheel version for a no-op");
    assert.equal((await memoryRow(db, id, "content, access_count")).access_count, 1, "the recall stands");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("restoring a deleted item whose id was reused is refused", async () => {
  const fx = fixture("hist-api-reused-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "first life" });
    await deleteMemory(db, OWNER, id);
    const deleted = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    assert.equal(deleted.op, "delete");

    // The id now belongs to a row created after the delete — a different item.
    await db.execute({ sql: "INSERT INTO memories (id, content) VALUES (?, ?)", args: [id, "a different memory"] });
    const before = (await listVersions(db, { itemType: "memory", itemId: id })).length;

    await assert.rejects(
      () => restoreVersion(db, { versionId: deleted.id }, OWNER),
      (err) => {
        assert.equal(err.code, "conflict", `expected a conflict, got ${err.code}: ${err.message}`);
        assert.match(err.message, /exists again/);
        return true;
      },
      "a delete version must not overwrite the row that took its id",
    );

    const row = await memoryRow(db, id);
    assert.equal(row.content, "a different memory", "the newer row is untouched");
    assert.equal(
      (await listVersions(db, { itemType: "memory", itemId: id })).length,
      before,
      "and nothing was written",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore without a write context is refused", async () => {
  const fx = fixture("hist-api-noctx-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "alpha" });
    await updateMemory(db, OWNER, id, { content: "beta" });
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);

    for (const ctx of [undefined, null, {}, { authorKind: "unattributed" }, { authorKind: "admin" }]) {
      await assert.rejects(
        () => restoreVersion(db, { versionId: v1.id }, ctx),
        (err) => {
          assert.equal(err.code, "invalid_context", `${JSON.stringify(ctx)} must not restore anything`);
          return true;
        },
      );
    }
    assert.equal((await memoryRow(db, id)).content, "beta", "nothing was written");
    assert.equal((await listVersions(db, { itemType: "memory", itemId: id })).length, 2, "and no version appeared");

    // The missing-version case is its own refusal, not a silent success.
    await assert.rejects(
      () => restoreVersion(db, { versionId: 999999 }, OWNER),
      (err) => err.code === "not_found",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore writes a hex blob back as bytes", async () => {
  const fx = fixture("hist-api-blob-");
  const db = createDbClient(fx.dbPath);
  try {
    // blog_posts.author is tracked and not in the FTS index, so it can hold a
    // blob. The capture trigger stores it as 'hex:<UPPERCASE HEX>'.
    const blob = Buffer.from([0x01, 0x02, 0xfe, 0xff]);
    const inserted = await withWriteContext(OWNER, () =>
      db.execute({
        sql: "INSERT INTO blog_posts (slug, title, content, author) VALUES (?, ?, ?, ?)",
        args: ["blob-post", "Blob post", "body text", blob],
      }),
    );
    const id = Number(inserted.lastInsertRowid);
    await withWriteContext(OWNER, () =>
      db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [id] }),
    );

    const deleted = (await listVersions(db, { itemType: "blog_post", itemId: id }))[0];
    assert.equal(deleted.op, "delete");
    assert.equal(deleted.snapshot.author, "hex:0102FEFF", "stored as reversible hex");

    const res = await restoreVersion(db, { versionId: deleted.id }, OWNER);
    assert.ok(res.newVersionId);
    const row = (
      await db.execute({ sql: "SELECT slug, title, content, author FROM blog_posts WHERE id = ?", args: [id] })
    ).rows[0];
    assert.equal(row.slug, "blob-post");
    assert.equal(row.content, "body text");
    assert.ok(Buffer.isBuffer(row.author), "a restored blob is bytes again, not the hex string");
    assert.equal(Buffer.compare(row.author, blob), 0, "the exact bytes");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore of a redacted version is refused", async () => {
  const fx = fixture("hist-api-redacted-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "trust me, there was a key in here" });
    await updateMemory(db, OWNER, id, { content: "edited since" });
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);

    // Task 4's shape: the redaction sweep rewrites a version's snapshot and sets
    // redacted = 1, which the append-only guard allows only while the erase switch
    // is armed. One transaction, arm → rewrite → disarm.
    await db.execute("BEGIN IMMEDIATE");
    await db.execute("UPDATE item_versions_erase SET armed = 1");
    await db.execute({
      sql: "UPDATE item_versions SET redacted = 1, snapshot_json = ? WHERE id = ?",
      args: [JSON.stringify({ content: "[redacted]", category: "general" }), v1.id],
    });
    await db.execute("UPDATE item_versions_erase SET armed = 0");
    await db.execute("COMMIT");

    const listed = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
    assert.equal(listed.redacted, true, "the list marks a redacted version as one");

    // Writing the placeholder back would destroy the live content and call it a
    // restore: refused, with a code the UI can explain.
    await assert.rejects(
      () => restoreVersion(db, { versionId: v1.id }, BOT),
      (err) => {
        assert.equal(err.code, "redacted");
        assert.match(err.message, /redacted/);
        return true;
      },
    );
    assert.equal((await memoryRow(db, id)).content, "edited since", "the live row is untouched");
    assert.equal((await listVersions(db, { itemType: "memory", itemId: id })).length, 2, "and no version was added");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------- listVersions */

test("listVersions paginates newest first", async () => {
  const fx = fixture("hist-api-list-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "edit 0" });
    for (let i = 1; i <= 9; i++) await updateMemory(db, OWNER, id, { content: `edit ${i}` });
    // A second item, whose versions must never appear in the first item's pages.
    const other = await insertMemory(db, OWNER, { content: "another item entirely" });

    const all = await listVersions(db, { itemType: "memory", itemId: id });
    assert.equal(all.length, 10);
    const descending = all.map((v) => v.id);
    assert.deepEqual(descending, [...descending].sort((a, b) => b - a), "newest first");
    assert.deepEqual(all.map((v) => v.snapshot.content), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => `edit ${i}`));
    assert.deepEqual(new Set(all.map((v) => v.itemId)), new Set([String(id)]), "one item only, never another's");
    assert.ok(!all.some((v) => v.itemId === String(other)), "the second item's versions are not in the first's list");

    const page1 = await listVersions(db, { itemType: "memory", itemId: id, limit: 4 });
    const page2 = await listVersions(db, { itemType: "memory", itemId: id, limit: 4, before: page1.at(-1).id });
    const page3 = await listVersions(db, { itemType: "memory", itemId: id, limit: 4, before: page2.at(-1).id });
    assert.deepEqual(page1.map((v) => v.id), descending.slice(0, 4));
    assert.deepEqual(page2.map((v) => v.id), descending.slice(4, 8));
    assert.deepEqual(page3.map((v) => v.id), descending.slice(8));
    assert.deepEqual([...page1, ...page2, ...page3].map((v) => v.id), descending, "no gap, no repeat");
    assert.deepEqual(
      await listVersions(db, { itemType: "memory", itemId: id, before: page3.at(-1).id }),
      [],
      "past the oldest version there is nothing",
    );

    // The cap is the cap: a caller cannot ask history for more than one page.
    const capItem = await insertMemory(db, OWNER, { content: "cap 0" });
    for (let i = 1; i <= MAX_LIMIT; i++) await updateMemory(db, BOT, capItem, { content: `cap ${i}` });
    const capped = await listVersions(db, { itemType: "memory", itemId: capItem, limit: 10_000 });
    assert.equal(capped.length, MAX_LIMIT, `a page is at most ${MAX_LIMIT} versions`);
    assert.equal(MAX_LIMIT, 500, "the ruling's cap");
    assert.equal(DEFAULT_LIMIT, 100, "and the default page size");

    // A bad cursor is a refusal, not a silently different page.
    await assert.rejects(
      () => listVersions(db, { itemType: "memory", itemId: id, before: "the-future" }),
      (err) => err.code === "invalid_request",
    );
    await assert.rejects(() => listVersions(db, { itemType: "nonsense", itemId: id }), (err) => err.code === "unsupported");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------- diffVersions */

test("diffVersions reports only the fields that changed", async () => {
  const fx = fixture("hist-api-diff-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, {
      content: "alpha\nbeta",
      tags: "one",
      importance: 5,
      context: "kept as it was",
    });
    await updateMemory(db, OWNER, id, { content: "alpha\ngamma", importance: 8 });

    const [newer, older] = await listVersions(db, { itemType: "memory", itemId: id });
    const diff = diffVersions(older, newer);

    // Only the two fields that moved, in the type's tracked order (content comes
    // before importance in COVERED.memory.tracked).
    assert.deepEqual(diff.map((d) => d.field), ["content", "importance"]);
    assert.ok(!diff.some((d) => d.field === "tags"), "an unchanged field is not in the diff");
    assert.ok(!diff.some((d) => d.field === "context"), "nor is an untouched one");

    const [content, importance] = diff;
    assert.equal(content.kind, "text", "text is a line diff");
    assert.equal(content.before, "alpha\nbeta");
    assert.equal(content.after, "alpha\ngamma");
    assert.deepEqual(content.lines, [
      { op: " ", text: "alpha" },
      { op: "-", text: "beta" },
      { op: "+", text: "gamma" },
    ]);
    assert.equal(content.added, 1);
    assert.equal(content.removed, 1);
    assert.equal(content.capped, false);

    assert.equal(importance.kind, "value", "a number is a before/after value, not a line edit");
    assert.deepEqual(
      { before: importance.before, after: importance.after },
      { before: 5, after: 8 },
    );

    // A diff of a version with itself is empty, and the diff is symmetric in
    // direction only (a → b and b → a name the same field).
    assert.deepEqual(diffVersions(newer, newer), []);
    assert.deepEqual(diffVersions(newer, older).map((d) => d.field), ["content", "importance"]);
    assert.equal(diffVersions(newer, older)[0].added, 1);
    assert.equal(diffVersions(newer, older)[0].removed, 1);
  } finally {
    db.close();
    fx.dispose();
  }
});