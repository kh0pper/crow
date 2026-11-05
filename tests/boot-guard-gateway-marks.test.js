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
import { dirname, join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  bootGuardProblem, demoteHeldMarker, installLauncherCopy, markPlanned, markStable, recordGuardResult,
  rolledBackResultText, scheduleStableMark,
} from "../servers/gateway/boot-guard-state.js";
import {
  clearUpdateQuarantine, ownerForHome, readUpdateQuarantine, writeUpdateQuarantine,
} from "../servers/shared/update-quarantine.js";
import { _setDbForTest } from "../servers/gateway/auto-update.js";
import { _setAlertsRootForTest, drainAlertSpool } from "../servers/shared/alert-spool.js";
import { freshState, loadState, saveState, writeSpoolAlert } from "../scripts/boot-guard/crow-boot-guard.mjs";

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
after(() => {
  _setAlertsRootForTest(null);
  _setDbForTest(null);
  for (const d of _dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

/** dashboard_settings behind a Map plus the notifications INSERT: enough for
 *  saveSetting, stampResultSince, createNotification and the spool's dedupe. */
function stubDb() {
  const settings = new Map();
  const notifications = [];
  return {
    settings,
    notifications,
    async execute({ sql, args = [] } = {}) {
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(sql || "")) {
        return { rows: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
      }
      if (/SELECT key, value FROM dashboard_settings WHERE key IN \(\?, \?\)/.test(sql || "")) {
        return { rows: args.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      if (/INSERT INTO dashboard_settings/.test(sql || "")) {
        settings.set(args[0], args[1]);
        return { rows: [], lastInsertRowid: 0 };
      }
      if (/INSERT INTO notifications/.test(sql || "")) {
        notifications.push({
          type: args[0], source: args[1], title: args[2], body: args[3],
          priority: args[4], action_url: args[5], metadata: args[6],
        });
        return { rows: [], lastInsertRowid: notifications.length };
      }
      return { rows: [] }; // the spool's dedupe SELECT, and anything else
    },
  };
}

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

/* ------------------------------------------- whose refusal is it (round 2/3) */

/** The state a refusal leaves: `reportRefusal` in the launcher keeps
 *  `pending_sha`, writes `state: "refused"` (a block writes `"blocked"`), and
 *  records the HELD marker it wrote as `refusal` (fix round 3). */
function refusedState(pendingSha, markerAt = "2026-01-02T03:04:05.000Z") {
  return {
    ...freshState(),
    state: "refused",
    last_ok_sha: A,
    previous_sha: A,
    pending_sha: pendingSha,
    previous_proven: true,
    failures: 3,
    refusal: { sha: pendingSha, marker_at: markerAt },
    result: {
      code: "update-rollback-refused", from: pendingSha, to: A, failures: 3, reason: "db-ahead",
      at: "2026-01-02T03:04:05.000Z", recorded: true,
    },
  };
}

/** The HELD marker a refusal / a blocked reset leaves in the shared git dir. */
function writeHeldMarker(gitDir, sha, { by = "boot-guard", now = Date.now(), owner = null } = {}) {
  const written = writeUpdateQuarantine({
    gitDir, sha, previous: A, reason: "startup-crash", by, now, persist: true, owner,
  });
  assert.ok(written, "fixture precondition: the marker must be written");
  return written;
}

const gitDirOf = (repo) => join(repo.work, ".git");
/** This instance's owner id, derived exactly as markStable derives it. */
const ownerOf = (stateDir) => ownerForHome(dirname(stateDir));

test("markStable leaves a HELD marker written by someone else alone (fix round 2)", () => {
  // Only the boot guard's own marker says anything about this instance's boot.
  const r = repoWithLauncher("// launcher\n");
  const stateDir = join(scratch(), "boot-guard");
  const at = writeHeldMarker(gitDirOf(r), r.sha, { by: "crow-update" }).at;
  saveState(stateDir, refusedState(r.sha, at));

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.marker.demoted, false);
  assert.equal(out.marker.reason, "other-writer", JSON.stringify(out.marker));
  const marker = readUpdateQuarantine({ gitDir: gitDirOf(r) });
  assert.equal(marker.by, "crow-update", "another writer's marker must not be rewritten to by: boot-guard");
  assert.equal(marker.held, true);
  assert.equal(marker.at, at, "an untouched marker keeps its own stamp");
});

test("markStable leaves a HELD marker naming another sha alone (fix round 2)", () => {
  // A state that refused B says nothing about a marker for C.
  const r = repoWithLauncher("// launcher\n");
  const C_SHA = "c".repeat(40);
  const stateDir = join(scratch(), "boot-guard");
  const at = writeHeldMarker(gitDirOf(r), C_SHA, { owner: ownerOf(stateDir) }).at;
  saveState(stateDir, refusedState(r.sha, at));

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.marker.demoted, false);
  assert.equal(out.marker.reason, "other-sha", JSON.stringify(out.marker));
  const marker = readUpdateQuarantine({ gitDir: gitDirOf(r) });
  assert.equal(marker.sha, C_SHA);
  assert.equal(marker.held, true, "another sha's refusal must stay HELD");
  assert.equal(marker.at, at);
});

test("a marker that changes between the read and the write is left as it is (fix round 2)", () => {
  // The marker is shared, so a peer can rewrite it while this instance decides.
  // The write is a rename of a record built from the FIRST read: without a
  // re-read it would overwrite the peer's record (and push `at` back in time,
  // re-spending a TTL).
  const r = repoWithLauncher("// launcher\n");
  const C_SHA = "c".repeat(40);
  const t0 = Date.parse("2026-03-01T00:00:00.000Z");
  const peerAt = "2026-03-01T00:02:00.000Z";

  const demoteWith = (mutate) => {
    const gitDir = gitDirOf(r);
    clearUpdateQuarantine({ gitDir });
    writeHeldMarker(gitDir, r.sha, { now: t0 });
    let reads = 0;
    const readMarker = ({ gitDir: dir }) => {
      reads += 1;
      if (reads === 1) return readUpdateQuarantine({ gitDir: dir });
      mutate(dir); // the peer's write, in the window
      return readUpdateQuarantine({ gitDir: dir });
    };
    const out = demoteHeldMarker({ gitDir, bootSha: r.sha, readMarker });
    return { out, reads, gitDir };
  };

  // A fresher refusal for ANOTHER sha landed in the window.
  const peer = demoteWith((dir) => writeHeldMarker(dir, C_SHA, { now: Date.parse(peerAt) }));
  assert.equal(peer.reads, 2, "the marker must be re-read right before the write");
  assert.equal(peer.out.demoted, false);
  assert.equal(peer.out.reason, "changed", JSON.stringify(peer.out));
  const kept = readUpdateQuarantine({ gitDir: peer.gitDir });
  assert.equal(kept.sha, C_SHA, "the peer's marker must survive, not be replaced with this boot's sha");
  assert.equal(kept.held, true);
  assert.equal(kept.at, peerAt, "the peer's stamp must not be rewritten from the stale read");

  // The peer CLEARED the marker (or demoted it) while this instance decided.
  const gone = demoteWith((dir) => clearUpdateQuarantine({ gitDir: dir }));
  assert.equal(gone.out.demoted, false);
  assert.equal(gone.out.reason, "changed", JSON.stringify(gone.out));
  assert.equal(readUpdateQuarantine({ gitDir: gone.gitDir }), null, "a marker a peer cleared must not be resurrected");
});

/* ------------------------------------- bound to the refusal that wrote it (round 3) */

test("a re-armed trial still demotes: the gate is the refusal record, not the state name (fix round 3)", () => {
  // A refusal whose reason is not permanent lets the launcher re-arm on the next
  // start, so the state is `pending` for B again. The HELD marker is still the
  // one this instance wrote, and ten minutes up on B is still the proof that it
  // runs — keying the gate on the state name froze every such box until an
  // operator deleted the marker by hand.
  const r = repoWithLauncher("// launcher\n");
  const stateDir = join(scratch(), "boot-guard");
  const owner = ownerOf(stateDir);
  const held = writeHeldMarker(gitDirOf(r), r.sha, { owner });
  saveState(stateDir, {
    ...freshState(),
    state: "pending",
    last_ok_sha: A,
    previous_sha: A,
    pending_sha: r.sha,
    previous_proven: true,
    failures: 1,
    refusal: { sha: r.sha, marker_at: held.at },
    attempt: { id: "inv-rearm", started_at: "2026-01-02T03:04:05.000Z" },
  });

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.marker.demoted, true, JSON.stringify(out.marker));
  assert.equal(readUpdateQuarantine({ gitDir: gitDirOf(r) }).held, undefined);
  assert.equal(loadState(stateDir).state.refusal, null, "a demotion spends the refusal record");
});

test("a peer's HELD marker for the same sha is never demoted: the owner is not ours (fix round 3)", () => {
  // One checkout, two instances. Y's state can name B (its own refusal of it)
  // and still not be the instance that wrote the marker on disk.
  const r = repoWithLauncher("// launcher\n");
  const stateDir = join(scratch(), "boot-guard");
  const peerOwner = "0123456789abcdef";
  const held = writeHeldMarker(gitDirOf(r), r.sha, { owner: peerOwner });
  saveState(stateDir, { ...refusedState(r.sha, held.at), pending_sha: r.sha });

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.marker.demoted, false, JSON.stringify(out.marker));
  assert.equal(out.marker.reason, "other-owner", JSON.stringify(out.marker));
  const marker = readUpdateQuarantine({ gitDir: gitDirOf(r) });
  assert.equal(marker.held, true, "a peer's refusal must stay HELD");
  assert.equal(marker.owner, peerOwner);
  assert.equal(marker.at, held.at);
  assert.equal(loadState(stateDir).state.refusal, null,
    "the record cannot describe a marker this instance did not write");
});

test("a HELD marker from a release without an owner is left alone (fix round 3)", () => {
  // Nothing in an owner-less marker proves which instance wrote it, so no stable
  // mark may claim it (the record is readable and still refuses, as before).
  const r = repoWithLauncher("// launcher\n");
  const stateDir = join(scratch(), "boot-guard");
  const held = writeHeldMarker(gitDirOf(r), r.sha);
  assert.equal(held.owner, undefined, "fixture precondition: no owner field");
  saveState(stateDir, refusedState(r.sha, held.at));

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.marker.demoted, false, JSON.stringify(out.marker));
  assert.equal(out.marker.reason, "other-owner", JSON.stringify(out.marker));
  assert.equal(readUpdateQuarantine({ gitDir: gitDirOf(r) }).held, true);
});

test("a demote whose write fails KEEPS the refusal record, and the next stable mark retries (fix round 3)", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: a 0555 directory is still writable");
    return;
  }
  const r = repoWithLauncher("// launcher\n");
  const gitDir = gitDirOf(r);
  const stateDir = join(scratch(), "boot-guard");
  const held = writeHeldMarker(gitDir, r.sha, { owner: ownerOf(stateDir) });
  saveState(stateDir, refusedState(r.sha, held.at));

  chmodSync(gitDir, 0o555);
  let failed;
  try {
    failed = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  } finally {
    chmodSync(gitDir, 0o755);
  }
  assert.equal(failed.ok, true, failed.reason);
  assert.equal(failed.marker.demoted, false, JSON.stringify(failed.marker));
  assert.equal(failed.marker.reason, "write-failed", JSON.stringify(failed.marker));
  assert.equal(readUpdateQuarantine({ gitDir }).held, true, "nothing was written");
  assert.deepEqual(loadState(stateDir).state.refusal, { sha: r.sha, marker_at: held.at },
    "a transient write failure must not spend the record — the next stable mark retries");

  const retried = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(retried.marker.demoted, true, JSON.stringify(retried.marker));
  assert.equal(readUpdateQuarantine({ gitDir }).held, undefined);
  assert.equal(loadState(stateDir).state.refusal, null);
});

test("a terminal answer clears the refusal record: the marker is gone (fix round 3)", () => {
  const r = repoWithLauncher("// launcher\n");
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, refusedState(r.sha, "2026-01-02T03:04:05.000Z"));

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.marker.demoted, false, JSON.stringify(out.marker));
  assert.equal(out.marker.reason, "no-marker", JSON.stringify(out.marker));
  assert.equal(loadState(stateDir).state.refusal, null, "there is no marker left to demote");
});

test("a terminal answer clears the refusal record: the marker names another sha (fix round 3)", () => {
  const r = repoWithLauncher("// launcher\n");
  const C_SHA = "c".repeat(40);
  const stateDir = join(scratch(), "boot-guard");
  const held = writeHeldMarker(gitDirOf(r), C_SHA, { owner: ownerOf(stateDir) });
  saveState(stateDir, refusedState(r.sha, held.at));

  const out = markStable(r.sha, { appRoot: r.work, stateDir, install: false });
  assert.equal(out.marker.reason, "other-sha", JSON.stringify(out.marker));
  assert.equal(loadState(stateDir).state.refusal, null, "the record no longer describes the marker on disk");
  assert.equal(readUpdateQuarantine({ gitDir: gitDirOf(r) }).held, true, "and the marker itself is untouched");
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

test("a rollback still waiting on dependencies is recorded too", async () => {
  // The previous commit is running; npm is still being retried. The dashboard
  // line must not be lost just because the state is not "rolled-back" yet.
  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, {
    ...freshState(), state: "rolled-back-deps-pending", previous_sha: A, pending_sha: B, failures: 3,
    deps_pending: true,
    result: { code: "update-rolled-back", from: B, to: A, failures: 3, reason: "startup-crash", at: new Date().toISOString(), recorded: false },
  });
  const calls = [];
  const text = await recordGuardResult({ stateDir, record: async (v) => { calls.push(v); } });
  assert.equal(calls.length, 1, "rolled-back-deps-pending must reach auto_update_last_result");
  assert.equal(text, `Rolled back: ${B.slice(0, 9)} crashed on startup 3 times; running ${A.slice(0, 9)}; `
    + `updates resume when main moves past it`);
});

test("markStable carries an unrecorded rollback result instead of clearing it", async () => {
  // markStable cannot write the DB itself; it must not drop what the next boot
  // still has to report (the launcher rolled back while the DB was not up).
  const r = repoWithLauncher("// launcher as of A\n");
  const stateDir = join(scratch(), "boot-guard");
  const result = { code: "update-rolled-back", from: B, to: A, failures: 3, reason: "startup-crash", at: new Date().toISOString(), recorded: false };
  saveState(stateDir, { ...freshState(), state: "rolled-back-deps-pending", last_ok_sha: A, previous_sha: A, pending_sha: B, result });

  const out = markStable(r.sha, { appRoot: r.work, stateDir });
  assert.equal(out.ok, true, out.reason);
  const { state } = loadState(stateDir);
  assert.equal(state.state, "ok");
  assert.equal(state.result?.recorded, false, "the unrecorded result must survive the stable mark");

  const calls = [];
  const text = await recordGuardResult({ stateDir, record: async (v) => { calls.push(v); } });
  assert.equal(calls.length, 1, "the next boot must still be able to write the rollback line");
  assert.match(text, /^Rolled back: /);
});

/* ------------------------------------------------------------ bell rows (F4) */

/** A state the launcher leaves after a rollback, spool alert and all. */
function rolledBackState({ alerted }) {
  return {
    ...freshState(),
    state: "rolled-back",
    last_ok_sha: A,
    previous_sha: A,
    pending_sha: B,
    failures: 3,
    last_crash: { SERVICE_RESULT: "exit-code", EXIT_CODE: "exited", EXIT_STATUS: "1" },
    alerted,
    result: {
      code: "update-rolled-back", from: B, to: A, failures: 3, reason: "startup-crash",
      at: "2026-01-02T03:04:05.000Z", recorded: false,
    },
  };
}

const SPOOL_BODY = `Commit ${B.slice(0, 9)} crashed on startup 3 times, so the checkout was moved back to `
  + `${A.slice(0, 9)} and the previous code is running again. ${B.slice(0, 9)} is quarantined: updates resume `
  + "by themselves when main moves past it.";

test("one boot-guard rollback gives ONE bell row: the spooled one (F4)", async () => {
  // The launcher spools `update-rolled-back` and the boot-time drain delivers it;
  // recordGuardResult then wrote the SAME event's result, whose saveSetting rang
  // notifyUpdateFailure — two rows for one rollback whenever the 24 h per-code
  // cooldown did not swallow the second.
  const crowHome = scratch("bg-bell-");
  const stateDir = join(crowHome, "boot-guard");
  mkdirSync(join(crowHome, "alerts"), { recursive: true });
  _setAlertsRootForTest(join(crowHome, "alerts"));
  assert.ok(writeSpoolAlert({
    crowHome,
    code: "update-rolled-back",
    title: "Crow rolled back an update that would not start",
    body: SPOOL_BODY,
    at: "2026-01-02T03:04:05.000Z",
  }), "the launcher must have spooled its alert");
  saveState(stateDir, rolledBackState({ alerted: { "update-rolled-back": B } }));

  const db = stubDb();
  const created = [];
  const createNotification = async (_db, n) => { created.push(n); return { id: created.length }; };
  try {
    _setDbForTest(db);
    await drainAlertSpool(db, { createNotification, log: () => {} });
    const text = await recordGuardResult({ stateDir });

    const rows = [...created, ...db.notifications];
    assert.equal(rows.length, 1, `one rollback, one row: ${JSON.stringify(rows)}`);
    assert.equal(created[0].source, "migrations", "the surviving row is the launcher's own alert");
    assert.match(created[0].body, /crashed on startup 3 times/);
    assert.ok(!/fails to load/.test(`${created[0].title} ${created[0].body}`),
      "a startup crash must never be described as code that fails to load");
    // The Settings → Updates line is still written: only the bell is deduped.
    assert.match(text, /^Rolled back: /);
    assert.match(db.settings.get("auto_update_last_result"), /^Rolled back: /);
    assert.ok(!db.settings.has("auto_update_notified_code"),
      "the suppressed bell must not claim a notification it never made");
  } finally {
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("a rollback whose spool write failed still rings the auto-update bell (F4)", async () => {
  // The suppression is conditional on the spool file really existing: with no
  // spool, the result write is the only channel left, so it must ring.
  const crowHome = scratch("bg-bell-nospool-");
  const stateDir = join(crowHome, "boot-guard");
  mkdirSync(join(crowHome, "alerts"), { recursive: true });
  _setAlertsRootForTest(join(crowHome, "alerts"));
  saveState(stateDir, rolledBackState({ alerted: {} }));

  const db = stubDb();
  const created = [];
  const createNotification = async (_db, n) => { created.push(n); return { id: created.length }; };
  try {
    _setDbForTest(db);
    await drainAlertSpool(db, { createNotification, log: () => {} });
    const text = await recordGuardResult({ stateDir });

    assert.equal(created.length, 0, "no spool file, so the drain delivers nothing");
    assert.equal(db.notifications.length, 1, `the sole channel must ring once: ${JSON.stringify(db.notifications)}`);
    assert.equal(db.notifications[0].source, "auto-update");
    assert.match(db.notifications[0].body, /crashed on startup 3 times/, "the recorded result is quoted verbatim");
    // S3: this row is the only channel left, and it is a STARTUP CRASH. The
    // cause-neutral "its code does not load, or its dependencies could not be
    // installed" is the Layer 0 wording and must not appear here.
    assert.ok(!/does not load/.test(`${db.notifications[0].title} ${db.notifications[0].body}`),
      `a startup crash must never be described as code that does not load: ${db.notifications[0].body}`);
    assert.match(db.notifications[0].body, /crashed on startup, so it was rolled back/,
      "the action text itself describes a startup crash (S3)");
    assert.match(text, /^Rolled back: /);
  } finally {
    _setDbForTest(null);
    _setAlertsRootForTest(null);
  }
});

test("markStable only claims a launcher_version when the copy was installed", () => {
  // A commit that does not carry the launcher (an old sha) must not make the
  // state claim a copy that is not there.
  const root = scratch("bg-gw-nolauncher-");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe" });
  const g = (...args) => execFileSync("git", args, { cwd: work, stdio: "pipe" }).toString().trim();
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(work, "README.md"), "no launcher here\n");
  g("add", "-A");
  g("commit", "-m", "A without a launcher");
  const sha = g("rev-parse", "HEAD");

  const stateDir = join(scratch(), "boot-guard");
  saveState(stateDir, { ...freshState(), state: "ok", last_ok_sha: A, launcher_version: "0" });
  const out = markStable(sha, { appRoot: work, stateDir });
  assert.equal(out.launcher.installed, false);
  assert.equal(loadState(stateDir).state.launcher_version, "0", "no copy, no version claim");
});

/* ------------------------------------------------------- fix-it (S13) */

test("a missing launcher stamp raises the boot-guard fix-it card", async () => {
  const { default: detector, DEDUP_KEY } = await import("../servers/gateway/fix-it/detectors/boot-guard.js");
  const { BOOT_CHECK_DETECTORS } = await import("../servers/gateway/fix-it/index.js");
  assert.ok(BOOT_CHECK_DETECTORS.some((d) => d.source === "boot-guard"),
    "the boot-guard check must run through the existing fix-it boot checks");

  const stateDir = join(scratch(), "boot-guard");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const hourAgo = (ms) => new Date(now - ms).toISOString();
  const boot = (overrides) => saveState(stateDir, { ...freshState(), state: "ok", last_ok_sha: A, ...overrides });
  // The machine has been up an hour, so a previous start 90 s ago was in this boot.
  const opts = { env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000, systemUptimeMs: 3_600_000 };

  // CROW_BOOT_GUARD unset: the unit never asked for a guard, so nothing to check.
  assert.equal(bootGuardProblem({ ...opts, env: {} }), null);

  // No state at all.
  const empty = join(scratch(), "boot-guard");
  assert.equal(bootGuardProblem({ ...opts, stateDir: empty }).reason, "missing");

  // The launcher never ran for this boot (nor finished).
  boot({ launcher_ran_at: null, launcher_finished_at: null });
  assert.equal(bootGuardProblem(opts).reason, "launcher");

  // The launcher ran, for this boot.
  boot({
    launcher_ran_at: hourAgo(30_000),
    launcher_finished_at: hourAgo(25_000),
    stable_at: new Date(now - 86_400_000).toISOString(),
    prev_launcher_ran_at: hourAgo(90_000),
    recorder_ran_at: hourAgo(40_000),
  });
  assert.equal(bootGuardProblem(opts), null);

  // A stamp from a PREVIOUS boot (the guard did not run this time).
  boot({ launcher_ran_at: hourAgo(86_400_000), launcher_finished_at: hourAgo(86_400_000) });
  assert.equal(bootGuardProblem(opts).reason, "launcher");

  // The recorder never ran, though an earlier boot existed and the previous
  // start was in THIS boot (so a clean stop would have run ExecStopPost).
  boot({
    launcher_ran_at: hourAgo(30_000),
    launcher_finished_at: hourAgo(25_000),
    stable_at: new Date(now - 86_400_000).toISOString(),
    prev_launcher_ran_at: hourAgo(90_000),
    recorder_ran_at: null,
  });
  assert.equal(bootGuardProblem(opts).reason, "recorder");

  // And the card itself.
  const items = [];
  const resolved = [];
  const store = {
    upsertItem: async (item) => { items.push(item); return { notify: false }; },
    resolveByKey: async (source, key) => { resolved.push([source, key]); },
  };
  const problem = await detector.check(store, { bootGuard: opts });
  assert.equal(problem.reason, "recorder");
  assert.equal(items.length, 1);
  assert.equal(items[0].dedupKey, DEDUP_KEY);
  assert.equal(items[0].title, "The boot guard did not run");
  assert.match(items[0].why, /roll back a Crow update that keeps crashing/);

  // A healthy boot resolves the card instead.
  boot({
    launcher_finished_at: hourAgo(25_000),
    stable_at: new Date(now - 86_400_000).toISOString(),
    prev_launcher_ran_at: hourAgo(90_000),
    recorder_ran_at: hourAgo(40_000),
  });
  const fine = await detector.check(store, { bootGuard: opts });
  assert.equal(fine, null);
  assert.deepEqual(resolved[0], ["boot-guard", DEDUP_KEY]);
});

test("a rollback whose dependency install took five minutes raises no card", () => {
  // The launcher started six minutes ago, spent five in npm and finished just
  // before this process; only the FINISH stamp shows that the guard did run.
  const stateDir = join(scratch(), "boot-guard");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  saveState(stateDir, {
    ...freshState(),
    state: "rolled-back",
    last_ok_sha: A,
    previous_sha: A,
    pending_sha: B,
    stable_at: at(86_400_000),
    launcher_ran_at: at(6 * 60_000 + 40_000), // the start, before the lock+npm
    launcher_finished_at: at(40_000), // the end of the pre-start run
    prev_launcher_ran_at: at(7 * 60_000),
    recorder_ran_at: at(6 * 60_000 + 45_000), // the previous stop, before that start
    result: { code: "update-rolled-back", from: B, to: A, failures: 3, reason: "startup-crash", recorded: false },
  });
  assert.equal(
    bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 30_000, systemUptimeMs: 10 * 60_000 }),
    null,
    "a long rollback is the guarded boot, not a broken guard",
  );
});

test("a reboot gap raises no card: the previous stop is unknown, not broken", () => {
  // The previous launcher ran before this boot, so no ExecStopPost was due in
  // this boot at all. Saying "did not run" there would fire on every reboot.
  const stateDir = join(scratch(), "boot-guard");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  saveState(stateDir, {
    ...freshState(),
    state: "ok",
    last_ok_sha: A,
    stable_at: at(86_400_000),
    launcher_ran_at: at(50_000),
    launcher_finished_at: at(45_000),
    prev_launcher_ran_at: at(10 * 60_000), // ten minutes ago, in the PREVIOUS boot
    recorder_ran_at: at(20 * 60_000), // from an even earlier boot
  });
  const problem = bootGuardProblem({ env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000, systemUptimeMs: 60_000 });
  assert.equal(problem.reason, "unknown", "we cannot tell, so we must not accuse the recorder");
});

test("the detector raises nothing for an unknown previous stop", async () => {
  const { default: detector } = await import("../servers/gateway/fix-it/detectors/boot-guard.js");
  const stateDir = join(scratch(), "boot-guard");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  saveState(stateDir, {
    ...freshState(), state: "ok", last_ok_sha: A, stable_at: at(86_400_000),
    launcher_finished_at: at(45_000), prev_launcher_ran_at: at(10 * 60_000),
  });
  const items = [];
  const store = { upsertItem: async (i) => { items.push(i); return { notify: false }; }, resolveByKey: async () => {} };
  const problem = await detector.check(store, { bootGuard: { env: { CROW_BOOT_GUARD: "1" }, stateDir, now, uptimeMs: 60_000, systemUptimeMs: 60_000 } });
  assert.equal(problem, null);
  assert.equal(items.length, 0, "no card on a routine reboot");
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