// Integration tests for scripts/ops/kill-orphan-gateways.sh
//
// Strategy: build a FAKE process tree under a mkdtemp dir T —
//   T/servers/gateway/index.js  (fake "gateway": spawns a bundle child, then sleeps)
//   T/bundles/fake/server/index.js  (fake "bundle child": sleeps; cwd contains /bundles/)
// — orphan it to ppid==1 (spawn via an intermediate `node -e` parent that
// spawns detached+unref and exits immediately), then run the real script with
// ORPHAN_MATCH_PATTERN / ORPHAN_BUNDLE_PATTERN regex-scoped to paths under T
// so it can NEVER match the real gateways on this production host.
//
// Every test also asserts the REAL prod gateway MainPIDs
// (crow-gateway / crow-mpa-gateway) are still alive after the script ran.
//
// Teardown kills every spawned fake pid by EXPLICIT PID (never pkill).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pExecFile = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dir, "..", "scripts", "ops", "kill-orphan-gateways.sh");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** true while the pid exists and is not a zombie */
function isAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

function ppidOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10);
}

async function waitFor(cond, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

/** MainPIDs of the real prod gateways, resolved once. */
async function prodMainPids() {
  const { stdout } = await pExecFile("systemctl", [
    "show", "-p", "MainPID", "--value", "crow-gateway", "crow-mpa-gateway",
  ]);
  return stdout
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 1);
}

function assertProdAlive(pids, when) {
  for (const pid of pids) {
    assert.ok(isAlive(pid), `PROD gateway pid ${pid} must still be alive ${when}`);
  }
}

/** Build the fake tree scripts under a fresh mkdtemp dir. Returns paths. */
function makeFakeTree() {
  const T = mkdtempSync(join(tmpdir(), "orphan-test-"));
  const gwDir = join(T, "servers", "gateway");
  const bundleDir = join(T, "bundles", "fake", "server");
  mkdirSync(gwDir, { recursive: true });
  mkdirSync(bundleDir, { recursive: true });
  const bundleScript = join(bundleDir, "index.js");
  const gwScript = join(gwDir, "index.js");
  const childPidFile = join(T, "child.pid");
  // Fake bundle child: just sleeps (holds "the lock" conceptually).
  writeFileSync(bundleScript, `setInterval(() => {}, 1000);\n`);
  // Fake gateway: spawns the bundle child (cwd under /bundles/), records its
  // pid, then sleeps.
  writeFileSync(
    gwScript,
    `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, [${JSON.stringify(bundleScript)}], {
  cwd: ${JSON.stringify(bundleDir)},
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`
  );
  return { T, gwScript, bundleScript, bundleDir, childPidFile };
}

/**
 * Spawn `script` orphaned to ppid==1: an intermediate `node -e` parent spawns
 * it detached+unref, prints the pid, and exits immediately (its child is then
 * adopted by init). Returns the pid once /proc shows ppid==1.
 */
async function spawnOrphaned(script, opts = {}) {
  const bootstrap = `
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, [${JSON.stringify(script)}], {
  detached: true,
  stdio: "ignore",
  cwd: ${JSON.stringify(opts.cwd || tmpdir())},
  env: Object.assign({}, process.env, ${JSON.stringify(opts.env || {})}),
});
c.unref();
process.stdout.write(String(c.pid));
`;
  const { stdout } = await pExecFile(process.execPath, ["-e", bootstrap]);
  // Strip any ANSI decoration (this env forces color even when non-TTY).
  const pid = parseInt((stdout.match(/\d+/) || [])[0], 10);
  assert.ok(pid > 1, "bootstrap must print the orphan pid");
  await waitFor(() => {
    try {
      return ppidOf(pid) === 1;
    } catch {
      return false;
    }
  }, 5000, `pid ${pid} to be re-parented to init (ppid==1)`);
  return pid;
}

async function runScript(env) {
  // Never inherit unscoped defaults in tests: both patterns are ALWAYS set.
  assert.ok(env.ORPHAN_MATCH_PATTERN, "test must scope ORPHAN_MATCH_PATTERN");
  assert.ok(env.ORPHAN_BUNDLE_PATTERN, "test must scope ORPHAN_BUNDLE_PATTERN");
  const { stdout, stderr } = await pExecFile("bash", [SCRIPT], {
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { stdout, stderr };
}

function trackedKill(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/**
 * Teardown that cannot leak the bundle child: even if the test failed before
 * reading childPidFile into `spawned`, the pidfile (written by the fake
 * gateway) is read here and its pid killed explicitly.
 */
function cleanupTree(spawned, T, childPidFile) {
  if (childPidFile && existsSync(childPidFile)) {
    const pid = parseInt(readFileSync(childPidFile, "utf8"), 10);
    if (Number.isFinite(pid) && pid > 1 && !spawned.includes(pid)) spawned.push(pid);
  }
  trackedKill(spawned);
  rmSync(T, { recursive: true, force: true });
}

const pidRe = (pid) => new RegExp(`\\b${pid}\\b`); // anchored: pid 1234 must not match 51234

test("reaps an orphaned fake gateway AND its bundle child (subtree reaping)", async (t) => {
  const prod = await prodMainPids();
  assert.ok(prod.length >= 1, "expected at least one prod gateway MainPID");

  const { T, gwScript, childPidFile } = makeFakeTree();
  const spawned = [];
  t.after(() => cleanupTree(spawned, T, childPidFile));

  const gwPid = await spawnOrphaned(gwScript);
  spawned.push(gwPid);
  await waitFor(() => existsSync(childPidFile), 5000, "bundle child pid file");
  const childPid = parseInt(readFileSync(childPidFile, "utf8"), 10);
  spawned.push(childPid);
  assert.ok(isAlive(gwPid) && isAlive(childPid), "fake tree must be alive pre-run");

  const { stdout } = await runScript({
    ORPHAN_MATCH_PATTERN: `${escRe(T)}/servers/gateway/index\\.js`,
    // Deliberately matches NOTHING: the bundle child must die via sweep 1's
    // SUBTREE reaping, not get mopped up later by sweep 2 — otherwise the
    // critical child-also-dies assertion couldn't detect a missing subtree
    // reap (sweep 2 would mask it).
    ORPHAN_BUNDLE_PATTERN: `${escRe(T)}/bundles/does-not-match\\.js`,
  });

  await waitFor(() => !isAlive(gwPid), 5000, "fake gateway to die");
  // THE critical assertion (finding 4): the bundle CHILD must die too —
  // killing only the gateway re-parents the child to init and the prod-DB
  // lock survives.
  await waitFor(() => !isAlive(childPid), 5000, "bundle CHILD to die with its gateway");

  assert.ok(!isAlive(gwPid), `orphan gateway ${gwPid} must be gone`);
  assert.ok(!isAlive(childPid), `bundle child ${childPid} must be gone (subtree reap)`);
  assert.match(stdout, /orphan/i, "script should log what it did");
  assertProdAlive(prod, "after the reap run");
});

test("second sweep reaps an ALREADY-orphaned bundle child (ppid==1, cwd under /bundles/)", async (t) => {
  const prod = await prodMainPids();
  const { T, bundleScript, bundleDir } = makeFakeTree();
  const spawned = [];
  t.after(() => {
    trackedKill(spawned);
    rmSync(T, { recursive: true, force: true });
  });

  // Orphan JUST the bundle child — the class the in-gateway boot sweep misses
  // when the leak happens between gateway boots. cwd contains "/bundles/".
  const childPid = await spawnOrphaned(bundleScript, { cwd: bundleDir });
  spawned.push(childPid);
  assert.ok(isAlive(childPid), "orphan bundle child must be alive pre-run");

  await runScript({
    // Gateway pattern scoped to a path that matches NOTHING:
    ORPHAN_MATCH_PATTERN: `${escRe(T)}/servers/gateway/does-not-exist\\.js`,
    ORPHAN_BUNDLE_PATTERN: `${escRe(T)}/bundles/fake/server/index\\.js`,
  });

  await waitFor(() => !isAlive(childPid), 5000, "orphaned bundle child to die");
  assert.ok(!isAlive(childPid), `orphaned bundle child ${childPid} must be gone`);
  assertProdAlive(prod, "after the bundle-sweep run");
});

test("ORPHAN_DRY_RUN=1 reports victims but kills nothing", async (t) => {
  const prod = await prodMainPids();
  const { T, gwScript, childPidFile } = makeFakeTree();
  const spawned = [];
  // explicit-PID cleanup of the deliberately-survived tree
  t.after(() => cleanupTree(spawned, T, childPidFile));

  const gwPid = await spawnOrphaned(gwScript);
  spawned.push(gwPid);
  await waitFor(() => existsSync(childPidFile), 5000, "bundle child pid file");
  const childPid = parseInt(readFileSync(childPidFile, "utf8"), 10);
  spawned.push(childPid);

  const { stdout } = await runScript({
    ORPHAN_MATCH_PATTERN: `${escRe(T)}/servers/gateway/index\\.js`,
    ORPHAN_BUNDLE_PATTERN: `${escRe(T)}/bundles/fake/server/index\\.js`,
    ORPHAN_DRY_RUN: "1",
  });

  await sleep(2500); // longer than the script's TERM→KILL grace window
  assert.ok(isAlive(gwPid), "dry run must NOT kill the fake gateway");
  assert.ok(isAlive(childPid), "dry run must NOT kill the bundle child");
  assert.match(stdout, pidRe(gwPid), "dry run must name the gateway victim");
  assert.match(stdout, pidRe(childPid), "dry run must name the child victim");
  assertProdAlive(prod, "after the dry run");
});

test("script exits 0 even when nothing matches", async (t) => {
  const prod = await prodMainPids();
  // Patterns that match nothing at all; execFile throws on non-zero exit.
  await runScript({
    ORPHAN_MATCH_PATTERN: "/nonexistent-orphan-test-path/servers/gateway/index\\.js",
    ORPHAN_BUNDLE_PATTERN: "/nonexistent-orphan-test-path/server/index\\.js",
  });
  assertProdAlive(prod, "after the no-match run");
});

test("--owned-check: classifies real systemd unit pids as owned, session pids as not", async () => {
  const prod = await prodMainPids();
  assert.ok(prod.length >= 1, "need a prod MainPID to classify");
  // A real service MainPID is systemd-owned → exit 0.
  await pExecFile("bash", [SCRIPT, "--owned-check", String(prod[0])]);
  // This test process runs in a session scope (not a *.service cgroup) → exit 1.
  // If the suite is ever run FROM a systemd service, skip that half honestly.
  const selfCgroup = readFileSync("/proc/self/cgroup", "utf8");
  if (/\.service/.test(selfCgroup)) return; // can't assert the negative here
  await assert.rejects(
    pExecFile("bash", [SCRIPT, "--owned-check", String(process.pid)]),
    /Command failed/,
    "a session-scope pid must NOT be classified systemd-owned"
  );
});

test("systemd-owned prod gateways are protected even when the pattern matches them (dry run)", async () => {
  // The REAL default pattern matches the prod gateways, and every systemd
  // MainPID has ppid==1 (systemd IS pid 1) — so this exercises the candidate
  // protection stack (cgroup ownership + whitelist) against the live units.
  // DRY_RUN prints victims without signalling, so this is safe even if the
  // protections were broken; the assertion is on the victim list.
  const prod = await prodMainPids();
  const { stdout } = await runScript({
    ORPHAN_MATCH_PATTERN: "node.*servers/gateway/index\\.js",
    ORPHAN_BUNDLE_PATTERN: "/nonexistent-orphan-test-path/server/index\\.js",
    ORPHAN_DRY_RUN: "1",
  });
  for (const pid of prod) {
    assert.doesNotMatch(stdout, pidRe(pid), `prod MainPID ${pid} must never appear as a victim`);
  }
  assertProdAlive(prod, "after the protection dry run");
});

test("CROW_ALLOW_ORPHAN=1 orphan survives a REAL (non-dry) sweep", async (t) => {
  // The operator opt-out must be honored by the sweeper, not only by
  // parent-watch — a deliberately detached gateway would otherwise die
  // within a minute of the timer.
  const prod = await prodMainPids();
  const { T, gwScript, childPidFile } = makeFakeTree();
  const spawned = [];
  t.after(() => cleanupTree(spawned, T, childPidFile));

  const gwPid = await spawnOrphaned(gwScript, { env: { CROW_ALLOW_ORPHAN: "1" } });
  spawned.push(gwPid);
  await waitFor(() => existsSync(childPidFile), 5000, "bundle child pid file");
  spawned.push(parseInt(readFileSync(childPidFile, "utf8"), 10));

  const { stdout } = await runScript({
    ORPHAN_MATCH_PATTERN: `${escRe(T)}/servers/gateway/index\\.js`,
    ORPHAN_BUNDLE_PATTERN: `${escRe(T)}/bundles/does-not-match\\.js`,
  });

  await sleep(2500); // longer than the TERM→KILL grace
  assert.ok(isAlive(gwPid), "CROW_ALLOW_ORPHAN=1 orphan must NOT be killed");
  assert.doesNotMatch(stdout, pidRe(gwPid), "opted-out orphan must not be named a victim");
  assertProdAlive(prod, "after the opt-out run");
});
