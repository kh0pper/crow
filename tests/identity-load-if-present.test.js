/**
 * loadIdentityIfPresent: opens an existing identity, never creates one.
 * Runs in a child process with its own CROW_DATA_DIR (the module resolves
 * its data dir once at import).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = pathToFileURL(path.join(ROOT, "servers", "sharing", "identity.js")).href;

function run(dataDir, code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, CROW_DATA_DIR: dataDir }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test("loadIdentityIfPresent: null and no file when there is no identity; the same identity when there is one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idlp-"));
  try {
    assert.equal(run(dir, `const m = await import(${JSON.stringify(MOD)}); console.log(String(m.loadIdentityIfPresent()))`), "null");
    assert.ok(!fs.existsSync(path.join(dir, "identity.json")), "nothing created");
    const created = run(dir, `const m = await import(${JSON.stringify(MOD)}); console.log(m.loadOrCreateIdentity().crowId)`);
    const loaded = run(dir, `const m = await import(${JSON.stringify(MOD)}); console.log(m.loadIdentityIfPresent().crowId)`);
    assert.equal(loaded, created);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
