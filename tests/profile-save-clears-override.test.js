/**
 * Cluster B D2 — a profile save writes the global row AND clears the stranded
 * broken-era local override, and the profile page reader (getMyProfile) sees
 * the saved value on the very next read (the F-SETTINGS-1 symptom).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { getMyProfile } from "../servers/gateway/dashboard/panels/contacts/data-queries.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "profile-save-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("save_profile writes global, clears the stranded override, and getMyProfile sees it", async () => {
  const { dir, db, cleanup } = freshDb();
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  setSettingsSyncManager(null); // emits are not this test's subject
  try {
    const localId = getOrCreateLocalInstanceId();
    // Seed the broken-era state: value stranded in the override, global empty.
    await db.execute({
      sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES ('profile_display_name', ?, 'Stranded', datetime('now'))",
      args: [localId],
    });

    const req = { body: { action: "save_profile", display_name: "Kevin", bio: "Hello" } };
    const out = await handleContactAction(req, db, {});
    assert.ok(out && out.redirect, "save redirects");

    const g = await db.execute("SELECT key, value FROM dashboard_settings WHERE key IN ('profile_display_name','profile_bio')");
    const byKey = Object.fromEntries(g.rows.map((r) => [r.key, r.value]));
    assert.equal(byKey.profile_display_name, "Kevin", "global name row written");
    assert.equal(byKey.profile_bio, "Hello", "global bio row written");

    const o = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE 'profile_%'");
    assert.equal(Number(o.rows[0].c), 0, "stranded override cleared (D2)");

    const profile = await getMyProfile(db);
    assert.equal(profile.display_name, "Kevin", "the profile page reader sees the save immediately");
    assert.equal(profile.bio, "Hello");
  } finally {
    setSettingsSyncManager(null);
    if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDataDir;
    cleanup();
  }
});
