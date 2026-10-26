/**
 * The bot engine hands every pi child PI_BOT_SECRET_VALUES_FILE (contract with
 * pi-lab, 2026-10-26): the engine alone names it (never a bot def's spawn_env,
 * never the per-session extraEnv, never an inherited value), the file is
 * refreshed at each spawn, and under the default sandbox a bot shell cannot
 * read it — not even after the file is replaced while the child runs.
 * Fake values only; the suite's scratch CROW_HOME only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const FAKE = "fake-" + "spawn-" + "secret-0000";
process.env.SPAWN_TEST_API_KEY = FAKE;

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { secretValuesPath, secretsDir, writeSecretValuesFile } = await import("../servers/shared/secret-values.js");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");

function scratch() { const d = mkdtempSync(join(tmpdir(), "crow-secret-spawn-")); mkdirSync(join(d, "sessions"), { recursive: true }); return d; }

/** Spawn a stub pi that reports its env var and what a shell inside sees. */
async function spawnReport({ def = {}, extraEnv = null, mode = "off", hold = false } = {}) {
  const dir = scratch();
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    'const p = process.env.PI_BOT_SECRET_VALUES_FILE || "";',
    'const look = () => { try { return execFileSync("/bin/sh", ["-c", "cat \\"$1\\"", "sh", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return "ERR"; } };',
    'const report = (tag) => process.stdout.write(JSON.stringify({ type: "report", tag, path: p, shell: look() }) + "\\n");',
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

test("every child gets the engine's file: fresh, 600, holding this instance's values", async () => {
  const { pi, r } = await spawnReport();
  await pi.exited;
  assert.equal(r.path, secretValuesPath(process.env));
  assert.equal(r.path, join(secretsDir(process.env), "pi-bot-secret-values"));
  const st = lstatSync(r.path);
  assert.equal(st.isFile(), true);
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(readFileSync(r.path, "utf8").split("\n").includes(FAKE));
  assert.ok(r.shell.includes(FAKE), "unsandboxed (mode off) the shell can read it, as it can every other file of this uid");
});

test("a bot def's spawn_env, the session extraEnv and an inherited value cannot point pi elsewhere", async () => {
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
    assert.equal(r.path, secretValuesPath(process.env));
    assert.match(msgs.join("\n"), /stripped engine-reserved spawn_env keys from bot def: PI_BOT_SECRET_VALUES_FILE/);
  } finally {
    console.error = origErr;
    delete process.env.PI_BOT_SECRET_VALUES_FILE;
  }
});

test("the file is refreshed at each spawn (a secret added since the last spawn is in it)", async () => {
  const later = "fake-" + "added-later-" + "0000";
  process.env.LATER_TEST_TOKEN = later;
  try {
    const { pi, r } = await spawnReport();
    await pi.exited;
    assert.ok(readFileSync(r.path, "utf8").split("\n").includes(later));
  } finally { delete process.env.LATER_TEST_TOKEN; }
});

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;

test("sandboxed: a bot shell cannot read the file, before or after it is replaced mid-session", { skip: noSandbox }, async () => {
  const { pi, r } = await spawnReport({ mode: "auto", hold: true });
  try {
    assert.equal(pi.sandboxed, true);
    assert.equal(r.path, secretValuesPath(process.env));
    assert.equal(existsSync(r.path), true, "the file exists outside");
    assert.equal(r.shell.includes(FAKE), false, "inside: " + r.shell.slice(0, 40));
    // another spawn (or this test) replaces the file by rename while the child runs
    writeSecretValuesFile(r.path, [FAKE, "fake-" + "rotated-" + "0000"]);
    const before = pi.events.length;
    pi.proc.stdin.write("x\n");
    const again = await pi.waitFor((m) => m.type === "report" && m.tag === "again" && m._seq > before, 10000, "again");
    assert.equal(again.shell.includes(FAKE), false, "still hidden after the rename");
    assert.equal(again.shell.includes("rotated"), false);
  } finally {
    await pi.close();
  }
});
