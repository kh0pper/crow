/**
 * Tests for servers/shared/project-spaces.js
 * Uses a temp DB init'd by the real init-db.js (same pattern as
 * tests/init-db-bot-tables.test.js).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

// ---- temp DB setup ----
const dir = mkdtempSync(join(tmpdir(), "ps-helper-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const rawDb = new Database(join(dir, "crow.db"));
after(() => {
  rawDb.close();
  rmSync(dir, { recursive: true, force: true });
});

// Build a thin db.js-compatible async wrapper around the raw handle.
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

const { createProjectSpace, updateProjectSpaceMeta } =
  await import("../servers/shared/project-spaces.js");

// ---- tests ----

test("createProjectSpace: inserts row with canonical slug (name-id form)", async () => {
  const result = await createProjectSpace(db, { name: "My Test Project" });
  assert.ok(result.id > 0, "id must be positive");
  assert.match(result.slug, /^my-test-project-\d+$/, "slug format");
  assert.ok(result.workspaceDir.includes("/projects/"), "workspaceDir has /projects/");
  assert.ok(result.storagePrefix.startsWith("projects/"), "storagePrefix");

  // Verify row in DB
  const row = rawDb.prepare("SELECT * FROM project_spaces WHERE id=?").get(result.id);
  assert.equal(row.slug, result.slug);
  assert.equal(row.workspace_dir, result.workspaceDir);
  assert.equal(row.storage_prefix, result.storagePrefix);
  assert.equal(row.name, "My Test Project");
  assert.equal(row.type, "general");
  assert.equal(row.status, "active");
});

test("createProjectSpace: creates owner project_members row by default", async () => {
  const result = await createProjectSpace(db, { name: "Owner Test" });
  const member = rawDb.prepare(
    "SELECT * FROM project_members WHERE project_id=? AND revoked_at IS NULL"
  ).get(result.id);
  assert.ok(member, "owner member row must exist");
  assert.equal(member.role, "owner");
  assert.equal(member.contact_id, null, "local owner has null contact_id");
});

test("createProjectSpace: ownerMember:false skips member row", async () => {
  const result = await createProjectSpace(db, { name: "No Member", ownerMember: false });
  const member = rawDb.prepare(
    "SELECT 1 FROM project_members WHERE project_id=?"
  ).get(result.id);
  assert.equal(member, undefined, "no member row should exist");
});

test("createProjectSpace: slug uses slugify (NFKD normalization)", async () => {
  const result = await createProjectSpace(db, { name: "Café Münze" });
  // slugify strips diacritics: café → cafe, münze → munze
  assert.match(result.slug, /^cafe-munze-\d+$/);
});

test("createProjectSpace: two projects with same name get distinct slugs (unique id suffix)", async () => {
  const a = await createProjectSpace(db, { name: "Duplicate Name" });
  const b = await createProjectSpace(db, { name: "Duplicate Name" });
  assert.notEqual(a.slug, b.slug, "slugs must differ");
  assert.notEqual(a.id, b.id);
});

test("createProjectSpace: explicitSlug mode uses provided slug verbatim", async () => {
  const slug = "imported-project-clone-1";
  const result = await createProjectSpace(db, {
    name: "Imported Project",
    explicitSlug: slug,
  });
  assert.equal(result.slug, slug);
  const row = rawDb.prepare("SELECT slug, workspace_dir, storage_prefix FROM project_spaces WHERE id=?").get(result.id);
  assert.equal(row.slug, slug);
  assert.ok(row.workspace_dir.endsWith(`/${slug}/workspace`), "workspace_dir ends with slug/workspace");
  assert.equal(row.storage_prefix, `projects/${slug}/`);
});

test("createProjectSpace: explicitSlug mode still creates owner member row", async () => {
  const result = await createProjectSpace(db, {
    name: "Clone Project",
    explicitSlug: "clone-project-clone-2",
  });
  const member = rawDb.prepare(
    "SELECT role FROM project_members WHERE project_id=? AND revoked_at IS NULL"
  ).get(result.id);
  assert.ok(member, "member row must exist");
  assert.equal(member.role, "owner");
});

test("createProjectSpace: throws if name is missing", async () => {
  await assert.rejects(
    () => createProjectSpace(db, {}),
    /name is required/
  );
});

test("createProjectSpace: ownerContactId is stored on member row", async () => {
  // Insert a contact row so the FK is satisfied (contacts requires crow_id,
  // ed25519_pubkey, and secp256k1_pubkey NOT NULL)
  const cInfo = rawDb.prepare(
    `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, created_at)
     VALUES (lower(hex(randomblob(16))), lower(hex(randomblob(32))), lower(hex(randomblob(32))), 'Test', datetime('now'))`
  ).run();
  const contactId = cInfo.lastInsertRowid;

  const result = await createProjectSpace(db, {
    name: "Project With Contact",
    ownerContactId: contactId,
  });
  const member = rawDb.prepare(
    "SELECT contact_id FROM project_members WHERE project_id=? AND revoked_at IS NULL"
  ).get(result.id);
  assert.equal(member.contact_id, contactId);
});

test("updateProjectSpaceMeta: updates name, description, status", async () => {
  const { id } = await createProjectSpace(db, { name: "Update Me" });

  const affected = await updateProjectSpaceMeta(db, id, {
    name: "Updated Name",
    description: "New desc",
    status: "paused",
  });
  assert.equal(affected, 1);

  const row = rawDb.prepare("SELECT name, description, status, slug FROM project_spaces WHERE id=?").get(id);
  assert.equal(row.name, "Updated Name");
  assert.equal(row.description, "New desc");
  assert.equal(row.status, "paused");
  // slug must NOT change
  assert.match(row.slug, /^update-me-\d+$/);
});

test("updateProjectSpaceMeta: returns 0 when nothing to update", async () => {
  const { id } = await createProjectSpace(db, { name: "No Op" });
  const affected = await updateProjectSpaceMeta(db, id, {});
  assert.equal(affected, 0);
});

test("updateProjectSpaceMeta: rejects empty name string", async () => {
  const { id } = await createProjectSpace(db, { name: "Blank Name Test" });
  await assert.rejects(
    () => updateProjectSpaceMeta(db, id, { name: "   " }),
    /name cannot be empty/
  );
});
