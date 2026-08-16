/**
 * Settings-scope coherence D5:
 *  - loadVisionProfiles resolves scope like every other vision_profiles reader
 *    (readSetting: override-then-global) instead of raw global (which returned
 *    [] for every install whose section default-wrote local).
 *
 * (D4 — "set_theme responds ok and writes NOTHING" — exercised the set_theme
 * handler, which retired with glass in Track 2 Task 5, spec §3.4. Deleted
 * alongside it.)
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
