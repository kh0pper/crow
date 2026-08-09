/**
 * Follow-up C — a proxied bundle's webUI port must come from its own instance.
 *
 * manifest.webUI.port is a shared constant, so a co-hosted second instance
 * whose gateway doesn't export the portEnv override silently proxied to the
 * FIRST instance's backend — for the browser bundle, a secondary dashboard's
 * VNC iframe drove the primary's Chrome. resolveWebUIPort() layers the
 * instance's own bundle .env (installer-written, per-instance) between
 * process.env and the manifest default, the same precedence
 * bundles/browser/server/instance.js established in #283.
 *
 * extension-proxy.js resolves CROW_HOME (and BUNDLES_DIR from it) at module
 * load, so CROW_HOME is pointed at a scratch dir BEFORE the import —
 * extension-proxy-auth-token.test.js idiom.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-port-"));
process.env.CROW_HOME = CROW_HOME;

after(() => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

const { resolveWebUIPort } = await import("../servers/gateway/routes/extension-proxy.js");

const PORT_ENV = "CROW_BROWSER_VNC_PORT_TEST";

beforeEach(() => {
  delete process.env[PORT_ENV];
});

function bundleDir(id) {
  return join(CROW_HOME, "bundles", id);
}

function writeBundleEnv(id, contents) {
  const dir = bundleDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
}

test("process.env[portEnv] wins when set", () => {
  const id = "browser-a";
  mkdirSync(bundleDir(id), { recursive: true });
  writeBundleEnv(id, `${PORT_ENV}=6081\n`);
  process.env[PORT_ENV] = "7000";
  try {
    const manifest = { webUI: { port: 6080, portEnv: PORT_ENV } };
    assert.equal(resolveWebUIPort(manifest, id), 7000);
  } finally {
    delete process.env[PORT_ENV];
  }
});

test("the bundle .env value is used when process.env has none (the bug this fixes)", () => {
  const id = "browser-b";
  writeBundleEnv(id, `${PORT_ENV}=6081\n`);
  const manifest = { webUI: { port: 6080, portEnv: PORT_ENV } };
  assert.equal(resolveWebUIPort(manifest, id), 6081,
    "a secondary instance's own bundle .env must win over the shared manifest default");
});

test("manifest.webUI.port is the fallback when neither process.env nor the bundle .env has a value", () => {
  const id = "browser-c";
  mkdirSync(bundleDir(id), { recursive: true });
  // No .env file at all for this bundle.
  const manifest = { webUI: { port: 6080, portEnv: PORT_ENV } };
  assert.equal(resolveWebUIPort(manifest, id), 6080);
});

test("a manifest with no portEnv returns manifest.webUI.port unchanged", () => {
  const id = "minio";
  writeBundleEnv(id, `${PORT_ENV}=6081\n`); // present but irrelevant — no portEnv key names it
  const manifest = { webUI: { port: 9001 } };
  assert.equal(resolveWebUIPort(manifest, id), 9001);
});

test("a bundle with no .env file does not throw", () => {
  const id = "no-env-bundle";
  // Deliberately do not create bundleDir(id) at all.
  const manifest = { webUI: { port: 5555, portEnv: PORT_ENV } };
  assert.doesNotThrow(() => resolveWebUIPort(manifest, id));
  assert.equal(resolveWebUIPort(manifest, id), 5555);
});
