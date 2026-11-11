/**
 * Secret files the default-tier bot sandbox masks by file (hideFiles).
 * Fake values only; scratch dirs under os.tmpdir(). The bridge test sets its
 * own scratch HOME/CROW_HOME before bridge.mjs is imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFilesFor, secretPinDirsFor, BUNDLE_ENV_READABLE, ROOT_SECRET_FILES } from "../scripts/pi-bots/hidden_files.mjs";

test("secretFilesFor: root token files, the appRoot .env and every non-allow-listed bundle .env", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-files-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  mkdirSync(join(crowHome, "bundles", "browser"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "workspace"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "other"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "x.migrated-2026"), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  try {
    const files = secretFilesFor({ crowHome, appRoot });
    for (const n of [".env", ".keystore-env", "board-token", "phone-token", "artifacts-token"]) {
      assert.ok(files.includes(join(crowHome, n)), "root file " + n);
    }
    assert.ok(ROOT_SECRET_FILES.includes(".env") && ROOT_SECRET_FILES.includes("artifacts-token"));
    assert.ok(files.includes(join(appRoot, ".env")), "the repo checkout's .env");
    assert.ok(files.includes(join(crowHome, "bundles", "other", ".env")), "a bundle with no in-sandbox reader");
    assert.ok(files.includes(join(crowHome, "bundles", "x.migrated-2026", ".env")), "a stale bundle copy is a secret too");
    assert.ok(!files.includes(join(crowHome, "bundles", "browser", ".env")), "the browser tool reads its own .env");
    assert.ok(!files.includes(join(crowHome, "bundles", "workspace", ".env")), "the workspace tool reads its own .env");
    for (const n of ["models-token", "llm-cloud-token", "kiosk-announce-token", "studio-agent-token"]) {
      assert.ok(!files.includes(join(crowHome, n)), n + " has a reader inside the sandbox");
    }
    assert.equal(new Set(files).size, files.length, "deduped");
    assert.deepEqual(BUNDLE_ENV_READABLE, ["browser", "workspace"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("secretFilesFor: no appRoot and a missing bundles dir -> no bundle entries, no throw", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-nobundles-"));
  const crowHome = join(root, ".crow");
  mkdirSync(crowHome, { recursive: true });
  try {
    const files = secretFilesFor({ crowHome });
    assert.ok(!files.some((f) => f.includes("/bundles/")));
    assert.ok(!files.includes(join(root, ".env")));
    assert.ok(files.includes(join(crowHome, ".env")));
    assert.deepEqual(secretFilesFor({ crowHome, readdir: () => { throw new Error("no dir"); } })
      .filter((f) => f.includes("/bundles/")), [], "a readdir error means none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- bridge level: what a spawn really masks ----

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const USER_HOME = mkdtempSync(join(tmpdir(), "crow-hidden-user-"));
process.env.HOME = USER_HOME;
const CROW = join(USER_HOME, ".crow");
mkdirSync(CROW, { recursive: true });
process.env.CROW_HOME = CROW;
process.env.CROW_DATA_DIR = join(CROW, "data");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const REAL_CROW = realpathSync(CROW);

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;

test("sandboxed spawn: root secrets and other bundles' .env are masked; models-token and browser/.env stay readable", { skip: noSandbox }, async () => {
  const dotenv = join(CROW, ".env");
  const keystore = join(CROW, ".keystore-env");
  const board = join(CROW, "board-token");
  const models = join(CROW, "models-token");
  const browserEnv = join(CROW, "bundles", "browser", ".env");
  const otherEnv = join(CROW, "bundles", "other", ".env");
  mkdirSync(join(CROW, "bundles", "browser"), { recursive: true });
  mkdirSync(join(CROW, "bundles", "other"), { recursive: true });
  for (const [p, v] of [[dotenv, "fake-env-value\n"], [keystore, "fake-keystore-value\n"], [board, "fake-board-token\n"],
    [models, "fake-models-token\n"], [browserEnv, "fake-browser-token\n"], [otherEnv, "fake-other-secret\n"]]) {
    writeFileSync(p, v, { mode: 0o600 });
  }
  const dir = mkdtempSync(join(tmpdir(), "crow-hidden-spawn-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  // ~/.ssh is hidden as a dir
  mkdirSync(join(USER_HOME, ".ssh"), { recursive: true });
  const sshKey = join(USER_HOME, ".ssh", "id_fake");
  writeFileSync(sshKey, "fake-ssh-key\n", { mode: 0o600 });
  const files = { dotenv, keystore, board, models, browserEnv, otherEnv, sshKey };
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    `const files = ${JSON.stringify(files)};`,
    'const len = (p) => { try { return readFileSync(p).length; } catch (e) { return e.code || -1; } };',
    'const out = {}; for (const [k, p] of Object.entries(files)) out[k] = len(p);',
    'process.stdout.write(JSON.stringify({ type: "report", len: out }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    for (const k of ["dotenv", "keystore", "board", "otherEnv"]) {
      assert.equal(r.len[k], 0, k + " reads empty inside");
    }
    assert.equal(r.len.sshKey, "ENOENT", "~/.ssh is hidden");
    assert.equal(r.len.models, readFileSync(models).length, "models-token stays readable");
    assert.equal(r.len.browserEnv, readFileSync(browserEnv).length, "the browser bundle's .env stays readable");
    const masked = pi.sandboxMaskedFiles;
    for (const p of [dotenv, keystore, board, otherEnv]) {
      assert.ok(masked.includes(join(REAL_CROW, p.slice(CROW.length))), "masked: " + p);
    }
    assert.equal(masked.includes(join(REAL_CROW, "models-token")), false);
    assert.equal(masked.includes(join(REAL_CROW, "bundles", "browser", ".env")), false);
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
/** The error a spawn is refused with, or null when it started. */
async function spawnOutcome() {
  const dir = mkdtempSync(join(tmpdir(), "crow-hidden-refuse-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, 'process.stdout.write(JSON.stringify({ type: "report" }) + "\\n"); setTimeout(() => process.exit(0), 50);');
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    return null;
  } catch (e) { return e; } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a bundle dir swapped for a symlink to a dir with a .env refuses the spawn, naming the path below its root and no content", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-linktarget-"));
  writeFileSync(join(target, ".env"), "fake-linked-env-content\n");
  const link = join(CROW, "bundles", "swapped");
  symlinkSync(target, link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.match(e.message, /A bot could not start: bundles\/swapped\/\.env is a link or sits behind one/);
    assert.ok(!e.message.includes("fake-linked-env-content"), "no content in the message");
    assert.ok(!e.message.includes(REAL_CROW), "the path is relative to its root");
  } finally { rmSync(link, { force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("a bundle symlink with nothing behind it is ignored", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-emptylink-"));
  const link = join(CROW, "bundles", "emptylink");
  symlinkSync(target, link);
  try { assert.equal(await spawnOutcome(), null, "the spawn starts"); }
  finally { rmSync(link, { force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("a symlinked .env refuses the spawn", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-envtarget-"));
  writeFileSync(join(target, "real"), "fake-env-content\n");
  const link = join(CROW, ".env");
  rmSync(link, { force: true });
  symlinkSync(join(target, "real"), link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.match(e.message, /A bot could not start: \.env is a link/);
    assert.ok(!e.message.includes("fake-env-content"));
  } finally { rmSync(link, { force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("secretFilesFor / secretPinDirsFor: a symlinked bundle is listed only with a .env behind it; real dirs and the bundles dir are pinned", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-pins-"));
  const crowHome = join(root, ".crow");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(join(crowHome, "bundles", "real"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "browser"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(root, "empty"), { recursive: true });
  symlinkSync(elsewhere, join(crowHome, "bundles", "withenv"));
  writeFileSync(join(elsewhere, ".env"), "fake\n");
  symlinkSync(join(root, "empty"), join(crowHome, "bundles", "noenv"));
  try {
    const files = secretFilesFor({ crowHome });
    assert.ok(files.includes(join(crowHome, "bundles", "real", ".env")));
    assert.ok(files.includes(join(crowHome, "bundles", "withenv", ".env")), "listed so the spawn is refused");
    assert.ok(!files.includes(join(crowHome, "bundles", "noenv", ".env")));
    const pins = secretPinDirsFor({ crowHome });
    assert.deepEqual(pins.sort(), [join(crowHome, "bundles"), join(crowHome, "bundles", "browser"), join(crowHome, "bundles", "real")].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
