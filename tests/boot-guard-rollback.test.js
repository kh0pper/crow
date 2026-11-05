/**
 * The boot guard end to end (audit N1c-3, Layer 1).
 *
 * The fixture is a scratch origin plus a clone whose commit A boots and whose
 * commit B throws while its module graph loads — the exact case no code INSIDE
 * the tree can recover from. B also ships its own `scripts/boot-guard/…` (which
 * must never run) and a `reference-transaction` hook (which must never fire on
 * the reset), and the clone sets `core.hooksPath=scripts/hooks` like the live
 * host does.
 *
 * A is marked stable through the real gateway-side module (which installs A's
 * launcher into a scratch CROW_HOME), then the clone is fast-forwarded to B and
 * the launcher is run once per "start", the way systemd would.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { markPlanned, markStable } from "../servers/gateway/boot-guard-state.js";
import { readUpdateQuarantine } from "../servers/shared/update-quarantine.js";

const REPO = join(import.meta.dirname, "..");
const repoFile = (p) => readFileSync(join(REPO, p), "utf8");
const A = "a";
const _fixtures = [];
after(() => { for (const f of _fixtures) { try { rmSync(f.root, { recursive: true, force: true }); } catch {} } });

/* ------------------------------------------------------------- fixture */

const INDEX_A = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FIXTURE_OUT + "/booted-A", "A\\n");
process.exit(0);
`;
const INDEX_B = `import "./boom.js";
`;
const BOOM_B = `throw new Error("this gateway graph does not load");\n`;
const INIT_DB = `// fixture init-db\nprocess.exit(0);\n`;

function makeFixture({ changeInitDb = false, changePkg = false, userVersion = 9 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bg-int-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const out = join(root, "out");
  const crowHome = join(root, "crow-home");
  const dataDir = join(root, "data");
  for (const d of [out, crowHome, dataDir]) mkdirSync(d, { recursive: true });

  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  // After core.hooksPath is set, every test-side git call must disable hooks too,
  // or the test itself would create the sentinel it asserts is absent.
  const gitNoHooks = (cwd, ...args) => execFileSync(
    "git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, stdio: "pipe" },
  ).toString().trim();

  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  git(work, "config", "user.email", "t@t");
  git(work, "config", "user.name", "t");
  for (const d of ["servers/gateway", "servers/shared", "scripts/boot-guard"]) {
    mkdirSync(join(work, d), { recursive: true });
  }
  writeFileSync(join(work, "servers", "gateway", "index.js"), INDEX_A);
  writeFileSync(join(work, "servers", "shared", "schema-version.js"), repoFile("servers/shared/schema-version.js"));
  writeFileSync(join(work, "scripts", "init-db.js"), INIT_DB);
  writeFileSync(join(work, "scripts", "boot-guard", "crow-boot-guard.mjs"), repoFile("scripts/boot-guard/crow-boot-guard.mjs"));
  writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  writeFileSync(join(work, "package-lock.json"), '{\n  "lockfileVersion": 3\n}\n');
  git(work, "add", "-A");
  git(work, "commit", "-m", "A");
  git(work, "push", "origin", "main");
  const a = git(work, "rev-parse", "HEAD");

  // B: an import-time crash, its OWN launcher (must never run), and a hook that
  // would fire on the rollback's ref update (must never run).
  writeFileSync(join(work, "servers", "gateway", "index.js"), INDEX_B);
  writeFileSync(join(work, "servers", "gateway", "boom.js"), BOOM_B);
  writeFileSync(join(work, "scripts", "boot-guard", "crow-boot-guard.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(out, "bad-launcher-ran"))}, "x");\nprocess.exit(0);\n`);
  mkdirSync(join(work, "scripts", "hooks"), { recursive: true });
  writeFileSync(join(work, "scripts", "hooks", "reference-transaction"),
    `#!/bin/sh\n: > ${JSON.stringify(join(out, "hook-ran"))}\n`);
  chmodSync(join(work, "scripts", "hooks", "reference-transaction"), 0o755);
  if (changeInitDb) writeFileSync(join(work, "scripts", "init-db.js"), "// fixture init-db, rebuilt\nprocess.exit(0);\n");
  if (changePkg) writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.1.0"\n}\n');
  git(work, "add", "-A");
  git(work, "commit", "-m", "B");
  git(work, "push", "origin", "main");
  const b = git(work, "rev-parse", "HEAD");

  // Live installs point core.hooksPath INTO the checkout. Set it only now, so
  // the fixture's own commits/push above cannot fire the hook.
  git(work, "config", "core.hooksPath", "scripts/hooks");
  gitNoHooks(work, "reset", "--hard", a); // the clone is genuinely behind again
  git(work, "update-ref", "refs/remotes/origin/main", b);

  const dbPath = join(dataDir, "crow.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();

  const f = {
    root, origin, work, out, crowHome, a, b, dbPath,
    gitDir: join(work, ".git"),
    stateDir: join(crowHome, "boot-guard"),
    launcherPath: join(crowHome, "boot-guard", "crow-boot-guard.mjs"),
    git: (...args) => gitNoHooks(work, ...args),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

const envFor = (f, extra = {}) => ({
  ...process.env, CROW_HOME: f.crowHome, FIXTURE_OUT: f.out, INVOCATION_ID: "", ...extra,
});

function runLauncher(f, extraEnv = {}) {
  return spawnSync(process.execPath, [f.launcherPath, "--app-root", f.work], {
    cwd: f.work, env: envFor(f, extraEnv), encoding: "utf8", timeout: 120_000,
  });
}

function runRecorder(f, { exit = null, extraEnv = {} } = {}) {
  const env = envFor(f, {
    SERVICE_RESULT: exit?.SERVICE_RESULT ?? "",
    EXIT_CODE: exit?.EXIT_CODE ?? "",
    EXIT_STATUS: exit?.EXIT_STATUS ?? "",
    ...extraEnv,
  });
  return spawnSync(process.execPath, [f.launcherPath, "--app-root", f.work, "--record-exit"], {
    cwd: f.work, env, encoding: "utf8", timeout: 60_000,
  });
}

function runGateway(f) {
  return spawnSync(process.execPath, ["servers/gateway/index.js"], {
    cwd: f.work, env: envFor(f), encoding: "utf8", timeout: 60_000,
  });
}

const CRASH = { SERVICE_RESULT: "exit-code", EXIT_CODE: "exited", EXIT_STATUS: "1" };
const readState = (f) => JSON.parse(readFileSync(join(f.stateDir, "state.json"), "utf8"));
const stateExists = (f) => existsSync(join(f.stateDir, "state.json"));

function spoolCodes(crowHome) {
  const dir = join(crowHome, "alerts", "pending");
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).code);
  } catch { return []; }
}

/** Mark A stable through the real gateway module — which installs A's launcher. */
function installAndStabilize(f) {
  const r = markStable(f.a, { appRoot: f.work, dbPath: f.dbPath, stateDir: f.stateDir });
  assert.equal(r.ok, true, `markStable failed: ${r.reason}`);
  assert.ok(existsSync(f.launcherPath), "markStable must install the launcher copy");
}

const fastForwardTo = (f, sha) => {
  f.git("reset", "--hard", sha);
};

/**
 * One "start": the launcher (ExecStartPre), the fake ExecStopPost, then the
 * gateway itself. Stops as soon as the launcher leaves the pending state.
 */
function cycle(f, { rounds = 6, exit = CRASH, duringStart = null, launcherEnv = {} } = {}) {
  for (let i = 1; i <= rounds; i += 1) {
    const run = runLauncher(f, launcherEnv);
    assert.equal(run.status, 0, `the launcher must always exit 0 (stderr: ${run.stderr})`);
    const state = readState(f);
    if (state.state !== "pending") return { iterations: i, state };
    if (duringStart) duringStart(f);
    runRecorder(f, { exit });
    runGateway(f);
  }
  return { iterations: rounds, state: readState(f) };
}

/** Three starts: the trial is armed and two crashes are counted. */
function primeToThreshold(f) {
  const r = cycle(f, { rounds: 3 });
  assert.equal(r.state.state, "pending");
  assert.equal(r.state.failures, 2);
  return r;
}

/* ------------------------------------------------------- the core rollback */

test("a commit that throws at import is rolled back on start 4 by the installed launcher", () => {
  const f = makeFixture();
  installAndStabilize(f);
  assert.equal(readFileSync(f.launcherPath, "utf8"), repoFile("scripts/boot-guard/crow-boot-guard.mjs"));
  fastForwardTo(f, f.b);

  // Self-arming (B2/R2): one launcher run opens the trial on the new upstream sha.
  runLauncher(f);
  const armed = readState(f);
  assert.equal(armed.state, "pending");
  assert.equal(armed.pending_sha, f.b);
  assert.equal(armed.previous_sha, f.a);
  assert.equal(armed.previous_proven, true);

  const r = cycle(f, { rounds: 6 });
  assert.equal(r.iterations, 4, "the rollback must land on start 4 (N=3 counted crashes)");
  assert.equal(r.state.state, "rolled-back");

  assert.equal(f.git("rev-parse", "HEAD"), f.a, "the checkout must be back on the last healthy commit");
  assert.equal(f.git("symbolic-ref", "-q", "HEAD"), "refs/heads/main", "reset must keep HEAD attached to main");

  const marker = readUpdateQuarantine({ gitDir: f.gitDir });
  assert.ok(marker, "the update quarantine must stop every instance re-pulling the bad commit");
  assert.equal(marker.sha, f.b);
  assert.equal(marker.reason, "startup-crash");

  assert.ok(spoolCodes(f.crowHome).includes("update-rolled-back"), "an update-rolled-back alert must be spooled");

  // The two "bad sha code" traps: neither file may exist.
  assert.equal(existsSync(join(f.out, "bad-launcher-ran")), false, "the bad commit's own launcher ran");
  assert.equal(existsSync(join(f.out, "hook-ran")), false, "the bad commit's git hook ran during the reset");

  // And P boots.
  const booted = runGateway(f);
  assert.equal(booted.status, 0);
  assert.ok(existsSync(join(f.out, "booted-A")), "the previous commit must actually boot after the rollback");
});

test("a commit that throws at import never boots on the bad sha before the rollback", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  const r = cycle(f, { rounds: 6 });
  assert.equal(r.iterations, 4);
  // Nothing wrote booted-A while B was checked out (B throws first).
  assert.equal(existsSync(join(f.out, "booted-A")), false);
});

/* --------------------------------------------------------------- peers */

test("two CROW_HOMEs on one checkout perform exactly one reset", () => {
  const f = makeFixture();
  const otherHome = join(f.root, "crow-home-b");
  mkdirSync(otherHome, { recursive: true });
  const otherState = join(otherHome, "boot-guard");
  installAndStabilize(f);
  const second = markStable(f.a, { appRoot: f.work, dbPath: f.dbPath, stateDir: otherState });
  assert.equal(second.ok, true);
  fastForwardTo(f, f.b);

  const resetCount = () => f.git("reflog", "show", "main").split("\n")
    .filter((l) => l.includes("reset: moving to")).length;
  const before = resetCount();

  let first = null;
  let secondResult = null;
  for (let i = 1; i <= 6; i += 1) {
    runLauncher(f);
    runLauncher(f, { CROW_HOME: otherHome });
    first = readState(f);
    secondResult = JSON.parse(readFileSync(join(otherState, "state.json"), "utf8"));
    if (first.state !== "pending" && secondResult.state !== "pending") break;
    runRecorder(f, { exit: CRASH });
    runRecorder(f, { exit: CRASH, extraEnv: { CROW_HOME: otherHome } });
    runGateway(f);
  }

  assert.equal(resetCount() - before, 1, "exactly one instance may move the shared checkout");
  assert.equal(f.git("rev-parse", "HEAD"), f.a);
  const states = [first.state, secondResult.state].sort();
  assert.deepEqual(states, ["rolled-back", "rolled-back-by-peer"],
    `expected one rollback and one peer, got ${states.join(",")}`);
});

/* ------------------------------------------------------------- blocking */

test("a live lock holder defers: HEAD unchanged, nothing written to git", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  primeToThreshold(f);

  const lockPath = join(f.gitDir, "crow-auto-update.lock");
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  try {
    const run = runLauncher(f, { CROW_BOOT_GUARD_LOCK_WAIT_MS: "50" });
    assert.equal(run.status, 0);
    assert.match(run.stderr, /checkout lock/);
    assert.equal(f.git("rev-parse", "HEAD"), f.b, "a deferred run must not move the tree");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a deferred run must not quarantine yet");
    const state = readState(f);
    assert.equal(state.state, "pending");
    assert.equal(state.failures, 3);
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test("a read-only git dir is blocked with an alert and a STATUS file", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: W_OK succeeds on a 0555 directory");
    return;
  }
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  primeToThreshold(f);
  chmodSync(f.gitDir, 0o555);
  try {
    const run = runLauncher(f);
    assert.equal(run.status, 0);
    const state = readState(f);
    assert.equal(state.state, "blocked");
    assert.equal(state.result.reason, "read-only");
    assert.equal(f.git("rev-parse", "HEAD"), f.b, "a blocked run must not move the tree");
    assert.ok(spoolCodes(f.crowHome).includes("update-rollback-blocked"));
    assert.ok(existsSync(join(f.stateDir, "STATUS")), "a refusal must leave the recovery text on disk");
  } finally {
    chmodSync(f.gitDir, 0o755);
  }
});

test("an existing index.lock blocks the rollback and is never deleted", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  primeToThreshold(f);
  const indexPath = join(f.gitDir, "index.lock");
  writeFileSync(indexPath, "");
  const run = runLauncher(f);
  assert.equal(run.status, 0);
  const state = readState(f);
  assert.equal(state.state, "blocked");
  assert.equal(state.result.reason, "index.lock");
  assert.equal(f.git("rev-parse", "HEAD"), f.b);
  assert.ok(existsSync(indexPath), "the guard must never delete a lock it did not create");
  rmSync(indexPath, { force: true });
});

/* --------------------------------------------------------------- schema */

test("a schema-generation crossing refuses and leaves the tree alone", () => {
  const f = makeFixture();
  const db = new DatabaseSync(f.dbPath);
  db.exec("PRAGMA user_version = 10"); // one past the running commit's generation
  db.close();
  installAndStabilize(f);
  fastForwardTo(f, f.b);

  const r = cycle(f, { rounds: 6 });
  assert.equal(r.state.state, "refused");
  assert.equal(r.state.result.reason, "db-ahead");
  assert.equal(f.git("rev-parse", "HEAD"), f.b, "a refusal must not move the tree");
  assert.ok(spoolCodes(f.crowHome).includes("update-rollback-refused"));
  const status = readFileSync(join(f.stateDir, "STATUS"), "utf8");
  assert.match(status, /The DB is ahead of/);
  assert.match(status, /reset --keep/);
});

test("a changed scripts/init-db.js refuses", () => {
  const f = makeFixture({ changeInitDb: true });
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  const r = cycle(f, { rounds: 6 });
  assert.equal(r.state.state, "refused");
  assert.equal(r.state.result.reason, "init-db-changed");
  assert.equal(f.git("rev-parse", "HEAD"), f.b);
});

/* ------------------------------------------------------------ counting */

test("an OOM kill is never counted and spools one alert instead", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  const oom = { SERVICE_RESULT: "oom-kill", EXIT_CODE: "killed", EXIT_STATUS: "KILL" };
  const r = cycle(f, { rounds: 6, exit: oom });
  assert.equal(r.state.state, "pending");
  assert.equal(r.state.failures, 0, "an OOM is evidence about the machine, not the commit");
  assert.equal(f.git("rev-parse", "HEAD"), f.b);
  const codes = spoolCodes(f.crowHome);
  assert.equal(codes.filter((c) => c === "update-oom-during-trial").length, 1, "exactly one OOM alert per trial");
  assert.equal(codes.includes("update-rolled-back"), false);
});

test("a planned restart (crow:shutdown / SIGTERM) is never counted", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  const r = cycle(f, {
    rounds: 5,
    // The gateway marks the attempt planned before it exits (index.js wires this
    // to crow:shutdown and gracefulShutdown).
    duringStart: () => { markPlanned({ stateDir: f.stateDir }); },
  });
  assert.equal(r.state.state, "pending");
  assert.equal(r.state.failures, 0, "a restart we asked for is not a crash");
  assert.equal(f.git("rev-parse", "HEAD"), f.b);
});

/* ------------------------------------------------------- self-arming */

test("there is no arming for a local commit that origin/main does not have", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  writeFileSync(join(f.work, "local.txt"), "a local commit\n");
  f.git("add", "-A");
  f.git("commit", "-m", "local work not pushed");
  const local = f.git("rev-parse", "HEAD");

  const run = runLauncher(f);
  assert.equal(run.status, 0);
  const state = readState(f);
  assert.equal(state.state, "ok", "a local commit on main must never be armed");
  assert.equal(f.git("rev-parse", "HEAD"), local);
});

/* ------------------------------------------------------------- deadline */

test("a deadline that cannot cover the git write defers before touching the tree", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  primeToThreshold(f);
  const run = runLauncher(f, { CROW_BOOT_GUARD_DEADLINE_MS: "0" });
  assert.equal(run.status, 0);
  const state = readState(f);
  assert.equal(state.state, "pending");
  assert.equal(state.failures, 3);
  assert.equal(f.git("rev-parse", "HEAD"), f.b);
  assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null);
});

/* ---------------------------------------------------------- dependencies */

test("an npm timeout leaves rolled-back-deps-pending and the next start retries the install", () => {
  const f = makeFixture({ changePkg: true });
  installAndStabilize(f);
  fastForwardTo(f, f.b);

  const shimDir = join(f.root, "shim");
  mkdirSync(shimDir, { recursive: true });
  const npmPath = join(shimDir, "npm");
  writeFileSync(npmPath, "#!/bin/sh\nexec sleep 10\n");
  chmodSync(npmPath, 0o755);
  const env = { PATH: `${shimDir}:${process.env.PATH}`, CROW_BOOT_GUARD_NPM_TIMEOUT_MS: "200" };

  const r = cycle(f, { rounds: 6, exit: CRASH, launcherEnv: env });
  assert.equal(f.git("rev-parse", "HEAD"), f.a, "the reset happens before the install");
  assert.equal(r.state.state, "rolled-back-deps-pending");
  assert.equal(r.state.result.code, "update-rolled-back");
  assert.equal(r.state.deps_changed, true);

  // The next start retries the install FIRST — a fast npm now, which records that
  // it ran, before anything else in the run.
  const marker = join(f.out, "npm-ran");
  writeFileSync(npmPath, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(npmPath, 0o755);
  const again = runLauncher(f, env);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(existsSync(marker), "the deferred dependency install must be retried on the next start");
  const state = readState(f);
  assert.equal(state.state, "rolled-back");
  assert.ok(spoolCodes(f.crowHome).includes("update-rolled-back"));
});

/* ---------------------------------------------------------------- recorder */

test("the ExecStopPost record is written only for the attempt it belongs to (R3)", () => {
  const f = makeFixture();
  installAndStabilize(f);
  fastForwardTo(f, f.b);
  runLauncher(f); // arms and opens the attempt
  const attemptId = readState(f).attempt.id;
  assert.ok(attemptId, "ExecStartPre must record which attempt it opened");

  runRecorder(f, { exit: CRASH, extraEnv: { INVOCATION_ID: `${attemptId}-other` } });
  assert.equal(readState(f).attempt.exit, null, "a record for another invocation must be ignored");
  assert.ok(readState(f).recorder_ran_at, "the recorder still stamps that it ran (S13)");

  runRecorder(f, { exit: CRASH, extraEnv: { INVOCATION_ID: attemptId } });
  const exit = readState(f).attempt.exit;
  assert.equal(exit.exit_code, "exited");
  assert.equal(exit.exit_status, "1");
  assert.equal(exit.service_result, "exit-code");
});