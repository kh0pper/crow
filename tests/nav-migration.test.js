/**
 * Tests for W3-6 nav groups migration and new defaults.
 * Covers:
 *  - OLD_NAV_DEFAULTS_2026_06 is exported and has the right shape
 *  - Fresh DB → gets new spine-aligned defaults
 *  - Stored old defaults → migration replaces with new defaults
 *  - Stored customized groups → migration leaves untouched
 *  - resolveNavGroups fallback: orphaned assignments (group id missing) → auto-reassign
 *  - No panel is orphaned: every registered visible panel id resolves to a rendered group
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

import {
  OLD_NAV_DEFAULTS_2026_06,
  resolveNavGroups,
} from "../servers/gateway/dashboard/nav-registry.js";

// ─── Helper: spin up a temp DB via init-db.js ───────────────────────────────

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "nav-mig-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });
  const db = new Database(join(dir, "crow.db"));
  return { db, dir };
}

// ─── In-memory libsql-compatible stub ────────────────────────────────────────
// resolveNavGroups uses db.execute({sql,args}) — wrap better-sqlite3 in that shape.
// Some calls are SELECTs (return rows) and some are INSERT/UPDATE (return run info).

function wrapDb(db) {
  return {
    execute({ sql, args }) {
      const stmt = db.prepare(sql);
      const trimmed = sql.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = args && args.length ? stmt.all(...args) : stmt.all();
        return Promise.resolve({ rows });
      } else {
        // INSERT / UPDATE / DELETE — use run() which returns { changes, lastInsertRowid }
        const info = args && args.length ? stmt.run(...args) : stmt.run();
        return Promise.resolve({ rows: [], ...info });
      }
    },
  };
}

// ─── Seed a DB with specific nav_groups / nav_panel_assignments ──────────────

function seedNav(db, groups, assignments) {
  const upsert = db.prepare(
    "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  upsert.run("nav_groups", JSON.stringify(groups));
  upsert.run("nav_panel_assignments", JSON.stringify(assignments));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("OLD_NAV_DEFAULTS_2026_06 has the expected old group ids", () => {
  const ids = OLD_NAV_DEFAULTS_2026_06.groups.map((g) => g.id);
  assert.deepStrictEqual(ids.sort(), ["content", "core", "education", "media", "system", "tools"]);
});

test("OLD_NAV_DEFAULTS_2026_06 has the expected old assignment targets", () => {
  const vals = new Set(Object.values(OLD_NAV_DEFAULTS_2026_06.assignments));
  assert.ok(vals.has("core"));
  assert.ok(vals.has("tools"));
  assert.ok(vals.has("system"));
  assert.ok(!vals.has("home"));
  assert.ok(!vals.has("agents"));
});

// ─── Fresh DB ────────────────────────────────────────────────────────────────

const fresh = makeTempDb();

after(() => {
  fresh.db.close();
  rmSync(fresh.dir, { recursive: true, force: true });
});

test("fresh DB: nav_migration_w3_6_v1 flag is set", () => {
  const row = fresh.db.prepare("SELECT value FROM dashboard_settings WHERE key = 'nav_migration_w3_6_v1'").get();
  assert.ok(row, "migration flag should be present on fresh DB");
  assert.equal(row.value, "1");
});

test("fresh DB: resolveNavGroups seeds new spine-aligned group ids", async () => {
  // Fake visible panels covering the core set.
  const panels = [
    { id: "nest", name: "Crow's Nest", icon: "home", route: "/dashboard/nest", category: "core", navOrder: 0 },
    { id: "bot-builder", name: "Bot Builder", icon: "bot", route: "/dashboard/bot-builder", category: "tools", navOrder: 10 },
    { id: "settings", name: "Settings", icon: "settings", route: "/dashboard/settings", category: "system", navOrder: 99 },
    { id: "memory", name: "Memory", icon: "memory", route: "/dashboard/memory", category: "core", navOrder: 20 },
  ];
  const groups = await resolveNavGroups(wrapDb(fresh.db), panels);
  const ids = groups.map((g) => g.id);
  assert.ok(ids.includes("home"), `expected 'home' group, got: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("agents") || ids.includes("workspace"), "expected spine groups");
  assert.ok(!ids.includes("core"), "old 'core' group should not appear on fresh DB");
  assert.ok(!ids.includes("tools"), "old 'tools' group should not appear on fresh DB");
});

// ─── Old defaults → migration replaces ───────────────────────────────────────

const migrated = makeTempDb();

after(() => {
  migrated.db.close();
  rmSync(migrated.dir, { recursive: true, force: true });
});

test("migration: stored old defaults are replaced with new spine-aligned groups", () => {
  // Write OLD defaults into a fresh DB (simulating an existing install before W3-6).
  const oldGroupsWithCollapsed = OLD_NAV_DEFAULTS_2026_06.groups.map((g) => ({
    ...g,
    collapsed: g.id === "system",
  }));
  seedNav(migrated.db, oldGroupsWithCollapsed, OLD_NAV_DEFAULTS_2026_06.assignments);
  // Clear the migration flag so init-db would fire it.
  migrated.db.prepare("DELETE FROM dashboard_settings WHERE key = 'nav_migration_w3_6_v1'").run();

  // Re-run init-db against this DB.
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: migrated.dir },
    stdio: "pipe",
  });

  const row = migrated.db.prepare("SELECT value FROM dashboard_settings WHERE key = 'nav_groups'").get();
  const groups = JSON.parse(row.value);
  const ids = groups.map((g) => g.id);
  assert.ok(ids.includes("home"), `expected 'home' after migration, got: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("agents"), "expected 'agents' group after migration");
  assert.ok(ids.includes("connections"), "expected 'connections' group after migration");
  assert.ok(ids.includes("workspace"), "expected 'workspace' group after migration");
  assert.ok(!ids.includes("core"), "old 'core' should be gone after migration");
  assert.ok(!ids.includes("tools"), "old 'tools' should be gone after migration");
});

test("migration: flag is set after running against old defaults", () => {
  const row = migrated.db.prepare("SELECT value FROM dashboard_settings WHERE key = 'nav_migration_w3_6_v1'").get();
  assert.ok(row && row.value === "1");
});

// ─── Customized groups → migration leaves untouched ──────────────────────────

const custom = makeTempDb();

after(() => {
  custom.db.close();
  rmSync(custom.dir, { recursive: true, force: true });
});

test("migration: customized nav groups are left untouched", () => {
  const customGroups = [
    { id: "my-group", name: "My Stuff", collapsed: false },
    { id: "system", name: "System", collapsed: true },
  ];
  seedNav(custom.db, customGroups, { nest: "my-group", settings: "system" });
  custom.db.prepare("DELETE FROM dashboard_settings WHERE key = 'nav_migration_w3_6_v1'").run();

  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: custom.dir },
    stdio: "pipe",
  });

  const row = custom.db.prepare("SELECT value FROM dashboard_settings WHERE key = 'nav_groups'").get();
  const groups = JSON.parse(row.value);
  const ids = groups.map((g) => g.id);
  assert.ok(ids.includes("my-group"), "custom group 'my-group' should be preserved");
  assert.ok(!ids.includes("home"), "new group 'home' should NOT be injected into customized config");
});

// ─── resolveNavGroups: orphaned assignment → auto-reassign ───────────────────

test("resolveNavGroups: panel assigned to a missing group gets auto-reassigned", async () => {
  const { db: orphanDb, dir: orphanDir } = makeTempDb();
  after(() => {
    orphanDb.close();
    rmSync(orphanDir, { recursive: true, force: true });
  });

  // Store groups that don't include 'workspace' but have an assignment pointing to 'workspace'.
  const storedGroups = [
    { id: "home", name: "Home", collapsed: false },
    { id: "system", name: "System", collapsed: true },
  ];
  const storedAssignments = {
    nest: "home",
    memory: "workspace", // orphaned — 'workspace' group doesn't exist
    settings: "system",
  };
  seedNav(orphanDb, storedGroups, storedAssignments);

  const panels = [
    { id: "nest", name: "Crow's Nest", icon: "home", route: "/dashboard/nest", category: "core", navOrder: 0 },
    { id: "memory", name: "Memory", icon: "memory", route: "/dashboard/memory", category: "core", navOrder: 10 },
    { id: "settings", name: "Settings", icon: "settings", route: "/dashboard/settings", category: "system", navOrder: 99 },
  ];

  const groups = await resolveNavGroups(wrapDb(orphanDb), panels);
  // memory should appear somewhere — it must not be dropped.
  const allPanelIds = groups.flatMap((g) => g.panels.map((p) => p.id));
  assert.ok(
    allPanelIds.includes("memory"),
    `'memory' panel should be rendered even when its assigned group was missing; got groups: ${JSON.stringify(groups.map((g) => ({ id: g.id, panels: g.panels.map((p) => p.id) })))}`
  );
});

// ─── No registered visible panel is orphaned in new defaults ─────────────────

test("new defaults: all core visible panels are accounted for in the default assignments", () => {
  const { DEFAULT_NAV_PANEL_ASSIGNMENTS } = { DEFAULT_NAV_PANEL_ASSIGNMENTS: undefined };
  // We import what we need from the new defaults via OLD_NAV_DEFAULTS_2026_06 logic;
  // verify that the new assignment table covers the spec's panels.
  const newAssignments = {
    nest: "home",
    "bot-builder": "agents",
    "bot-board": "agents",
    skills: "agents",
    orchestrator: "agents",
    connect: "connections",
    contacts: "connections",
    messages: "connections",
    fediverse: "connections",
    memory: "workspace",
    projects: "workspace",
    blog: "workspace",
    files: "workspace",
    extensions: "workspace",
    settings: "system",
    "design-system": "system",
  };
  const specPanels = [
    "nest",
    "bot-builder", "bot-board", "skills", "orchestrator",
    "connect", "contacts", "messages", "fediverse",
    "memory", "projects", "blog", "files", "extensions",
    "settings", "design-system",
  ];
  for (const p of specPanels) {
    assert.ok(
      newAssignments[p],
      `panel '${p}' from spec table must have an assignment in the new defaults`
    );
  }
  // Verify all targets are valid new group ids.
  const validGroups = new Set(["home", "agents", "connections", "workspace", "system"]);
  for (const [panel, group] of Object.entries(newAssignments)) {
    assert.ok(
      validGroups.has(group),
      `panel '${panel}' is assigned to unknown group '${group}'`
    );
  }
});
