/**
 * 4-PR3 identity backup — encryptSeed/decryptSeed exports, buildIdentityBackup,
 * the onboarding identity-backup POST handler, the done-step backup form, and
 * the CLI export/import honesty fixes.
 *
 * Ordering matters within this file: the "identity.json missing" tests run
 * BEFORE loadOrCreateIdentity() creates the scratch identity (identity.js pins
 * its DATA_DIR at import time, so one process = one identity dir). CLI tests
 * spawn child processes with their own scratch dirs and are order-independent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const identityModulePath = resolve(repoRoot, "servers/sharing/identity.js");

// Pin the scratch dir BEFORE importing identity.js (it resolves DATA_DIR at import).
const scratch = mkdtempSync(join(tmpdir(), "crow-idbackup-"));
const dataDir = join(scratch, "data");
process.env.CROW_DATA_DIR = dataDir;
process.env.CROW_DISABLE_NOSTR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const identity = await import("../servers/sharing/identity.js");
const {
  encryptSeed, decryptSeed, buildIdentityBackup,
  loadOrCreateIdentity, deriveInstanceIdentity, loadInstanceSeed,
} = identity;
const onboardingMod = await import("../servers/gateway/dashboard/panels/onboarding.js");
const { handleIdentityBackupPost, STEP_KEYS } = onboardingMod;
const onboardingPanel = onboardingMod.default;
const i18n = await import("../servers/gateway/dashboard/shared/i18n.js");

const DONE_IDX = STEP_KEYS.indexOf("done");
const PASSPHRASE = "correct horse battery staple";

// ── helpers ─────────────────────────────────────────────────────────────────

async function renderDoneStep(query = {}) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query: { step: String(DONE_IDX), ...query }, headers: {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en" });
  return typeof out === "string" ? out : captured;
}

function makeRes() {
  return {
    headers: {}, redirected: null, body: null, contentType: null,
    setHeader(k, v) { this.headers[k] = v; },
    redirectAfterPost(url) { this.redirected = url; },
    type(t) { this.contentType = t; return this; },
    send(b) { this.body = b; return this; },
  };
}

function makePostReq(body) {
  return { method: "POST", headers: {}, query: {}, body };
}

/** Spawn the identity CLI exactly the way package.json does (node -e import chain). */
function runCli(fnName, args, envOverrides = {}) {
  const script = `import(${JSON.stringify(pathToFileURL(identityModulePath).href)}).then(m => m.${fnName}())`;
  return spawnSync(process.execPath, ["-e", script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CROW_DISABLE_NOSTR: "1",
      CROW_DISABLE_INSTANCE_SYNC: "1",
      ...envOverrides,
    },
  });
}

// ── 1. encryptSeed / decryptSeed exports ────────────────────────────────────

test("encryptSeed/decryptSeed are exported and round-trip; wrong passphrase throws", () => {
  assert.equal(typeof encryptSeed, "function", "encryptSeed is exported");
  assert.equal(typeof decryptSeed, "function", "decryptSeed is exported");
  const seed = Buffer.from("aa".repeat(32), "hex");
  const enc = encryptSeed(seed, PASSPHRASE);
  assert.ok(enc.salt && enc.iv && enc.encrypted && enc.tag, "encrypted blob has salt/iv/encrypted/tag");
  assert.ok(!JSON.stringify(enc).includes(seed.toString("hex")), "ciphertext never carries the seed hex");
  assert.deepEqual(decryptSeed(enc, PASSPHRASE), seed, "round-trip reproduces the seed");
  assert.throws(() => decryptSeed(enc, "wrong-passphrase-1"), "wrong passphrase throws (GCM tag failure)");
});

// ── 2. missing-identity states (must run before the identity is created) ────

test("buildIdentityBackup throws a clear error when identity.json is missing", () => {
  assert.equal(existsSync(join(dataDir, "identity.json")), false, "precondition: no identity yet");
  assert.throws(() => buildIdentityBackup(PASSPHRASE), /identity/i, "names the missing identity file");
});

test("done step renders the honest no-identity note and NO backup form when identity.json is missing", async () => {
  const html = await renderDoneStep();
  assert.ok(!html.includes("/dashboard/onboarding/identity-backup"), "no backup form action");
  assert.ok(!html.includes('name="passphrase"'), "no passphrase field");
  assert.ok(html.includes(i18n.t("onboarding.backup.noIdentity", "en")), "honest note rendered");
});

// ── 3. buildIdentityBackup payload ──────────────────────────────────────────

test("buildIdentityBackup payload never contains the plaintext seed hex", () => {
  const id = loadOrCreateIdentity(); // creates the scratch identity (plaintext seed)
  const payload = buildIdentityBackup(PASSPHRASE);
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(id.seed.toString("hex")), "plaintext seed hex is ABSENT from the payload JSON");
  assert.ok(payload.encrypted && typeof payload.encrypted === "object", "encrypted blob present");
});

test("buildIdentityBackup: shape, clear identification fields, decrypt round-trip, crowId derivation", () => {
  const stored = JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf-8"));
  const payload = buildIdentityBackup(PASSPHRASE);
  assert.equal(payload.version, 1);
  assert.equal(payload.kind, "crow-identity-backup");
  assert.equal(payload.crowId, stored.crowId);
  assert.equal(payload.ed25519Pubkey, stored.ed25519Pubkey);
  assert.equal(payload.secp256k1Pubkey, stored.secp256k1Pubkey);
  assert.equal(payload.createdAt, stored.createdAt);
  assert.ok(typeof payload._restore === "string" && payload._restore.includes("identity:import"), "_restore names the import command");
  const seed = decryptSeed(payload.encrypted, PASSPHRASE);
  assert.equal(seed.toString("hex"), stored.seed, "decrypt round-trip reproduces the original seed");
  assert.equal(deriveInstanceIdentity(seed).crowId, payload.crowId, "crowId matches deriveInstanceIdentity(seed)");
  assert.throws(() => decryptSeed(payload.encrypted, "not-the-passphrase"), "wrong passphrase cannot decrypt the backup");
});

// ── 4. endpoint handler (handleIdentityBackupPost) ──────────────────────────

test("endpoint: passphrase shorter than 12 chars redirects back with backup_error", async () => {
  const res = makeRes();
  await handleIdentityBackupPost(makePostReq({ passphrase: "short", confirm: "short" }), res);
  assert.ok(res.redirected, "redirects instead of sending a file");
  assert.ok(res.redirected.includes(`/dashboard/onboarding?step=${DONE_IDX}`), "redirects to the done step");
  assert.ok(res.redirected.includes("backup_error="), "carries a backup_error message");
  assert.equal(res.body, null, "no payload sent");
});

test("endpoint: mismatched confirm redirects back with backup_error", async () => {
  const res = makeRes();
  await handleIdentityBackupPost(makePostReq({ passphrase: PASSPHRASE, confirm: PASSPHRASE + "x" }), res);
  assert.ok(res.redirected && res.redirected.includes("backup_error="), "redirects with backup_error");
  assert.equal(res.body, null, "no payload sent");
});

test("endpoint: valid passphrase → attachment download with encrypted payload, no plaintext seed", async () => {
  const stored = JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf-8"));
  const res = makeRes();
  await handleIdentityBackupPost(makePostReq({ passphrase: PASSPHRASE, confirm: PASSPHRASE }), res);
  assert.equal(res.redirected, null, "no redirect on success");
  assert.equal(res.headers["Content-Disposition"], 'attachment; filename="crow-identity-backup.json"');
  assert.equal(res.contentType, "application/json");
  const payload = JSON.parse(res.body);
  assert.equal(payload.kind, "crow-identity-backup");
  assert.equal(payload.crowId, stored.crowId);
  assert.ok(payload.encrypted, "encrypted seed present");
  assert.ok(!res.body.includes(stored.seed), "response body never contains the plaintext seed hex");
});

test("endpoint: unexpected failure redirects with a generic error (no 500)", async () => {
  const res = makeRes();
  // Missing body entirely → treated as invalid input, redirect (never a throw).
  await handleIdentityBackupPost({ method: "POST", headers: {}, query: {} }, res);
  assert.ok(res.redirected && res.redirected.includes("backup_error="), "redirects with backup_error");
});

// ── 5. done-step render with identity present ───────────────────────────────

test("done step renders the backup form: csrf, two password fields, minlength 12, crowId", async () => {
  const stored = JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf-8"));
  const html = await renderDoneStep();
  assert.ok(html.includes('action="/dashboard/onboarding/identity-backup"'), "form posts to the endpoint");
  assert.ok(html.includes('method="POST"') || html.includes('method="post"'), "form is a POST");
  assert.ok(html.includes('name="_csrf"'), "csrf input present");
  assert.ok(html.includes('name="passphrase"'), "passphrase field present");
  assert.ok(html.includes('name="confirm"'), "confirm field present");
  const pwFields = html.match(/type="password"/g) || [];
  assert.ok(pwFields.length >= 2, "two password-type fields");
  const minlengths = html.match(/minlength="12"/g) || [];
  assert.ok(minlengths.length >= 2, "minlength=12 on both fields");
  assert.ok(html.includes(stored.crowId), "crowId shown for identification");
  assert.ok(!html.includes(stored.seed), "seed never rendered");
});

test("done step renders backup_error escaped", async () => {
  const html = await renderDoneStep({ backup_error: '<script>alert(1)</script>' });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag never rendered");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "error text rendered escaped");
});

test("i18n: every onboarding.backup.* key has non-empty en AND es values", () => {
  const keys = Object.keys(i18n.translations).filter((k) => k.startsWith("onboarding.backup."));
  assert.ok(keys.length >= 8, `expected the backup key block, found ${keys.length}`);
  for (const k of keys) {
    const entry = i18n.translations[k];
    assert.ok(entry.en && entry.en.trim(), `missing en for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing es for ${k}`);
  }
});

// ── 6. CLI (child processes, independent scratch dirs) ──────────────────────

test("CLI export: refuses without a passphrase when non-interactive", () => {
  const out = runCli("exportIdentity", [], { CROW_DATA_DIR: dataDir });
  assert.equal(out.status, 1, "exit 1");
  assert.match(out.stderr, /passphrase/i, "clear message names the passphrase");
});

test("CLI export → import round-trip: encrypted output, restore writes a plaintext-seed identity.json", () => {
  const stored = JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf-8"));
  // Flag-first args need the `--` separator or node -e eats them as node options.
  const exp = runCli("exportIdentity", ["--", "--passphrase", PASSPHRASE], { CROW_DATA_DIR: dataDir });
  assert.equal(exp.status, 0, `export succeeds: ${exp.stderr}`);
  assert.ok(!exp.stdout.includes(stored.seed), "export output never contains the plaintext seed hex");
  const b64 = (exp.stdout.match(/[A-Za-z0-9+/=]{40,}/) || [])[0];
  assert.ok(b64, "export output contains the base64 blob");
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  assert.equal(payload.kind, "crow-identity-backup", "export blob is the encrypted backup format");

  const restoreDir = join(scratch, "restore", "data");
  mkdirSync(restoreDir, { recursive: true });
  const imp = runCli("importIdentity", [b64, "--passphrase", PASSPHRASE], { CROW_DATA_DIR: restoreDir });
  assert.equal(imp.status, 0, `import succeeds: ${imp.stderr}`);
  const restored = JSON.parse(readFileSync(join(restoreDir, "identity.json"), "utf-8"));
  assert.equal(restored.seed, stored.seed, "restore writes the PLAINTEXT seed");
  assert.equal(restored.crowId, stored.crowId, "crowId preserved");
  // The gateway host must be able to boot from the restored file.
  const seed = loadInstanceSeed(restoreDir);
  assert.equal(seed.toString("hex"), stored.seed, "loadInstanceSeed accepts the restored identity.json");
});

test("CLI import refuses to overwrite an existing identity.json", () => {
  const payload = buildIdentityBackup(PASSPHRASE);
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  // dataDir already holds the scratch identity — import must refuse.
  const out = runCli("importIdentity", [b64, "--passphrase", PASSPHRASE], { CROW_DATA_DIR: dataDir });
  assert.equal(out.status, 1, "exit 1");
  assert.match(out.stderr, /already exists/i, "clear refusal message");
});

test("CLI import: wrong passphrase fails cleanly (message, not a stack trace)", () => {
  const payload = buildIdentityBackup(PASSPHRASE);
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const dir = join(scratch, "wrongpass", "data");
  mkdirSync(dir, { recursive: true });
  const out = runCli("importIdentity", [b64, "--passphrase", "not-the-passphrase"], { CROW_DATA_DIR: dir });
  assert.equal(out.status, 1, "exit 1");
  assert.match(out.stderr, /passphrase/i, "message names the passphrase");
  assert.ok(!out.stderr.includes("Uncaught"), "no unhandled rejection");
  assert.ok(!/at .*identity\.js/.test(out.stderr), "no stack trace");
  assert.equal(existsSync(join(dir, "identity.json")), false, "no identity written on failure");
});

test("CLI import: encrypted backup without passphrase (non-interactive) refuses", () => {
  const payload = buildIdentityBackup(PASSPHRASE);
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const dir = join(scratch, "nopass", "data");
  mkdirSync(dir, { recursive: true });
  const out = runCli("importIdentity", [b64], { CROW_DATA_DIR: dir });
  assert.equal(out.status, 1, "exit 1");
  assert.match(out.stderr, /passphrase/i, "message names the passphrase");
  assert.equal(existsSync(join(dir, "identity.json")), false, "no identity written");
});

test("CLI import: legacy plaintext-base64 blob still works", () => {
  const raw = readFileSync(join(dataDir, "identity.json"), "utf-8");
  const b64 = Buffer.from(raw).toString("base64");
  const dir = join(scratch, "legacy", "data");
  mkdirSync(dir, { recursive: true });
  const out = runCli("importIdentity", [b64], { CROW_DATA_DIR: dir });
  assert.equal(out.status, 0, `legacy import succeeds: ${out.stderr}`);
  assert.equal(readFileSync(join(dir, "identity.json"), "utf-8"), raw, "legacy blob written as-is");
});
