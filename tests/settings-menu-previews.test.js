/**
 * Settings menu previews (settings audit 2026-10-20).
 *
 * The menu called getPreview({ settings, lang }) without `db`, so every
 * db-backed preview threw into its catch and showed a fallback forever:
 * LLM Orchestrator always read "LLM orchestrator", Data hygiene / Passwords /
 * Paired Instances / Sync Conflicts / Cross-Host Audit always read "-".
 * Paired Instances also counted this instance's own row as a peer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "settings-menu-previews-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") },
    stdio: "pipe", cwd: REPO_ROOT,
  });
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_DB_PATH = join(dir, "crow.db");
  return dir;
}

function previewOf(html, sectionId) {
  const re = new RegExp(`href="/dashboard/settings\\?section=${sectionId}"[\\s\\S]*?<span class="settings-row-preview">([\\s\\S]*?)</span>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

test("menu previews get the db: LLM counts enabled providers, Data hygiene scans, Paired excludes this instance", async () => {
  const dir = freshDb();
  try {
    const { createDbClient } = await import("../servers/db.js");
    const db = createDbClient();
    const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
    const localId = getOrCreateLocalInstanceId();

    for (const [id, disabled] of [["p-on-1", 0], ["p-on-2", 0], ["p-off", 1]]) {
      await db.execute({
        sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?, 'http://127.0.0.1:1/v1', '[]', ?)",
        args: [id, disabled],
      });
    }
    await db.execute({
      sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status) VALUES (?, 'this one', 'crow:test', 'active')",
      args: [localId],
    });

    const { renderSettingsMenu } = await import("../servers/gateway/dashboard/settings/menu-renderer.js");
    const sections = [
      (await import("../servers/gateway/dashboard/settings/sections/llm.js")).default,
      (await import("../servers/gateway/dashboard/settings/sections/data-hygiene.js")).default,
      (await import("../servers/gateway/dashboard/settings/sections/paired-instances.js")).default,
      (await import("../servers/gateway/dashboard/settings/sections/sync-conflicts.js")).default,
      (await import("../servers/gateway/dashboard/settings/sections/audit-log.js")).default,
    ];
    const html = await renderSettingsMenu(sections, db, "en");

    assert.equal(previewOf(html, "llm"), "2 providers", "counts enabled providers only");
    assert.equal(previewOf(html, "data-hygiene"), "clean");
    // Paired Instances is hidden from the menu until a peer exists (hiddenUnless: "peer"),
    // so read its preview directly.
    assert.equal(await sections[2].getPreview({ settings: {}, db, lang: "en" }), "0 active", "this instance's own row is not a peer");
    assert.equal(previewOf(html, "sync-conflicts"), "none");
    assert.equal(previewOf(html, "audit-log"), "0 in 24h");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identity preview shows the Crow ID prefix, never 'undefined...' (scratch data dir, own process)", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-identity-preview-"));
  try {
    const sectionPath = join(REPO_ROOT, "servers/gateway/dashboard/settings/sections/identity.js");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const s = (await import(${JSON.stringify(sectionPath)})).default; process.stdout.write(String(await s.getPreview({})));`],
      { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") }, cwd: REPO_ROOT, encoding: "utf8" });
    assert.ok(!out.includes("undefined"), `got ${out}`);
    assert.match(out, /^crow:[0-9a-z]{7}\.\.\.$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("previews are escaped (they can carry synced values)", async () => {
  const { renderSettingsMenu } = await import("../servers/gateway/dashboard/settings/menu-renderer.js");
  const evil = { id: "evil", group: "appearance", labelKey: "settings.section.blog", async getPreview() { return '<img src=x onerror="alert(1)">'; } };
  const fakeDb = { execute: async () => ({ rows: [] }) };
  const html = await renderSettingsMenu([evil], fakeDb, "en");
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
