/**
 * Settings-scope coherence D1 — INSTANCE_SCOPE_KEYS routing.
 * Instance-scope keys are per-install: they live in the global
 * dashboard_settings table (their readers are global-direct) and NEVER sync.
 * Everything else keeps the legacy downgrade-to-local behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  SYNC_ALLOWLIST,
  INSTANCE_SCOPE_KEYS,
  isSyncable,
  isInstanceScope,
} from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import {
  writeSetting,
  upsertSetting,
  setSettingsSyncManager,
} from "../servers/gateway/dashboard/settings/registry.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "instance-scope-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const globalValue = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const overrideRows = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ?", args: [key] })).rows;

test("isInstanceScope: explicit keys, blog_* prefix, and negatives", () => {
  for (const k of [
    "auto_update_enabled", "auto_update_interval_hours", "notification_prefs",
    "discovery_enabled", "discovery_name", "onboarding_completed_at",
    "language", "tts_voice", "blog_title", "blog_podcast_language", "blog_theme_mode",
  ]) assert.equal(isInstanceScope(k), true, k);
  for (const k of ["feature_flags", "profile_display_name", "blog", "kiosk_mode", "ai_profiles", "", null]) {
    assert.equal(isInstanceScope(k), false, String(k));
  }
});

test("zero overlap between SYNC_ALLOWLIST and INSTANCE_SCOPE_KEYS (pattern-aware both directions)", () => {
  const overlaps = (a, b) => {
    const aPre = a.endsWith("*") ? a.slice(0, -1) : null;
    const bPre = b.endsWith("*") ? b.slice(0, -1) : null;
    if (aPre !== null && bPre !== null) return aPre.startsWith(bPre) || bPre.startsWith(aPre);
    if (aPre !== null) return b.startsWith(aPre);
    if (bPre !== null) return a.startsWith(bPre);
    return a === b;
  };
  for (const s of Object.keys(SYNC_ALLOWLIST)) {
    for (const i of Object.keys(INSTANCE_SCOPE_KEYS)) {
      assert.equal(overlaps(s, i), false, `overlap: allowlist "${s}" vs instance "${i}"`);
    }
  }
});

test("writeSetting routing: instance key → global table, NO override, NO emit (D1)", async () => {
  const { db, cleanup } = fresh();
  const emitted = [];
  setSettingsSyncManager({ emitChange: async (t, op, row) => { emitted.push(row.key); } });
  try {
    const res = await upsertSetting(db, "auto_update_enabled", "false");
    assert.equal(await globalValue(db, "auto_update_enabled"), "false", "lands in dashboard_settings");
    assert.equal((await overrideRows(db, "auto_update_enabled")).length, 0, "no override row");
    assert.equal(emitted.length, 0, "instance-scope write does NOT emit to peers");
    // allowlisted key still emits (control)
    await writeSetting(db, "unified_dashboard_enabled", "true", { scope: "global" });
    assert.deepEqual(emitted, ["unified_dashboard_enabled"], "allowlisted global write still emits");
    // non-listed key still downgrades to local (feature_flags class preserved)
    await upsertSetting(db, "feature_flags", '{"x":1}');
    assert.equal(await globalValue(db, "feature_flags"), undefined, "non-listed key NOT in global table");
    assert.equal((await overrideRows(db, "feature_flags")).length, 1, "non-listed key downgraded to override");
  } finally {
    setSettingsSyncManager(null);
    cleanup();
  }
});

test("writeSetting allowLocalFallback:false — throws for non-listed, succeeds for instance-scope", async () => {
  const { db, cleanup } = fresh();
  try {
    await assert.rejects(
      writeSetting(db, "some_random_key", "v", { scope: "global", allowLocalFallback: false }),
      (err) => err.code === "NotSyncable",
    );
    const r = await writeSetting(db, "discovery_enabled", "true", { scope: "global", allowLocalFallback: false });
    assert.deepEqual(r, { scope: "global", instance_id: null });
    assert.equal(await globalValue(db, "discovery_enabled"), "true");
  } finally { cleanup(); }
});
