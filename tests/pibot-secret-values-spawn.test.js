/**
 * The bot engine and PI_BOT_SECRET_VALUES_FILE (contract with pi-lab,
 * 2026-10-26). Under bubblewrap: the <CROW_HOME>/secrets dir is hidden behind a
 * tmpfs, the file is refreshed at each spawn and named to pi by the engine
 * alone (never a bot def's spawn_env, the session extraEnv or an inherited
 * value), and a bot shell cannot read it, not even after the file is replaced
 * while the child runs. Without bubblewrap the file is neither written nor
 * named: a bot shell there could read it. Fake values only; this file uses its
 * own scratch CROW_HOME so parallel test files never race on the one file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
// A scratch $HOME holding this instance (.crow) and, later, a co-hosted one:
// instance discovery scans $HOME's children.
const USER_HOME = mkdtempSync(join(tmpdir(), "crow-secret-spawn-user-"));
process.env.HOME = USER_HOME;
const HOME = join(USER_HOME, ".crow");
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const FAKE = "fakeGenSpawn" + "Ab3x".repeat(9);      // generated-secret shaped
// a trusted card source: a manual keychain entry (sealed under a scratch key)
const { sealSecret } = await import("../servers/sharing/secret-box.js");
const { KEYCHAIN_DDL } = await import("../servers/gateway/keychain/schema.js");
const { default: Database } = await import("better-sqlite3");
const { randomBytes } = await import("node:crypto");
const SEED = randomBytes(32);
mkdirSync(join(HOME, "secrets"), { recursive: true, mode: 0o700 });
writeFileSync(join(HOME, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: SEED.toString("base64") }), { mode: 0o600 });
function setManual(values) {
  const db = new Database(join(HOME, "data", "crow.db"));
  db.exec(KEYCHAIN_DDL);
  db.exec("DELETE FROM crow_keychain");
  for (const v of values) db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual','m',?,?,'manual')").run(sealSecret(v, { seed: SEED }), "0123456789abcdef");
  db.close();
  recordCard(values);                                  // what the keychain UI records on save
}
const { recordCardSecret: recordCardSecretFn } = await import("../servers/shared/secret-values.js");
function recordCard(values) { recordCardSecretFn(values, process.env); }
setManual([FAKE]);

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { secretValuesPath, writeSecretValuesFile } = await import("../servers/shared/secret-values.js");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;
const PATH = secretValuesPath(process.env);

function scratch() { const d = mkdtempSync(join(tmpdir(), "crow-secret-spawn-")); mkdirSync(join(d, "sessions"), { recursive: true }); return d; }

/** Spawn a stub pi that reports its env var and what a shell inside sees at the engine's path. */
async function spawnReport({ def = {}, extraEnv = null, mode = "auto", hold = false } = {}) {
  const dir = scratch();
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { execFileSync } from "node:child_process";',
    `const target = ${JSON.stringify(PATH)};`,
    'const look = () => { try { return execFileSync("/bin/cat", [target], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return "ERR"; } };',
    'const report = (tag) => process.stdout.write(JSON.stringify({ type: "report", tag, path: process.env.PI_BOT_SECRET_VALUES_FILE || null, shell: look() }) + "\\n");',
    'report("start");',
    'process.stdin.on("data", () => report("again"));',
    hold ? "process.stdin.resume();" : "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = mode;
  try {
    const pi = new PiRpc({ def, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {}, extraEnv });
    const r = await pi.waitFor((m) => m.type === "report" && m.tag === "start", 10000, "report");
    return { pi, r };
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
}

test("without bubblewrap (CROW_PI_SANDBOX=off) the file is neither written nor named", async () => {
  const { pi, r } = await spawnReport({ mode: "off" });
  await pi.exited;
  assert.equal(r.path, null);
  assert.equal(existsSync(PATH), false);
  assert.equal(r.shell, "ERR");
});

test("sandboxed: the engine's file, fresh and 600, named to pi; a bot shell cannot read it, before or after it is replaced", { skip: noSandbox }, async () => {
  const { pi, r } = await spawnReport({ hold: true });
  try {
    assert.equal(pi.sandboxed, true);
    assert.equal(r.path, PATH);
    const st = lstatSync(PATH);
    assert.equal(st.isFile(), true);
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(readFileSync(PATH, "utf8").split("\n").includes(FAKE), "outside: the instance's values");
    assert.equal(r.shell, "ERR", "inside: hidden");
    writeSecretValuesFile(PATH, [FAKE, "fake-" + "rotated-" + "0000"]);    // replaced by rename mid-session
    const seq = pi._seq;
    pi.proc.stdin.write("x\n");
    const again = await pi.waitFor((m) => m.type === "report" && m.tag === "again" && m._seq > seq, 10000, "again");
    assert.equal(again.shell, "ERR", "still hidden after the rename");
  } finally {
    await pi.close();
  }
});

test("sandboxed: a bot def's spawn_env, the session extraEnv and an inherited value cannot point pi elsewhere", { skip: noSandbox }, async () => {
  const planted = join(scratch(), "planted-values");
  writeFileSync(planted, "nothing\n", { mode: 0o600 });
  process.env.PI_BOT_SECRET_VALUES_FILE = planted;
  const origErr = console.error; const msgs = []; console.error = (m) => msgs.push(String(m));
  try {
    const { pi, r } = await spawnReport({
      def: { spawn_env: { PI_BOT_SECRET_VALUES_FILE: planted } },
      extraEnv: { PI_BOT_INTERACTIVE: "1", PI_BOT_SECRET_VALUES_FILE: planted },
    });
    await pi.exited;
    assert.equal(r.path, PATH);
    assert.match(msgs.join("\n"), /stripped engine-reserved spawn_env keys from bot def: PI_BOT_SECRET_VALUES_FILE/);
  } finally {
    console.error = origErr;
    delete process.env.PI_BOT_SECRET_VALUES_FILE;
  }
});

test("sandboxed: the file is refreshed at each spawn (a secret added since the last spawn is in it)", { skip: noSandbox }, async () => {
  const later = "fakeGenLater" + "Cd5y".repeat(9);
  setManual([FAKE, later]);
  const { pi } = await spawnReport();
  await pi.exited;
  assert.ok(readFileSync(PATH, "utf8").split("\n").includes(later));
});

test("off with no inherited value: the engine never leaks an inherited PI_BOT_SECRET_VALUES_FILE", async () => {
  process.env.PI_BOT_SECRET_VALUES_FILE = "/tmp/planted";
  try {
    const { pi, r } = await spawnReport({ mode: "off" });
    await pi.exited;
    assert.equal(r.path, null);
  } finally { delete process.env.PI_BOT_SECRET_VALUES_FILE; }
});

test("sandboxed: the hidden secrets dir is read-only inside (no decoy can be planted for send_user_file)", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-secret-decoy-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { writeFileSync } from "node:fs";',
    `let r = "written"; try { writeFileSync(${JSON.stringify(PATH)}, "decoy"); } catch (e) { r = e.code || "refused"; }`,
    'process.stdout.write(JSON.stringify({ type: "report", tag: "decoy", r }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "decoy");
    await pi.exited;
    assert.notEqual(r.r, "written");
    assert.notEqual(readFileSync(PATH, "utf8"), "decoy");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("without bubblewrap the values still reach this process's own mask (in memory), with no file", async () => {
  const { rmSync } = await import("node:fs");
  rmSync(PATH, { force: true });
  const { getSecretValues, invalidateSecretValues } = await import("../servers/shared/secret-values.js");
  invalidateSecretValues();
  const { pi } = await spawnReport({ mode: "off" });
  await pi.exited;
  assert.equal(existsSync(PATH), false);
  assert.ok(getSecretValues().includes(FAKE));
});

test("without bubblewrap a values file left by an earlier sandboxed spawn is removed", async () => {
  writeSecretValuesFile(PATH, [FAKE]);
  const { pi } = await spawnReport({ mode: "off" });
  await pi.exited;
  assert.equal(existsSync(PATH), false);
});

test("sandboxed: the gateway's delivered-files staging dir is hidden too", { skip: noSandbox }, async () => {
  const staged = join(HOME, "secrets", "perch-delivered", "sess", "f.txt");
  mkdirSync(join(HOME, "secrets", "perch-delivered", "sess"), { recursive: true });
  writeFileSync(staged, "staged");
  const dir = mkdtempSync(join(tmpdir(), "crow-secret-staged-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    `let r = "read"; try { readFileSync(${JSON.stringify(staged)}); } catch (e) { r = e.code || "refused"; }`,
    'process.stdout.write(JSON.stringify({ type: "report", tag: "staged", r }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "staged");
    await pi.exited;
    assert.notEqual(r.r, "read");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("sandboxed: a bot cannot add to the operator's card list (the hidden dir is read-only)", { skip: noSandbox }, async () => {
  const list = join(HOME, "secrets", "card-secret-hashes");
  const dir = mkdtempSync(join(tmpdir(), "crow-secret-list-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { appendFileSync } from "node:fs";',
    `let r = "written"; try { appendFileSync(${JSON.stringify(list)}, "a".repeat(64) + "\\n"); } catch (e) { r = e.code || "refused"; }`,
    'process.stdout.write(JSON.stringify({ type: "report", tag: "list", r }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "list");
    await pi.exited;
    assert.notEqual(r.r, "written");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("sandboxed: after the secrets dir was renamed away and a decoy planted, the NEXT bot still cannot read the real one", { skip: noSandbox }, async () => {
  const { renameSync, rmSync: rm } = await import("node:fs");
  const secrets = join(HOME, "secrets");
  const moved = join(HOME, "secrets-moved");
  renameSync(secrets, moved);
  mkdirSync(secrets, { mode: 0o700 });
  const dir = mkdtempSync(join(tmpdir(), "crow-secret-moved-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    `let r = "read"; try { readFileSync(${JSON.stringify(join(moved, "keychain.key"))}); } catch (e) { r = e.code || "refused"; }`,
    'process.stdout.write(JSON.stringify({ type: "report", tag: "moved", r }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "moved");
    await pi.exited;
    assert.notEqual(r.r, "read", "the real (moved) dir is hidden wherever it now is");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rm(secrets, { recursive: true, force: true });
    renameSync(moved, secrets);
  }
});

test("sandboxed: the bot cannot rename the instance home (or any user-writable ancestor of the secrets dir) away", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-secret-rename-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { renameSync } from "node:fs";',
    `let r = "renamed"; try { renameSync(${JSON.stringify(HOME)}, ${JSON.stringify(HOME + "-x")}); } catch (e) { r = e.code || "refused"; }`,
    `let r2 = "renamed"; try { renameSync(${JSON.stringify(join(HOME, "secrets"))}, ${JSON.stringify(join(HOME, "secrets-x"))}); } catch (e) { r2 = e.code || "refused"; }`,
    'process.stdout.write(JSON.stringify({ type: "report", tag: "rename", r, r2 }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "rename");
    await pi.exited;
    assert.notEqual(r.r, "renamed", "the instance home is pinned");
    assert.notEqual(r.r2, "renamed", "the secrets dir is pinned");
    assert.equal(existsSync(HOME), true);
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("without bubblewrap no value hides text on cards (a bot could have made it), the display set still masks", async () => {
  const { getCardValues, getSecretValues } = await import("../servers/shared/secret-values.js");
  const { pi } = await spawnReport({ mode: "off" });
  await pi.exited;
  assert.deepEqual(getCardValues(), []);
  assert.ok(getSecretValues().includes(FAKE));
});

test("sandboxed: a co-hosted instance's secrets dir (any Crow home under $HOME, whatever its name) is hidden too", { skip: noSandbox }, async () => {
  const sibling = join(USER_HOME, "crow-r4-home");       // no shared name prefix
  mkdirSync(join(sibling, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(sibling, "secrets", "keychain.key"), "{}", { mode: 0o600 });
  const dir = mkdtempSync(join(tmpdir(), "crow-secret-cohost-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    `let r = "read"; try { readFileSync(${JSON.stringify(join(sibling, "secrets", "keychain.key"))}); } catch (e) { r = e.code || "refused"; }`,
    'process.stdout.write(JSON.stringify({ type: "report", tag: "cohost", r }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "cohost");
    await pi.exited;
    assert.notEqual(r.r, "read");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("more instance secrets dirs than the cap: the spawn is refused with a clear error, never run with fewer hidden", { skip: noSandbox }, async () => {
  const many = [];
  for (let i = 0; i < 520; i++) { const d = join(USER_HOME, "fake-home-" + i); mkdirSync(join(d, "secrets"), { recursive: true }); many.push(d); }
  const { rmSync: rm } = await import("node:fs");
  try {
    await assert.rejects(spawnReport({ mode: "auto" }), /secrets dirs to hide/);
  } finally {
    for (const d of many) rm(d, { recursive: true, force: true });
  }
});

test("sandboxed: a co-hosted home made unreadable (chmod 000) refuses the spawn instead of leaving it visible", { skip: noSandbox }, async () => {
  const other = join(USER_HOME, ".crow-locked");
  mkdirSync(join(other, "secrets"), { recursive: true, mode: 0o700 });
  const { chmodSync: chmod, rmSync: rm } = await import("node:fs");
  chmod(other, 0o000);
  try {
    await assert.rejects(spawnReport({ mode: "auto" }), /cannot be checked/);
  } finally {
    chmod(other, 0o700); rm(other, { recursive: true, force: true });
    const { forgetInstanceSecretsDir } = await import("../servers/shared/secret-values.js");
    forgetInstanceSecretsDir(join(other, "secrets"));
  }
});

test("sandboxed: a co-hosted secrets dir hidden once and then moved away refuses the next spawn", { skip: noSandbox }, async () => {
  const { renameSync: mv, rmSync: rm } = await import("node:fs");
  const { forgetInstanceSecretsDir } = await import("../servers/shared/secret-values.js");
  const other = join(USER_HOME, "crow-moving-home");
  mkdirSync(join(other, "secrets"), { recursive: true, mode: 0o700 });
  const first = await spawnReport({ mode: "auto" });
  await first.pi.exited;                                // hidden once: remembered
  mkdirSync(join(USER_HOME, "deep"), { recursive: true });
  mv(other, join(USER_HOME, "deep", "crow-moving-home"));
  try {
    await assert.rejects(spawnReport({ mode: "auto" }), /was hidden before and is gone/);
  } finally {
    rm(join(USER_HOME, "deep"), { recursive: true, force: true });
    forgetInstanceSecretsDir(join(other, "secrets"));
  }
});
