/**
 * The pure half of the boot guard (audit N1c-3, Layer 1).
 *
 * decide() owns every rule: when the guard arms itself, what counts as a crash,
 * and each refusal that keeps a rollback from touching the tree. The shell only
 * gathers facts and performs the returned action, so everything here is a plain
 * function call on a state object.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  DEADLINE_MS, FAILURE_THRESHOLD, STATE_MAX_BYTES, STATE_FILE, decide, exitCountsAsCrash, freshState,
  loadState, saveState,
} from "../scripts/boot-guard/crow-boot-guard.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const _dirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "bg-decide-"));
  _dirs.push(dir);
  return dir;
}
after(() => { for (const d of _dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

/** A state mid-trial (the launcher armed and B is checked out). */
function trial(overrides = {}) {
  return {
    ...freshState(),
    state: "pending",
    last_ok_sha: A,
    previous_sha: A,
    pending_sha: B,
    armed_at: new Date().toISOString(),
    previous_proven: true,
    failures: 0,
    attempt: { id: "inv-1", started_at: new Date().toISOString(), planned_at: null, exit: null },
    db_path: "/home/u/.crow/data/crow.db",
    ...overrides,
  };
}

/** Facts for a rollback that every precondition allows. */
function rollbackFacts(overrides = {}) {
  return {
    now: Date.now(),
    head: B,
    branch: "refs/heads/main",
    originMain: B,
    headIsAncestorOfOrigin: true,
    lastOkIsAncestorOfHead: true,
    previousIsAncestorOfPending: true,
    failures: FAILURE_THRESHOLD,
    gitDirWritable: true,
    indexLock: false,
    schema: { ok: true },
    deadlineRemainingMs: DEADLINE_MS,
    ...overrides,
  };
}

/* ------------------------------------------------------------- counting */

test("a first start with no previous attempt is not a failure", () => {
  // The convergence restart opens the trial; nothing has crashed yet.
  assert.equal(exitCountsAsCrash(null, { planned: false }), false);
  const d = decide(trial(), rollbackFacts({ failures: 0 }));
  assert.equal(d.action, "wait", "start 1 must not count anything");
});

test("an unplanned exit before stable counts one failure", () => {
  assert.equal(exitCountsAsCrash({ service_result: "exit-code", exit_code: "exited", exit_status: "1" }), true);
  assert.equal(exitCountsAsCrash({ service_result: "signal", exit_code: "dumped", exit_status: "SEGV" }), true);
  assert.equal(exitCountsAsCrash({ service_result: "signal", exit_code: "killed", exit_status: "SEGV" }), true);
});

test("a planned restart (crow:shutdown / SIGTERM) does not count", () => {
  const record = { service_result: "exit-code", exit_code: "exited", exit_status: "1" };
  assert.equal(exitCountsAsCrash(record, { planned: true }), false);
  // exit 1 is exactly what scheduleSupervisedRestart() uses.
  assert.equal(exitCountsAsCrash(record, { planned: false }), true);
});

test("oom-kill, SIGKILL, exit 78 and a missing record are not failures", () => {
  assert.equal(exitCountsAsCrash({ service_result: "oom-kill", exit_code: "killed", exit_status: "KILL" }), false);
  assert.equal(exitCountsAsCrash({ service_result: "signal", exit_code: "killed", exit_status: "KILL" }), false);
  assert.equal(exitCountsAsCrash({ service_result: "signal", exit_code: "killed", exit_status: "TERM" }), false);
  assert.equal(exitCountsAsCrash({ service_result: "signal", exit_code: "killed", exit_status: "INT" }), false);
  assert.equal(exitCountsAsCrash({ service_result: "signal", exit_code: "killed", exit_status: "HUP" }), false);
  assert.equal(exitCountsAsCrash({ service_result: "exit-code", exit_code: "exited", exit_status: "78" }), false);
  assert.equal(exitCountsAsCrash({ service_result: "timeout", exit_code: "exited", exit_status: "0" }), false);
});

test("rollback happens on start N+1, not before (N=3)", () => {
  // Replay the shell's counting loop: every start counts the attempt it found.
  let state = trial();
  const actions = [];
  for (let start = 1; start <= 5; start += 1) {
    if (state.attempt?.started_at && exitCountsAsCrash(state.attempt.exit)) {
      state = { ...state, failures: state.failures + 1 };
    }
    const d = decide(state, rollbackFacts({ failures: state.failures }));
    actions.push(d.action);
    if (d.action === "rollback") break;
    state = { ...state, attempt: { id: `inv-${start + 1}`, started_at: new Date().toISOString(), exit: { service_result: "exit-code", exit_code: "exited", exit_status: "1" } } };
  }
  assert.deepEqual(actions, ["wait", "wait", "wait", "rollback"],
    `rollback must land on start 4, got ${actions.join(",")}`);
  assert.equal(FAILURE_THRESHOLD, 3);
});

/* -------------------------------------------------------------- arming */

test("self-arms from last_ok_sha when HEAD moved upstream", () => {
  const state = { ...freshState(), state: "ok", last_ok_sha: A, stable_at: new Date().toISOString() };
  const d = decide(state, { head: B, branch: "refs/heads/main", originMain: B, headIsAncestorOfOrigin: true, lastOkIsAncestorOfHead: true });
  assert.equal(d.action, "arm", "a manual pull / reboot onto a newer upstream main must arm the guard");
});

test("does not arm for local commits not in origin/main", () => {
  const state = { ...freshState(), state: "ok", last_ok_sha: A };
  const d = decide(state, { head: C, branch: "refs/heads/main", originMain: B, headIsAncestorOfOrigin: false, lastOkIsAncestorOfHead: true });
  assert.equal(d.action, "idle", "a developer's unpushed commit must never be rolled back");
  assert.equal(d.reason, "not-upstream");
});

test("does not arm off main", () => {
  const state = { ...freshState(), state: "ok", last_ok_sha: A };
  const d = decide(state, { head: B, branch: "refs/heads/feature", originMain: B, headIsAncestorOfOrigin: true, lastOkIsAncestorOfHead: true });
  assert.equal(d.action, "idle");
  assert.equal(d.reason, "not-on-main");
});

test("does not arm when origin/main is missing (logged, never guessed)", () => {
  const state = { ...freshState(), state: "ok", last_ok_sha: A };
  const d = decide(state, { head: B, branch: "refs/heads/main", originMain: "", headIsAncestorOfOrigin: false, lastOkIsAncestorOfHead: true });
  assert.equal(d.action, "idle");
  assert.equal(d.reason, "no-origin-main");
});

test("does not arm when the baseline is not an ancestor of HEAD", () => {
  const state = { ...freshState(), state: "ok", last_ok_sha: C };
  const d = decide(state, { head: B, branch: "refs/heads/main", originMain: B, headIsAncestorOfOrigin: true, lastOkIsAncestorOfHead: false });
  assert.equal(d.action, "idle");
  assert.equal(d.reason, "baseline-not-ancestor");
});

/* ------------------------------------------------- peers and stale records */

test("HEAD == previous → rolled-back-by-peer", () => {
  const d = decide(trial(), rollbackFacts({ head: A }));
  assert.equal(d.action, "peer");
});

test("a record for a sha that is not HEAD is discarded, never acted on", () => {
  const d = decide(trial(), rollbackFacts({ head: C }));
  assert.equal(d.action, "discard");
  assert.equal(d.reason, "tree-moved");
});

/* ------------------------------------------------------------ refusals */

test("unproven previous → refuse", () => {
  const d = decide(trial({ previous_proven: false }), rollbackFacts());
  assert.equal(d.action, "refuse");
  assert.equal(d.reason, "unproven-previous");
});

test("not on refs/heads/main → refuse", () => {
  const d = decide(trial(), rollbackFacts({ branch: "refs/heads/topic" }));
  assert.equal(d.action, "refuse");
  assert.equal(d.reason, "not-on-main");
});

test("previous not an ancestor of pending → refuse", () => {
  const d = decide(trial(), rollbackFacts({ previousIsAncestorOfPending: false }));
  assert.equal(d.action, "refuse");
  assert.equal(d.reason, "previous-not-ancestor");
});

test("a read-only git dir is blocked, not reset", () => {
  const d = decide(trial(), rollbackFacts({ gitDirWritable: false }));
  assert.equal(d.action, "blocked");
  assert.equal(d.reason, "read-only");
});

test("an existing index.lock is blocked (never deleted)", () => {
  const d = decide(trial(), rollbackFacts({ indexLock: true }));
  assert.equal(d.action, "blocked");
  assert.equal(d.reason, "index.lock");
});

test("a failed schema check refuses with its own reason", () => {
  const d = decide(trial(), rollbackFacts({ schema: { ok: false, reason: "db-ahead" } }));
  assert.equal(d.action, "refuse");
  assert.equal(d.reason, "db-ahead");
});

test("a missing schema result refuses rather than guessing", () => {
  const d = decide(trial(), rollbackFacts({ schema: null }));
  assert.equal(d.action, "refuse");
});

/* ------------------------------------------------------------- deadline */

test("a deadline that cannot cover the git write defers", () => {
  const d = decide(trial(), rollbackFacts({ deadlineRemainingMs: 5000 }));
  assert.equal(d.action, "defer");
  assert.equal(d.reason, "deadline");
});

/* --------------------------------------------------------- state reader */

test("a malformed state file is ignored", () => {
  const dir = scratch();
  writeFileSync(join(dir, STATE_FILE), "{not json");
  assert.equal(loadState(dir).state, null);
  assert.match(loadState(dir).error, /JSON/);

  writeFileSync(join(dir, STATE_FILE), JSON.stringify({ v: 1, state: "banana" }));
  assert.equal(loadState(dir).state, null);
  assert.match(loadState(dir).error, /format/);

  writeFileSync(join(dir, STATE_FILE), JSON.stringify({ v: 1, state: "pending", pending_sha: "short" }));
  assert.equal(loadState(dir).state, null, "a non-40-hex sha must invalidate the record");
});

test("a symlinked state file is ignored", () => {
  const dir = scratch();
  const real = join(dir, "real.json");
  writeFileSync(real, JSON.stringify({ ...freshState(), state: "ok", last_ok_sha: A }));
  symlinkSync(real, join(dir, STATE_FILE));
  const loaded = loadState(dir);
  assert.equal(loaded.state, null);
  assert.match(loaded.error, /symlink/);
});

test("an oversized state file is ignored", () => {
  const dir = scratch();
  writeFileSync(join(dir, STATE_FILE), "x".repeat(STATE_MAX_BYTES + 1));
  const loaded = loadState(dir);
  assert.equal(loaded.state, null);
  assert.match(loaded.error, /oversized/);
});

test("a state file owned by another user is ignored", () => {
  const dir = scratch();
  writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...freshState(), state: "ok", last_ok_sha: A }));
  const loaded = loadState(dir, { uid: (process.getuid?.() ?? 0) + 1 });
  assert.equal(loaded.state, null);
  assert.match(loaded.error, /another user/);
});

test("a valid state round-trips through saveState and loadState", () => {
  const dir = scratch();
  mkdirSync(dir, { recursive: true });
  assert.equal(saveState(dir, trial({ failures: 2 })), true);
  const loaded = loadState(dir);
  assert.equal(loaded.error, null);
  assert.equal(loaded.state.pending_sha, B);
  assert.equal(loaded.state.failures, 2);
});