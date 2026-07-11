/**
 * Settings-scope coherence D2 — one-shot heal. Stranded broken-era overrides
 * for instance-scope keys are promoted to the global table newest-updated_at-
 * wins and deleted; flag-guarded (__instance_scope_heal_v1); failure-tracked
 * flag (a per-key error leaves the flag unwritten → retry next boot — a
 * DELIBERATE divergence from profile-heal, which never retries); runs with no
 * sync manager at all (ungated posture).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { healInstanceScopeOverridesOnce } from "../servers/gateway/dashboard/settings/instance-scope-heal.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "iscope-heal-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
async function seedOverride(db, localId, key, value, ts) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, ?)",
    args: [key, localId, value, ts],
  });
}
async function seedGlobal(db, key, value, ts) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, ?)",
    args: [key, value, ts],
  });
}
const globalValue = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const overrideCount = async (db, like) =>
  Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE ?", args: [like] })).rows[0].c);
const flagValue = async (db) =>
  (await db.execute("SELECT value FROM dashboard_settings WHERE key = '__instance_scope_heal_v1'")).rows[0]?.value;

function withDataDir(dir, fn) {
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
  });
}

test("heal: promote override-only, newest-wins vs global, blog_* pattern, non-instance keys untouched, flag one-shot", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      const localId = getOrCreateLocalInstanceId();
      // (a) override-only → promoted
      await seedOverride(db, localId, "discovery_enabled", "true", "2026-07-01 10:00:00");
      // (c) override NEWER than global → override wins
      await seedOverride(db, localId, "notification_prefs", '{"types_enabled":["reminder"]}', "2026-07-02 10:00:00");
      await seedGlobal(db, "notification_prefs", '{"types_enabled":["reminder","media"]}', "2026-07-01 09:00:00");
      // (d) global NEWER than override → global preserved, override still deleted
      await seedOverride(db, localId, "blog_title", "Stale UI Title", "2026-03-01 10:00:00");
      await seedGlobal(db, "blog_title", "Live MCP Title", "2026-06-01 10:00:00");
      // (g) non-instance-scope overrides untouched
      await seedOverride(db, localId, "feature_flags", '{"keep":"me"}', "2026-07-01 10:00:00");
      await seedOverride(db, localId, "profile_display_name", "KeepMe", "2026-07-01 10:00:00");

      const n = await healInstanceScopeOverridesOnce(db);
      assert.equal(n, 2, "(a)+(c) promoted; (d) not promoted");
      assert.equal(await globalValue(db, "discovery_enabled"), "true", "(a)");
      assert.equal(await globalValue(db, "notification_prefs"), '{"types_enabled":["reminder"]}', "(c) newer override won");
      assert.equal(await globalValue(db, "blog_title"), "Live MCP Title", "(d) newer global preserved");
      assert.equal(await overrideCount(db, "discovery_%"), 0);
      assert.equal(await overrideCount(db, "notification_%"), 0);
      assert.equal(await overrideCount(db, "blog_%"), 0, "(d) losing override still deleted");
      assert.equal(await overrideCount(db, "feature_flags"), 1, "(g) consistent-key override untouched");
      assert.equal(await overrideCount(db, "profile_%"), 1, "(g) allowlisted-key override untouched");
      assert.match(String(await flagValue(db)), /^done:2$/);

      // (b) second run is a flag-guarded no-op even with a fresh override present
      await seedOverride(db, localId, "discovery_enabled", "false", "2026-07-03 10:00:00");
      const n2 = await healInstanceScopeOverridesOnce(db);
      assert.equal(n2, 0, "(b) flag-guarded");
      assert.equal(await globalValue(db, "discovery_enabled"), "true", "(b) post-flag override not consumed");
    } finally { cleanup(); }
  });
});

test("heal: (e) no overrides → flag set, nothing written; runs with NO sync manager (i)", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      setSettingsSyncManager(null); // (i) ungated posture: null manager must not matter
      const n = await healInstanceScopeOverridesOnce(db);
      assert.equal(n, 0);
      assert.match(String(await flagValue(db)), /^done:0$/, "(e) flag written on clean empty run");
    } finally { cleanup(); }
  });
});

test("heal: (j) NULL-updated_at precedence", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      const localId = getOrCreateLocalInstanceId();
      // global ts NULL → override wins
      await seedOverride(db, localId, "language", "es", "2026-07-01 10:00:00");
      await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('language', 'en', NULL)");
      // override ts NULL, global ts present → global wins (override deleted)
      await seedOverride(db, localId, "tts_voice", "af_bella", null);
      await seedGlobal(db, "tts_voice", "en-US-BrianNeural", "2026-07-01 10:00:00");

      const n = await healInstanceScopeOverridesOnce(db);
      assert.equal(n, 1);
      assert.equal(await globalValue(db, "language"), "es", "global-ts-NULL → override wins");
      assert.equal(await globalValue(db, "tts_voice"), "en-US-BrianNeural", "override-ts-NULL → global wins");
      assert.equal(await overrideCount(db, "tts_voice"), 0, "losing override still deleted");
    } finally { cleanup(); }
  });
});

test("heal: (h) one key's failure does not abort the others AND leaves the flag UNWRITTEN", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      const localId = getOrCreateLocalInstanceId();
      await seedOverride(db, localId, "discovery_enabled", "true", "2026-07-01 10:00:00");
      await seedOverride(db, localId, "language", "es", "2026-07-01 10:00:00");
      // Wrap the db so the global-row lookup for ONE key throws.
      const failingDb = {
        execute: (arg) => {
          const sql = typeof arg === "string" ? arg : arg.sql;
          const args = typeof arg === "string" ? [] : (arg.args || []);
          if (sql.includes("SELECT value, updated_at FROM dashboard_settings WHERE key = ?") && args[0] === "language") {
            throw new Error("injected failure");
          }
          return db.execute(arg);
        },
      };
      const n = await healInstanceScopeOverridesOnce(failingDb);
      assert.equal(n, 1, "the healthy key still promoted");
      assert.equal(await globalValue(db, "discovery_enabled"), "true");
      assert.equal(await flagValue(db), undefined, "(h) flag UNWRITTEN after a per-key failure → retries next boot");

      // Next (clean) boot retries and completes.
      const n2 = await healInstanceScopeOverridesOnce(db);
      assert.equal(n2, 1, "retry promotes the previously-failed key");
      assert.equal(await globalValue(db, "language"), "es");
      assert.match(String(await flagValue(db)), /^done:1$/);
    } finally { cleanup(); }
  });
});
