import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolation rule as bundles-install-job.test.js: bundles.js resolves its
// paths from CROW_HOME at module load — point it at a scratch dir BEFORE import.
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
const { writeInstallEnv } = await import("../servers/gateway/routes/bundles.js");

const scratchDest = () => mkdtempSync(join(tmpdir(), "crow-env-dest-"));

test("provided non-empty values are written to .env; empty/undefined values dropped", () => {
  const dest = scratchDest();
  writeInstallEnv(dest, { A_KEY: "v1", EMPTY: "", GONE: undefined, B_KEY: "v2" }, null);
  const content = readFileSync(join(dest, ".env"), "utf8");
  assert.equal(content, "A_KEY=v1\nB_KEY=v2\n");
});

test("UI install with zero usable values falls back to .env.example (the dead-fallback bug)", () => {
  // The old code only consulted .env.example when envVars was NOT an object —
  // but the install modal ALWAYS sends an object, so the fallback was dead for
  // every UI install. A required-keys-left-blank UI install must still get the
  // example copied.
  const dest = scratchDest();
  writeFileSync(join(dest, ".env.example"), "REQ_KEY=\n# fill me in\n");
  writeInstallEnv(dest, { REQ_KEY: "" }, { env_vars: [{ name: "REQ_KEY", required: true }] });
  assert.ok(existsSync(join(dest, ".env")), ".env.example fallback must fire for a zero-value UI install");
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), "REQ_KEY=\n# fill me in\n");
});

test("vaultwarden shape: zero values, NO .env.example, manifest declares env vars → placeholder .env (managed evidence)", () => {
  // Without ANY .env the needs-setup badge fails closed (resolveEffectiveEnv
  // managed:false) and the bundle can never badge — ~20 shipped bundles have a
  // required-no-default key and no .env.example (vaultwarden, gitea, immich, …).
  const dest = scratchDest();
  writeInstallEnv(dest, {}, { env_vars: [{ name: "MQTT_HOST", required: true }] });
  assert.ok(existsSync(join(dest, ".env")), "placeholder .env must be written so the bundle can badge");
  const content = readFileSync(join(dest, ".env"), "utf8");
  assert.ok(content.startsWith("#"), "placeholder must be comment-only (no KEY= lines — empty-string env vars change container semantics)");
  assert.ok(!/^[A-Z_]+=/m.test(content), "placeholder must not set any variable");
});

test("zero values, no example, manifest with NO env vars → no .env littered", () => {
  const dest = scratchDest();
  writeInstallEnv(dest, {}, { env_vars: [] });
  assert.ok(!existsSync(join(dest, ".env")));
  writeInstallEnv(dest, {}, null);
  assert.ok(!existsSync(join(dest, ".env")));
});

test("an existing .env is never clobbered by the fallback paths", () => {
  const dest = scratchDest();
  writeFileSync(join(dest, ".env"), "KEEP=1\n");
  writeFileSync(join(dest, ".env.example"), "KEEP=example\n");
  writeInstallEnv(dest, {}, { env_vars: [{ name: "KEEP", required: true }] });
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), "KEEP=1\n");
});

test("non-object envVars keeps the original example-copy behavior", () => {
  const dest = scratchDest();
  writeFileSync(join(dest, ".env.example"), "X=1\n");
  writeInstallEnv(dest, null, null);
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), "X=1\n");
});
