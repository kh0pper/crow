// Crow Artifacts — an artifacts DB created by an earlier version of the bundle
// (0.10.x, every CHECK in place) must keep the exact table text it had, and it
// must accept a report version. `artifact_version_holds` is the one additive
// table this change makes: CREATE IF NOT EXISTS reaches a live DB, no CHECK is
// widened and no table is rebuilt (SQLite cannot alter a CHECK in place).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";

const deps = { markdownBlocks };
const OWNER = { kind: "session" };
const s = {};
const doc = (md) => ({ markdown: md, title: "T" });

const tablesIn = async (db) => Object.fromEntries((await db.execute({
  sql: "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
  args: [],
})).rows.map((r) => [r.name, r.sql]));

before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-legacy-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  // Rebuild the shape a 0.10.x install has: the same tables, without the one
  // table this change adds. That drop is what makes the "legacy" DB honest —
  // everything else was written by this init.
  await s.db.execute({ sql: "DROP TABLE artifact_version_holds", args: [] });
  s.legacy = await tablesIn(s.db);
  // A second init is what a live install gets on its next boot.
  await initArtifactsTables(s.db);
  s.after = await tablesIn(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

test("the init on a live DB adds the hold table and changes no existing table's sql text", () => {
  assert.ok(!("artifact_version_holds" in s.legacy), "the baseline really is a DB without the hold table");
  assert.deepEqual(Object.keys(s.after).sort(), [...Object.keys(s.legacy), "artifact_version_holds"].sort(), "exactly one table is added");
  for (const [name, sql] of Object.entries(s.legacy)) assert.equal(s.after[name], sql, `${name}: sql text is byte-identical`);
  assert.match(s.after.artifact_version_holds, /CREATE TABLE artifact_version_holds/);
});

test("a pre-existing artifacts DB accepts a report version (made_by 'user', no CHECK failure)", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "Weekly", type: "document", source: doc("# one"), actor: OWNER, untrusted: true }, deps);
  const v = await store.addVersion(s.db, s.blobs, { artifactId: a.id, source: doc("# two"), actor: OWNER, untrusted: true, changeNote: "Run 2026-01-05" }, deps);
  assert.deepEqual([v.n, v.state], [2, "current"]);
  const row = (await s.db.execute({ sql: "SELECT made_by, made_by_bot, state FROM artifact_versions WHERE artifact_id=? AND n=2", args: [a.id] })).rows[0];
  assert.deepEqual({ ...row }, { made_by: "user", made_by_bot: null, state: "current" });
  assert.equal((await store.getArtifact(s.db, a.id)).current_version, 2);
});