/**
 * Tests for the canonical-slug normalization pass in scripts/init-db.js.
 *
 * Strategy: init a temp DB, seed a project_spaces row carrying a legacy
 * trigger-style slug (the rp→ps triggers were retired in W2-5B3a, but rows
 * they created with SQL-chain slugs still exist in the wild), then re-run
 * init-db.js and verify the normalization pass made the slug canonical.
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

test("normalization: legacy trigger-style slug gets canonical slug on next init-db", () => {
  // Simulate a legacy row left behind by the (retired) rp→ps ins trigger:
  // its SQL replace-chain kept diacritics — "Café Münze" → "café-münze-<id>".
  // slugify() gives "cafe-munze-<id>".
  const ins = db.prepare(
    `INSERT INTO project_spaces (slug, name, type, status)
     VALUES ('café-münze-seed', 'Café Münze', 'general', 'active')`
  ).run();
  const id = Number(ins.lastInsertRowid);
  // Re-shape the slug into the exact id-suffixed legacy form the trigger emitted.
  db.prepare("UPDATE project_spaces SET slug = ? WHERE id = ?").run(`café-münze-${id}`, id);

  const before = db.prepare("SELECT slug, workspace_dir FROM project_spaces WHERE id=?").get(id);
  assert.ok(before, "seed row must exist");
  // The legacy SQL slug keeps diacritics; canonical slugify strips them.
  const canonical = slugify("Café Münze", id);
  assert.notEqual(before.slug, canonical, "pre-norm slug should differ from canonical");
  assert.equal(before.workspace_dir, null, "legacy row has no workspace_dir");

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
