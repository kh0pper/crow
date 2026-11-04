/**
 * Installer-generated bundle secrets + .env hygiene (Crow Workspace W1, Task 1).
 * bundles.js resolves CROW_HOME at import — scratch dirs are set BEFORE the import.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-envsec-home-"));
process.env.CROW_HOME = TMP_HOME;
const TMP_DATA = mkdtempSync(join(tmpdir(), "crow-envsec-data-"));
process.env.CROW_DATA_DIR = TMP_DATA;
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
  for (const d of [TMP_HOME, TMP_DATA, FIXTURES]) rmScratch(d);
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

test("install ignores a request-supplied generated key: not in .env, not in the gateway .env", async () => {
  const id = "demo-attack";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: MANIFEST.env_vars };
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "Correct-Horse-1" }, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  const env = S.parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  assert.notEqual(env.DEMO_DB_PASSWORD, "attacker");
  assert.match(env.DEMO_DB_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
  const gw = existsSync(GATEWAY_ENV) ? readFileSync(GATEWAY_ENV, "utf8") : "";
  assert.equal(gw.includes("attacker"), false);
  assert.equal(gw.includes(env.DEMO_DB_PASSWORD), false);
});

test("a bundle with a generated key keeps its .env.example defaults (mode 600)", async () => {
  const id = "demo-example";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: MANIFEST.env_vars };
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(FIXTURES, id, ".env.example"), "DEMO_REGION=eu-west\n");
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, { DEMO_ADMIN_PASSWORD: "Correct-Horse-1" }, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  const p = join(CROW_HOME, "bundles", id, ".env");
  const env = S.parseEnvText(readFileSync(p, "utf8"));
  assert.equal(env.DEMO_REGION, "eu-west");
  assert.match(env.DEMO_DB_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(env.DEMO_ADMIN_PASSWORD, "Correct-Horse-1");
  assert.equal(mode(p), 0o600);
});

test("resolveGeneratedEnv rejects an invalid bundle id before touching CROW_HOME", () => {
  assert.throws(() => S.resolveGeneratedEnv("../evil", MANIFEST, { destDir: scratch("d-"), crowHome: scratch("h-") }), /Invalid bundle ID/);
});

// ── Garage (PR 1): hex32 + garage_key_id kinds, and propagate_as ──

test("generate: hex32 mints 64 lowercase hex chars (32 bytes); garage_key_id mints GK + 24 hex", () => {
  for (let i = 0; i < 5; i++) {
    assert.match(S.newSecretValue("hex32"), /^[0-9a-f]{64}$/);
    assert.match(S.newSecretValue("garage_key_id"), /^GK[0-9a-f]{24}$/);
  }
  assert.notEqual(S.newSecretValue("hex32"), S.newSecretValue("hex32"));
  assert.ok(S.GENERATE_KIND_NAMES.includes("hex32"));
  assert.ok(S.GENERATE_KIND_NAMES.includes("garage_key_id"));
});

test("hex32 / garage_key_id are generated keys: minted once, reused on reinstall", () => {
  const m = { env_vars: [{ name: "K_ID", generate: "garage_key_id" }, { name: "K_SECRET", generate: "hex32" }] };
  const home = scratch("h-");
  const dest = scratch("d-");
  const first = S.resolveGeneratedEnv("hexdemo", m, { destDir: dest, crowHome: home });
  assert.match(first.K_ID, /^GK[0-9a-f]{24}$/);
  assert.match(first.K_SECRET, /^[0-9a-f]{64}$/);
  const again = S.resolveGeneratedEnv("hexdemo", m, { destDir: scratch("d-"), crowHome: home });
  assert.deepEqual(again, first, "the retained copy wins: never regenerated");
});

test("gatewayGeneratedEnv: propagate_as renames a generated key on its way to the gateway .env", () => {
  const m = {
    env_vars: [
      { name: "G_ID", generate: "garage_key_id", propagate: true, propagate_as: "S3_ACCESS_KEY" },
      { name: "G_SECRET", generate: "hex32", propagate: true, propagate_as: "S3_SECRET_KEY" },
      { name: "G_PLAIN", generate: "secret", propagate: true },
      { name: "G_MASTER", generate: "secret", propagate: false },
    ],
  };
  const out = S.gatewayGeneratedEnv(m, { G_ID: "GK0123", G_SECRET: "ab", G_PLAIN: "p", G_MASTER: "never" });
  assert.deepEqual(out, { S3_ACCESS_KEY: "GK0123", S3_SECRET_KEY: "ab", G_PLAIN: "p" });
  assert.deepEqual(S.gatewayEnvNames(m).sort(), ["G_MASTER", "G_PLAIN", "S3_ACCESS_KEY", "S3_SECRET_KEY"].sort(), "uninstall re-comments the names the gateway .env really holds");
});

// ── mint_if_missing: the one regenerate-free "mint on repair" path (browser CDP gate) ──

const FLAGGED = {
  id: "mintdemo",
  env_vars: [
    { name: "MINT_NEW_KEY", generate: "hex32", secret: true, propagate: false, mint_if_missing: true },
    { name: "MINT_PLAIN", default: "kept-as-is" },
  ],
};
const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** An installed bundle dir + a retained copy, both writable by the test. */
function mintFixture({ id = "mintdemo", installed = "KEEP_KEY=keep\n", retained = null } = {}) {
  const crowHome = scratch("mint-home-");
  const destDir = scratch("mint-dest-");
  const installedPath = join(destDir, ".env");
  writeFileSync(installedPath, installed, { mode: 0o644 });
  chmodSync(installedPath, 0o644);
  const retainedPath = S.retainedEnvPath(crowHome, id);
  if (retained !== null) {
    mkdirSync(join(crowHome, "secrets", "bundle-env"), { recursive: true });
    writeFileSync(retainedPath, retained);
  }
  return { crowHome, destDir, installedPath, retainedPath };
}

const readEnv = (p) => S.parseEnvText(readFileSync(p, "utf8"));

test("mint_if_missing: a key absent from BOTH files is minted into both, at mode 600, other lines kept", () => {
  const f = mintFixture();
  const lines = [];
  const minted = S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { ...f, log: (m) => lines.push(m) });
  assert.deepEqual(minted, ["MINT_NEW_KEY"]);
  const installed = readEnv(f.installedPath);
  assert.ok(hex(installed.MINT_NEW_KEY), "hex32 shape");
  assert.equal(installed.KEEP_KEY, "keep", "the rest of the .env is untouched");
  assert.equal(mode(f.installedPath), 0o600, "the token does not widen the .env's mode");
  assert.deepEqual(readEnv(f.retainedPath), { MINT_NEW_KEY: installed.MINT_NEW_KEY }, "the retained copy is updated too");
  assert.equal(mode(f.retainedPath), 0o600);
  assert.equal(mode(join(f.crowHome, "secrets", "bundle-env")), 0o700);
  assert.deepEqual(lines, ["[bundles] minted MINT_NEW_KEY for mintdemo"], "the key name is logged, and only it");
  assert.ok(!lines.join("\n").includes(installed.MINT_NEW_KEY), "the value is never logged");
});

test("mint_if_missing: a key already in the installed .env is never touched or regenerated", () => {
  const f = mintFixture({ installed: "MINT_NEW_KEY=" + "a".repeat(64) + "\nKEEP_KEY=keep\n" });
  const lines = [];
  assert.deepEqual(S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { ...f, log: (m) => lines.push(m) }), []);
  assert.equal(readEnv(f.installedPath).MINT_NEW_KEY, "a".repeat(64));
  assert.equal(existsSync(f.retainedPath), false, "nothing to retain: the key already existed");
  assert.deepEqual(lines, []);
});

test("mint_if_missing: a key only in the retained copy is restored into the .env, never regenerated", () => {
  const kept = "b".repeat(64);
  const f = mintFixture({ retained: "MINT_NEW_KEY=" + kept + "\n" });
  const lines = [];
  assert.deepEqual(S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { ...f, log: (m) => lines.push(m) }), [], "nothing new was minted");
  assert.equal(readEnv(f.installedPath).MINT_NEW_KEY, kept, "the retained value is restored (install's own order)");
  assert.equal(readEnv(f.installedPath).KEEP_KEY, "keep", "other lines kept");
  assert.equal(mode(f.installedPath), 0o600);
  assert.equal(readEnv(f.retainedPath).MINT_NEW_KEY, kept);
  assert.ok(lines.length === 1 && !lines[0].includes(kept), "one line, never the value");
});

test("mint_if_missing: never regenerates — a second pass mints nothing", () => {
  const f = mintFixture();
  const first = S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { ...f, log: () => {} });
  assert.deepEqual(first, ["MINT_NEW_KEY"]);
  const value = readEnv(f.installedPath).MINT_NEW_KEY;
  const again = S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { ...f, log: () => {} });
  assert.deepEqual(again, []);
  assert.equal(readEnv(f.installedPath).MINT_NEW_KEY, value);
  assert.equal(readEnv(f.retainedPath).MINT_NEW_KEY, value);
});

test("mint_if_missing: only flagged keys are minted, and another bundle's keys are left alone", () => {
  const f = mintFixture();
  const otherId = "mintother";
  const otherDest = scratch("mint-other-");
  writeFileSync(join(otherDest, ".env"), "MINT_NEW_KEY=" + "c".repeat(64) + "\n");
  const otherRetained = S.retainedEnvPath(f.crowHome, otherId);
  mkdirSync(join(f.crowHome, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(otherRetained, "OTHER_KEY=other\n");
  const otherBefore = readFileSync(join(otherDest, ".env"), "utf8");
  const otherRetainedBefore = readFileSync(otherRetained, "utf8");

  const minted = S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { ...f, log: () => {} });
  assert.deepEqual(minted, ["MINT_NEW_KEY"], "MINT_PLAIN is not a generate key and is not listed for minting");
  assert.equal(readFileSync(join(otherDest, ".env"), "utf8"), otherBefore, "the other install's .env is untouched");
  assert.equal(readFileSync(otherRetained, "utf8"), otherRetainedBefore, "the other install's retained copy is untouched");
  assert.deepEqual(S.mintableKeys(FLAGGED), ["MINT_NEW_KEY"]);
  assert.deepEqual(S.mintableKeys({ env_vars: [{ name: "X", generate: "hex32" }] }), [], "no flag, no mint");
});

test("mint_if_missing: nothing is minted for a directory with no .env (not an install to repair)", () => {
  const home = scratch("mint-empty-home-");
  const dest = scratch("mint-empty-dest-");
  const lines = [];
  assert.deepEqual(S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { destDir: dest, crowHome: home, log: (m) => lines.push(m) }), []);
  assert.equal(existsSync(join(dest, ".env")), false);
  assert.deepEqual(lines, []);
});

test("mint_if_missing: a failure returns null, logs no value, and never throws", () => {
  // An .env that exists but cannot be read as a file: the read itself fails, before anything is written.
  const crowHome = scratch("mint-fail-home-");
  const destDir = scratch("mint-fail-dest-");
  mkdirSync(join(destDir, ".env"));
  const lines = [];
  const out = S.mintMissingFlaggedKeys("mintdemo", FLAGGED, { destDir, crowHome, log: (m) => lines.push(m) });
  assert.equal(out, null, "null is what tells the boot repair to retry instead of advancing the version");
  assert.match(lines.join("\n"), /could not mint the flagged key\(s\) for mintdemo/);
  assert.doesNotMatch(lines.join("\n"), /[0-9a-f]{64}/, "no log line carries a value");
  assert.equal(existsSync(S.retainedEnvPath(crowHome, "mintdemo")), false, "nothing was half-written");
});

test("install already mints the browser's CDP token: planGeneratedEnv generates every `generate` key", () => {
  const manifest = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8"));
  const plan = S.planGeneratedEnv("browser", manifest, { destDir: scratch("d-"), crowHome: scratch("h-") });
  assert.match(plan.env.CROW_BROWSER_CDP_TOKEN, /^[0-9a-f]{64}$/, "hex32, minted at install next to the VNC token — no change to the install path");
  assert.ok(S.generatedEnvKeys(manifest).includes("CROW_BROWSER_CDP_TOKEN"));
  assert.ok(S.gatewayExcludedKeys(manifest).has("CROW_BROWSER_CDP_TOKEN"), "propagate:false keeps it out of the gateway .env");
  assert.deepEqual(S.mintableKeys(manifest), ["CROW_BROWSER_CDP_TOKEN"], "and it is the only key a boot repair may add later");
});

// ── the same path through the boot repair (mint BEFORE the version refresh) ──

test("boot repair mints the flagged key for an installed bundle, logging the key only", async () => {
  const id = "mint-repair";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  // No version on either side: no refresh, so this is the mint-on-repair path alone.
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", env_vars: FLAGGED.env_vars }));
  const dest = seedInstalled(id, { env_vars: FLAGGED.env_vars }, "KEEP_KEY=keep\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle" }]));
  const lines = [];
  const out = await B.repairInstalledBundleAssets({ appBundles: FIXTURES, run: async () => ({ stdout: "", stderr: "" }), skillMode: "off", log: (m) => lines.push(m) });
  assert.deepEqual(out.errors, []);
  const env = readEnv(join(dest, ".env"));
  assert.ok(hex(env.MINT_NEW_KEY), "the installed .env got the key");
  assert.equal(env.KEEP_KEY, "keep");
  assert.ok(hex(readEnv(S.retainedEnvPath(CROW_HOME, id)).MINT_NEW_KEY), "and so did the retained copy");
  assert.ok(lines.includes(`[bundles] minted MINT_NEW_KEY for ${id}`), lines.join(" | "));
  assert.ok(!lines.join("\n").includes(env.MINT_NEW_KEY), "no log line carries the value");
  // A second boot is a no-op: never regenerated.
  const lines2 = [];
  await B.repairInstalledBundleAssets({ appBundles: FIXTURES, run: async () => ({ stdout: "", stderr: "" }), skillMode: "off", log: (m) => lines2.push(m) });
  assert.ok(!lines2.join("\n").includes("minted"), "nothing was minted on the second pass");
  assert.equal(readEnv(join(dest, ".env")).MINT_NEW_KEY, env.MINT_NEW_KEY);
});

test("a failed mint skips the version refresh, so the next boot retries both", async () => {
  const id = "mint-block-refresh";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "2.0.0", env_vars: FLAGGED.env_vars }));
  const dest = join(CROW_HOME, "bundles", id);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "1.0.0", env_vars: FLAGGED.env_vars }));
  // An .env that exists but cannot be read as a file: the mint must fail rather than guess.
  mkdirSync(join(dest, ".env"));
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle", version: "1.0.0" }]));
  const lines = [];
  const out = await B.repairInstalledBundleAssets({ appBundles: FIXTURES, run: async () => ({ stdout: "", stderr: "" }), skillMode: "off", log: (m) => lines.push(m) });
  assert.ok(out.errors.some((e) => e.id === id && /could not generate a missing key/.test(e.error)), JSON.stringify(out.errors));
  assert.ok(!out.repaired.some((r) => r.startsWith(id + ": refreshed")), "no copy happened without the key");
  assert.equal(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")).version, "1.0.0", "the commit marker stays old, so the next boot retries");
});
