/**
 * Task 1.6 — the install and refresh writers: `pinnedMcpEntry` seals the keys an install
 * produced, and both install sites hold the add-on's lock around build → seal → re-read.
 *
 * What this file pins down:
 *   1. with sealing ON, a typed key and a generated secret are sealed with origins
 *      `typed` / `generated`, and a `store_as` hash stays plain (it is not the secret);
 *   2. a seal failure registers NO entry, logs one fixed line (no value) and fails the job;
 *   3. uninstall → reinstall with the field blank revives nothing: no `keychainEnv`, the row
 *      stays `extension_removed`, the field shows as needing setup;
 *   4. retyping it on the next reinstall reactivates the row and lists it again;
 *   5. the sentinel never reaches the console, an audit row, a notification or the file.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR and a scratch bundle-source tree; no docker, no real app.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-addon-install-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-addon-install-src-"));
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_APP_ENV_PATH = join(TMP_HOME, "gateway.env");
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const B = await import("../servers/gateway/routes/bundles.js");
const { markBundleKeychainRemoved } = await import("../servers/gateway/keychain/install-hooks.js");
const { createDbClient } = await import("../servers/db.js");
const { listEntries, openEntrySecret } = await import("../servers/gateway/keychain/store.js");
const { keychainKeyPath, loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { gatewayKeychainPaths } = await import("../servers/gateway/addon-keys-paths.js");
const { readAddonSecretsSync } = await import("../servers/shared/addon-secrets.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { captureOutput, scanDb } = await import("./helpers/sentinel-scan.mjs");

B._setAppBundlesForTest(FIXTURES);
B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
B._setHookRunnerForTest(async () => ({ stdout: "", stderr: "" }));

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const HASH = "argon2-hash-" + randomUUID();
const MCP_ADDONS = join(TMP_HOME, "mcp-addons.json");
const KEY_PATH = keychainKeyPath(TMP_HOME);

after(() => {
  B._setAppBundlesForTest(null);
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setHookRunnerForTest(null);
  delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  for (const d of [TMP_HOME, TMP_DATA, FIXTURES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

async function withSealing(on, fn) {
  const before = process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  if (on) process.env.CROW_ADDON_SECRETS_KEYCHAIN = "1";
  else delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
    else process.env.CROW_ADDON_SECRETS_KEYCHAIN = before;
  }
}

const MANIFEST = (id) => ({
  id,
  name: "Demo Keys",
  description: "d",
  type: "mcp-server",
  category: "misc",
  version: "0.1.0",
  server: { command: "node", args: ["server/index.js"], envKeys: ["DEMO_TOKEN", "DEMO_GENERATED", "DEMO_STORED_HASH"] },
  env_vars: [
    { name: "DEMO_TOKEN", description: "typed key", required: true, secret: true },
    { name: "DEMO_GENERATED", description: "minted", secret: true, generate: "secret" },
    // store_as: the entry holds a hash, the keychain row of `store_as` holds the plaintext.
    { name: "DEMO_STORED_HASH", description: "a hash", secret: true, store_as: "DEMO_PLAINTEXT" },
    { name: "DEMO_URL", description: "a URL", default: "http://127.0.0.1:19999" },
  ],
});

/** Put a bundle manifest in the scratch source tree (the installer copies from here). */
function fixture(id) {
  const manifest = MANIFEST(id);
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function install(id, envVars = {}) {
  const job = B._createJobForTest(id, "install");
  const manifest = MANIFEST(id);
  const out = await B.runInstallJob(id, envVars, { job, installedSnapshot: [], consentVerified: false, manifest });
  return { out, job };
}

const readEntry = (id) => (JSON.parse(readFileSync(MCP_ADDONS, "utf8"))[id] || null);
const spawnEnv = (id) => readAddonSecretsSync(id, (readEntry(id) || { keychainEnv: [] }).keychainEnv || [], { unsealer: "gateway", ...gatewayKeychainPaths() });
async function rowsFor(id) {
  const db = createDbClient();
  try {
    const key = loadKeychainKey();
    const rows = (await listEntries(db, { keyId: key?.id ?? null })).filter((e) => e.bundle_id === id);
    const out = [];
    for (const row of rows) out.push({ ...row, secret: await openEntrySecret(db, key, row.id) });
    return out;
  } finally {
    db.close();
  }
}

// ─── 1. the seal at install ─────────────────────────────────────────────────

test("sealing on: typed and generated secrets are sealed with their origins; a store_as hash stays plain", async () => {
  fixture("demo-keys");
  await withSealing(true, async () => {
    const { out, job } = await install("demo-keys", { DEMO_TOKEN: SENTINEL, DEMO_STORED_HASH: HASH });
    assert.equal(out.ok, true, out.reason);
    assert.equal(job.log.join("\n").includes(SENTINEL), false, "the job log never carries a value");
  });

  const entry = readEntry("demo-keys");
  assert.ok(entry, "the entry was registered");
  assert.deepEqual(entry.keychainEnv, ["DEMO_GENERATED", "DEMO_TOKEN"], "both secrets are listed by NAME");
  assert.equal(entry.env.DEMO_TOKEN, undefined, "the typed key is not in the file");
  assert.equal(entry.env.DEMO_GENERATED, undefined, "neither is the generated one");
  assert.equal(entry.env.DEMO_STORED_HASH, HASH, "a store_as hash is not the secret: it stays plain");
  assert.equal(entry.env.DEMO_URL, "http://127.0.0.1:19999", "a default stays plain");
  assert.equal(readFileSync(MCP_ADDONS, "utf8").split(SENTINEL).length - 1, 0, "no typed value in the file");

  const rows = await rowsFor("demo-keys");
  const byKey = Object.fromEntries(rows.map((r) => [r.env_key, r]));
  assert.deepEqual(Object.keys(byKey).sort(), ["DEMO_GENERATED", "DEMO_TOKEN"], "one row per secret, and none for the hash");
  assert.equal(byKey.DEMO_TOKEN.origin, "typed", "the key the request typed");
  assert.equal(byKey.DEMO_TOKEN.secret, SENTINEL);
  assert.equal(byKey.DEMO_GENERATED.origin, "generated", "the key Crow minted");
  const dotEnv = parseEnvText(readFileSync(join(TMP_HOME, "bundles", "demo-keys", ".env"), "utf8"));
  assert.equal(byKey.DEMO_GENERATED.secret, dotEnv.DEMO_GENERATED, "the sealed value is the one the install wrote for the app");
  assert.match(byKey.DEMO_GENERATED.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(spawnEnv("demo-keys").DEMO_TOKEN, SENTINEL, "the spawn env gets the typed key back");
});

// ─── 2. a seal failure registers nothing ────────────────────────────────────

test("a seal failure: no entry, one fixed log line, and the job fails", async () => {
  fixture("demo-keys-fail");
  await withSealing(true, async () => {
    // A first install leaves keychain rows, so a damaged key file must be refused.
    const first = await install("demo-keys", { DEMO_TOKEN: SENTINEL });
    assert.equal(first.out.ok, true, first.out.reason);
    const keyBefore = readFileSync(KEY_PATH, "utf8");
    writeFileSync(KEY_PATH, "");
    try {
      const { out, job } = await install("demo-keys-fail", { DEMO_TOKEN: SENTINEL2 });
      assert.equal(out.ok, false, "the install fails when its keys cannot be saved");
      const log = job.log.join("\n");
      assert.match(log, /Could not save this extension's keys to the keychain; it was not registered/);
      assert.equal(log.includes(SENTINEL2), false, "the log line carries no value");
      assert.equal(log.includes(SENTINEL), false);
    } finally {
      writeFileSync(KEY_PATH, keyBefore);
    }
  });
  assert.equal(readEntry("demo-keys-fail"), null, "nothing was registered for the failed install");
});

// ─── 3./4. uninstall, reinstall blank, reinstall typed ──────────────────────

test("uninstall then reinstall: blank revives nothing, retyping reactivates the row", async () => {
  const id = "demo-keys-cycle";
  fixture(id);
  await withSealing(true, async () => {
    const first = await install(id, { DEMO_TOKEN: SENTINEL });
    assert.equal(first.out.ok, true, first.out.reason);
    assert.deepEqual(readEntry(id).keychainEnv, ["DEMO_GENERATED", "DEMO_TOKEN"]);
    assert.equal((await rowsFor(id)).find((r) => r.env_key === "DEMO_TOKEN").status, "active");

    // A real uninstall: the entry goes, the rows turn extension_removed, the folder goes.
    const all = JSON.parse(readFileSync(MCP_ADDONS, "utf8"));
    delete all[id];
    writeFileSync(MCP_ADDONS, JSON.stringify(all, null, 2), { mode: 0o600 });
    assert.equal(await markBundleKeychainRemoved(id), 2, "both rows are marked removed");
    rmSync(join(TMP_HOME, "bundles", id), { recursive: true, force: true });

    // Reinstall with the field blank: today's behaviour — the field needs setup, nothing is
    // revived from the old row.
    const blank = await install(id, {});
    assert.equal(blank.out.ok, true, blank.out.reason);
    const entry = readEntry(id);
    assert.ok(!(entry.keychainEnv || []).includes("DEMO_TOKEN"), "no keychainEnv entry for a field that was left blank");
    assert.equal(entry.env?.DEMO_TOKEN, undefined, "and no plain value either");
    assert.equal((await rowsFor(id)).find((r) => r.env_key === "DEMO_TOKEN").status, "extension_removed", "the row stays removed");
    assert.ok(B.needsConfigKeys(id).includes("DEMO_TOKEN"), "the field shows as needing setup");

    // Retyping it seals it again and reactivates the row.
    const retyped = await install(id, { DEMO_TOKEN: SENTINEL2 });
    assert.equal(retyped.out.ok, true, retyped.out.reason);
    assert.ok(readEntry(id).keychainEnv.includes("DEMO_TOKEN"));
    const row = (await rowsFor(id)).find((r) => r.env_key === "DEMO_TOKEN");
    assert.equal(row.status, "active");
    assert.equal(row.secret, SENTINEL2, "the keychain holds the key just typed");
    assert.equal(spawnEnv(id).DEMO_TOKEN, SENTINEL2);
  });
});

// ─── 5. the sentinel scan ───────────────────────────────────────────────────

test("no install leaks the sentinel: console, audit rows, notifications, the entry", async (t) => {
  const out = captureOutput(t);
  fixture("demo-keys-scan");
  await withSealing(true, async () => {
    const { out: result } = await install("demo-keys-scan", { DEMO_TOKEN: SENTINEL });
    assert.equal(result.ok, true, result.reason);
  });
  assert.equal(out.text().includes(SENTINEL), false, "no console line carries a value");
  assert.deepEqual(scanDb(gatewayKeychainPaths().dbPath, SENTINEL), [], "no audit row or bell carries a value");
  assert.equal(JSON.stringify(readEntry("demo-keys-scan")).includes(SENTINEL), false, "and the entry never holds it");
  // The bundle's own .env is where the value goes (PR3 strips only the entry).
  assert.equal(readFileSync(join(TMP_HOME, "bundles", "demo-keys-scan", ".env"), "utf8").includes(SENTINEL), true);
  assert.equal(existsSync(join(TMP_HOME, "bundles", "demo-keys-scan", "manifest.json")), true);
});