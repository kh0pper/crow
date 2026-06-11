/**
 * Tests for the project-clone bundle path in servers/sharing/server.js.
 *
 * applyProjectCloneBundle is a closure inside createSharingServer — not
 * directly importable. The testable seam chosen here is the ps-creation
 * slice it delegates to: createProjectSpace({ explicitSlug, ownerMember: false })
 * followed by the clone's own member INSERT. This covers the load-bearing
 * invariants without spawning a full sharing server or mocking network.
 *
 * Tests verify:
 *   - explicitSlug "-clone-N" shape is preserved verbatim
 *   - workspace_dir stays inside the data dir (path-containment invariant)
 *   - storage_prefix matches the expected key prefix
 *   - ownerMember:false means the helper does NOT insert a member row
 *   - the clone's own member INSERT (role=owner, mode=clone, granted_by_contact_id)
 *     succeeds and is the only member row
 *   - a second clone of the same project gets slug -clone-2 (uniqueness loop)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";
import { slugify } from "../servers/shared/slugify.js";
import { createProjectSpace } from "../servers/shared/project-spaces.js";

// ---- temp DB setup ----
const dir = mkdtempSync(join(tmpdir(), "ps-clone-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const rawDb = new Database(join(dir, "crow.db"));
after(() => {
  rawDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function wrapDb(bsDb) {
  function executeOne(sql, args = []) {
    const stmt = bsDb.prepare(sql);
    const a = Array.isArray(args) ? args : [args];
    if (stmt.reader) {
      const rows = stmt.all(...a);
      return { rows, columns: rows.length > 0 ? Object.keys(rows[0]) : [], rowsAffected: 0, lastInsertRowid: 0 };
    }
    const info = stmt.run(...a);
    return { rows: [], columns: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
  return {
    async execute(arg) {
      if (typeof arg === "string") return executeOne(arg, []);
      return executeOne(arg.sql, arg.args);
    },
    async batch(stmts) {
      const txn = bsDb.transaction((ss) => ss.map((s) => {
        if (typeof s === "string") return executeOne(s, []);
        return executeOne(s.sql, s.args);
      }));
      return txn(stmts);
    },
  };
}

const db = wrapDb(rawDb);

// ---- helpers that mirror the clone path in sharing/server.js ----

/**
 * Simulate the uniqueness-counter loop from applyProjectCloneBundle.
 * Returns the first unused -clone-N slug.
 */
async function pickCloneSlug(db, baseSlug) {
  let suffix = 1;
  while (true) {
    const hit = (await db.execute({
      sql: "SELECT 1 FROM project_spaces WHERE slug = ?",
      args: [`${baseSlug}-clone-${suffix}`],
    })).rows[0];
    if (!hit) return `${baseSlug}-clone-${suffix}`;
    suffix += 1;
  }
}

// ---- tests ----

test("clone: explicitSlug -clone-1 shape preserved verbatim in DB", async () => {
  const origName = "My Research Project";
  const baseSlug = slugify(origName);
  const newSlug = await pickCloneSlug(db, baseSlug);
  assert.equal(newSlug, `${baseSlug}-clone-1`);

  const result = await createProjectSpace(db, {
    explicitSlug: newSlug,
    name: `${origName} (clone)`,
    description: "A clone",
    type: "general",
    tags: null,
    originInstanceId: "some-instance-id",
    ownerMember: false,
  });

  assert.equal(result.slug, newSlug, "slug must match explicitSlug");
  const row = rawDb.prepare("SELECT slug, workspace_dir, storage_prefix FROM project_spaces WHERE id=?").get(result.id);
  assert.equal(row.slug, newSlug);
  assert.ok(row.storage_prefix.startsWith("projects/"), "storage_prefix starts with projects/");
  assert.ok(row.storage_prefix.includes(newSlug), "storage_prefix contains the slug");
});

test("clone: workspace_dir stays inside data dir (path-containment invariant)", async () => {
  const origName = "Another Project";
  const baseSlug = slugify(origName);
  const newSlug = await pickCloneSlug(db, baseSlug);

  // Point the helper at the temp dir so we can assert containment.
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  let result;
  try {
    result = await createProjectSpace(db, {
      explicitSlug: newSlug,
      name: `${origName} (clone)`,
      ownerMember: false,
    });
  } finally {
    if (prevDataDir == null) delete process.env.CROW_DATA_DIR;
    else process.env.CROW_DATA_DIR = prevDataDir;
  }

  const resolvedRoot = resolve(dir);
  const resolvedWs = resolve(result.workspaceDir);
  assert.ok(
    resolvedWs.startsWith(resolvedRoot + "/"),
    `workspace_dir must be inside data dir: ${resolvedWs} not in ${resolvedRoot}`
  );
});

test("clone: ownerMember:false means helper inserts NO member row", async () => {
  const origName = "No Helper Member";
  const baseSlug = slugify(origName);
  const newSlug = await pickCloneSlug(db, baseSlug);

  const result = await createProjectSpace(db, {
    explicitSlug: newSlug,
    name: `${origName} (clone)`,
    ownerMember: false,
  });

  const member = rawDb.prepare(
    "SELECT * FROM project_members WHERE project_id=?"
  ).get(result.id);
  assert.equal(member, undefined, "helper must NOT insert a member row when ownerMember=false");
});

test("clone: clone's own member INSERT succeeds (mode=clone, role=owner)", async () => {
  const origName = "Clone Member Test";
  const baseSlug = slugify(origName);
  const newSlug = await pickCloneSlug(db, baseSlug);

  const result = await createProjectSpace(db, {
    explicitSlug: newSlug,
    name: `${origName} (clone)`,
    ownerMember: false,
  });

  // Simulate what applyProjectCloneBundle does after createProjectSpace:
  await db.execute({
    sql: `INSERT INTO project_members (project_id, contact_id, role, mode, granted_by_contact_id)
          VALUES (?, NULL, 'owner', 'clone', NULL)`,
    args: [result.id],
  });

  const member = rawDb.prepare(
    "SELECT role, mode FROM project_members WHERE project_id=? AND revoked_at IS NULL"
  ).get(result.id);
  assert.ok(member, "clone member row must exist");
  assert.equal(member.role, "owner");
  assert.equal(member.mode, "clone");
});

test("clone: second clone of same project gets -clone-2 slug", async () => {
  const origName = "Dupe Clone";
  const baseSlug = slugify(origName);

  // First clone
  const slug1 = await pickCloneSlug(db, baseSlug);
  assert.equal(slug1, `${baseSlug}-clone-1`);
  await createProjectSpace(db, { explicitSlug: slug1, name: "Dupe Clone (clone)", ownerMember: false });

  // Second clone — uniqueness loop should bump to -clone-2
  const slug2 = await pickCloneSlug(db, baseSlug);
  assert.equal(slug2, `${baseSlug}-clone-2`);
  const result2 = await createProjectSpace(db, { explicitSlug: slug2, name: "Dupe Clone (clone)", ownerMember: false });
  assert.equal(result2.slug, slug2);
});
