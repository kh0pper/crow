/** Installer ↔ keychain wiring (Task 6). Real init-db in a scratch data dir; no docker. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-kcwire-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcwire-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const CROW_HOME = process.env.CROW_HOME;
const B = await import("../servers/gateway/routes/bundles.js");
const H = await import("../servers/gateway/keychain/install-hooks.js");
const K = await import("../servers/gateway/keychain/store.js");
const P = await import("../servers/gateway/keychain/argon2-phc.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { createDbClient } = await import("../servers/db.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-kcwire-app-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(mkdtempSync(join(tmpdir(), "crow-kcwire-gw-")), ".env"));
const vaultCalls = [];
let vaultResult = { ok: true };
H._setKeychainDepsForTest({ vault: { status: () => ({ installed: true, cliPath: "/fake/bw.js", serverUrl: "https://vault.example.ts.net:8450", secure: true }), save: async (o) => { vaultCalls.push(o); return vaultResult; } } });
after(() => {
  H._setKeychainDepsForTest(null);
  B._setAppEnvPathForTest(null);
  for (const d of [CROW_HOME, process.env.CROW_DATA_DIR, FIXTURES]) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = (id) => ({
  id, name: "Demo Vault", description: "d", type: "bundle", category: "infrastructure", version: "0.1.0",
  env_vars: [
    { name: "DEMO_DOMAIN", default: "http://localhost:18097" },
    { name: "DEMO_ADMIN_TOKEN", secret: true, generate: "secret", keychain: true, store_as: "argon2id", keychain_label: "admin token", keychain_url: "${DEMO_DOMAIN}/admin" },
    { name: "DEMO_USER", default: "admin" },
    { name: "DEMO_PASSWORD", secret: true, generatable: true, propagate: false, keychain_label: "admin password", keychain_username: "${DEMO_USER}" },
    { name: "DEMO_API_KEY", secret: true },
  ],
});
function fixture(id) {
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(MANIFEST(id)));
  return MANIFEST(id);
}
const db = () => createDbClient();
const ID = () => loadKeychainKey();

test("sanitizeKeychainRequest: only local sessions, only env-name keys, vault needs both fields", () => {
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A"], vault: { email: "e", password: "p" } }, { localSession: false }), { save: [], vault: null });
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A", "bad key", 3], vault: { email: " e@x ", password: "p" } }, { localSession: true }), { save: ["A"], vault: { email: "e@x", password: "p" } });
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A"], vault: { email: "e", password: "" } }, { localSession: true }).vault, null);
  assert.deepEqual(S.keychainEligibleKeys(MANIFEST("x")), ["DEMO_PASSWORD"], "the third-party DEMO_API_KEY is never eligible");
});

test("install: generated token → keychain (first view) + PHC hash in .env; checked human field → keychain; unchecked is not saved", async () => {
  const id = "demo-kc-a"; const manifest = fixture(id);
  const job = B._createJobForTest(id, "install");
  const keychain = { save: ["DEMO_PASSWORD", "DEMO_API_KEY"], vault: null };
  const out = await B.runInstallJob(id, { DEMO_DOMAIN: "http://localhost:18097", DEMO_USER: "kevin", DEMO_PASSWORD: "p a$s'w\"d #1", DEMO_API_KEY: "api-123" }, { job, installedSnapshot: [], consentVerified: false, manifest, keychain });
  assert.equal(out.ok, true, out.reason);
  const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  assert.match(env.DEMO_ADMIN_TOKEN, /^\$argon2id\$v=19\$m=65540,t=3,p=4\$/);
  assert.equal(env.DEMO_PASSWORD, "p a$s'w\"d #1", "the wide-charset value round-trips through the installer");
  const d = db();
  try {
    const entries = await K.listEntries(d);
    const byKey = Object.fromEntries(entries.map((e) => [e.env_key, e]));
    assert.deepEqual(Object.keys(byKey).sort(), ["DEMO_ADMIN_TOKEN", "DEMO_PASSWORD"], "DEMO_API_KEY is not eligible even when the request asks");
    assert.equal(byKey.DEMO_ADMIN_TOKEN.label, "Demo Vault — admin token");
    assert.equal(byKey.DEMO_ADMIN_TOKEN.url, "http://localhost:18097/admin");
    assert.equal(byKey.DEMO_ADMIN_TOKEN.first_view_pending, true);
    assert.equal(byKey.DEMO_PASSWORD.username, "kevin");
    assert.equal(byKey.DEMO_PASSWORD.first_view_pending, false);
    const token = await K.openEntrySecret(d, ID(), byKey.DEMO_ADMIN_TOKEN.id);
    assert.equal(P.verifyArgon2idPhc(token, env.DEMO_ADMIN_TOKEN), true, "the keychain plaintext matches the .env hash");
    assert.equal(await K.openEntrySecret(d, ID(), byKey.DEMO_PASSWORD.id), "p a$s'w\"d #1");
    const ev = (await d.execute("SELECT event_type, details FROM audit_log WHERE event_type = 'keychain_save'")).rows;
    assert.equal(ev.length, 2);
    assert.ok(!JSON.stringify(ev).includes(token) && !JSON.stringify(ev).includes("p a$s"));
  } finally { d.close(); }
  const logText = job.log.join("\n");
  assert.match(logText, /Saved 2 password\(s\) to Crow keychain/);
  assert.ok(!logText.includes("p a$s"), "no value in the job log");
});

test("REVIEW FOCUS 5 (install) — a failed vault save never fails the install or leaks", async () => {
  const id = "demo-kc-b"; const manifest = fixture(id);
  vaultCalls.length = 0;
  vaultResult = { ok: false, reason: "Vaultwarden did not accept that email or master password." };
  const job = B._createJobForTest(id, "install");
  const keychain = { save: ["DEMO_PASSWORD"], vault: { email: "k@example.invalid", password: "Master-PW-9" } };
  const out = await B.runInstallJob(id, { DEMO_PASSWORD: "Typed-Pass-123" }, { job, installedSnapshot: [], consentVerified: false, manifest, keychain });
  assert.equal(out.ok, true, "the install itself succeeds");
  assert.ok(vaultCalls.length >= 1);
  assert.equal(vaultCalls[0].masterPassword, "Master-PW-9");
  assert.match(job.log.join("\n"), /Vaultwarden save did not complete: Vaultwarden did not accept/);
  assert.ok(!JSON.stringify(job).includes("Master-PW-9") && !JSON.stringify(job).includes("Typed-Pass-123"));
  assert.equal(keychain.vault, null, "the master password is dropped after use");
  vaultResult = { ok: true };
});

test("reinstall reuses the generated token: no new plaintext, no first view, entry reactivated after uninstall", async () => {
  const id = "demo-kc-c"; const manifest = fixture(id);
  const install = async () => {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, true, out.reason);
  };
  await install();
  const d = db();
  try {
    const e1 = (await K.listEntries(d, { keyId: ID().id })).find((e) => e.bundle_id === id);
    await K.consumeFirstView(d, ID(), e1.id);
    assert.equal(await H.markBundleKeychainRemoved(id), 1);
    assert.equal((await K.getEntry(d, e1.id)).status, "extension_removed");
    rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
    await install();
    const e2 = await K.getEntry(d, e1.id);
    assert.equal(e2.status, "active");
    assert.equal(e2.first_view_pending, false, "nothing new was minted, so nothing new to show");
    assert.equal((await K.listEntries(d, { keyId: ID().id })).filter((e) => e.bundle_id === id).length, 1);
  } finally { d.close(); }
});

test("Configure: a local session saves a checked human field; a peer-signed request never does", async () => {
  const id = "demo-kc-d"; const manifest = MANIFEST(id);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, ".env"), "DEMO_USER=admin\n");
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-peer"]) req.crossHostAuth = { sourceInstanceId: "peer" };
    else req.dashboardSession = "S";
    next();
  });
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/bundles/api/env`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const peer = await post({ bundle_id: id, env_vars: { DEMO_PASSWORD: "Peer-Typed-1" }, keychain: { save: ["DEMO_PASSWORD"] } }, { "x-test-peer": "1" });
    assert.equal(peer.status, 200, JSON.stringify(peer.body));
    const d = db();
    try { assert.equal((await K.listEntries(d, { keyId: ID().id })).filter((e) => e.bundle_id === id).length, 0, "peer request saved nothing"); } finally { d.close(); }
    const local = await post({ bundle_id: id, env_vars: { DEMO_PASSWORD: "Local-Typed-1" }, keychain: { save: ["DEMO_PASSWORD"] } });
    assert.equal(local.status, 200, JSON.stringify(local.body));
    assert.equal(local.body.keychain.saved, 1);
    const d2 = db();
    try {
      const e = (await K.listEntries(d2, { keyId: ID().id })).find((x) => x.bundle_id === id);
      assert.equal(await K.openEntrySecret(d2, ID(), e.id), "Local-Typed-1");
    } finally { d2.close(); }
  } finally { server.close(); }
});

test("C5 — if the generated token cannot be saved, the install fails with NOTHING persisted; a retry mints a new token", async () => {
  const id = "demo-kc-e"; const manifest = fixture(id);
  H._setKeychainDepsForTest({ writeKey: async () => null, vault: { status: () => ({ installed: false }), save: async () => ({ ok: true }) } });
  try {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, false);
    assert.match(out.reason, /nothing was written/);
    assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false, "install dir removed");
    assert.equal(existsSync(S.retainedEnvPath(CROW_HOME, id)), false, "no orphan hash in the retained copy");
  } finally {
    H._setKeychainDepsForTest({ vault: { status: () => ({ installed: true, cliPath: "/fake/bw.js", serverUrl: "https://vault.example.ts.net:8450", secure: true }), save: async (o) => { vaultCalls.push(o); return vaultResult; } } });
  }
  const job = B._createJobForTest(id, "install");
  assert.equal((await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest })).ok, true);
  const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  const d = db();
  try {
    const e = (await K.listEntries(d, { keyId: ID().id })).find((x) => x.bundle_id === id);
    assert.equal(P.verifyArgon2idPhc(await K.openEntrySecret(d, ID(), e.id), env.DEMO_ADMIN_TOKEN), true, "the saved token matches the persisted hash");
  } finally { d.close(); }
});

test("m1 — a damaged key file with entries: a keychain:true install fails with the file path in the log, nothing written", async () => {
  const { keychainKeyPath } = await import("../servers/gateway/keychain/key.js");
  const id = "demo-kc-f"; const manifest = fixture(id);
  const p = keychainKeyPath(CROW_HOME);
  const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const saved = rf(p, "utf8");
  wf(p, "");
  try {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, false);
    assert.ok(job.log.some((l) => l.includes(`unreadable at ${p}`)), job.log.join("\n"));
    assert.equal(existsSync(S.retainedEnvPath(CROW_HOME, id)), false);
  } finally { wf(p, saved); }
});

test("R-B — an insecure (non-https) vault URL: vault outcome is insecureUrl, no save attempted, install succeeds", async () => {
  const { VAULT_REASONS } = await import("../servers/gateway/keychain/vault-save.js");
  const id = "demo-kc-g"; const manifest = fixture(id);
  vaultCalls.length = 0;
  H._setKeychainDepsForTest({ vault: { status: () => ({ installed: true, cliPath: "/fake/bw.js", serverUrl: "http://127.0.0.1:8097", secure: false }), save: async (o) => { vaultCalls.push(o); return { ok: true }; } } });
  try {
    const job = B._createJobForTest(id, "install");
    const keychain = { save: ["DEMO_PASSWORD"], vault: { email: "k@example.invalid", password: "Master-PW-8" } };
    const out = await B.runInstallJob(id, { DEMO_PASSWORD: "Typed-Pass-456" }, { job, installedSnapshot: [], consentVerified: false, manifest, keychain });
    assert.equal(out.ok, true, out.reason);
    assert.equal(vaultCalls.length, 0, "no vault save attempted");
    assert.ok(job.log.join("\n").includes(VAULT_REASONS.insecureUrl));
    assert.ok(!JSON.stringify(job).includes("Master-PW-8"));
    assert.equal(keychain.vault, null);
    const r = await H.recordKeychainForInstall({ bundleId: id, manifest, env: { DEMO_PASSWORD: "Typed-Pass-456" }, minted: {}, keychainReq: { save: ["DEMO_PASSWORD"], vault: { email: "e", password: "p" } } });
    assert.deepEqual(r.vault, { ok: false, reason: VAULT_REASONS.insecureUrl });
  } finally {
    H._setKeychainDepsForTest({ vault: { status: () => ({ installed: true, cliPath: "/fake/bw.js", serverUrl: "https://vault.example.ts.net:8450", secure: true }), save: async (o) => { vaultCalls.push(o); return vaultResult; } } });
  }
});
