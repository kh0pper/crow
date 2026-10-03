/** Env-var scoping for bundles (Crow Workspace W1, Task 2). Scratch CROW_HOME before import. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-envscope-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-envscope-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;

const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-envscope-app-"));
B._setAppBundlesForTest(FIXTURES);
const GATEWAY_ENV = join(mkdtempSync(join(tmpdir(), "crow-envscope-gw-")), ".env");
writeFileSync(GATEWAY_ENV, "# gateway env\n");
B._setAppEnvPathForTest(GATEWAY_ENV);
after(() => {
  B._setAppEnvPathForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

async function withApp(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const SAFE = "^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$";
const ENV_VARS = [
  { name: "WS_ADMIN_USER", default: "admin", propagate: false },
  { name: "WS_ADMIN_PASSWORD", install_required: true, secret: true, propagate: false, pattern: SAFE, pattern_hint: "12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~" },
  { name: "WS_DB_PASSWORD", required: true, generate: "secret" },
  { name: "WS_PLAIN_URL", required: false },
];
function fixture(id, { compose = null } = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: ENV_VARS }));
  if (compose) writeFileSync(join(dir, "docker-compose.yml"), compose);
  return dir;
}

test("gatewayExcludedKeys = generated + propagate:false", () => {
  assert.deepEqual([...S.gatewayExcludedKeys({ env_vars: ENV_VARS })].sort(), ["WS_ADMIN_PASSWORD", "WS_ADMIN_USER", "WS_DB_PASSWORD"]);
});

test("REVIEW FOCUS 5a — generated and propagate:false keys never reach the gateway .env", () => {
  const subset = B.declaredEnvSubset({ env_vars: ENV_VARS }, { WS_ADMIN_USER: "admin", WS_ADMIN_PASSWORD: "Correct-Horse-1", WS_DB_PASSWORD: "x", WS_PLAIN_URL: "http://a" });
  assert.deepEqual(subset, { WS_PLAIN_URL: "http://a" });
});

test("envPatternViolation: blank skipped, match ok, mismatch named by key (value never echoed)", () => {
  const m = { env_vars: ENV_VARS };
  assert.equal(S.envPatternViolation(m, {}), null);
  assert.equal(S.envPatternViolation(m, { WS_ADMIN_PASSWORD: "" }), null);
  assert.equal(S.envPatternViolation(m, { WS_ADMIN_PASSWORD: "Good.Pass-word_1" }), null);
  for (const bad of ["pa$$word12345", "has space 12345", "hash#tag123456", "quote'd1234567", "semi;colon12345", "short1"]) {
    const v = S.envPatternViolation(m, { WS_ADMIN_PASSWORD: bad });
    assert.ok(v, `expected refusal for ${JSON.stringify(bad)}`);
    assert.equal(v.key, "WS_ADMIN_PASSWORD");
    assert.ok(!v.why.includes(bad));
  }
});

test("installBlockingEnvKeys: generated keys never block; install_required blocks without any compose reference", () => {
  fixture("ws-block", { compose: "services:\n  a:\n    image: busybox:1.36\n    environment:\n      P: ${WS_DB_PASSWORD:?gen}\n" });
  assert.deepEqual(B.installBlockingEnvKeys("ws-block"), ["WS_ADMIN_PASSWORD"]);
  assert.deepEqual(B.missingInstallEnv("ws-block", { WS_ADMIN_PASSWORD: "Correct-Horse-1" }), []);
});

test("REVIEW FOCUS 2 — unsafe admin password refused before anything is written", async () => {
  fixture("ws-pattern");
  const v = await B.validateInstall("ws-pattern", { envVars: { WS_ADMIN_PASSWORD: "pa$$ w0rd#'; rm" }, requireEnv: true, forceInstall: true });
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
  assert.equal(v.code, "invalid_env");
  assert.match(v.error, /WS_ADMIN_PASSWORD/);
  assert.equal(existsSync(join(CROW_HOME, "bundles", "ws-pattern")), false);
});

test("a missing install_required password is refused; a safe one passes", async () => {
  fixture("ws-req");
  const miss = await B.validateInstall("ws-req", { envVars: {}, requireEnv: true, forceInstall: true });
  assert.equal(miss.code, "missing_required_env");
  const ok = await B.validateInstall("ws-req", { envVars: { WS_ADMIN_PASSWORD: "Correct-Horse-Battery-9" }, requireEnv: true, forceInstall: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("Configure refuses a pattern-violating value with 400 invalid_env and leaves the .env untouched", async () => {
  const dir = join(CROW_HOME, "bundles", "ws-cfg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "ws-cfg", name: "ws-cfg", type: "bundle", version: "0.1.0", env_vars: ENV_VARS }));
  writeFileSync(join(dir, ".env"), "WS_ADMIN_USER=admin\n", { mode: 0o600 });
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "ws-cfg", env_vars: { WS_ADMIN_PASSWORD: "bad $value here" } }),
    });
    const body = await r.json();
    assert.equal(r.status, 400);
    assert.equal(body.code, "invalid_env");
  } finally { server.close(); }
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WS_ADMIN_USER=admin\n");
  assert.ok(!readFileSync(GATEWAY_ENV, "utf8").includes("WS_ADMIN"));
});

test("not_breached: a breached value is refused via k-anonymity (5-char prefix only); offline → no verdict", async () => {
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha1").update("Password1234").digest("hex").toUpperCase();
  const urls = [];
  const fakeFetch = async (url) => { urls.push(url); return { ok: true, text: async () => `0000000000000000000000000000000000A:3\r\n${sha.slice(5)}:41234\r\n` }; };
  const m = { env_vars: [{ name: "P", check: "not_breached" }] };
  const v = await S.breachedValueViolation(m, { P: "Password1234" }, { fetchImpl: fakeFetch });
  assert.equal(v.key, "P");
  assert.ok(!v.why.includes("Password1234"));
  assert.deepEqual(urls, [`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`]);
  assert.equal(await S.breachedValueViolation(m, { P: "Never-Seen-Before-9" }, { fetchImpl: fakeFetch }), null);
  assert.equal(await S.breachedValueViolation(m, { P: "Password1234" }, { fetchImpl: async () => { throw new Error("offline"); } }), null);
  fixture("ws-breach");
  B._setBreachFetchForTest(fakeFetch);
  const manifestPath = join(FIXTURES, "ws-breach", "manifest.json");
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  man.env_vars = man.env_vars.map((e) => (e.name === "WS_ADMIN_PASSWORD" ? { ...e, check: "not_breached" } : e));
  writeFileSync(manifestPath, JSON.stringify(man));
  const r = await B.validateInstall("ws-breach", { envVars: { WS_ADMIN_PASSWORD: "Password1234" }, requireEnv: true, forceInstall: true });
  B._setBreachFetchForTest(null);
  assert.equal(r.code, "invalid_env");
  assert.match(r.error, /known data breaches/);
});

test("the store never sends a generated key to the browser", () => {
  const { addonRegistryScript } = buildExtensionsHTML({
    installed: {}, available: [{ id: "ws-ui", name: "WS", description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: ENV_VARS }],
    collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
  });
  assert.ok(!addonRegistryScript.includes("WS_DB_PASSWORD"));
  assert.ok(addonRegistryScript.includes("WS_ADMIN_PASSWORD"));
});

test("REVIEW FOCUS 2 (route) — POST /bundles/api/install with an unsafe password: 400 invalid_env, nothing written", async () => {
  fixture("ws-route");
  await withApp(async (base) => {
    const r = await fetch(`${base}/bundles/api/install`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "ws-route", env_vars: { WS_ADMIN_PASSWORD: "pa$$ w0rd#'; rm -rf" }, force_install: true }),
    });
    const body = await r.json();
    assert.equal(r.status, 400);
    assert.equal(body.code, "invalid_env");
    assert.equal(body.key, "WS_ADMIN_PASSWORD");
    assert.ok(!JSON.stringify(body).includes("rm -rf"));
  });
  assert.equal(existsSync(join(CROW_HOME, "bundles", "ws-route")), false);
  assert.equal(existsSync(join(CROW_HOME, "secrets", "bundle-env", "ws-route.env")), false);
  assert.ok(!readFileSync(GATEWAY_ENV, "utf8").includes("WS_ADMIN"));
});

test("breachedValueViolation clears its timer even when fetch rejects (no lingering handle)", async () => {
  const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const m = { env_vars: [{ name: "P", check: "not_breached" }] };
  for (let i = 0; i < 5; i++) await S.breachedValueViolation(m, { P: "x" + i }, { fetchImpl: async () => { throw new Error("offline"); }, timeoutMs: 60000 });
  assert.equal(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length, before);
});
