/**
 * Tests for the canonical-slug normalization pass in scripts/init-db.js.
 *
 * Strategy: init a temp DB, insert a trigger-style row via
 * `INSERT INTO research_projects` (which fires tr_rp_to_ps_ins and produces
 * a SQL-only slug), then re-run init-db.js to trigger the normalization pass
 * and verify the slug became canonical.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";
import { slugify } from "../servers/shared/slugify.js";

const dir = mkdtempSync(join(tmpdir(), "ps-norm-"));

// First init run — creates all tables + triggers.
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const db = new Database(join(dir, "crow.db"));
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("normalization: trigger-inserted accented name gets canonical slug on next init-db", () => {
  // Insert via research_projects so the SQL trigger fires.
  // The trigger slug uses a simple replace-chain — "Café Münze" → "café-münze-<id>"
  // (diacritics NOT stripped). slugify() gives "cafe-munze-<id>".
  const ins = db.prepare(
    "INSERT INTO research_projects (name, type, status) VALUES (?, 'general', 'active')"
  ).run("Café Münze");
  const id = ins.lastInsertRowid;

  // Verify the trigger produced the non-canonical slug.
  const before = db.prepare("SELECT slug, workspace_dir FROM project_spaces WHERE id=?").get(id);
  assert.ok(before, "trigger must have created project_spaces row");
  // The SQL trigger keeps diacritics; canonical slugify strips them.
  const canonical = slugify("Café Münze", id);
  assert.notEqual(before.slug, canonical, "pre-norm slug should differ from canonical");
  assert.equal(before.workspace_dir, null, "trigger row has no workspace_dir");

  // Re-run init-db — the normalization pass should fix the slug.
  db.close(); // release the DB so init-db can open it without WAL contention
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });

  // Reopen to verify.
  const db2 = new Database(join(dir, "crow.db"), { readonly: true });
  const after = db2.prepare("SELECT slug FROM project_spaces WHERE id=?").get(id);
  db2.close();

  assert.equal(after.slug, canonical, "slug must equal slugify(name, id) after normalization");
});

test("normalization: second init-db run is a no-op (idempotent)", () => {
  // Re-run a third time; should produce no errors and no changes.
  const out = execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  }).toString();
  // The normalization log line only prints when a slug changes.
  assert.ok(!out.includes("Normalized slug"), "third run should not normalize anything");
});

test("normalization: row WITH workspace_dir is not re-slugged", () => {
  // Open the DB (after the second run above closed it).
  const db3 = new Database(join(dir, "crow.db"));

  // Insert a project_spaces row directly with a workspace_dir (simulating a
  // helper-created row). Give it a deliberately non-canonical slug.
  const slug = "custom-slug-99";
  db3.prepare(
    `INSERT INTO project_spaces (slug, name, type, status, workspace_dir, storage_prefix)
     VALUES (?, 'Custom Slug Test', 'general', 'active', '/tmp/ws', 'projects/custom-slug-99/')`
  ).run(slug);
  const id = db3.prepare("SELECT last_insert_rowid() AS id").get().id;
  db3.close();

  // Re-run init-db — normalization pass should skip this row.
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });

  const db4 = new Database(join(dir, "crow.db"), { readonly: true });
  const row = db4.prepare("SELECT slug FROM project_spaces WHERE id=?").get(id);
  db4.close();

  assert.equal(row.slug, slug, "slug must be unchanged when workspace_dir is set");
});
