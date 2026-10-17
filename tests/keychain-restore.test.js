/**
 * A reinstall restores generated keys from the Crow keychain (queue item 30, recovery keys
 * option 1, decision 2026-10-16). Before this, a rebuilt machine (crow.db restored, keychain
 * Export imported, extension reinstalled) MINTED a new key and then overwrote the imported
 * keychain entry with it: data saved under the old key became unreadable. Real init-db in a
 * scratch home; no docker.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-kcrestore-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcrestore-data-"));
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
const S = await import("../servers/gateway/bundle-env-secrets.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { createDbClient } = await import("../servers/db.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-kcrestore-app-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(mkdtempSync(join(tmpdir(), "crow-kcrestore-gw-")), ".env"));
after(() => {
  B._setAppEnvPathForTest(null);
  for (const d of [CROW_HOME, process.env.CROW_DATA_DIR, FIXTURES]) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = (id) => ({
  id, name: "Demo Data", description: "d", type: "bundle", category: "infrastructure", version: "0.1.0",
  env_vars: [
    { name: "DEMO_DATA_KEY", secret: true, generate: "secret", keychain: true, keychain_label: "data encryption key" },
    { name: "DEMO_ADMIN_TOKEN", secret: true, generate: "secret", keychain: true, store_as: "argon2id", keychain_label: "admin token" },
    { name: "DEMO_DB_PASSWORD", secret: true, generate: "secret" },
  ],
});
function fixture(id) {
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(MANIFEST(id)));
  return MANIFEST(id);
}
const db = () => createDbClient();
async function install(id, manifest) {
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  return { job, env: parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8")) };
}
// "This machine is lost": the installed copy and the retained copy are gone, the keychain rows
// (restored crow.db + imported Export) remain.
function loseFiles(id) {
  rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
  rmSync(S.retainedEnvPath(CROW_HOME, id), { force: true });
}
async function entry(id, envKey) {
  const d = db();
  try {
    const e = (await K.listEntries(d, { keyId: loadKeychainKey().id })).find((x) => x.bundle_id === id && x.env_key === envKey);
    return e ? { ...e, plain: e.readable ? await K.openEntrySecret(d, loadKeychainKey(), e.id) : null } : null;
  } finally { d.close(); }
}

test("planGeneratedEnv: a keychain value is used when .env, the retained copy and fallbacks have none, and it is reused, never minted", () => {
  const m = MANIFEST("plan-a");
  const destDir = mkdtempSync(join(tmpdir(), "crow-kcrestore-dest-"));
  const plan = S.planGeneratedEnv("plan-a", m, { destDir, crowHome: CROW_HOME, keychain: { DEMO_DATA_KEY: "kept-data-key", DEMO_ADMIN_TOKEN: "kept-token" } });
  assert.equal(plan.env.DEMO_DATA_KEY, "kept-data-key");
  assert.equal(P.verifyArgon2idPhc("kept-token", plan.env.DEMO_ADMIN_TOKEN), true, "a hashed key gets a hash of the restored plaintext");
  assert.deepEqual(Object.keys(plan.minted), [], "nothing restored is minted");
  assert.deepEqual(plan.restored.sort(), ["DEMO_ADMIN_TOKEN", "DEMO_DATA_KEY"]);
  assert.ok(plan.env.DEMO_DB_PASSWORD && plan.env.DEMO_DB_PASSWORD.length >= 40, "a non-keychain key is still minted");
  rmSync(destDir, { recursive: true, force: true });
});

test("planGeneratedEnv: the installed .env and the retained copy still win over the keychain (they are what the data uses)", () => {
  const m = MANIFEST("plan-b");
  const destDir = mkdtempSync(join(tmpdir(), "crow-kcrestore-dest-"));
  writeFileSync(join(destDir, ".env"), "DEMO_DATA_KEY=from-env\n");
  const plan = S.planGeneratedEnv("plan-b", m, { destDir, crowHome: CROW_HOME, keychain: { DEMO_DATA_KEY: "from-keychain" } });
  assert.equal(plan.env.DEMO_DATA_KEY, "from-env");
  assert.equal(plan.restored.includes("DEMO_DATA_KEY"), false);
  rmSync(destDir, { recursive: true, force: true });
});

test("keychainRestoreValues: only keychain:true generated keys, only readable entries", async () => {
  const id = "kcr-values"; const m = fixture(id);
  await install(id, m);
  const { values: v, unreadable } = await H.keychainRestoreValues(id, m);
  assert.deepEqual(Object.keys(v).sort(), ["DEMO_ADMIN_TOKEN", "DEMO_DATA_KEY"], "DEMO_DB_PASSWORD is never in the keychain, so never looked up");
  assert.deepEqual(unreadable, []);
  assert.equal((await H.keychainRestoreValues(id, m)).failed, false);
  assert.equal(v.DEMO_DATA_KEY, (await entry(id, "DEMO_DATA_KEY")).plain);
  assert.deepEqual(await H.keychainRestoreValues(id, { ...m, env_vars: [] }), { values: {}, unreadable: [], failed: false }, "a manifest with no keychain keys reads nothing");
});

test("machine lost → reinstall restores the SAME data key from the keychain (and does not overwrite the entry)", async () => {
  const id = "kcr-e2e"; const m = fixture(id);
  const first = await install(id, m);
  assert.match(first.job.log.join("\n"), /export your keychain/, "a first generated key reminds the user to export");
  const before = await entry(id, "DEMO_DATA_KEY");
  assert.equal(first.env.DEMO_DATA_KEY, before.plain);
  const tokenBefore = (await entry(id, "DEMO_ADMIN_TOKEN")).plain;

  assert.equal(await H.markBundleKeychainRemoved(id), 2, "uninstall marks the entries removed (they are kept)");
  loseFiles(id);

  const { job, env } = await install(id, m);
  assert.equal(env.DEMO_DATA_KEY, before.plain, "the data key is the one the data was saved with");
  assert.equal(P.verifyArgon2idPhc(tokenBefore, env.DEMO_ADMIN_TOKEN), true, "the admin token still signs in");
  const after = await entry(id, "DEMO_DATA_KEY");
  assert.equal(after.plain, before.plain, "the keychain entry was not overwritten");
  assert.equal(after.status, "active", "the entry is active again");
  assert.equal(after.first_view_pending, false, "nothing new to show");
  const retained = parseEnvText(readFileSync(S.retainedEnvPath(CROW_HOME, id), "utf8"));
  assert.equal(retained.DEMO_DATA_KEY, before.plain, "the restored key is retained for the next reinstall");
  const log = job.log.join("\n");
  assert.match(log, /Restored 2 key\(s\) from Crow keychain/);
  assert.ok(!log.includes(before.plain) && !log.includes(tokenBefore), "no value in the job log");
});

test("an entry sealed with another machine's keychain key (Export not imported yet): the install is REFUSED, nothing is minted over it", async () => {
  const id = "kcr-unreadable"; const m = fixture(id);
  await install(id, m);
  const sealedBefore = async () => { const d = db(); try { return (await d.execute({ sql: "SELECT secret_sealed FROM crow_keychain WHERE bundle_id = ? AND env_key = 'DEMO_DATA_KEY'", args: [id] })).rows[0].secret_sealed; } finally { d.close(); } };
  const d = db();
  try { await d.execute({ sql: "UPDATE crow_keychain SET key_id = 'ffffffffffffffff' WHERE bundle_id = ? AND env_key = 'DEMO_DATA_KEY'", args: [id] }); } finally { d.close(); }
  const sealed = await sealedBefore();
  loseFiles(id);
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
  assert.equal(out.ok, false);
  assert.match(out.reason, /DEMO_DATA_KEY.*Import your keychain Export first/);
  assert.equal(await sealedBefore(), sealed, "the old sealed key is untouched, so a later Import can still bring it back");
  assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false, "nothing was written");
  // Starting fresh is the user's explicit choice: delete the old entry, then the install mints.
  const d2 = db();
  try { await d2.execute({ sql: "DELETE FROM crow_keychain WHERE bundle_id = ? AND env_key = 'DEMO_DATA_KEY'", args: [id] }); } finally { d2.close(); }
  const again = await install(id, m);
  assert.ok(again.env.DEMO_DATA_KEY);
});

test("a keychain read failure FAILS CLOSED: no keychain:true key is minted (it could replace an entry the read missed)", async () => {
  const id = "kcr-fail"; const m = fixture(id);
  H._setKeychainDepsForTest({ openDb: () => { throw new Error("db down"); } });
  try {
    assert.deepEqual(await H.keychainRestoreValues(id, m), { values: {}, unreadable: [], failed: true });
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
    assert.equal(out.ok, false);
    assert.match(out.reason, /could not be read.*Try the install again/);
  } finally { H._setKeychainDepsForTest(null); }
});

test("one damaged entry counts as unreadable (refused), never as 'none' (minted over)", async () => {
  const id = "kcr-damaged"; const m = fixture(id);
  await install(id, m);
  const d = db();
  try { await d.execute({ sql: "UPDATE crow_keychain SET secret_sealed = 'not-a-sealed-value' WHERE bundle_id = ? AND env_key = 'DEMO_DATA_KEY'", args: [id] }); } finally { d.close(); }
  const r = await H.keychainRestoreValues(id, m);
  assert.deepEqual(r.unreadable, ["DEMO_DATA_KEY"]);
  assert.ok(r.values.DEMO_ADMIN_TOKEN, "the other entry is still read");
  loseFiles(id);
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
  assert.equal(out.ok, false);
  assert.match(out.reason, /DEMO_DATA_KEY/);
});

test("crow_keychain stays local-only (never synced to a paired instance)", async () => {
  const sync = await import("../servers/sharing/instance-sync.js");
  assert.ok((sync.LOCAL_ONLY_TABLES || []).includes("crow_keychain"));
  assert.equal((sync.SYNCED_TABLES || []).includes("crow_keychain"), false);
});

test("mcp-addons.json (it carries MCP children's generated keys) is written at mode 600", async () => {
  const id = "kcr-mcp";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  const m = { id, name: "Demo MCP", description: "d", type: "mcp-server", category: "productivity", version: "0.1.0",
    server: { command: "node", args: ["server/index.js"], envKeys: ["DEMO_MCP_KEY"] },
    env_vars: [{ name: "DEMO_MCP_KEY", secret: true, generate: "secret", keychain: true, keychain_label: "data encryption key" }] };
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(m));
  mkdirSync(join(FIXTURES, id, "server"), { recursive: true });
  writeFileSync(join(FIXTURES, id, "server", "index.js"), "");
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
  assert.equal(out.ok, true, out.reason);
  const path = join(CROW_HOME, "mcp-addons.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const entryEnv = JSON.parse(readFileSync(path, "utf8"))[id].env;
  assert.equal(entryEnv.DEMO_MCP_KEY, (await entry(id, "DEMO_MCP_KEY")).plain, "the MCP child gets the keychain's plaintext");
});

test("crow.db restored on a machine with no keychain key file at all: the install is refused, not minted over", async () => {
  const id = "kcr-nokey"; const m = fixture(id);
  await install(id, m);
  loseFiles(id);
  const { keychainKeyPath } = await import("../servers/gateway/keychain/key.js");
  const { renameSync } = await import("node:fs");
  const kp = keychainKeyPath();
  renameSync(kp, kp + ".away");
  try {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
    assert.equal(out.ok, false);
    assert.match(out.reason, /Import your keychain Export first/);
    assert.equal(existsSync(kp), false, "no new keychain key was created by the refused install");
  } finally { renameSync(kp + ".away", kp); }
});

test("boot backfill: a key kept only in an older install's .env is saved to the keychain once, never over an existing entry", async () => {
  const id = "kcr-backfill"; const m = fixture(id);
  // An install from before the manifest saved this key to the keychain: .env only.
  mkdirSync(join(CROW_HOME, "bundles", id), { recursive: true });
  writeFileSync(join(CROW_HOME, "bundles", id, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(CROW_HOME, "bundles", id, ".env"), "DEMO_DATA_KEY=typed-long-ago-123456\nDEMO_ADMIN_TOKEN=$argon2id$v=19$m=65540,t=3,p=4$AAAA$BBBB\n");
  const instPath = join(CROW_HOME, "installed.json");
  const prev = existsSync(instPath) ? JSON.parse(readFileSync(instPath, "utf8")) : [];
  const list = Array.isArray(prev) ? prev : Object.entries(prev).map(([i, v]) => ({ id: i, ...v }));
  writeFileSync(instPath, JSON.stringify([...list.filter((r) => r.id !== id), { id, version: "0.1.0" }]));
  const logs = [];
  const n = await B.backfillBundleKeychain({ log: (l) => logs.push(l) });
  assert.ok(n >= 1);
  const e = await entry(id, "DEMO_DATA_KEY");
  assert.equal(e.plain, "typed-long-ago-123456");
  assert.equal(e.origin, "typed");
  assert.equal(e.first_view_pending, false);
  assert.equal(await entry(id, "DEMO_ADMIN_TOKEN"), null, "a store_as key has only a hash on disk: never backfilled");
  assert.ok(!logs.join("\n").includes("typed-long-ago"), "names only in the log");
  // A second boot changes nothing, even if the .env now differs.
  writeFileSync(join(CROW_HOME, "bundles", id, ".env"), "DEMO_DATA_KEY=something-else-999999\n");
  await B.backfillBundleKeychain({ log: () => {} });
  assert.equal((await entry(id, "DEMO_DATA_KEY")).plain, "typed-long-ago-123456");
  // The user deletes it in Settings → Passwords: a later boot never brings it back.
  const d = db();
  try { await d.execute({ sql: "DELETE FROM crow_keychain WHERE bundle_id = ? AND env_key = 'DEMO_DATA_KEY'", args: [id] }); } finally { d.close(); }
  await B.backfillBundleKeychain({ log: () => {} });
  assert.equal(await entry(id, "DEMO_DATA_KEY"), null, "a deleted entry stays deleted");
});
