/**
 * importIdentity legacy-blob guard (Item 4-PR4 fold-in C12).
 *
 * The legacy import branch used to write ANY base64-JSON blob as-is to
 * identity.json — a garbage blob (valid JSON, no usable seed) produced a
 * corrupt identity file the gateway would then fail to boot from. The guard
 * validates parsed.seed is 64-hex before the as-is write and exits cleanly
 * otherwise (no file written).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function runImport(dataDir, blob) {
  return spawnSync(
    process.execPath,
    ["-e", "import('./servers/sharing/identity.js').then(m => m.importIdentity())", blob],
    { cwd: REPO, env: { ...process.env, CROW_DATA_DIR: dataDir }, encoding: "utf8", timeout: 30000 }
  );
}

test("garbage legacy blob (JSON, no seed) -> clean exit 1, no identity.json written", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-idimport-"));
  const blob = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64");
  const r = runImport(dir, blob);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /seed/i, "error should name the missing/invalid seed");
  assert.ok(!existsSync(join(dir, "identity.json")), "identity.json must NOT be written");
});

test("legacy blob with non-64-hex seed -> clean exit 1, no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-idimport-"));
  const blob = Buffer.from(JSON.stringify({ version: 1, seed: "abc123" })).toString("base64");
  const r = runImport(dir, blob);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr=${r.stderr}`);
  assert.ok(!existsSync(join(dir, "identity.json")), "identity.json must NOT be written");
});

test("valid legacy blob (64-hex seed) still imports as-is", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-idimport-"));
  const seed = "ab".repeat(32); // 64 hex chars
  const content = { version: 1, seed, createdAt: new Date().toISOString() };
  const blob = Buffer.from(JSON.stringify(content)).toString("base64");
  const r = runImport(dir, blob);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const written = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
  assert.equal(written.seed, seed, "legacy blob must be written as-is");
});
