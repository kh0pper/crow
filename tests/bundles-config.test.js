// tests/bundles-config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Unit tests for servers/gateway/bundles-config.js — the single source of truth
 * for bundle config resolution (CROW_HOME/BUNDLES_DIR, APP_BUNDLES, getManifest,
 * getInstalledFirstManifest, resolveEffectiveEnv, needsConfigKeys).
 *
 * Isolation rules (non-negotiable — see tests/install-set-e2e.test.js:35-39, where a
 * prior run of a test in this family actually installed a bundle on the operator's
 * live host): CROW_HOME/CROW_DATA_DIR point at a scratch dir set BEFORE a dynamic
 * import (the module captures CROW_HOME at load, so ESM import hoisting would read
 * the real ~/.crow), and APP_BUNDLES is repointed at a scratch fixture source tree
 * via _setAppBundlesForTest. The real ~/.crow is never read or written.
 */

const home = mkdtempSync(join(tmpdir(), "crowhome-cfg-"));
mkdirSync(join(home, "bundles"), { recursive: true });
mkdirSync(join(home, "data"), { recursive: true });
process.env.CROW_HOME = home;
process.env.CROW_DATA_DIR = join(home, "data");

const appBundles = mkdtempSync(join(tmpdir(), "crow-fixture-bundles-cfg-"));

// Import AFTER the env is set.
const {
  needsConfigKeys,
  resolveEffectiveEnv,
  getManifest,
  getInstalledFirstManifest,
  _setAppBundlesForTest,
} = await import("../servers/gateway/bundles-config.js");
_setAppBundlesForTest(appBundles);

process.on("exit", () => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  try { rmSync(appBundles, { recursive: true, force: true }); } catch {}
});

/** Write a manifest into the fixture REPO tree (APP_BUNDLES). */
function repoBundle(id, envVars, extra = {}) {
  const dir = join(appBundles, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id, name: id, type: "bundle", version: "1.0.0", env_vars: envVars, ...extra,
  }, null, 2));
}

/** Write a manifest into the INSTALLED tree (CROW_HOME/bundles). */
function installedBundle(id, envVars, extra = {}) {
  const dir = join(home, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id, name: id, type: "bundle", version: "1.0.0", env_vars: envVars, ...extra,
  }, null, 2));
  return dir;
}

/** Write CROW_HOME/bundles/<id>/.env */
function writeDotEnv(id, kv) {
  const dir = join(home, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

/** Rewrite CROW_HOME/mcp-addons.json with the given map. */
function writeMcpAddons(map) {
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify(map, null, 2));
}

const REQ = (...names) => names.map((n) => ({ name: n, required: true }));

test("managed-evidence gate: no .env and no mcp-addons entry => nothing reported (fail closed)", () => {
  // The measured prod case: capstone-tracker's installed dir holds ONLY manifest.json;
  // frigate has no .env. existsSync(bundleDir) passes for both, so it is the wrong gate.
  // Without positive evidence the gateway manages this bundle's config we cannot tell
  // "unconfigured" from "not managed this way" — and a false nag is worse than none.
  repoBundle("fx-stub", REQ("FX_A", "FX_B"));
  installedBundle("fx-stub", REQ("FX_A", "FX_B")); // manifest only — no .env
  writeMcpAddons({});
  assert.deepEqual(needsConfigKeys("fx-stub"), []);
});

test("a .env with every required key filled reports nothing", () => {
  repoBundle("fx-docker-ok", REQ("FX_URL", "FX_KEY"));
  installedBundle("fx-docker-ok", REQ("FX_URL", "FX_KEY"));
  writeDotEnv("fx-docker-ok", { FX_URL: "http://localhost:1", FX_KEY: "abc" });
  writeMcpAddons({});
  assert.deepEqual(needsConfigKeys("fx-docker-ok"), []);
});

test("a .env with an empty required key reports exactly that key", () => {
  repoBundle("fx-docker-partial", REQ("FX_URL", "FX_KEY"));
  installedBundle("fx-docker-partial", REQ("FX_URL", "FX_KEY"));
  writeDotEnv("fx-docker-partial", { FX_URL: "http://localhost:2", FX_KEY: "   " }); // whitespace = empty
  writeMcpAddons({});
  assert.deepEqual(needsConfigKeys("fx-docker-partial"), ["FX_KEY"]);
});

test("an MCP add-on configured via mcp-addons.json only (no .env) reports nothing", () => {
  // The day-one prod bug: MCP children are spawned with { ...process.env, ...config.env }
  // from mcp-addons.json (proxy.js:145) — they never read bundles/<id>/.env. A working
  // add-on has no .env at all and must not be badged.
  repoBundle("fx-mcp", REQ("FX_TOKEN"), { server: { command: "node", args: [] } });
  installedBundle("fx-mcp", REQ("FX_TOKEN"), { server: { command: "node", args: [] } });
  writeMcpAddons({ "fx-mcp": { command: "node", args: [], env: { FX_TOKEN: "live-token" } } });
  assert.deepEqual(needsConfigKeys("fx-mcp"), []);
});

test("an MCP add-on whose required key comes only from ambient process.env reports nothing", () => {
  repoBundle("fx-mcp-ambient", REQ("FX_AMBIENT_TOKEN"), { server: { command: "node", args: [] } });
  installedBundle("fx-mcp-ambient", REQ("FX_AMBIENT_TOKEN"), { server: { command: "node", args: [] } });
  // Registered as an MCP add-on but with no env of its own — the value is supplied by the
  // gateway's own environment (systemd Environment=), which proxy.js passes to the child.
  writeMcpAddons({ "fx-mcp-ambient": { command: "node", args: [] } });
  process.env.FX_AMBIENT_TOKEN = "from-systemd";
  try {
    assert.deepEqual(needsConfigKeys("fx-mcp-ambient"), []);
  } finally {
    delete process.env.FX_AMBIENT_TOKEN;
  }
});

test("an MCP add-on with no value anywhere reports its required key", () => {
  repoBundle("fx-mcp-empty", REQ("FX_MISSING"), { server: { command: "node", args: [] } });
  installedBundle("fx-mcp-empty", REQ("FX_MISSING"), { server: { command: "node", args: [] } });
  writeMcpAddons({ "fx-mcp-empty": { command: "node", args: [], env: {} } });
  assert.deepEqual(needsConfigKeys("fx-mcp-empty"), ["FX_MISSING"]);
});

test("envOverride short-circuits mcp-addons and process.env — it is the whole truth", () => {
  // tests/bundles-install-set.test.js:40,45 inject a parsed env. If the other sources
  // were still consulted, that unit test's result would depend on whether the HOST
  // happens to carry the bundle in ~/.crow/mcp-addons.json.
  repoBundle("fx-override", REQ("FX_OKEY"), { server: { command: "node", args: [] } });
  installedBundle("fx-override", REQ("FX_OKEY"), { server: { command: "node", args: [] } });
  writeMcpAddons({ "fx-override": { command: "node", args: [], env: { FX_OKEY: "would-satisfy" } } });
  process.env.FX_OKEY = "ambient-would-satisfy";
  try {
    assert.deepEqual(needsConfigKeys("fx-override", { FX_OKEY: "" }), ["FX_OKEY"]);
    assert.deepEqual(needsConfigKeys("fx-override", { FX_OKEY: "given" }), []);
  } finally {
    delete process.env.FX_OKEY;
  }
});

test("a bundle with no required keys reports nothing", () => {
  repoBundle("fx-noreq", [{ name: "FX_OPT", required: false }]);
  installedBundle("fx-noreq", [{ name: "FX_OPT", required: false }]);
  writeDotEnv("fx-noreq", { FX_OPT: "" });
  writeMcpAddons({});
  assert.deepEqual(needsConfigKeys("fx-noreq"), []);
});

test("required keys come from the INSTALLED manifest, not the repo copy", () => {
  // A bundle installed from a version whose manifest no longer matches the repo must
  // still surface the keys the INSTALLED copy actually needs.
  repoBundle("fx-drift", REQ("FX_OLD"));
  installedBundle("fx-drift", REQ("FX_NEW"));
  writeDotEnv("fx-drift", { FX_OLD: "set-in-old" }); // FX_NEW absent
  writeMcpAddons({});
  assert.deepEqual(needsConfigKeys("fx-drift"), ["FX_NEW"]);
  assert.equal(getInstalledFirstManifest("fx-drift").env_vars[0].name, "FX_NEW");
  // getManifest's semantics are UNCHANGED — it still reads the repo only (~18 callers:
  // consent, hardware gate, compose validation, planInstallSet).
  assert.equal(getManifest("fx-drift").env_vars[0].name, "FX_OLD");
});

test("getInstalledFirstManifest falls back to the repo copy when not installed", () => {
  repoBundle("fx-repo-only", REQ("FX_R"));
  assert.equal(getInstalledFirstManifest("fx-repo-only").env_vars[0].name, "FX_R");
  assert.equal(getInstalledFirstManifest("fx-nonexistent-xyz"), null);
});

test("resolveEffectiveEnv: .env wins over mcp-addons, which wins over ambient process.env", () => {
  repoBundle("fx-prec", REQ("FX_P1", "FX_P2", "FX_P3"), { server: { command: "node", args: [] } });
  const man = installedBundle("fx-prec", REQ("FX_P1", "FX_P2", "FX_P3"), { server: { command: "node", args: [] } }) && getInstalledFirstManifest("fx-prec");
  writeDotEnv("fx-prec", { FX_P1: "from-dotenv" });
  writeMcpAddons({ "fx-prec": { command: "node", args: [], env: { FX_P1: "from-mcp", FX_P2: "from-mcp" } } });
  process.env.FX_P1 = "from-ambient";
  process.env.FX_P2 = "from-ambient";
  process.env.FX_P3 = "from-ambient";
  try {
    const { managed, env } = resolveEffectiveEnv("fx-prec", man);
    assert.equal(managed, true);
    assert.equal(env.FX_P1, "from-dotenv");
    assert.equal(env.FX_P2, "from-mcp");
    assert.equal(env.FX_P3, "from-ambient");
    assert.deepEqual(needsConfigKeys("fx-prec"), []);
  } finally {
    delete process.env.FX_P1;
    delete process.env.FX_P2;
    delete process.env.FX_P3;
  }
});

test("a docker bundle (no mcp-addons entry) never inherits ambient process.env", () => {
  // Compose reads bundles/<id>/.env; the gateway's own environment is NOT the container's.
  repoBundle("fx-docker-ambient", REQ("FX_D_KEY"));
  installedBundle("fx-docker-ambient", REQ("FX_D_KEY"));
  writeDotEnv("fx-docker-ambient", { FX_D_KEY: "" });
  writeMcpAddons({});
  process.env.FX_D_KEY = "ambient-must-not-count";
  try {
    assert.deepEqual(needsConfigKeys("fx-docker-ambient"), ["FX_D_KEY"]);
  } finally {
    delete process.env.FX_D_KEY;
  }
});

test("CROW_HOME is honored: the installed tree read is the scratch one, not ~/.crow", () => {
  // The 1b28d38a invariant. If the module hard-coded homedir()/.crow this fixture —
  // which exists ONLY under the scratch home — would be invisible.
  repoBundle("fx-crowhome", REQ("FX_H"));
  installedBundle("fx-crowhome", REQ("FX_H"));
  writeDotEnv("fx-crowhome", { FX_H: "" });
  writeMcpAddons({});
  assert.deepEqual(needsConfigKeys("fx-crowhome"), ["FX_H"]);
});
