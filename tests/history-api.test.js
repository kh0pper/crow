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

/** INSERT a project_spaces row (the portable uuid is what a restore files by). */
const insertProject = (db, { id, uuid, slug, name = slug }) =>
  db.execute({
    sql: "INSERT INTO project_spaces (id, uuid, slug, name) VALUES (?, ?, ?, ?)",
    args: [id, uuid, slug, name],
  });

/** INSERT a crow_context section as `ctx`; returns its id. */
async function insertSection(db, ctx, fields = {}) {
  const row = { section_key: "history_test_section", section_title: "History test", content: "a section", ...fields };
  const columns = Object.keys(row);
  const { lastInsertRowid } = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO crow_context (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return Number(lastInsertRowid);
}

const updateSection = (db, ctx, id, fields) => {
  const columns = Object.keys(fields);
  return withWriteContext(ctx, () =>
    db.execute({
      sql: `UPDATE crow_context SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      args: [...columns.map((c) => fields[c]), id],
    }),
  );
};

const deleteSection = (db, ctx, id) =>
  withWriteContext(ctx, () => db.execute({ sql: "DELETE FROM crow_context WHERE id = ?", args: [id] }));

const sectionRow = async (db, id, columns = "id, section_key, content, device_id, project_id") =>
  (await db.execute({ sql: `SELECT ${columns} FROM crow_context WHERE id = ?`, args: [id] })).rows[0];

/** INSERT a blog post as `ctx`; returns its id (slug is UNIQUE). */
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

const postRow = async (db, id, columns = "id, slug, title, content") =>
  (await db.execute({ sql: `SELECT ${columns} FROM blog_posts WHERE id = ?`, args: [id] })).rows[0];

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
    // The project, as it exists HERE now: id 77. The memory was filed under id 42
    // (the id its project had when the version was written), so the restore has to
    // resolve the portable uuid to the current local id rather than replay 42.
    await insertProject(db, { id: 77, uuid: "proj-uuid-1", slug: "project-one" });
    const id = await insertMemory(db, OWNER, {
      content: "filed under the first project",
      project_id: 42,
      project_uuid: "proj-uuid-1",
      instance_id: "inst-placement",
    });
    await updateMemory(db, OWNER, id, { content: "an edited filed memory" });
    // The row is placed elsewhere now (an untracked column, so no version).
    await db.execute({ sql: "UPDATE memories SET instance_id = 'inst-moved' WHERE id = ?", args: [id] });

    // memories.instance_id is snapshotted but is NOT restored: it is a placement
    // pointer (which of the owner's machines wrote the row), so an old value must
    // not drag the memory back to a machine it has since moved off.
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
    assert.equal(v1.snapshot.instance_id, "inst-placement");
    const restored = await restoreVersion(db, { versionId: v1.id }, OWNER);
    assert.ok(restored.newVersionId, "the content changed back, so this restore is a version");
    assert.equal(restored.unfiled, false, "the project still exists (by uuid), so nothing was lost");

    const again = await memoryRow(db, id, "content, instance_id, project_id, project_uuid");
    assert.equal(again.content, "filed under the first project", "the content is back");
    assert.equal(again.instance_id, "inst-moved", "the placement stays what it is, never the snapshot's");
    assert.equal(again.project_id, 77, "the filing is part of the value: it comes back as TODAY's id");
    assert.equal(again.project_uuid, "proj-uuid-1");

    // A version differing ONLY in instance_id is therefore not a change to
    // restore: the placement is deliberately left out of the SET.
    await db.execute({ sql: "UPDATE memories SET instance_id = 'inst-elsewhere' WHERE id = ?", args: [id] });
    const placed = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    const onlyPlacement = await restoreVersion(db, { versionId: placed.id }, OWNER);
    assert.equal(onlyPlacement.unchanged, true, "instance_id alone is not a restore");
    assert.equal(onlyPlacement.newVersionId, null, "and it wrote no version");
    assert.equal(
      (await memoryRow(db, id, "instance_id")).instance_id,
      "inst-elsewhere",
      "the current placement is kept",
    );

    // A delete, then a Trash restore: the row comes back as itself with its filing,
    // and the version that restore wrote is scoped to the project again (Task 4's
    // erase scope reads the same column).
    await deleteMemory(db, OWNER, id);
    const deleted = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    assert.equal(deleted.op, "delete");
    const back = await restoreVersion(db, { versionId: deleted.id }, OWNER);
    assert.ok(back.newVersionId);

    const row = await memoryRow(db, id, "content, project_id, project_uuid");
    assert.equal(row.content, "filed under the first project");
    assert.equal(row.project_id, 77);
    assert.equal(row.project_uuid, "proj-uuid-1");

    const { rows } = await db.execute({
      sql: `SELECT project_ref FROM item_versions
             WHERE item_type = 'memory' AND item_id = ? ORDER BY id DESC LIMIT 1`,
      args: [String(id)],
    });
    assert.equal(rows[0].project_ref, "proj-uuid-1");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore never files an item into a different project that reused the id", async () => {
  const fx = fixture("hist-api-project-reuse-");
  const db = createDbClient(fx.dbPath);
  try {
    // The project the version names: local id 42, portable uuid "proj-uuid-old".
    await insertProject(db, { id: 42, uuid: "proj-uuid-old", slug: "old-project" });
    const id = await insertMemory(db, OWNER, {
      content: "a memory of the old project",
      project_id: 42,
      project_uuid: "proj-uuid-old",
    });
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id }))[0];

    // The old project is deleted and a DIFFERENT project takes the same id 42 — ids
    // are reused, which is why the local id alone is not a filing.
    await db.execute({ sql: "DELETE FROM project_spaces WHERE id = 42", args: [] });
    await insertProject(db, { id: 42, uuid: "proj-uuid-new", slug: "new-project" });

    const res = await restoreVersion(db, { versionId: v1.id }, OWNER);
    assert.equal(res.unfiled, true, "the project it named is gone, so it came back unfiled");
    assert.ok(res.newVersionId, "it still came back — unfiled, not refused");

    const row = await memoryRow(db, id, "content, project_id, project_uuid");
    assert.equal(row.content, "a memory of the old project", "the content is back");
    assert.equal(row.project_id, null, "and it was NOT filed into the stranger holding id 42");
    assert.equal(row.project_uuid, null);

    // The stranger gained nothing.
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM memories WHERE project_id = 42", args: [] });
    assert.equal(Number(rows[0].n), 0, "the project that reused the id has no memories");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restored context section never lands in a project that reused its old id", async () => {
  const fx = fixture("hist-api-section-reuse-");
  const db = createDbClient(fx.dbPath);
  try {
    // The project the section belongs to: local id 42, portable uuid
    // "proj-uuid-old". crow_context has no project_uuid column, so the uuid rides
    // in the SNAPSHOT (a derived field, covered.js) — that is what makes the
    // section's filing portable at all.
    await insertProject(db, { id: 42, uuid: "proj-uuid-old", slug: "old-project" });
    const section = await insertSection(db, OWNER, {
      section_key: "history_project_section",
      section_title: "History project section",
      content: "a section of the old project",
      project_id: 42,
    });
    const v1 = (await listVersions(db, { itemType: "context_section", itemId: section }))[0];
    assert.equal(v1.snapshot.project_uuid, "proj-uuid-old", "the snapshot names the project portably");
    assert.equal(v1.snapshot.project_id, 42, "beside the local id the row itself holds");
    await deleteSection(db, OWNER, section);

    // The old project is deleted and a DIFFERENT project takes id 42 — ids are
    // reused, which is why a section's local project id alone is not a filing.
    await db.execute({ sql: "DELETE FROM project_spaces WHERE id = 42", args: [] });
    await insertProject(db, { id: 42, uuid: "proj-uuid-new", slug: "new-project" });

    const deleted = (await listVersions(db, { itemType: "context_section", itemId: section }))[0];
    assert.equal(deleted.op, "delete");
    const res = await restoreVersion(db, { versionId: deleted.id }, OWNER);
    assert.equal(res.unfiled, true, "the project it named is gone, so it came back unfiled");
    assert.ok(res.newVersionId, "it still came back — unfiled, not refused");

    const row = await sectionRow(db, section, "id, section_key, content, project_id");
    assert.equal(row.content, "a section of the old project", "the content is back");
    assert.equal(row.project_id, null, "and it was NOT filed into the stranger holding id 42");

    const stranger = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM crow_context WHERE project_id = 42",
      args: [],
    });
    assert.equal(Number(stranger.rows[0].n), 0, "the project that reused the id gained nothing");

    // The version the restore wrote is scoped to nothing, not to the stranger.
    const newest = (await listVersions(db, { itemType: "context_section", itemId: section }))[0];
    assert.equal(newest.id, Number(res.newVersionId));
    const { rows } = await db.execute({
      sql: `SELECT project_ref FROM item_versions
             WHERE item_type = 'context_section' AND item_id = ? ORDER BY id DESC LIMIT 1`,
      args: [String(section)],
    });
    assert.equal(rows[0].project_ref, null, "an unfiled restore version has no project scope");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("an old context-section version with no portable id comes back unfiled", async () => {
  const fx = fixture("hist-api-section-oldsnapshot-");
  const db = createDbClient(fx.dbPath);
  try {
    // The project the section names is STILL THERE and its id still means what it
    // meant — and that is exactly why this case needs its own rule: a version
    // written before the snapshot carried project_uuid holds a bare per-instance
    // id, and nothing in the row says which project that id named. Trusting it is
    // how a section ends up in a stranger's project after a delete and a reuse.
    await insertProject(db, { id: 42, uuid: "proj-uuid-kept", slug: "kept-project" });
    const section = await insertSection(db, OWNER, {
      section_key: "history_old_shape_section",
      section_title: "Old shape",
      content: "the old shape's body",
      project_id: 42,
    });
    await deleteSection(db, OWNER, section);

    // An OLD row: the shape item_versions held before project_uuid was captured
    // (append-only, so a real store's old rows look exactly like this).
    const oldSnapshot = {
      section_key: "history_old_shape_section",
      section_title: "Old shape",
      content: "the old shape's body",
      enabled: 1,
      device_id: null,
      project_id: 42,
    };
    const inserted = await db.execute({
      sql: `INSERT INTO item_versions (item_type, item_id, op, snapshot_json, project_ref)
            VALUES ('context_section', ?, 'insert', ?, '42')`,
      args: [String(section), JSON.stringify(oldSnapshot)],
    });
    const oldVersionId = Number(inserted.lastInsertRowid);

    const res = await restoreVersion(db, { versionId: oldVersionId }, OWNER);
    assert.equal(res.unfiled, true, "a bare local id is not a filing: the section comes back unfiled");
    assert.ok(res.newVersionId);

    const row = await sectionRow(db, section, "id, content, project_id, device_id");
    assert.equal(row.content, "the old shape's body", "the content is back");
    assert.equal(row.project_id, null, "and the un-portable id was not trusted, even though it still resolves");
    assert.equal(row.device_id, null, "the rest of the snapshot is restored as it was");

    // A memory's old shape is NOT affected: its project_id-only versions are a
    // normal pre-uuid form, and the local id is kept while it still stands.
    const memory = await insertMemory(db, OWNER, { content: "a memory of that project", project_id: 42 });
    await deleteMemory(db, OWNER, memory);
    const memoryDelete = (await listVersions(db, { itemType: "memory", itemId: memory }))[0];
    const memoryRes = await restoreVersion(db, { versionId: memoryDelete.id }, OWNER);
    assert.equal(memoryRes.unfiled, false, "a memory keeps a local id it can still justify");
    assert.equal((await memoryRow(db, memory, "project_id")).project_id, 42);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a concurrent write on the same client cannot join a restore's transaction", async () => {
  const fx = fixture("hist-api-concurrent-");
  const db = createDbClient(fx.dbPath);
  try {
    // A restore that ends in a CONFLICT, and therefore ROLLS BACK: the id its
    // delete version names is live again, held by a different memory.
    const id = await insertMemory(db, OWNER, { content: "first life" });
    await deleteMemory(db, OWNER, id);
    const deleted = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    assert.equal(deleted.op, "delete");
    await db.execute({
      sql: "INSERT INTO memories (id, content) VALUES (?, ?)",
      args: [id, "a different memory"],
    });

    // The concurrent write is issued in the SAME tick as the restore, with the
    // restore's promise not yet awaited. A handle is ONE connection, so if the
    // restore's transaction were still open across an await this insert would be
    // executed INSIDE it — and the restore's rollback would take it with it.
    const restoring = restoreVersion(db, { versionId: deleted.id }, OWNER);
    const concurrent = db.execute({
      sql: "INSERT INTO memories (content) VALUES ('a concurrent write')",
      args: [],
    });

    const [restoreOutcome, writeOutcome] = await Promise.allSettled([restoring, concurrent]);
    assert.equal(restoreOutcome.status, "rejected", "the reused id still refuses the restore");
    assert.equal(restoreOutcome.reason.code, "conflict", `expected a conflict, got ${restoreOutcome.reason.code}`);
    assert.equal(writeOutcome.status, "fulfilled", "the concurrent write is its own statement, not part of the restore");

    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM memories WHERE content = 'a concurrent write'",
      args: [],
    });
    assert.equal(Number(rows[0].n), 1, "and it committed: the restore's rollback did not take it");
    assert.equal((await memoryRow(db, id)).content, "a different memory", "while the restore left its own row alone");

    // The same holds the other way round: a successful restore writes its OWN
    // version and nothing else, so the concurrent write's version is separate.
    const other = await insertMemory(db, OWNER, { content: "third life" });
    await updateMemory(db, OWNER, other, { content: "fourth life" });
    const otherV1 = (await listVersions(db, { itemType: "memory", itemId: other })).at(-1);
    const [ok, alsoConcurrent] = await Promise.allSettled([
      restoreVersion(db, { versionId: otherV1.id }, OWNER),
      db.execute({ sql: "INSERT INTO memories (content) VALUES ('another concurrent write')", args: [] }),
    ]);
    assert.equal(ok.status, "fulfilled");
    assert.equal(alsoConcurrent.status, "fulfilled");
    assert.equal((await memoryRow(db, other)).content, "third life", "the restore landed");
    const both = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM memories WHERE content = 'another concurrent write'",
      args: [],
    });
    assert.equal(Number(both.rows[0].n), 1, "and the concurrent write landed too, independently");
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
    assert.deepEqual(
      res,
      { newVersionId: null, unchanged: true, synced: false, unfiled: false },
      "nothing to put back, so nothing is written and nothing is emitted",
    );

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

test("a restore refuses when a delete version newer than the chosen one says the live row began a new life", async () => {
  const fx = fixture("hist-api-relife-");
  const db = createDbClient(fx.dbPath);
  try {
    const id = await insertMemory(db, OWNER, { content: "first life" });
    await updateMemory(db, OWNER, id, { content: "first life, edited" });
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
    assert.equal(v1.snapshot.content, "first life");

    await deleteMemory(db, OWNER, id);
    // The id is taken again by a DIFFERENT memory: its life began after the delete.
    await db.execute({ sql: "INSERT INTO memories (id, content) VALUES (?, ?)", args: [id, "a different memory"] });
    const before = (await listVersions(db, { itemType: "memory", itemId: id })).length;
    assert.equal(before, 4, "insert + update + delete + the new life's insert");

    await assert.rejects(
      () => restoreVersion(db, { versionId: v1.id }, OWNER),
      (err) => {
        assert.equal(err.code, "conflict", `expected a conflict, got ${err.code}: ${err.message}`);
        assert.match(err.message, /new life/);
        return true;
      },
      "a version from before the deletion must not be written over the row that replaced it",
    );

    assert.equal((await memoryRow(db, id)).content, "a different memory", "the newer row is untouched");
    assert.equal(
      (await listVersions(db, { itemType: "memory", itemId: id })).length,
      before,
      "and no version was written",
    );
  } finally {
    db.close();
    fx.dispose();
  }
});

test('a memory whose text is "hex:DEADBEEF" restores as text', async () => {
  const fx = fixture("hist-api-hextext-");
  const db = createDbClient(fx.dbPath);
  try {
    // Text that LOOKS like a stored blob: without the 'txt:' escape it would come
    // back as the bytes 0xDE 0xAD 0xBE 0xEF and quietly corrupt the memory.
    const id = await insertMemory(db, OWNER, { content: "hex:DEADBEEF" });
    await updateMemory(db, OWNER, id, { content: "edited since" });
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
    assert.equal(v1.snapshot.content, "txt:hex:DEADBEEF", "ambiguous text is stored with the txt: escape");

    const res = await restoreVersion(db, { versionId: v1.id }, BOT);
    assert.ok(res.newVersionId);
    assert.equal(res.synced, false, "no sync manager here: the write happens, nothing is emitted");

    const row = await memoryRow(db, id, "content, typeof(content) AS kind");
    assert.equal(row.content, "hex:DEADBEEF", "the text is back, character for character");
    assert.equal(row.kind, "text", "and it is TEXT, not the blob the string resembles");

    // The restore's own version is escaped the same way, so it can be restored again.
    const newest = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    assert.equal(newest.snapshot.content, "txt:hex:DEADBEEF");
    const third = await restoreVersion(db, { versionId: newest.id }, BOT);
    assert.equal(third.unchanged, true, "a text that starts with hex: round-trips exactly");

    // Text that does not look like a blob is stored verbatim (no prefix at all).
    const plain = await insertMemory(db, OWNER, { content: "DEADBEEF" });
    const plainVersion = (await listVersions(db, { itemType: "memory", itemId: plain }))[0];
    assert.equal(plainVersion.snapshot.content, "DEADBEEF", "ordinary text is not escaped");
  } finally {
    db.close();
    fx.dispose();
  }
});

test('text that starts with "txt:" or "hex:" round-trips exactly', async () => {
  const fx = fixture("hist-api-textmarkers-");
  const db = createDbClient(fx.dbPath);
  try {
    // The escape must be SYMMETRIC: valueExpr adds one 'txt:' to any text value
    // that starts with either marker, and decodeValue strips exactly one. Every
    // case below would be corrupted by an escape that only knew about 'hex:' (a
    // plain "txt:hello" would come back as "hello") or that stripped twice.
    const cases = [
      ["hex:DEADBEEF", "txt:hex:DEADBEEF"],
      ["txt:hello", "txt:txt:hello"],
      ["txt:", "txt:txt:"],
      ["txt:hex:0102", "txt:txt:hex:0102"],
      ["ordinary text", "ordinary text"],
      ["atxt:not-a-prefix", "atxt:not-a-prefix"],
    ];
    for (const [value, stored] of cases) {
      const id = await insertMemory(db, OWNER, { content: value });
      await updateMemory(db, OWNER, id, { content: "edited since" });
      const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);
      assert.equal(v1.snapshot.content, stored, `${JSON.stringify(value)} is stored escaped exactly one level`);

      const res = await restoreVersion(db, { versionId: v1.id }, BOT);
      assert.ok(res.newVersionId, `${JSON.stringify(value)}: the restore wrote a version`);
      const row = await memoryRow(db, id, "content, typeof(content) AS kind");
      assert.equal(row.content, value, `${JSON.stringify(value)} comes back character for character`);
      assert.equal(row.kind, "text", `${JSON.stringify(value)} is TEXT, never the blob a marker resembles`);

      // The restore's own version is escaped the same way, so restoring it again
      // is a no-op: the stored form decodes to exactly the live value.
      const newest = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
      assert.equal(newest.snapshot.content, stored, "the restore's version is escaped once, not twice");
      assert.equal(
        (await restoreVersion(db, { versionId: newest.id }, BOT)).unchanged,
        true,
        `${JSON.stringify(value)} round-trips exactly`,
      );
    }
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a restore emits the wire row an ordinary write would", async () => {
  const fx = fixture("hist-api-emit-");
  const db = createDbClient(fx.dbPath);
  // A stand-in for the process's InstanceSyncManager: the emit path only needs
  // `feedsDisabled` and `emitChange`, and recording the call proves what would
  // have gone on the wire.
  const calls = [];
  const syncManager = {
    feedsDisabled: false,
    emitChange: async (table, op, row) => {
      calls.push({ table, op, row });
      return 7;
    },
  };
  try {
    const id = await insertMemory(db, OWNER, { content: "alpha", tags: "one" });
    await updateMemory(db, OWNER, id, { content: "beta" });
    const v1 = (await listVersions(db, { itemType: "memory", itemId: id })).at(-1);

    const res = await restoreVersion(db, { versionId: v1.id, syncManager }, OWNER);
    assert.equal(res.synced, true, "a live manager gets the row");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].table, "memories");
    assert.equal(calls[0].op, "update", "restoring a live row is an update");
    assert.equal(calls[0].row.id, id);
    assert.equal(calls[0].row.content, "alpha");
    assert.equal(calls[0].row.tags, "one", "the whole snapshotted row rides, not just the content");

    // An un-delete is an INSERT: on a peer the row is new again.
    await deleteMemory(db, OWNER, id);
    const deleted = (await listVersions(db, { itemType: "memory", itemId: id }))[0];
    assert.equal(deleted.op, "delete");
    const back = await restoreVersion(db, { versionId: deleted.id, syncManager }, OWNER);
    assert.equal(back.synced, true);
    assert.equal(calls[1].op, "insert", "an un-delete is emitted as an insert");
    assert.equal(calls[1].row.content, "alpha");

    // A context section goes out in the wire shape servers/memory/server.js uses:
    // the allowlisted columns, sort_order included (it is not part of the
    // snapshot), and the project's uuid rather than its local id.
    const section = await insertSection(db, OWNER, {
      section_key: "history_emit_section",
      content: "the section's first body",
      device_id: "phone",
    });
    await updateSection(db, OWNER, section, { content: "the section's second body" });
    const sectionV1 = (await listVersions(db, { itemType: "context_section", itemId: section })).at(-1);
    const sectionRes = await restoreVersion(db, { versionId: sectionV1.id, syncManager }, OWNER);
    assert.equal(sectionRes.synced, true);
    const call = calls[2];
    assert.equal(call.table, "crow_context");
    assert.equal(call.op, "update");
    assert.equal(call.row.section_key, "history_emit_section");
    assert.equal(call.row.content, "the section's first body");
    assert.equal(call.row.device_id, "phone");
    assert.equal(call.row.enabled, 1);
    assert.equal(typeof call.row.sort_order, "number", "sort_order is on the wire, though not in the snapshot");
    assert.equal(call.row.project_uuid, null);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("restoring a deleted blog post whose slug was taken is refused", async () => {
  const fx = fixture("hist-api-slug-");
  const db = createDbClient(fx.dbPath);
  try {
    const first = await insertPost(db, OWNER, { slug: "taken-slug", title: "First", content: "one" });
    await withWriteContext(OWNER, () => db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [first] }));
    const deleted = (await listVersions(db, { itemType: "blog_post", itemId: first }))[0];
    assert.equal(deleted.op, "delete");
    assert.equal(deleted.snapshot.slug, "taken-slug");

    // Another post took the slug while the first one was in the Trash.
    const second = await insertPost(db, OWNER, { slug: "taken-slug", title: "Second", content: "two" });
    assert.equal(await postRow(db, first), undefined);

    await assert.rejects(
      () => restoreVersion(db, { versionId: deleted.id }, OWNER),
      (err) => {
        assert.equal(err.code, "conflict", `expected a conflict, got ${err.code}: ${err.message}`);
        return true;
      },
      "blog_posts.slug is UNIQUE: the removed post cannot come back beside the one that took its slug",
    );

    const survivor = await postRow(db, second, "id, slug, title, content");
    assert.equal(survivor.title, "Second", "the post holding the slug is untouched");
    assert.equal(await postRow(db, first), undefined, "and the removed one did not come back");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a context section restores, and its partial unique indexes decide a taken key", async () => {
  const fx = fixture("hist-api-section-");
  const db = createDbClient(fx.dbPath);
  try {
    // A DEVICE-scoped section: covered by idx_crow_context_device
    // (section_key, device_id) WHERE device_id IS NOT NULL AND project_id IS NULL.
    const phone = await insertSection(db, OWNER, {
      section_key: "history_test_section",
      content: "the first version",
      device_id: "phone",
    });
    await updateSection(db, OWNER, phone, { content: "the second version" });
    await deleteSection(db, OWNER, phone);
    const deleteVersion = (await listVersions(db, { itemType: "context_section", itemId: phone }))[0];
    assert.equal(deleteVersion.op, "delete");

    // A GLOBAL section with the same key is a different scope, so the partial
    // index for globals does not stand in the restored section's way.
    const global = await insertSection(db, OWNER, { section_key: "history_test_section", content: "global body" });

    const back = await restoreVersion(db, { versionId: deleteVersion.id }, OWNER);
    assert.ok(back.newVersionId, "the deleted section came back as a new version");
    assert.equal(back.unfiled, false, "a device-scoped section has no project filing");
    const restored = await sectionRow(db, phone, "id, section_key, section_title, content, enabled, device_id, project_id");
    assert.equal(Number(restored.id), phone, "with its own id");
    assert.equal(restored.content, "the second version", "holding the value the delete removed");
    assert.equal(restored.device_id, "phone", "and its scope keys");
    assert.equal(restored.project_id, null);
    assert.equal(restored.enabled, 1, "and the enabled toggle the snapshot carried");
    assert.equal((await sectionRow(db, global)).content, "global body", "the global section is untouched");

    // Delete it again and let ANOTHER device-scoped section take the key: now the
    // (section_key, device_id) index is in the way, and the restore is a conflict.
    await deleteSection(db, OWNER, phone);
    const taken = await insertSection(db, OWNER, {
      section_key: "history_test_section",
      content: "someone else's section",
      device_id: "phone",
    });
    const secondDelete = (await listVersions(db, { itemType: "context_section", itemId: phone }))[0];
    assert.equal(secondDelete.op, "delete");

    await assert.rejects(
      () => restoreVersion(db, { versionId: secondDelete.id }, OWNER),
      (err) => {
        assert.equal(err.code, "conflict", `expected a conflict, got ${err.code}: ${err.message}`);
        return true;
      },
      "two sections cannot share (section_key, device_id)",
    );
    assert.equal(await sectionRow(db, phone), undefined, "the removed section did not come back");
    assert.equal((await sectionRow(db, taken)).content, "someone else's section", "the newer one is untouched");
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