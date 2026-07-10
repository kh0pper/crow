/**
 * Cluster B D3 — one-shot heal: values stranded in dashboard_settings_overrides
 * by the broken-era save_profile are promoted (non-empty only) to the global
 * scope once, flag-guarded, gated OFF for --no-auth companions (feedsDisabled).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { healProfileOverridesOnce } from "../servers/gateway/dashboard/settings/profile-heal.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "profile-heal-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function seedOverride(db, localId, key, value) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))",
    args: [key, localId, value],
  });
}
const globalValue = async (db, key) => (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const overrideCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE 'profile_%'")).rows[0].c);

test("heal: promotes non-empty stranded overrides (override wins over global), deletes empties, one-shot flag, emits", async () => {
  const { dir, db, cleanup } = fresh();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const emitted = [];
  setSettingsSyncManager({ emitChange: async (t, op, row) => { emitted.push(row.key); } });
  try {
    const localId = getOrCreateLocalInstanceId();
    await seedOverride(db, localId, "profile_display_name", "Kevin");   // (a)+(c): promote, wins over global
    await seedOverride(db, localId, "profile_bio", "");                 // (f): empty → delete only
    await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Old Global', datetime('now'))");
    await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_bio', 'Real Bio', datetime('now'))");

    const n = await healProfileOverridesOnce(db, { feedsDisabled: false });
    assert.equal(n, 1, "exactly the one non-empty override promoted");
    assert.equal(await globalValue(db, "profile_display_name"), "Kevin", "(c) override value wins over pre-existing global");
    assert.equal(await globalValue(db, "profile_bio"), "Real Bio", "(f) empty override did NOT blank the real global value");
    assert.equal(await overrideCount(db), 0, "all profile overrides cleared (incl. the empty one)");
    assert.ok(emitted.includes("profile_display_name"), "(e) promotion emitted (manager wired)");
    const flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__profile_override_heal_v1'");
    assert.match(String(flag.rows[0]?.value), /^done:1$/, "flag row written to dashboard_settings via raw SQL");

    // (b) second run is a flag-guarded no-op even with a fresh override present
    await seedOverride(db, localId, "profile_display_name", "Deliberate Local");
    emitted.length = 0;
    const n2 = await healProfileOverridesOnce(db, { feedsDisabled: false });
    assert.equal(n2, 0, "(b) flag-guarded second run no-ops");
    assert.equal(await globalValue(db, "profile_display_name"), "Kevin", "deliberate post-heal override untouched");
    assert.equal(emitted.length, 0);
  } finally {
    setSettingsSyncManager(null);
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    cleanup();
  }
});

test("heal: no overrides → flag still set, nothing written (d); feedsDisabled → FULL no-op, no flag (5d)", async () => {
  const { dir, db, cleanup } = fresh();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  setSettingsSyncManager(null);
  try {
    // 5d: companion gateway (feedsDisabled) must not run NOR mark the flag —
    // it shares the primary's DB and would make the primary skip its own heal.
    const gated = await healProfileOverridesOnce(db, { feedsDisabled: true });
    assert.equal(gated, 0);
    let flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__profile_override_heal_v1'");
    assert.equal(flag.rows.length, 0, "feedsDisabled run left NO flag row");

    // (d): a clean primary marks the flag with zero promotions
    const n = await healProfileOverridesOnce(db, { feedsDisabled: false });
    assert.equal(n, 0);
    flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__profile_override_heal_v1'");
    assert.match(String(flag.rows[0]?.value), /^done:0$/);
  } finally {
    setSettingsSyncManager(null);
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    cleanup();
  }
});

test("boot wiring order pin: setSettingsSyncManager is wired BEFORE the heal, which runs BEFORE the re-emit", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/boot/mcp-mounts.js"), "utf8");
  const wireIdx = src.indexOf("setSettingsSyncManager(syncManager)");
  const healIdx = src.indexOf("healProfileOverridesOnce");
  const reemitIdx = src.indexOf("reemitSyncableSettingsOnce");
  assert.ok(wireIdx > -1 && healIdx > -1 && reemitIdx > -1, "all three call sites present");
  assert.ok(wireIdx < healIdx, "R1 MAJOR-1: manager wired before the heal (else the heal's emit hits a null manager)");
  assert.ok(healIdx < reemitIdx, "heal before re-emit so a promoted value rides the same boot's re-emit");
  assert.match(src, /feedsDisabled/, "heal call site carries the feedsDisabled gate");
});
