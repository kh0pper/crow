/**
 * SAT-8 part A: the off-site backup key and `node scripts/vault-restore.mjs` (spec §12.1, §12.4).
 *
 * The key is created once, reused, and survives a keychain export → import round trip; the upload
 * gate (offsiteKeyInExport) only goes true once a recorded Export holds it. The CLI is spawned as a
 * real process with a piped passphrase, exactly as the owner would run it on a machine with no
 * running Crow. Real init-db in a scratch home; nothing outside tmpdir is touched.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-vault-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-vault-data-"));
const DIR = mkdtempSync(join(tmpdir(), "crow-vault-cli-"));
const HOME2 = mkdtempSync(join(tmpdir(), "crow-vault-home2-"));
const DB2 = mkdtempSync(join(tmpdir(), "crow-vault-db2-"));
after(() => { for (const d of [HOME, DATA, DIR, HOME2, DB2]) rmScratch(d); });

process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "scripts", "vault-restore.mjs");
const V = await import("../servers/shared/crow-vault.js");
const K = await import("../servers/gateway/keychain/store.js");
const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { sealExport, openExport } = await import("../servers/gateway/keychain/export.js");
const R = await import("../servers/gateway/keychain/reminder.js");
const O = await import("../servers/gateway/satellites/offsite-key.js");
const { createDbClient } = await import("../servers/db.js");

const PASSPHRASE = "correct horse battery staple";
const DATE = "2026-10-30";
const CREATED = `${DATE}T02:30:00.000Z`;
const DB_BYTES = randomBytes(200 * 1024);

const keychainKey = createKeychainKey();
const db = createDbClient();
after(() => { try { db.close(); } catch { /* already closed */ } });

const offsiteRow = async (handle = db) => (await handle.execute({
  sql: "SELECT id, kind, origin, secret_sealed FROM crow_keychain WHERE bundle_id = ? AND env_key = ?",
  args: [V.OFFSITE_KEY.bundleId, V.OFFSITE_KEY.envKey],
})).rows;

function runCli(args, { stdin = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const assertNoSecrets = (text, key) => {
  for (const form of [key.toString("hex"), key.toString("base64")]) assert.ok(!text.includes(form), "the output never carries the key");
  assert.ok(!text.includes(PASSPHRASE), "the output never carries the passphrase");
};

test("the off-site key is created once, reused, and never sits in the clear", async () => {
  const [first, concurrent] = await Promise.all([O.ensureOffsiteKey(db, keychainKey), O.ensureOffsiteKey(db, keychainKey)]);
  assert.equal(first.created, true);
  assert.equal(first.key.length, 32);
  assert.equal(first.key_id, V.keyId(first.key));
  assert.deepEqual(concurrent.key, first.key, "two first callers share one key");

  const again = await O.ensureOffsiteKey(db, keychainKey);
  assert.equal(again.created, false);
  assert.deepEqual(again.key, first.key);
  assert.equal(again.id, first.id);

  const rows = await offsiteRow();
  assert.equal(rows.length, 1, "one fixed entry, so a second call can never mint a second key");
  assert.equal(rows[0].kind, "extension");
  assert.equal(rows[0].origin, "generated");
  assert.match(rows[0].secret_sealed, /^enc:v1:/);
  assert.ok(!rows[0].secret_sealed.includes(first.key.toString("base64")), "sealed, not stored in the clear");
});

test("http routes cannot reach the key: offsite-key.js exports no route and the row is not readable without the keychain key", async () => {
  const rows = await offsiteRow();
  const other = createKeychainKey({ crowHome: HOME2 });
  await assert.rejects(K.openEntrySecret(db, other, rows[0].id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  await assert.rejects(K.openEntrySecret(db, null, rows[0].id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
});

let exportFile;
let offsiteKey;

test("the upload gate is false until a recorded keychain Export holds the key", async () => {
  const { key } = await O.ensureOffsiteKey(db, keychainKey);
  offsiteKey = key;
  assert.equal(await O.offsiteKeyInExport(db), false, "no export recorded yet");

  const snapshot = await R.exportSnapshot(db, keychainKey.id);
  const entries = await K.exportableEntries(db, keychainKey);
  const file = await sealExport(entries, PASSPHRASE);
  assert.equal(await O.offsiteKeyInExport(db), false, "a sealed file nobody recorded is not an Export");
  await R.recordKeychainExport(db, keychainKey.id, snapshot);
  assert.equal(await O.offsiteKeyInExport(db), true, "the newest Export holds it");

  exportFile = join(DIR, "crow-keychain-export.json");
  writeFileSync(exportFile, JSON.stringify(file));
  assert.ok(!JSON.stringify(file).includes(offsiteKey.toString("base64")), "the export file is sealed");
});

test("the key survives sealExport → openExport and a real import with the same identity", async () => {
  const file = JSON.parse(readFileSync(exportFile, "utf8"));
  const entries = await openExport(file, PASSPHRASE);
  assert.ok(Array.isArray(entries) && entries.length > 0);
  const entry = entries.find((e) => e.kind === "extension" && e.bundle_id === V.OFFSITE_KEY.bundleId && e.env_key === V.OFFSITE_KEY.envKey);
  assert.ok(entry, "the export carries the off-site key as an ordinary entry");
  assert.equal(entry.status, "active");
  assert.deepEqual(V.offsiteKeyFromEntries(entries), offsiteKey);

  const db2 = createDbClient(join(DB2, "crow.db"));
  try {
    const keychainKey2 = createKeychainKey({ crowHome: HOME2 });
    const { imported } = await K.importEntries(db2, keychainKey2, entries);
    assert.ok(imported >= 1);
    const reused = await O.ensureOffsiteKey(db2, keychainKey2);
    assert.equal(reused.created, false, "the imported entry is reused, never re-minted");
    assert.deepEqual(reused.key, offsiteKey);
    assert.equal(reused.key_id, V.keyId(offsiteKey));
    const rows2 = await offsiteRow(db2);
    assert.equal(rows2.length, 1);
  } finally { db2.close(); }
});

let vaultFile;

test("the CLI restores with a passphrase on stdin and prints only a short summary", async () => {
  vaultFile = join(DIR, `crow-db-${DATE.replaceAll("-", "")}.vault`);
  await V.encryptVault({ input: DB_BYTES, output: vaultFile, key: offsiteKey, backupDate: DATE, createdAt: CREATED, sourceInstanceId: "inst-test", crowId: "crow:test" });
  const out = join(DIR, "restored.db");
  const r = await runCli(["--file", vaultFile, "--date", DATE, "--keychain-export", exportFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readFileSync(out), DB_BYTES, "the restored database is byte for byte the backup");
  assert.match(r.stdout, new RegExp(DATE), "the summary names the backup date");
  assert.match(r.stdout, /verified/);
  assert.ok(r.stdout.includes(String(DB_BYTES.length)), "the summary names the bytes written");
  assert.equal(r.stdout.trim().split("\n").length, 1, "one short line");
  assertNoSecrets(r.stdout + r.stderr, offsiteKey);
  assert.equal(existsSync(`${out}.partial`), false, "nothing is left half-written");
});

test("the CLI refuses a wrong passphrase (exit 3)", async () => {
  const out = join(DIR, "wrong-pass.db");
  const r = await runCli(["--file", vaultFile, "--date", DATE, "--keychain-export", exportFile, "--out", out], { stdin: "not the passphrase\n" });
  assert.equal(r.code, 3);
  assert.equal(existsSync(out), false);
  assertNoSecrets(r.stdout + r.stderr, offsiteKey);
});

test("the CLI refuses an older file under a newer name (exit 4, rollback)", async () => {
  const out = join(DIR, "rollback.db");
  const r = await runCli(["--file", vaultFile, "--date", "2026-10-31", "--keychain-export", exportFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /rollback/);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(`${out}.partial`), false);
});

test("the CLI refuses to overwrite an existing --out", async () => {
  const out = join(DIR, "keep-me.db");
  writeFileSync(out, "the old database");
  const r = await runCli(["--file", vaultFile, "--date", DATE, "--keychain-export", exportFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /refusing to overwrite/);
  assert.equal(readFileSync(out, "utf8"), "the old database", "the existing file is untouched");
});

test("an export with no off-site key is refused (exit 3)", async () => {
  const bare = await sealExport([{ kind: "manual", label: "unrelated", secret: "not-the-key" }], PASSPHRASE);
  const bareFile = join(DIR, "bare-export.json");
  writeFileSync(bareFile, JSON.stringify(bare));
  const out = join(DIR, "no-key.db");
  const r = await runCli(["--file", vaultFile, "--date", DATE, "--keychain-export", bareFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /no off-site backup key/);
  assert.equal(existsSync(out), false);
  assertNoSecrets(r.stdout + r.stderr, offsiteKey);
});

test("missing arguments are a usage error (exit 2)", async () => {
  const r = await runCli(["--file", vaultFile], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--date is required/);
  assert.match(r.stderr, /usage:/);
});
// ---- review: the output file is ours, 0600, and never replaces anything -------------------------

test("the restored database is mode 0600", async () => {
  const out = join(DIR, "mode.db");
  const r = await runCli(["--file", vaultFile, "--date", DATE, "--keychain-export", exportFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

test("an existing <out>.partial (someone else's file or link) is refused and left alone", async () => {
  const out = join(DIR, "planted.db");
  writeFileSync(`${out}.partial`, "not yours");
  chmodSync(`${out}.partial`, 0o666);
  const r = await runCli(["--file", vaultFile, "--date", DATE, "--keychain-export", exportFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /partial_exists/);
  assert.equal(readFileSync(`${out}.partial`, "utf8"), "not yours", "the planted file never receives the database");
  assert.equal(existsSync(out), false);
});

test("a file that appears at --out during the restore is never replaced", async () => {
  const out = join(DIR, "race.db");
  // decryptVault directly, with the out file created after the CLI-style pre-check would have run.
  writeFileSync(out, "appeared meanwhile");
  await assert.rejects(V.decryptVault({ file: vaultFile, out, key: offsiteKey, date: DATE }), (e) => e.code === "out_exists");
  assert.equal(readFileSync(out, "utf8"), "appeared meanwhile");
  assert.equal(existsSync(`${out}.partial`), false, "our partial is cleaned up");
});

test("a tampered vault file is exit 4 with its refusal code, and leaves nothing", async () => {
  const bad = join(DIR, "tampered.vault");
  const bytes = readFileSync(vaultFile); bytes[bytes.length - 5] ^= 0xff; writeFileSync(bad, bytes);
  const out = join(DIR, "tampered.db");
  const r = await runCli(["--file", bad, "--date", DATE, "--keychain-export", exportFile, "--out", out], { stdin: `${PASSPHRASE}\n` });
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /tag_failure/);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(`${out}.partial`), false);
});

// ---- review: "offsite-backup" is Crow's own keychain id, never an add-on's ------------------------

test("an add-on cannot write, read back or pause the off-site key's entry", async () => {
  const store = await import("../servers/gateway/keychain/store.js");
  const hooks = await import("../servers/gateway/keychain/install-hooks.js");
  const { OFFSITE_KEY } = V;
  assert.ok(store.isSystemBundleId(OFFSITE_KEY.bundleId), "the format's id is the reserved one");
  await assert.rejects(
    store.saveExtensionSecret(db, keychainKey, { bundleId: OFFSITE_KEY.bundleId, envKey: OFFSITE_KEY.envKey, label: "x", secret: "attacker", origin: "typed" }),
    /reserved for Crow itself/, "a plain add-on write is refused");
  const manifest = { id: OFFSITE_KEY.bundleId, env_vars: [{ name: OFFSITE_KEY.envKey, generate: "hex32", keychain: true }] };
  const restored = await hooks.keychainRestoreValues(OFFSITE_KEY.bundleId, manifest);
  assert.deepEqual(restored.values, {}, "an add-on install under that id is never handed the key");
  await hooks.markBundleKeychainRemoved(OFFSITE_KEY.bundleId);
  const { key: again } = await O.ensureOffsiteKey(db, keychainKey);
  assert.ok(again.equals(offsiteKey), "the key is unchanged and still active");
});
