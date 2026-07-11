/**
 * Settings-scope coherence D5 + D4:
 *  - loadVisionProfiles resolves scope like every other vision_profiles reader
 *    (readSetting: override-then-global) instead of raw global (which returned
 *    [] for every install whose section default-wrote local).
 *  - set_theme is response-only: the dashboard_theme write was vestigial
 *    (zero runtime readers) and is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { loadVisionProfiles } from "../servers/gateway/dashboard/panels/bot-builder/data-queries.js";
import { writeSetting } from "../servers/gateway/dashboard/settings/registry.js";
import themeSection from "../servers/gateway/dashboard/settings/sections/theme.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "iscope-clean-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("D5: loadVisionProfiles sees a LOCAL-scoped vision_profiles row (apiKey stripped)", async () => {
  const { dir, db, cleanup } = fresh();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  try {
    await writeSetting(db, "vision_profiles",
      JSON.stringify([{ id: "v1", name: "Local Vision", apiKey: "sk-secret" }]),
      { scope: "local" });
    const out = await loadVisionProfiles(db);
    assert.equal(out.length, 1, "local-scoped profile visible");
    assert.equal(out[0].name, "Local Vision");
    assert.equal(out[0].apiKey, undefined, "apiKey stripped");
  } finally {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    cleanup();
  }
});

test("D4: set_theme responds ok and writes NOTHING", async () => {
  const executed = [];
  const recorderDb = { execute: async (arg) => { executed.push(typeof arg === "string" ? arg : arg.sql); return { rows: [] }; } };
  let jsonBody = null;
  const res = { json: (b) => { jsonBody = b; }, setHeader() {} };
  const handled = await themeSection.handleAction({
    req: { body: { theme: "light" } }, res, db: recorderDb, action: "set_theme",
  });
  assert.equal(handled, true);
  assert.deepEqual(jsonBody, { ok: true });
  assert.equal(executed.length, 0, "no DB writes from set_theme");
});
