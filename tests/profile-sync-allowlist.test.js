/**
 * Cluster B (F-SETTINGS-1/F-CONTACT-5) — the three profile keys are
 * sync-allowlisted so upsertSetting writes the GLOBAL scope and emits to
 * peers, instead of silently downgrading to a local override no reader sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { isSyncable, PROFILE_SYNC_KEYS } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { upsertSetting, setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "profile-allowlist-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("profile keys are sync-allowlisted (F-SETTINGS-1 root fix)", () => {
  for (const k of ["profile_display_name", "profile_avatar_url", "profile_bio"]) {
    assert.equal(isSyncable(k), true, `${k} must be syncable`);
  }
  assert.deepEqual(PROFILE_SYNC_KEYS, ["profile_display_name", "profile_avatar_url", "profile_bio"]);
});

test("explicit-entry posture: an unrelated profile_ key is NOT syncable", () => {
  assert.equal(isSyncable("profile_zzz"), false);
});

test("upsertSetting on a profile key writes the GLOBAL row (no override) and emits", async () => {
  const { dir, db, cleanup } = freshDb();
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const emitted = [];
  setSettingsSyncManager({ emitChange: async (t, op, row) => { emitted.push({ t, op, row }); } });
  try {
    await upsertSetting(db, "profile_display_name", "Kevin");
    const g = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'profile_display_name'");
    assert.equal(g.rows[0]?.value, "Kevin", "global row written");
    const o = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key = 'profile_display_name'");
    assert.equal(Number(o.rows[0].c), 0, "no local-override downgrade");
    assert.ok(
      emitted.some((e) => e.t === "dashboard_settings" && e.op === "update" && e.row.key === "profile_display_name" && e.row.instance_id === null),
      "sync emit fired with instance_id null"
    );
  } finally {
    setSettingsSyncManager(null);
    if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDataDir;
    cleanup();
  }
});
