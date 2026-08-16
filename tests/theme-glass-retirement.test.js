/**
 * Track 2 visual language, Task 5 — glass retires end to end (spec §3.4).
 *
 * Task 3 already deleted the glass CSS blocks, class composition, and
 * `themeGlass` reads. This test guards everything Task 5 owns:
 *   1. Orphan grep over servers/ + bundles/ for every glass token — nothing
 *      left except the settings migration (which must NAME the retired keys,
 *      controller ruling) and design-tokens-legacy.js's frozen-snapshot
 *      header comment (prose, not code — its only hit).
 *   2. theme-keys-migration.js deletes the four retired keys from BOTH
 *      dashboard_settings and dashboard_settings_overrides, for every
 *      instance_id, while leaving the three surviving blog_theme_* keys
 *      alone; guarded, idempotent.
 *   3. init-db.js's retired dashboard_theme→blog_theme_dashboard_mode branch
 *      does not resurrect blog_theme_dashboard_mode from a legacy
 *      dashboard_theme='light' row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------ orphan grep */

const ORPHAN_PATTERN = /crow-glass-blur|crow-bg-popup|crow-border-popup|theme-glass|theme_glass|themeGlass/;

// Controller ruling: the settings migration names the retired keys in its
// own source (comments + the RETIRED_KEYS array literally contains
// "blog_theme_glass"), so its directory is exempt from the sweep.
const EXEMPT_DIRS = [
  join(ROOT, "servers/gateway/dashboard/settings/migrations"),
];
// design-tokens-legacy.js's only hit is its frozen-snapshot header comment
// (prose referencing the deleted `.theme-glass` CSS block, not code).
const EXEMPT_FILES = new Set([
  join(ROOT, "servers/gateway/dashboard/shared/design-tokens-legacy.js"),
]);

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (EXEMPT_DIRS.some((d) => p === d || p.startsWith(d + "/"))) continue;
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("orphan sweep: no glass token survives in servers/ or bundles/ outside the exempted migration + frozen-snapshot comment", () => {
  const files = [...walk(join(ROOT, "servers")), ...walk(join(ROOT, "bundles"))]
    .filter((f) => !EXEMPT_FILES.has(f));
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (ORPHAN_PATTERN.test(src)) hits.push(relative(ROOT, f));
  }
  assert.deepEqual(hits, [], `glass tokens still referenced in: ${hits.join(", ")}`);
});

/* ------------------------------------------------------- migration tests */

function freshScratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "theme-keys-migration-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: ROOT,
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir,
    db,
    cleanup() {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const RETIRED_KEYS = ["blog_theme_glass", "blog_theme_dashboard_mode", "dashboard_theme", "blog_theme"];
const SURVIVING_KEYS = ["blog_theme_mode", "blog_theme_serif"];
const INSTANCE_IDS = ["inst-a", "inst-b"];

async function seedBothTables(db) {
  for (const key of [...RETIRED_KEYS, ...SURVIVING_KEYS]) {
    await db.execute({
      sql: `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, 'seed', datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = 'seed'`,
      args: [key],
    });
    for (const instanceId of INSTANCE_IDS) {
      await db.execute({
        sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, 'seed', datetime('now'))
              ON CONFLICT(key, instance_id) DO UPDATE SET value = 'seed'`,
        args: [key, instanceId],
      });
    }
  }
}

async function readAllRows(db) {
  const global = await db.execute({ sql: "SELECT key FROM dashboard_settings", args: [] });
  const overrides = await db.execute({ sql: "SELECT key, instance_id FROM dashboard_settings_overrides", args: [] });
  return {
    globalKeys: new Set(global.rows.map((r) => r.key)),
    overrideKeys: new Set(overrides.rows.map((r) => r.key)),
  };
}

test("theme-keys-migration deletes the four retired keys from both tables for every instance_id, leaves survivors intact, guards, and no-ops on second run", async () => {
  const { db, cleanup } = freshScratchDb();
  try {
    const { migrateThemeKeys } = await import("../servers/gateway/dashboard/settings/migrations/theme-keys-migration.js");
    await seedBothTables(db);

    const result = await migrateThemeKeys(db);
    assert.ok(!result.skipped, "first run must actually migrate");

    const after = await readAllRows(db);
    for (const key of RETIRED_KEYS) {
      assert.ok(!after.globalKeys.has(key), `${key} must be gone from dashboard_settings`);
      assert.ok(!after.overrideKeys.has(key), `${key} must be gone from dashboard_settings_overrides`);
    }
    for (const key of SURVIVING_KEYS) {
      assert.ok(after.globalKeys.has(key), `${key} must survive in dashboard_settings`);
      assert.ok(after.overrideKeys.has(key), `${key} must survive in dashboard_settings_overrides`);
    }

    // Guard flag set.
    const flag = await db.execute({
      sql: "SELECT value FROM dashboard_settings_overrides WHERE key = 'theme_keys_migration_v1_done' UNION SELECT value FROM dashboard_settings WHERE key = 'theme_keys_migration_v1_done'",
      args: [],
    });
    assert.ok(flag.rows.length > 0, "guard flag must be set somewhere");

    // Second run no-ops.
    const second = await migrateThemeKeys(db);
    assert.equal(second.skipped, "already_migrated");
  } finally {
    cleanup();
  }
});

/* --------------------------------------------------- init-db non-resurrection */

test("init-db: a legacy dashboard_theme='light' row with no blog_theme_mode does not resurrect blog_theme_dashboard_mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "initdb-noresurrect-"));
  try {
    // First init to get the schema, then seed the legacy row and re-run
    // init-db against the same DB (idempotent CREATE TABLE IF NOT EXISTS)
    // so the theme-migration block executes against seeded state.
    const env = { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir };
    execFileSync(process.execPath, ["scripts/init-db.js"], { env, stdio: "pipe", cwd: ROOT });

    const db = createClient({ url: "file:" + join(dir, "crow.db") });
    // Seed the legacy row with value 'light' (plan-review finding 4 — any
    // other value would make this test vacuously green because the retired
    // branch only ever fired on 'light').
    await db.execute({
      sql: `INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('dashboard_theme', 'light', datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = 'light'`,
      args: [],
    });
    // Ensure blog_theme_mode is absent so the guard in init-db's theme block
    // would have let a live re-mint branch fire.
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = 'blog_theme_mode'", args: [] });
    db.close();

    execFileSync(process.execPath, ["scripts/init-db.js"], { env, stdio: "pipe", cwd: ROOT });

    const db2 = createClient({ url: "file:" + join(dir, "crow.db") });
    const row = await db2.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_theme_dashboard_mode'",
      args: [],
    });
    db2.close();
    assert.equal(row.rows.length, 0, "blog_theme_dashboard_mode must not be resurrected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
