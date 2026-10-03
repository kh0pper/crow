/**
 * Installer-generated bundle secrets + .env hygiene (Crow Workspace W1, Task 1).
 * bundles.js resolves CROW_HOME at import — scratch dirs are set BEFORE the import.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-envsec-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-envsec-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;

const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-envsec-app-"));
B._setAppBundlesForTest(FIXTURES);
const GATEWAY_ENV = join(mkdtempSync(join(tmpdir(), "crow-envsec-gwenv-")), ".env");
B._setAppEnvPathForTest(GATEWAY_ENV);

after(() => {
  B._setAppEnvPathForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const MANIFEST = {
  id: "demo",
  env_vars: [
    { name: "DEMO_DB_PASSWORD", generate: "secret" },
    { name: "DEMO_JWT", generate: "secret" },
    { name: "DEMO_ADMIN_PASSWORD", required: true, secret: true },
  ],
};
const mode = (p) => statSync(p).mode & 0o777;
const scratch = (prefix) => mkdtempSync(join(tmpdir(), prefix));

test("generatedEnvKeys lists only generate:'secret' vars", () => {
  assert.deepEqual(S.generatedEnvKeys(MANIFEST), ["DEMO_DB_PASSWORD", "DEMO_JWT"]);
  assert.deepEqual(S.generatedEnvKeys({ env_vars: [{ name: "X", generate: "bogus" }] }), []);
  assert.deepEqual(S.generatedEnvKeys(null), []);
});

test("fresh install: one distinct 43-char base64url value per generated key", () => {
  const out = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d-"), crowHome: scratch("h-") });
  assert.deepEqual(Object.keys(out).sort(), ["DEMO_DB_PASSWORD", "DEMO_JWT"]);
  for (const v of Object.values(out)) assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(out.DEMO_DB_PASSWORD, out.DEMO_JWT);
});

test("retained copy is mode 600 inside a mode 700 dir and holds every generated key", () => {
  const home = scratch("h-");
  const out = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d-"), crowHome: home });
  const p = S.retainedEnvPath(home, "demo");
  assert.equal(p, join(home, "secrets", "bundle-env", "demo.env"));
  assert.equal(mode(p), 0o600);
  assert.equal(mode(join(home, "secrets", "bundle-env")), 0o700);
  assert.deepEqual(S.parseEnvText(readFileSync(p, "utf8")), out);
});

test("REVIEW FOCUS 1 — reinstall reuses retained secrets", () => {
  const home = scratch("h-");
  const first = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d1-"), crowHome: home });
  const second = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d2-"), crowHome: home });
  assert.deepEqual(second, first, "a regenerated DB password would lock Nextcloud out of its kept database");
});

test("an existing installed .env value wins over the retained copy", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  S.resolveGeneratedEnv("demo", MANIFEST, { destDir: dest, crowHome: home });
  writeFileSync(join(dest, ".env"), "DEMO_DB_PASSWORD=from-installed-env\n");
  assert.equal(S.resolveGeneratedEnv("demo", MANIFEST, { destDir: dest, crowHome: home }).DEMO_DB_PASSWORD, "from-installed-env");
});

test("a manifest with no generated vars returns {} and writes no retained file", () => {
  const home = scratch("h-");
  assert.deepEqual(S.resolveGeneratedEnv("plain", { env_vars: [{ name: "A" }] }, { destDir: scratch("d-"), crowHome: home }), {});
  assert.equal(existsSync(S.retainedEnvPath(home, "plain")), false);
});

test("stripGeneratedKeys drops generated keys from a request body", () => {
  assert.deepEqual(S.stripGeneratedKeys(MANIFEST, { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "ok" }), { DEMO_ADMIN_PASSWORD: "ok" });
  assert.equal(S.stripGeneratedKeys(MANIFEST, null), null);
});

test("writePrivateFile replaces a 644 file atomically at 600 and leaves no temp file", () => {
  const dir = scratch("w-"); const p = join(dir, ".env");
  writeFileSync(p, "A=1\n", { mode: 0o644 });
  S.writePrivateFile(p, "A=2\n");
  assert.equal(mode(p), 0o600);
  assert.equal(readFileSync(p, "utf8"), "A=2\n");
  assert.deepEqual(readdirSync(dir), [".env"]);
});

test("writeInstallEnv writes .env at 600 on all three rungs; existing file tightened, never clobbered", () => {
  const d1 = scratch("e1-");
  B.writeInstallEnv(d1, { A_KEY: "v" }, null);
  assert.equal(mode(join(d1, ".env")), 0o600);
  const d2 = scratch("e2-");
  writeFileSync(join(d2, ".env.example"), "X=1\n", { mode: 0o644 });
  B.writeInstallEnv(d2, {}, null);
  assert.equal(mode(join(d2, ".env")), 0o600);
  const d3 = scratch("e3-");
  B.writeInstallEnv(d3, {}, { env_vars: [{ name: "K", required: true }] });
  assert.equal(mode(join(d3, ".env")), 0o600);
  const d4 = scratch("e4-");
  writeFileSync(join(d4, ".env"), "KEEP=1\n", { mode: 0o644 });
  B.writeInstallEnv(d4, {}, { env_vars: [{ name: "KEEP" }] });
  assert.equal(readFileSync(join(d4, ".env"), "utf8"), "KEEP=1\n");
  assert.equal(mode(join(d4, ".env")), 0o600);
});

// ── routes ──
function seedInstalled(id, manifest, envText) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "0.1.0", ...manifest }));
  writeFileSync(join(dir, ".env"), envText, { mode: 0o644 });
  chmodSync(join(dir, ".env"), 0o644);
  return dir;
}
async function withRouter(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("Configure leaves the .env at 600 and ignores attempts to overwrite a generated key", async () => {
  const dir = seedInstalled("demo-cfg", { env_vars: MANIFEST.env_vars }, "DEMO_DB_PASSWORD=original\nDEMO_ADMIN_PASSWORD=old\n");
  const r = await withRouter((base) => post(base, "/bundles/api/env", { bundle_id: "demo-cfg", env_vars: { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "newpass" } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const env = S.parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(env.DEMO_DB_PASSWORD, "original");
  assert.equal(env.DEMO_ADMIN_PASSWORD, "newpass");
  assert.equal(mode(join(dir, ".env")), 0o600);
});

test("REVIEW FOCUS 1 (wiring) — install → uninstall route → install keeps the same .env secrets", async () => {
  const id = "demo-cycle";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: MANIFEST.env_vars };
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  const installOnce = async () => {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, { DEMO_ADMIN_PASSWORD: "Correct-Horse-1" }, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, true, out.reason);
    return S.parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  };
  const first = await installOnce();
  await withRouter(async (base) => {
    const r = await post(base, "/bundles/api/uninstall", { bundle_id: id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const deadline = Date.now() + 10_000;
    while (existsSync(join(CROW_HOME, "bundles", id)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  });
  assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false, "uninstall removed the bundle dir");
  const second = await installOnce();
  assert.equal(second.DEMO_DB_PASSWORD, first.DEMO_DB_PASSWORD);
  assert.equal(second.DEMO_JWT, first.DEMO_JWT);
});

test("boot repair tightens every installed bundle .env to 600", async () => {
  const dir = seedInstalled("demo-loose", {}, "PHONE_RUNNER_SECRET=x\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "demo-loose", type: "bundle", version: "0.1.0" }]));
  await B.repairInstalledBundleAssets({ appBundles: FIXTURES, run: async () => ({ stdout: "", stderr: "" }) });
  assert.equal(mode(join(dir, ".env")), 0o600);
});
