/**
 * identity.json holds the master seed: it must be 0600 (audit A12(a),
 * 2026-09-24 — the fleet had 0664). New files are created 0600 under any
 * umask, and an existing loose file is tightened on the next load.
 * Runs in a child process so the module's import-time DATA_DIR points at
 * a scratch dir, never the real ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function run(dataDir, code) {
  const r = spawnSync(process.execPath, ["-e", `process.umask(0o002); import('./servers/sharing/identity.js').then(m => { ${code} })`], {
    cwd: REPO, env: { ...process.env, CROW_DATA_DIR: dataDir }, encoding: "utf8", timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);

test("a freshly created identity.json is 0600 even under a 002 umask", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-idmode-"));
  try {
    run(dir, "m.loadOrCreateIdentity()");
    assert.equal(modeOf(join(dir, "identity.json")), "600");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an existing 0664 identity.json is tightened to 0600 on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-idmode-"));
  try {
    run(dir, "m.loadOrCreateIdentity()");
    const p = join(dir, "identity.json");
    chmodSync(p, 0o664);
    const crowIdA = run(dir, "console.log(m.loadOrCreateIdentity().crowId)");
    assert.equal(modeOf(p), "600");
    const crowIdB = run(dir, "console.log(m.loadOrCreateIdentity().crowId)");
    assert.equal(crowIdA, crowIdB, "tightening must not change the identity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
