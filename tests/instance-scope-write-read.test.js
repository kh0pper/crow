/**
 * Settings-scope coherence §5.3 — end-to-end write→read per family: a UI-style
 * upsertSetting write is visible to each family's REAL reader mechanism
 * (raw global SELECT or actual reader function). These are the exact reads
 * that were blind to UI saves before D1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { upsertSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { createNotification } from "../servers/shared/notifications.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "iscope-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
// The EXACT reader query each family's consumer runs (global-direct):
const rawGlobal = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;

test("auto_update family: UI-style save visible to the timer's global read", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "auto_update_enabled", "false");
    await upsertSetting(db, "auto_update_interval_hours", "12");
    // auto-update.js getSettings(): SELECT ... WHERE key LIKE 'auto_update_%'
    const rows = (await db.execute("SELECT key, value FROM dashboard_settings WHERE key LIKE 'auto_update_%'")).rows;
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.equal(m.auto_update_enabled, "false");
    assert.equal(m.auto_update_interval_hours, "12");
  } finally { cleanup(); }
});

test("notification_prefs: UI-style save actually gates delivery (createNotification returns null)", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "notification_prefs", JSON.stringify({ types_enabled: ["reminder"] }));
    const suppressed = await createNotification(db, {
      type: "media", title: "t", body: "b",
    });
    assert.equal(suppressed, null, "disabled type suppressed by the real delivery gate");
    const delivered = await createNotification(db, {
      type: "reminder", title: "t", body: "b",
    });
    assert.ok(delivered, "enabled type still delivers");
  } finally { cleanup(); }
});

test("discovery family: UI-style save visible to the peer API's global reads", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "discovery_enabled", "true");
    await upsertSetting(db, "discovery_name", "Crow Test");
    assert.equal(await rawGlobal(db, "discovery_enabled"), "true");
    assert.equal(await rawGlobal(db, "discovery_name"), "Crow Test");
  } finally { cleanup(); }
});

test("blog family: UI-style save visible to blog-public/MCP global reads (incl. listed gate)", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "blog_title", "New Title");
    await upsertSetting(db, "blog_listed", "true");
    assert.equal(await rawGlobal(db, "blog_title"), "New Title");
    assert.equal(await rawGlobal(db, "blog_listed"), "true");
  } finally { cleanup(); }
});

test("language + onboarding + tts_voice: UI-style saves visible to their global-direct readers", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "language", "es");
    await upsertSetting(db, "onboarding_completed_at", "2026-07-11T00:00:00.000Z");
    await upsertSetting(db, "tts_voice", "af_bella");
    assert.equal(await rawGlobal(db, "language"), "es");
    assert.ok(await rawGlobal(db, "onboarding_completed_at"));
    assert.equal(await rawGlobal(db, "tts_voice"), "af_bella");
  } finally { cleanup(); }
});
