/**
 * The gateway's half of the boot guard (audit N1c-3, Layer 1).
 *
 * The launcher owns every decision; this side only stamps what a running gateway
 * knows (planned exit, ten minutes up) and reports a rollback the launcher made
 * before this process existed. The launcher copy it installs must come from the
 * COMMIT, never the working tree (S4): the tree may already hold the next sha.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  bootGuardProblem, installLauncherCopy, markPlanned, markStable, recordGuardResult,
  rolledBackResultText, scheduleStableMark,
} from "../servers/gateway/boot-guard-state.js";
import { freshState, loadState, saveState } from "../scripts/boot-guard/crow-boot-guard.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const REPO = join(import.meta.dirname, "..");

const _dirs = [];
function scratch(prefix = "bg-gw-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  _dirs.push(dir);
  return dir;
}
after(() => { for (const d of _dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A repo whose commit A carries one version of the launcher. */
function repoWithLauncher(launcherSource = "// launcher as of A\n") {
  const root = scratch("bg-gw-repo-");
  const work = join(root, "work");
  mkdirSync(join(work, "scripts", "boot-guard"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe" });
  const g = (...args) => execFileSync("git", args, { cwd: work, stdio: "pipe" }).toString().trim();
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(work, "scripts", "boot-guard", "crow-boot-guard.mjs"), launcherSource);
  g("add", "-A");
  g("commit", "-m", "A");
  return { root, work, sha: g("rev-parse", "HEAD") };
}

/* ------------------------------------------------------ launcher copy */

test("markStable installs the launcher copy from the COMMIT, not the working tree", () => {
  const r = repoWithLauncher("// launcher as of A\n");
  const stateDir = join(scratch(), "boot-guard");
  // The checkout has already moved on to the next commit's launcher.
  writeFileSync(join(r.work, "scripts", "boot-guard", "crow-boot-guard.mjs"), "// launcher as of B (uncommitted)\n");

  const out = markStable(r.sha, { appRoot: r.work, stateDir, dbPath: "/tmp/crow.db" });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.launcher.installed, true);
  const installed = readFileSync(join(stateDir, "crow-boot-guard.mjs"), "utf8");
  assert.equal(installed, "// launcher as of A\n", "the copy must come from git show <bootSha>, never the worktree");
  assert.equal(lstatSync(join(stateDir, "crow-boot-guard.mjs")).mode & 0o777, 0o600);
  assert.equal(lstatSync(stateDir).mode & 0o777, 0o700);

  const { state } = loadState(stateDir);
  assert.equal(state.state, "ok");
  assert.equal(state.last_ok_sha, r.sha);
  assert.equal(state.db_path, "/tmp/crow.db");
  assert.ok(Number.isFinite(Date.parse(state.stable_at)));
});

test("an unchanged launcher copy is not rewritten", () => {
  const r = repoWithLauncher("// stable\n");
  const stateDir = join(scratch(), "boot-guard");
  assert.equal(installLauncherCopy({ appRoot: r.work, bootSha: r.sha, stateDir }).installed, true);
  const second = installLauncherCopy({ appRoot: r.work, bootSha: r.sha, stateDir });
  assert.equal(second.installed, false);
  assert.equal(second.reason, "current");
});

test("a symlinked boot-guard directory is refused", () => {
  const r = repoWithLauncher("// stable\n");
  const base = scratch();
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const stateDir = join(base, "boot-guard");
  symlinkSync(elsewhere, stateDir);
  const out = installLauncherCopy({ appRoot: r.work, bootSha: r.sha, stateDir });
  assert.equal(out.installed, false);
  assert.equal(existsSync(join(elsewhere, "crow-boot-guard.mjs")), false, "nothing may be written through the link");
});

test("markStable is a no-op while the trial is pending for another sha", () => {
  const stateDir = join(scratch(), "boot-guard");
  const pending = {
    ...freshState(), state: "pending", last_ok_sha: A, previous_sha: A, pending_sha: C,
    previous_proven: true, attempt: { id: "inv", started_at: "2026-01-02T03:04:05.000Z" },
  };
  assert.equal(saveState(stateDir, pending), true);
  const out = markStable(B, { stateDir, dbPath: "/tmp/crow.db" });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, "pending-other");
  const { state } = loadState(stateDir);
  assert.equal(state.state, "pending");
  assert.equal(state.pending_sha, C, "another sha's trial must not be closed by this process");
});

test("markStable flips a pending trial for THIS boot to ok", () => {
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, {
    ...freshState(), state: "pending", last_ok_sha: A, previous_sha: A, pending_sha: B,
    previous_proven: true, failures: 1, attempt: { id: "inv", started_at: "2026-01-02T03:04:05.000Z" },
  });
  const out = markStable(B, { stateDir, install: false });
  assert.equal(out.ok, true);
  const { state } = loadState(stateDir);
  assert.equal(state.state, "ok");
  assert.equal(state.last_ok_sha, B);
  assert.equal(state.failures, 0);
  assert.equal(state.attempt, null);
});

test("the stable mark is armed on an UNREF'd timer", async () => {
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, { ...freshState(), state: "pending", last_ok_sha: A, pending_sha: B, previous_proven: true });

  const slow = scheduleStableMark({ bootSha: B, stateDir, windowMs: 5_000 });
  assert.equal(typeof slow.unref, "function");
  await sleep(20);
  assert.equal(loadState(stateDir).state.state, "pending", "the window must not be short-circuited");
  clearTimeout(slow);

  const fast = scheduleStableMark({ bootSha: B, stateDir, windowMs: 10 });
  await sleep(60);
  clearTimeout(fast);
  assert.equal(loadState(stateDir).state.state, "ok");
  assert.equal(loadState(stateDir).state.last_ok_sha, B);
});

/* ------------------------------------------------------------- planned */

test("markPlanned stamps the attempt in flight (crow:shutdown / SIGTERM)", () => {
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, {
    ...freshState(), state: "pending", last_ok_sha: A, pending_sha: B, previous_proven: true,
    attempt: { id: "inv-1", started_at: "2026-01-02T03:04:05.000Z", planned_at: null, exit: null },
  });
  assert.equal(markPlanned({ stateDir }), true);
  const { state } = loadState(stateDir);
  assert.ok(Number.isFinite(Date.parse(state.attempt.planned_at)), "a planned exit must be recorded");
  // Outside a trial there is nothing to plan.
  saveState(stateDir, { ...freshState(), state: "ok", last_ok_sha: A });
  assert.equal(markPlanned({ stateDir }), false);
});

/* --------------------------------------------------------------- result */

test("recordGuardResult writes the Rolled back line exactly once", async () => {
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, {
    ...freshState(),
    state: "rolled-back",
    previous_sha: A,
    pending_sha: B,
    failures: 3,
    result: { code: "update-rolled-back", from: B, to: A, failures: 3, reason: "startup-crash", at: new Date().toISOString(), recorded: false },
  });
  const calls = [];
  const text = await recordGuardResult({ stateDir, record: async (v) => { calls.push(v); } });
  assert.equal(calls.length, 1);
  assert.equal(text, `Rolled back: ${B.slice(0, 9)} crashed on startup 3 times; running ${A.slice(0, 9)}; `
    + `updates resume when main moves past it`);
  assert.match(text, /^Rolled back: /, "the Layer 0 classifier keys on this prefix");

  const second = await recordGuardResult({ stateDir, record: async (v) => { calls.push(v); } });
  assert.equal(second, null);
  assert.equal(calls.length, 1, "the result must be recorded exactly once");
  assert.equal(loadState(stateDir).state.result.recorded, true);
});

test("the by-peer result names the co-hosted instance", async () => {
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, {
    ...freshState(), state: "rolled-back-by-peer", previous_sha: A, pending_sha: B, failures: 3,
    result: { code: "update-rolled-back", from: B, to: A, failures: 3, reason: "peer", at: new Date().toISOString(), recorded: false },
  });
  const calls = [];
  const text = await recordGuardResult({ stateDir, record: async (v) => { calls.push(v); } });
  assert.match(text, /a co-hosted instance rolled it back/);
  assert.equal(rolledBackResultText(loadState(stateDir).state), text);
});

test("a state that is not rolled back writes nothing", async () => {
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, { ...freshState(), state: "ok", last_ok_sha: A });
  const calls = [];
  assert.equal(await recordGuardResult({ stateDir, record: async (v) => { calls.push(v); } }), null);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------- fix-it (S13) */

test("a missing launcher stamp raises the boot-guard fix-it card", async () => {
  const { default: detector, DEDUP_KEY } = await import("../servers/gateway/fix-it/detectors/boot-guard.js");
  const { BOOT_CHECK_DETECTORS } = await import("../servers/gateway/fix-it/index.js");
  assert.ok(BOOT_CHECK_DETECTORS.some((d) => d.source === "boot-guard"),
    "the boot-guard check must run through the existing fix-it boot checks");

  const stateDir = join(scratch(), "boot-guard");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const boot = (overrides) => saveState(stateDir, { ...freshState(), state: "ok", last_ok_sha: A, ...overrides });

  // CROW_BOOT_GUARD unset: the unit never asked for a guard, so nothing to check.
  assert.equal(bootGuardProblem({ env: {}, stateDir, now, uptimeMs: 60_000 }), null);

  // No state at all.
  const empty = join(scratch(), "boot-guard");
  assert.equal(bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir: empty, now, uptimeMs: 60_000 }).reason, "missing");

  // The launcher never ran for this boot.
  boot({ launcher_ran_at: null });
  const missing = bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000 });
  assert.equal(missing.reason, "launcher");

  // The launcher ran, for this boot.
  boot({
    launcher_ran_at: new Date(now - 30_000).toISOString(),
    stable_at: new Date(now - 86_400_000).toISOString(),
    recorder_ran_at: new Date(now - 40_000).toISOString(),
  });
  assert.equal(bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000 }), null);

  // A stamp from a PREVIOUS boot (the guard did not run this time).
  boot({ launcher_ran_at: new Date(now - 86_400_000).toISOString() });
  assert.equal(bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000 }).reason, "launcher");

  // The recorder never ran, though an earlier boot existed.
  boot({
    launcher_ran_at: new Date(now - 30_000).toISOString(),
    stable_at: new Date(now - 86_400_000).toISOString(),
    recorder_ran_at: null,
  });
  assert.equal(bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000 }).reason, "recorder");

  // And the card itself.
  const items = [];
  const resolved = [];
  const store = {
    upsertItem: async (item) => { items.push(item); return { notify: false }; },
    resolveByKey: async (source, key) => { resolved.push([source, key]); },
  };
  const problem = await detector.check(store, { bootGuard: { env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000 } });
  assert.equal(problem.reason, "recorder");
  assert.equal(items.length, 1);
  assert.equal(items[0].dedupKey, DEDUP_KEY);
  assert.equal(items[0].title, "The boot guard did not run");
  assert.match(items[0].why, /roll back a Crow update that keeps crashing/);

  // A healthy boot resolves the card instead.
  boot({ launcher_ran_at: new Date(now - 30_000).toISOString(), recorder_ran_at: new Date(now - 40_000).toISOString() });
  const fine = await detector.check(store, { bootGuard: { env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000 } });
  assert.equal(fine, null);
  assert.deepEqual(resolved[0], ["boot-guard", DEDUP_KEY]);
});

test("index.js marks an exit planned on crow:shutdown AND in gracefulShutdown", () => {
  // Both paths exit with status 1 on purpose (a supervised restart is not a
  // crash), so both must tell the launcher before the process goes away.
  const src = readFileSync(join(REPO, "servers", "gateway", "index.js"), "utf8");
  const shutdownStart = src.indexOf('process.on("crow:shutdown"');
  const shutdownEnd = src.indexOf("// --- Graceful Shutdown ---");
  assert.ok(shutdownStart > -1 && shutdownEnd > shutdownStart, "the crow:shutdown handler moved");
  assert.match(src.slice(shutdownStart, shutdownEnd), /markPlanned\(\)/);

  const gracefulStart = src.indexOf("async function gracefulShutdown");
  const gracefulEnd = src.indexOf('process.on("SIGINT"');
  assert.ok(gracefulStart > -1 && gracefulEnd > gracefulStart, "gracefulShutdown moved");
  const graceful = src.slice(gracefulStart, gracefulEnd);
  assert.match(graceful, /markPlanned\(\)/, "a SIGTERM restart must not count as a crash");
  // Before the first await: the stamp must land even if shutdown then hangs.
  assert.ok(graceful.indexOf("markPlanned()") < graceful.indexOf("await"),
    "markPlanned must run before gracefulShutdown awaits anything");
});

test("the s13 stamps are readable from a state file the launcher wrote", () => {
  const stateDir = join(scratch(), "boot-guard");
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "state.json");
  saveState(stateDir, { ...freshState(), state: "ok", launcher_ran_at: new Date().toISOString(), launcher_version: "1" });
  chmodSync(path, 0o600);
  const { state } = loadState(stateDir);
  assert.equal(state.launcher_version, "1");
});