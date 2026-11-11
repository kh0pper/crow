/**
 * Version history, Task 7: the rest of the covered content.
 *
 * Research notes, KB articles, bot definitions — and board cards, which live in
 * the instance-global tasks.db, a SEPARATE database whose own item_versions and
 * capture triggers migration 0025 installs (a SQLite trigger cannot write across
 * databases). Plus the two read-through stores: artifacts (their own
 * artifact_versions) and Studio songs (their own undo, listed by a job's undo and
 * never restored by History).
 *
 * Every fixture is a real crow.db from scripts/init-db.js in its own temp dir and
 * a real tasks.db brought to the production shape by the board migrations, then
 * 0024 and 0025 — the same rail a boot runs. Writes go through the gateway's
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
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { run as runTasksBase } from "../scripts/migrations/0000-tasks-base.mjs";
import { run as runBoardStages } from "../scripts/migrations/0001-board-stages.mjs";
import { run as runTrackerConvergence } from "../scripts/migrations/0003-tracker-convergence.mjs";
import { run as runCardModel } from "../scripts/migrations/0004-track1-card-model.mjs";
import { run as runItemVersions, id as MIGRATION_0024 } from "../scripts/migrations/0024-item-versions.mjs";
import {
  ITEM_TYPES,
  run as runMore,
  id as MIGRATION_0025,
} from "../scripts/migrations/0025-item-versions-more.mjs";
import {
  BOT_DEFINITION_KEYS,
  COVERED,
  SECRET_COLUMN,
  STORE_TASKS,
  triggerSql,
  typesForMigration,
  typesForStore,
} from "../servers/shared/history/covered.js";
import { ensureHistoryTriggers } from "../servers/shared/history/ensure.js";
import { withWriteContext } from "../servers/shared/history/write-context.js";
import {
  ARTIFACT_ITEM_TYPE,
  diffVersions,
  listVersions,
  restoreVersion,
} from "../servers/shared/history/api.js";
import { undoJob } from "../servers/shared/history/jobs.js";
import { sweep } from "../servers/shared/history/sweep.js";
import { initKbTables } from "../bundles/knowledge-base/server/init-tables.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createBlobStore } from "../bundles/artifacts/server/blob-store-minio.js";
import { createArtifact, addVersion } from "../bundles/artifacts/server/store.js";
import { SYNCED_TABLES } from "../servers/sharing/instance-sync.js";

const REPO = new URL("..", import.meta.url).pathname;

/** The owner at their dashboard, and a verified bot working a board card. */
const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };
const BOT = { authorKind: "bot", authorId: "hank", jobId: "card:9" };

/**
 * A fresh crow.db (init-db.js) plus a real tasks.db in the production shape, with
 * 0024 and 0025 applied: exactly what a boot leaves behind.
 */
async function fixture(prefix = "hist-coverage-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
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
  const book = new Database(dbPath);
  book.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of [MIGRATION_0024, MIGRATION_0025]) {
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

/** INSERT a row as `ctx`; returns its id (or key). */
async function insert(db, ctx, table, row) {
  const columns = Object.keys(row);
  const info = await withWriteContext(ctx, () =>
    db.execute({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }),
  );
  return info.lastInsertRowid;
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
      sql: "SELECT id, op, snapshot_json FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id",
      args: [itemType, String(itemId)],
    })
  ).rows;

const countVersions = async (db, itemType) =>
  Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM item_versions WHERE item_type = ?",
        args: [itemType],
      })
    ).rows[0].n,
  );

/** A bot definition whose CONTENT is ordinary and whose credentials are canaries. */
const CANARY = "CANARY-do-not-version";
/** An AWS-shaped key, written into a versioned TEXT field (the sweep's job). */
const AWS_SHAPED_CANARY = "AKIA" + "IOSFODNN7EXAMPLE";
function botDefinition({ prompt = "You are Hank.", token = `${CANARY}-discord` } = {}) {
  return {
    engine: "pi",
    models: { default: "prov:model-a" },
    system_prompt: prompt,
    tools: { pi_builtin: ["read"], crow_mcp: ["crow-tasks/tasks_list"] },
    skills: ["triage"],
    permission_policy: { bash: "deny", self_authoring: false },
    triggers: { gateway: true, cron: "" },
    gateways: [
      { type: "discord", token },
      { type: "slack", bot_token: `${CANARY}-slack-bot`, app_token: `${CANARY}-slack-app` },
      { type: "telegram", token: `${CANARY}-telegram` },
    ],
    // Keys the Bot Builder does not write today, and a new credential key nobody
    // knows about yet: the allow-list must drop them all, which is the whole
    // reason it is an allow-list.
    spawn_env: { OPENAI_API_KEY: `${CANARY}-env-key`, GITHUB_TOKEN: `${CANARY}-env-token` },
    api_token: `${CANARY}-unknown-key`,
    session_dir: "/workspace/bots/hank",
  };
}

/* ---------------------------------------------------------- the new types */

test("each new type is captured and restorable", async () => {
  const f = await fixture();
  try {
    // A research note: insert, edit, restore the first version.
    const noteId = await insert(f.db, OWNER, "research_notes", {
      title: "First title",
      content: "the first body of the note",
      note_type: "note",
    });
    await update(f.db, OWNER, "research_notes", "id", noteId, { content: "the second body of the note" });
    let versions = await versionsOf(f.db, "research_note", noteId);
    assert.equal(versions.length, 2, "insert + update");
    assert.deepEqual(
      versions.map((v) => v.op),
      ["insert", "update"],
    );
    await restoreVersion(f.db, { versionId: Number(versions[0].id) }, OWNER);
    const note = (await f.db.execute({ sql: "SELECT content FROM research_notes WHERE id = ?", args: [noteId] }))
      .rows[0];
    assert.equal(note.content, "the first body of the note", "the note's old content is back");
    versions = await versionsOf(f.db, "research_note", noteId);
    assert.equal(versions.length, 3, "the restore is itself a version");

    // A KB article (the bundle owns its table; its init installs the triggers).
    await initKbTables(f.db);
    const collection = await f.db.execute({
      sql: "INSERT INTO kb_collections (slug, name) VALUES ('guides', 'Guides') RETURNING id",
    });
    const collectionId = Number(collection.rows[0].id);
    const articleId = await insert(f.db, OWNER, "kb_articles", {
      collection_id: collectionId,
      pair_id: "pair-1",
      language: "en",
      slug: "a-guide",
      title: "A guide",
      content: "the first body of the article",
    });
    await update(f.db, OWNER, "kb_articles", "id", articleId, { content: "the second body of the article" });
    let articleVersions = await versionsOf(f.db, "kb_article", articleId);
    assert.equal(articleVersions.length, 2);
    await restoreVersion(f.db, { versionId: Number(articleVersions[0].id) }, OWNER);
    const article = (
      await f.db.execute({ sql: "SELECT content FROM kb_articles WHERE id = ?", args: [articleId] })
    ).rows[0];
    assert.equal(article.content, "the first body of the article");
    articleVersions = await versionsOf(f.db, "kb_article", articleId);
    assert.equal(articleVersions.length, 3);

    // A bot definition: content is captured, credentials are not (see the next two
    // tests for that half).
    await insert(f.db, OWNER, "pi_bot_defs", {
      bot_id: "hank",
      display_name: "Hank",
      definition: JSON.stringify(botDefinition()),
      enabled: 1,
    });
    await update(f.db, OWNER, "pi_bot_defs", "bot_id", "hank", {
      definition: JSON.stringify(botDefinition({ prompt: "You are Hank, revised." })),
    });
    const botVersions = await versionsOf(f.db, "bot_def", "hank");
    assert.equal(botVersions.length, 2, "insert + a definition edit");
    // The definition is stored through its allow-list projection, which SQLite
    // keeps as a nested JSON object (so the history view can show it).
    assert.equal(JSON.parse(botVersions[0].snapshot_json).definition.system_prompt, "You are Hank.");
    await restoreVersion(f.db, { versionId: Number(botVersions[0].id) }, OWNER);
    const live = (
      await f.db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = 'hank'" })
    ).rows[0];
    assert.equal(JSON.parse(live.definition).system_prompt, "You are Hank.", "the old definition content is back");

    // A board card: captured in tasks.db, restored there.
    const cardId = await insert(f.tdb, BOT, "tasks_items", {
      title: "First card title",
      description: "the card's first body",
      project_id: 2,
    });
    await update(f.tdb, BOT, "tasks_items", "id", cardId, { title: "Second card title" });
    const cardVersions = await versionsOf(f.tdb, "card", cardId);
    assert.equal(cardVersions.length, 2);
    await restoreVersion(f.tdb, { versionId: Number(cardVersions[0].id) }, OWNER);
    const card = (await f.tdb.execute({ sql: "SELECT title, description FROM tasks_items WHERE id = ?", args: [cardId] }))
      .rows[0];
    assert.equal(card.title, "First card title");
    assert.equal(card.description, "the card's first body");
  } finally {
    await f.dispose();
  }
});

test("no pi_bot_defs credential column value ever appears in snapshot_json", async () => {
  const f = await fixture();
  try {
    // pi_bot_defs has NO credential-named column at all — read from the schema,
    // not assumed — which is exactly why the credentials inside `definition` need
    // the allow-list projection (BOT_DEFINITION_KEYS) rather than a column denylist.
    const columns = (await f.db.execute("PRAGMA table_info(pi_bot_defs)")).rows.map((c) => c.name);
    const credentialColumns = columns.filter((c) => SECRET_COLUMN.test(c));
    assert.deepEqual(credentialColumns, [], "pi_bot_defs carries its credentials in the definition JSON, not in columns");
    // And the covered lists never name one, for this table or any other.
    for (const [itemType, spec] of Object.entries(COVERED)) {
      for (const column of [...spec.tracked, ...spec.snapshot]) {
        assert.doesNotMatch(column, SECRET_COLUMN, `${itemType}: ${column} looks like a credential`);
      }
    }
  } finally {
    await f.dispose();
  }
});

test("bot_def canary in every credential column and key never appears in snapshot_json, listVersions, diffVersions or an undo/restore result", async () => {
  const f = await fixture();
  try {
    await insert(f.db, BOT, "pi_bot_defs", {
      bot_id: "hank",
      display_name: "Hank",
      definition: JSON.stringify(botDefinition()),
      enabled: 1,
    });
    // A second version, written by the job whose undo we will ask for.
    await update(f.db, BOT, "pi_bot_defs", "bot_id", "hank", {
      definition: JSON.stringify(botDefinition({ prompt: "You are Hank, second draft." })),
    });

    // 1. Every stored snapshot of the bot.
    const stored = (await f.db.execute("SELECT snapshot_json FROM item_versions WHERE item_type = 'bot_def'")).rows;
    assert.ok(stored.length >= 2, "there is a history to inspect");
    for (const row of stored) {
      assert.ok(!row.snapshot_json.includes(CANARY), "no credential canary is in a stored snapshot");
    }
    // The allow-listed keys ARE stored — otherwise "no canary" would be vacuous.
    const snapshot = JSON.parse(stored[0].snapshot_json);
    const projection = snapshot.definition;
    assert.equal(typeof projection, "object", "the definition is stored as its projection");
    for (const key of ["engine", "models", "system_prompt", "tools", "skills", "permission_policy", "triggers"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(projection, key), `${key} is versioned`);
    }
    for (const key of ["gateways", "spawn_env", "api_token", "session_dir"]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(projection, key), `${key} is not versioned`);
    }

    // 2. The History API's own output.
    const listed = await listVersions(f.db, { itemType: "bot_def", itemId: "hank" });
    assert.ok(!JSON.stringify(listed).includes(CANARY), "listVersions never returns a credential");
    const diff = diffVersions(listed[1], listed[0]);
    assert.ok(diff.length > 0, "the edit is visible as a change");
    assert.ok(!JSON.stringify(diff).includes(CANARY), "diffVersions never returns a credential");

    // 3. A restore result, and the live row it wrote.
    const restored = await restoreVersion(f.db, { versionId: Number(listed[0].id) }, OWNER);
    assert.ok(!JSON.stringify(restored).includes(CANARY), "a restore result never carries a credential");
    const live = (await f.db.execute("SELECT definition FROM pi_bot_defs WHERE bot_id = 'hank'")).rows[0];
    assert.ok(live.definition.includes(CANARY), "the live credentials are kept (the projection never touched them)");

    // 4. The redaction sweep over everything stored (the existing secret-pattern
    //    scrub, for anything a person typed into a versioned field).
    const beforeSweep = await versionsOf(f.db, "bot_def", "hank");
    await withWriteContext(OWNER, () =>
      f.db.execute({
        sql: "UPDATE pi_bot_defs SET display_name = ? WHERE bot_id = 'hank'",
        args: [`Hank ${AWS_SHAPED_CANARY}`],
      }),
    );
    const written = await versionsOf(f.db, "bot_def", "hank");
    assert.equal(written.length, beforeSweep.length + 1, "the display name edit is a version");
    assert.ok(written[written.length - 1].snapshot_json.includes(AWS_SHAPED_CANARY), "and it holds the key-shaped text");
    await sweep(f.db, { batchSize: 500 });
    const afterSweep = (await f.db.execute("SELECT snapshot_json, redacted FROM item_versions WHERE item_type = 'bot_def'")).rows;
    assert.ok(
      afterSweep.some((row) => Number(row.redacted) === 1 && row.snapshot_json.includes("[redacted]")),
      `the sweep scrubbed the AWS-shaped canary out of the stored version: ${JSON.stringify(afterSweep)}`,
    );
    assert.ok(!afterSweep.some((row) => row.snapshot_json.includes(AWS_SHAPED_CANARY)));

    // 5. An undo of the job that made the bot (the job's first version for it is
    //    its insert, so the undo removes it — and its result still carries no
    //    credential).
    const undone = await undoJob(f.db, { jobId: BOT.jobId }, OWNER);
    assert.ok(!JSON.stringify(undone).includes(CANARY), "an undo result never carries a credential");
    assert.ok(!JSON.stringify(undone).includes(AWS_SHAPED_CANARY));
  } finally {
    await f.dispose();
  }
});

test("restoring a bot_def never blanks or overwrites the live credential keys", async () => {
  const f = await fixture();
  try {
    await insert(f.db, OWNER, "pi_bot_defs", {
      bot_id: "hank",
      display_name: "Hank",
      definition: JSON.stringify(botDefinition({ prompt: "You are Hank.", token: "old-discord-token" })),
      enabled: 1,
    });
    await update(f.db, OWNER, "pi_bot_defs", "bot_id", "hank", {
      definition: JSON.stringify(botDefinition({ prompt: "You are Hank, second.", token: "old-discord-token" })),
    });
    const versions = await versionsOf(f.db, "bot_def", "hank");

    // The operator rotates the Discord token (a credential-only change) and adds an
    // env key. NEITHER is a version: the projection cannot see them.
    const rotated = botDefinition({ prompt: "You are Hank, second.", token: "rotated-discord-token" });
    rotated.spawn_env = { OPENAI_API_KEY: "rotated-env-key" };
    await update(f.db, OWNER, "pi_bot_defs", "bot_id", "hank", { definition: JSON.stringify(rotated) });
    assert.equal((await versionsOf(f.db, "bot_def", "hank")).length, versions.length, "a token rotation writes no version");

    // Restoring the first version puts the persona back and leaves the live
    // credentials exactly as they are.
    await restoreVersion(f.db, { versionId: Number(versions[0].id) }, OWNER);
    const live = JSON.parse(
      (await f.db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = 'hank'" })).rows[0].definition,
    );
    assert.equal(live.system_prompt, "You are Hank.", "the version's content is restored");
    assert.equal(live.gateways[0].token, "rotated-discord-token", "the live token is NOT overwritten");
    assert.equal(live.spawn_env.OPENAI_API_KEY, "rotated-env-key", "the live env blob is kept");
    assert.equal(live.gateways[1].bot_token, `${CANARY}-slack-bot`, "the other credential keys are untouched");
    assert.equal(live.session_dir, "/workspace/bots/hank", "keys outside the allow-list are not touched either");
  } finally {
    await f.dispose();
  }
});

test("card history lives in tasks.db only and crow.db gets no card versions", async () => {
  const f = await fixture();
  try {
    const cardId = await insert(f.tdb, BOT, "tasks_items", { title: "A card", project_id: 3 });
    await update(f.tdb, BOT, "tasks_items", "id", cardId, { title: "A renamed card" });
    assert.equal((await versionsOf(f.tdb, "card", cardId)).length, 2, "the card's versions are rows of tasks.db");
    assert.equal(await countVersions(f.db, "card"), 0, "crow.db holds no card version");
    // And the crow.db store's triggers know nothing about tasks_items: a card type
    // is never installed there, so nothing can sneak in.
    const crowTriggers = (await f.db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")).rows.map(
      (r) => r.name,
    );
    assert.ok(!crowTriggers.some((n) => n.startsWith("hist_tasks_items")), "no card trigger in crow.db");
    // The Trash and the sweep read crow.db and therefore never see a card: a card
    // deleted (or edited) in tasks.db cannot make either of them misbehave, and no
    // card row is ever listed for erase here.
    const { listTrash } = await import("../servers/shared/history/trash.js");
    assert.deepEqual((await listTrash(f.db)).filter((e) => e.itemType === "card"), [], "the Trash lists no card");
    await sweep(f.db, { batchSize: 500 });
    assert.equal(await countVersions(f.tdb, "card"), 2, "and a sweep of crow.db touches no card version");
  } finally {
    await f.dispose();
  }
});

test("no new table or trigger of this migration enters sync", async () => {
  // The new tables this task creates are item_versions in tasks.db (and the erase
  // control switch beside it in 0024's DDL). History is LOCAL ONLY: it is never in
  // instance-sync's table list, and no outbound transform names it — each instance
  // records the versions of the changes IT applied.
  for (const table of ["item_versions", "item_versions_erase", "item_erasures"]) {
    assert.ok(!SYNCED_TABLES.includes(table), `${table} is never synced`);
  }
  // Nor does the migration touch the sync list at all.
  const src = readFileSync(join(REPO, "scripts", "migrations", "0025-item-versions-more.mjs"), "utf8");
  assert.doesNotMatch(src, /SYNCED_TABLES\.(push|unshift|splice)|OUTBOUND_TRANSFORMS\[/, "no code path adds anything to sync");
  // And the covered tables that already sync (research_notes) do so for their own
  // reasons: nothing here changes that either way.
  assert.ok(SYNCED_TABLES.includes("research_notes"), "the note table's own sync is untouched by history");
});

test("an archived card stays archived after restore", async () => {
  const f = await fixture();
  try {
    const cardId = await insert(f.tdb, OWNER, "tasks_items", { title: "Live title", project_id: 4 });
    await update(f.tdb, OWNER, "tasks_items", "id", cardId, { title: "Edited title" });
    const versions = await versionsOf(f.tdb, "card", cardId);
    // The card is archived AFTER the version we restore: a restore must not
    // unarchive it (archived_at is in neither the tracked nor the snapshot list).
    await update(f.tdb, OWNER, "tasks_items", "id", cardId, { archived_at: "2026-11-04T10:00:00.000Z" });
    await restoreVersion(f.tdb, { versionId: Number(versions[0].id) }, OWNER);
    const card = (await f.tdb.execute({ sql: "SELECT title, archived_at FROM tasks_items WHERE id = ?", args: [cardId] }))
      .rows[0];
    assert.equal(card.title, "Live title", "the content is restored");
    assert.equal(card.archived_at, "2026-11-04T10:00:00.000Z", "and an archived card stays archived");
  } finally {
    await f.dispose();
  }
});

test("kb_articles absent -> the migration defers that type with a reason; bundle init installs its triggers", async () => {
  const f = await fixture();
  try {
    // A crow.db with no knowledge-base bundle: kb_articles does not exist. 0025 has
    // already run here (the fixture), so re-run it directly to read its outcome.
    const before = (await f.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_articles'")).rows;
    assert.equal(before.length, 0, "the bundle-owned table is absent");
    const outcome = runMore({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.equal(outcome.applied, true, "the rest of the types still apply");
    const skipped = (outcome.skipped || []).find((s) => s.itemType === "kb_article");
    assert.ok(skipped, "the article type is reported as skipped");
    assert.match(skipped.reason, /kb_articles absent/, "with the reason a reader can act on");
    assert.match(skipped.reason, /bundle-owned/, "and why it is not a deferral");

    // The bundle's own init creates the table and then installs the triggers.
    await initKbTables(f.db);
    const triggers = (await f.db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")).rows.map(
      (r) => r.name,
    );
    for (const suffix of ["ai", "au", "ad"]) {
      assert.ok(triggers.includes(`hist_kb_articles_${suffix}`), `hist_kb_articles_${suffix} is installed by the bundle`);
    }
    assert.ok(triggers.includes("kb_articles_ai"), "and the FTS triggers are still there");
    // Capture works from the first article on.
    const collectionId = Number(
      (await f.db.execute({ sql: "INSERT INTO kb_collections (slug, name) VALUES ('c', 'C') RETURNING id" })).rows[0].id,
    );
    const articleId = await insert(f.db, OWNER, "kb_articles", {
      collection_id: collectionId,
      pair_id: "pair-9",
      slug: "s",
      title: "T",
      content: "C",
    });
    assert.equal((await versionsOf(f.db, "kb_article", articleId)).length, 1);
    // A second init run (what every boot does) writes nothing new and throws nothing.
    await initKbTables(f.db);
    assert.equal((await versionsOf(f.db, "kb_article", articleId)).length, 1, "re-running the bundle init changes no version");
  } finally {
    await f.dispose();
  }
});

test("restoring an article keeps its FTS row in step", async () => {
  const f = await fixture();
  try {
    await initKbTables(f.db);
    const collectionId = Number(
      (await f.db.execute({ sql: "INSERT INTO kb_collections (slug, name) VALUES ('c', 'C') RETURNING id" })).rows[0].id,
    );
    const articleId = await insert(f.db, OWNER, "kb_articles", {
      collection_id: collectionId,
      pair_id: "pair-fts",
      slug: "fts",
      title: "FTS article",
      content: "the original uniquelyquoted phrase",
    });
    await update(f.db, OWNER, "kb_articles", "id", articleId, { content: "the replaced uniquesubstitute phrase" });
    const match = async (term) =>
      Number(
        (
          await f.db.execute({
            sql: "SELECT COUNT(*) AS n FROM kb_articles_fts WHERE kb_articles_fts MATCH ?",
            args: [term],
          })
        ).rows[0].n,
      );
    assert.equal(await match("uniquelyquoted"), 0, "the replaced text is not findable yet");
    assert.equal(await match("uniquesubstitute"), 1);

    const versions = await versionsOf(f.db, "kb_article", articleId);
    await restoreVersion(f.db, { versionId: Number(versions[0].id) }, OWNER);

    // The article's own UPDATE trigger is what keeps the shadow in step: the
    // restore is an ordinary write, so the FTS row followed it.
    assert.equal(await match("uniquelyquoted"), 1, "the restored text is searchable");
    assert.equal(await match("uniquesubstitute"), 0, "and the replaced text is gone from the index");
    const row = (await f.db.execute({ sql: "SELECT content FROM kb_articles WHERE id = ?", args: [articleId] })).rows[0];
    assert.equal(row.content, "the original uniquelyquoted phrase");
  } finally {
    await f.dispose();
  }
});

test("a research note has no FTS shadow to keep in step (the FTS table research_notes has is research_sources')", async () => {
  const f = await fixture();
  try {
    // init-db's craw is the authority: there is no notes FTS table, so the plan's
    // "restore a note and run an FTS MATCH on it" has nothing to run it against.
    // A future notes shadow would need its own triggers; this test exists so the
    // gap is visible rather than assumed.
    const tables = (await f.db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")).rows.map(
      (r) => r.name,
    );
    for (const name of ["research_notes_fts", "notes_fts"]) {
      assert.ok(!tables.includes(name), `${name} does not exist`);
    }
    assert.ok(tables.includes("sources_fts"), "the SOURCES index is the one init-db builds");
  } finally {
    await f.dispose();
  }
});

/* ------------------------------------------------------------- artifacts */

/** An artifact with `n` versions, built through the bundle's own store. */
async function artifactFixture(f) {
  await initArtifactsTables(f.db);
  const blobs = await createBlobStore(f.db, f.dir);
  const actor = { kind: "session", id: null };
  const created = await createArtifact(
    f.db,
    blobs,
    {
      title: "A page about nothing",
      type: "page",
      source: { html: "<!doctype html><p>first</p>" },
      actor,
    },
    {},
  );
  await addVersion(
    f.db,
    blobs,
    {
      artifactId: created.id,
      source: { html: "<!doctype html><p>second</p>" },
      actor,
      baseVersion: 1,
    },
    {},
  );
  return { blobs, artifactId: created.id, seams: { blobs, store: undefined } };
}

test("an artifact's History lists its existing versions (no new item_versions rows)", async () => {
  const f = await fixture();
  try {
    const { artifactId } = await artifactFixture(f);
    const before = await countVersions(f.db, ARTIFACT_ITEM_TYPE);
    assert.equal(before, 0, "nothing of the artifact's has ever been in item_versions");
    const versions = await listVersions(f.db, { itemType: ARTIFACT_ITEM_TYPE, itemId: artifactId });
    assert.equal(versions.length, 2, "both of its own versions are listed");
    assert.deepEqual(
      versions.map((v) => v.op),
      ["update", "insert"],
      "newest first; n=1 is the artifact's creation",
    );
    assert.equal(versions[0].snapshot.title, "A page about nothing");
    assert.equal(versions[0].snapshot.state, "current");
    assert.equal(await countVersions(f.db, ARTIFACT_ITEM_TYPE), 0, "reading writes no history row of its own");
    const artifacts = (await f.db.execute("SELECT COUNT(*) AS n FROM artifact_versions")).rows[0].n;
    assert.equal(Number(artifacts), 2, "and no artifact version was touched either");
  } finally {
    await f.dispose();
  }
});

test("restoring an artifact version goes through the store and is owner-only", async () => {
  const f = await fixture();
  try {
    const { artifactId, blobs } = await artifactFixture(f);
    const seams = { blobs };

    // Not the owner: refused before anything is written.
    await assert.rejects(
      () => restoreVersion(f.db, { itemType: ARTIFACT_ITEM_TYPE, itemId: artifactId, versionId: 1, artifacts: seams }, BOT),
      (err) => err.code === "invalid_context",
    );

    // The owner restores version 1: the store makes a NEW current version from it.
    const result = await restoreVersion(
      f.db,
      { itemType: ARTIFACT_ITEM_TYPE, itemId: artifactId, versionId: 1, artifacts: seams },
      OWNER,
    );
    assert.equal(result.synced, false, "artifacts never ride instance sync");
    const rows = (
      await f.db.execute({
        sql: "SELECT n, state, source_json FROM artifact_versions WHERE artifact_id = ? ORDER BY n",
        args: [artifactId],
      })
    ).rows;
    assert.equal(rows.length, 3, "a restore is a new version, not a rewrite");
    assert.deepEqual(
      rows.map((r) => r.state),
      ["past", "past", "current"],
    );
    assert.deepEqual(JSON.parse(rows[2].source_json), { html: "<!doctype html><p>first</p>" });
    const current = (await f.db.execute({ sql: "SELECT current_version FROM artifacts WHERE id = ?", args: [artifactId] }))
      .rows[0];
    assert.equal(Number(current.current_version), 3);

    // A RECEIVED artifact is refused (it is not ours to edit).
    await f.db.execute({ sql: "UPDATE artifacts SET received = 1 WHERE id = ?", args: [artifactId] });
    await assert.rejects(
      () => restoreVersion(f.db, { itemType: ARTIFACT_ITEM_TYPE, itemId: artifactId, versionId: 1, artifacts: seams }, OWNER),
      (err) => err.code === "untrusted",
    );
    await f.db.execute({ sql: "UPDATE artifacts SET received = 0 WHERE id = ?", args: [artifactId] });

    // An UNTRUSTED (non-owner text) version is refused rather than replayed.
    await f.db.execute({
      sql: "UPDATE artifact_versions SET untrusted_input = 1, trust_cleared_at = NULL WHERE artifact_id = ? AND n = 1",
      args: [artifactId],
    });
    await assert.rejects(
      () => restoreVersion(f.db, { itemType: ARTIFACT_ITEM_TYPE, itemId: artifactId, versionId: 1, artifacts: seams }, OWNER),
      (err) => err.code === "untrusted",
    );
  } finally {
    await f.dispose();
  }
});

/* ------------------------------------------------------------ Studio songs */

test("a job that touched a Studio song lists it as skipped own_undo with a link", async () => {
  const f = await fixture();
  try {
    await initStudioTables(f.db);
    await f.db.execute({
      sql: "INSERT INTO studio_songs (id, project_id, title) VALUES ('song-1', 5, 'Night drive')",
    });
    // The job's own unit of work: one memory edit, stamped with card:9 by bot hank.
    const memoryId = await insert(f.db, BOT, "memories", { content: "a memory the job wrote" });
    // Studio's own log: studio_history records the AUTHOR but no job id (see
    // jobs.js), so the linkage is the job's bot inside the job's own write window.
    await f.db.execute({
      sql: `INSERT INTO studio_history (id, song_id, seq, command, author_kind, author_id, author_label, summary, created_at)
            SELECT 'entry-1', 'song-1', 1, 'song.set_meta', 'agent', 'bot:hank', 'Bot hank', 'tempo 120',
                   MAX(created_at) FROM item_versions WHERE item_type = 'memory' AND item_id = ?`,
      args: [String(memoryId)],
    });

    const result = await undoJob(f.db, { jobId: BOT.jobId }, OWNER);
    assert.deepEqual(
      result.restored.map((r) => r.itemType),
      ["memory"],
      "the database item is undone",
    );
    const song = result.skipped.find((s) => s.itemType === "studio_song");
    assert.ok(song, "the Studio song is listed");
    assert.equal(song.skipped, true, "and never restored through History");
    assert.equal(song.reason, "own_undo");
    assert.equal(song.itemId, "song-1");
    assert.equal(song.link, "/dashboard/studio?song=song-1", "the link goes to the song's own undo");
    assert.equal(song.label, "Night drive");
    // Nothing of the song's was written into item_versions.
    assert.equal(await countVersions(f.db, "studio_song"), 0);
  } finally {
    await f.dispose();
  }
});

/* --------------------------------------------------- the rules that hold */

test("the COVERED import rules still hold for the new entries", async () => {
  // Every COVERED type is claimed by exactly one migration, and each migration's
  // list is its own (0024's never grows).
  const claimed = [...typesForMigration(MIGRATION_0024), ...typesForMigration(MIGRATION_0025)];
  assert.deepEqual(claimed.sort(), Object.keys(COVERED).sort(), "every covered type names its migration");
  assert.equal(typesForMigration(MIGRATION_0024).length, 3, "0024 keeps its own three types");
  assert.deepEqual(typesForMigration(MIGRATION_0025), [...ITEM_TYPES], "0025 owns the rest");
  assert.deepEqual(
    typesForStore(STORE_TASKS),
    ["card"],
    "the card is the one type in tasks.db",
  );

  for (const [itemType, spec] of Object.entries(COVERED)) {
    assert.ok(spec.tracked.length > 0, `${itemType}: tracks at least one column`);
    for (const column of spec.tracked) {
      assert.ok(spec.snapshot.includes(column), `${itemType}: ${column} is tracked AND snapshotted`);
      assert.doesNotMatch(column, SECRET_COLUMN, `${itemType}: ${column} looks like a credential`);
    }
    for (const column of spec.snapshot) {
      assert.doesNotMatch(column, SECRET_COLUMN, `${itemType}: ${column} looks like a credential`);
    }
    // A projected field's KEYS are the credential surface: none may look like one.
    for (const column of Object.keys(spec.projected || {})) {
      assert.ok(spec.snapshot.includes(column), `${itemType}: ${column} is projected and snapshotted`);
    }
    for (const key of itemType === "bot_def" ? BOT_DEFINITION_KEYS : []) {
      assert.doesNotMatch(key, SECRET_COLUMN, `bot_def.${key} looks like a credential key`);
    }
    const sql = triggerSql(itemType);
    assert.equal(sql.length, 3, `${itemType}: three triggers`);
    for (const statement of sql) assert.match(statement, /^CREATE TRIGGER IF NOT EXISTS hist_/);
  }
  // The projection is not the raw column: no trigger stores `definition` itself.
  const botSql = triggerSql("bot_def").join("\n");
  assert.match(botSql, /json_object\(/, "the definition is stored as a projection");
  assert.match(botSql, /json_valid\(/, "and a corrupt definition cannot fail the bot's own write");
  assert.ok(!/NEW\."definition" IS NOT OLD\."definition"/.test(botSql), "the trigger compares projections, not the raw blob");
});

test("0024 still creates triggers only for its own types", async () => {
  const f = await fixture();
  try {
    // A store where 0024's own tables were dropped AND the new tables are present:
    // running 0024 must not install (or report on) another migration's triggers.
    for (const suffix of ["ai", "au", "ad"]) {
      await f.db.execute(`DROP TRIGGER hist_research_notes_${suffix}`);
    }
    await f.db.execute("DROP TABLE memories");
    await f.db.execute("DROP TABLE blog_posts");
    await f.db.execute("DROP TABLE crow_context");
    const lines = [];
    const outcome = runItemVersions({ dbPath: f.dbPath, log: (m) => lines.push(m) });
    assert.equal(outcome.deferred, true, "its own tables are missing, so it retries");
    assert.ok(!lines.some((l) => l.includes("research_notes")), "it never looks at 0025's tables");
    const triggers = (await f.db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")).rows.map(
      (r) => r.name,
    );
    assert.ok(!triggers.includes("hist_research_notes_ai"), "it installs no 0025 trigger");
  } finally {
    await f.dispose();
  }
});

test("migration 0025 is idempotent", async () => {
  const f = await fixture();
  try {
    // Seed one row per covered table so a second run has a baseline to consider.
    await insert(f.db, OWNER, "research_notes", { title: "note", content: "body" });
    await insert(f.db, OWNER, "pi_bot_defs", {
      bot_id: "hank",
      display_name: "Hank",
      definition: JSON.stringify(botDefinition()),
      enabled: 1,
    });
    await insert(f.tdb, OWNER, "tasks_items", { title: "card", project_id: 6 });

    const snapshot = async () => ({
      crow: (await f.db.execute("SELECT COUNT(*) AS n FROM item_versions")).rows[0].n,
      tasks: (await f.tdb.execute("SELECT COUNT(*) AS n FROM item_versions")).rows[0].n,
      crowTriggers: (await f.db.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'")).rows[0].n,
      tasksTriggers: (await f.tdb.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'")).rows[0].n,
    });
    const before = await snapshot();
    const again = runMore({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.equal(again.applied, true);
    assert.deepEqual(await snapshot(), before, "a second run writes no version and changes no trigger");

    // And the per-item baseline guard is what makes that true: a re-run's INSERT
    // matches no row (each item already has a version).
    const counts = await f.db.execute(
      "SELECT item_type, COUNT(*) AS n FROM item_versions GROUP BY item_type ORDER BY item_type",
    );
    const byType = Object.fromEntries(counts.rows.map((r) => [r.item_type, Number(r.n)]));
    assert.equal(byType.research_note, 1, "one version per seeded note (its own insert, not a second baseline)");
    assert.equal(byType.bot_def, 1);
  } finally {
    await f.dispose();
  }
});

test("a card edit inside a write context is attributed in tasks.db", async () => {
  const f = await fixture();
  try {
    // servers/db.js stamps a version only when the handle's OWN file has
    // item_versions and item_versions_erase; 0025 creates both in tasks.db, so the
    // tasks.db client stamps exactly as crow.db's does.
    const cardId = await insert(f.tdb, BOT, "tasks_items", { title: "attributed card", project_id: 7 });
    const rows = (await f.tdb.execute({ sql: "SELECT author_kind, author_id, job_id FROM item_versions WHERE item_type = 'card'", args: [] })).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0] },
      { author_kind: "bot", author_id: "hank", job_id: "card:9" },
      "the card version is attributed to the bot and its job",
    );
    void cardId;
  } finally {
    await f.dispose();
  }
});

test("ensure leaves the other store alone and re-arms the KB triggers when the bundle is there", async () => {
  const f = await fixture();
  try {
    await initKbTables(f.db);
    const raw = new Database(f.dbPath);
    try {
      for (const suffix of ["ai", "au", "ad"]) raw.exec(`DROP TRIGGER hist_kb_articles_${suffix}`);
      // A crow.db ensure works only on crow.db: it never reports the card's table
      // (which lives in tasks.db) as missing.
      const result = ensureHistoryTriggers(raw);
      assert.ok(result.restored.includes("hist_kb_articles_ai"), "a dropped article trigger comes back");
      assert.ok(!result.skipped.includes("tasks_items"), "the other store's table is not this store's business");
      assert.deepEqual(result.awaitingBaseline, [], "both migrations are recorded here");
    } finally {
      raw.close();
    }
  } finally {
    await f.dispose();
  }
});

test("the registry applies 0025 in the same pass as the board migrations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-coverage-registry-"));
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
      cwd: REPO,
      stdio: "pipe",
    });
    const dbPath = join(dir, "crow.db");
    const tasksDbPath = join(dir, "tasks.db");
    const outcome = await runMigrations({
      migrationsDir: join(REPO, "scripts", "migrations"),
      dbPath,
      tasksDbPath,
      sha: "test",
      log: () => {},
    });
    assert.ok(outcome.applied.includes(MIGRATION_0025), `a fresh store gets 0025 on its first boot: ${JSON.stringify(outcome)}`);
    assert.ok(!outcome.deferred.includes(MIGRATION_0025), `and does not defer it: ${JSON.stringify(outcome)}`);
    const cdb = new Database(dbPath);
    const tdb = new Database(tasksDbPath);
    try {
      const crowTriggers = cdb.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
      const tasksTriggers = tdb.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
      assert.ok(crowTriggers.includes("hist_research_notes_ai"), "the note triggers are installed");
      assert.ok(crowTriggers.includes("hist_pi_bot_defs_ai"), "the bot triggers are installed");
      assert.ok(tasksTriggers.includes("hist_tasks_items_ai"), "the card triggers are installed in tasks.db");
      assert.ok(
        tdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_versions'").get(),
        "tasks.db has its own item_versions",
      );
      assert.ok(
        tdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_versions_erase'").get(),
        "and the erase switch the append-only guards read",
      );
      assert.equal(
        cdb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().n,
        0,
        "crow.db never gets a tasks_items",
      );
    } finally {
      cdb.close();
      tdb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});