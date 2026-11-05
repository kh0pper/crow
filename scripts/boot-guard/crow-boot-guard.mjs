#!/usr/bin/env node
/**
 * crow-boot-guard.mjs — the crash-loop rollback guard (audit N1c-3, Layer 1).
 *
 * The gateway cannot heal a commit that throws while its module graph is being
 * evaluated: nothing in the graph has run, so no updater tick ever starts and
 * systemd restarts the crash loop forever. This file therefore runs from
 * OUTSIDE the tree, as the service's `ExecStartPre=`: it counts real crash exits
 * for the commit the checkout holds, and after three of them moves `main` back
 * to the last commit this host proved it could boot.
 *
 * Why it is a copy: it is installed at `<CROW_HOME>/boot-guard/crow-boot-guard.mjs`
 * by a gateway that has just been stable for ten minutes (see
 * servers/gateway/boot-guard-state.js). The bad commit's own copy of this file
 * must never run, so the installed copy is refreshed ONLY from a commit that
 * already booted.
 *
 * Hard rules, each one load-bearing:
 *   - imports are `node:*` builtins ONLY (tests/boot-guard-contract.test.js): the
 *     installed copy cannot resolve the checkout's node_modules, and importing
 *     tree code would execute the sha it is about to judge;
 *   - every git call runs with `core.hooksPath=/dev/null` and
 *     `core.fsmonitor=false` (live installs point core.hooksPath INTO the tree,
 *     so a reset would otherwise run the bad sha's own hooks) and with
 *     GIT_TERMINAL_PROMPT=0 (a credential prompt would hang the start);
 *   - every exit is 0: the unit's `Restart=` policy must still start the
 *     gateway, even when this script is confused;
 *   - no path comes from the state file except `db_path`, which is validated and
 *     opened read-only. The app root comes from argv and must equal realpath(cwd);
 *     CROW_HOME comes from the unit environment.
 *
 * `decide()` is pure and holds every refusal rule; the shell below only gathers
 * facts and performs the effects it returns.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync, chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/** Bumped whenever the state file's meaning changes; stamped as launcher_version. */
export const LAUNCHER_VERSION = "1";
export const STATE_FORMAT = 1;
/** Counted crashes before the rollback, so the decision lands on start N+1. */
export const FAILURE_THRESHOLD = 3;
/** The reader's ceiling: the real record is a few hundred bytes. */
export const STATE_MAX_BYTES = 64 * 1024;
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;
export const BOOT_GUARD_DIR = "boot-guard";
export const STATE_FILE = "state.json";
export const STATUS_FILE = "STATUS";
export const LAUNCHER_FILE = "crow-boot-guard.mjs";
export const LOCK_FILE = "crow-auto-update.lock";

/** Identical to auto-update.js's LOCK_STALE_MS (contract test). */
export const LOCK_STALE_MS = 30 * 60 * 1000;
/** A lock file with no pid yet is being written: young = held (5 s grace). */
export const LOCK_WRITE_GRACE_MS = 5000;
export const LOCK_WAIT_MS = 60 * 1000;
export const LOCK_POLL_MS = 500;
/** Overall budget for one run, under the drop-in's TimeoutStartSec=15min (S6). */
export const DEADLINE_MS = 10 * 60 * 1000;
/** `git reset --keep` is fast; a hung git must not eat the deadline. */
export const RESET_TIMEOUT_MS = 30 * 1000;
/** npm rewrites node_modules; peers wait 6 min for this lock. */
export const NPM_TIMEOUT_MS = 5 * 60 * 1000;
/** Budget that must remain BEFORE the first git write, or the run defers. */
export const MIN_REMAINING_MS = 90 * 1000;
/** Failed dependency reinstalls after a rollback before the guard stops paying
 *  for npm on every start and asks the operator instead. */
export const DEPS_MAX_ATTEMPTS = 3;

/** Refusal reasons that cannot clear on their own: re-arming the same sha would
 *  only cycle refused → pending → refused and boot the bad commit three more
 *  times per cycle. The operator has to act (the alert says how). */
export const PERMANENT_REFUSAL_REASONS = Object.freeze([
  "db-ahead", "init-db-changed", "migration-not-rollback-safe",
]);

export const STATES = Object.freeze([
  "ok", "pending", "rolled-back", "rolled-back-by-peer", "rolled-back-deps-pending", "refused", "blocked",
]);

/** The transient-reason TTLs of servers/shared/update-quarantine.js.
 *  Duplicated because the installed copy cannot import tree code; the contract
 *  test compares the two tables. */
export const TRANSIENT_QUARANTINE_MS = Object.freeze({
  "import-timeout": 6 * 60 * 60 * 1000,
  "init-db-failed": 6 * 60 * 60 * 1000,
  "deps-failed": 6 * 60 * 60 * 1000,
});

/** Signals a service manager sends when it means "stop", not "you crashed". */
export const NON_CRASH_SIGNALS = Object.freeze(["TERM", "INT", "HUP", "KILL"]);

/** A migration id becomes a path component; anything else is refused. */
const MIGRATION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/* ------------------------------------------------------------------ utils */

const iso = (ms) => new Date(ms).toISOString();
const short = (sha) => (typeof sha === "string" && sha ? sha.slice(0, 9) : "unknown");

function log(msg) {
  try { process.stderr.write(`[boot-guard] ${msg}\n`); } catch { /* nothing left to do */ }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Test seams only: a real unit never sets these. */
function envMs(env, key, fallback) {
  return num(env?.[key], fallback);
}

export function crowHomeFor(env = process.env) {
  const raw = String(env?.CROW_HOME || "").trim();
  return raw ? raw : join(homedir(), ".crow");
}

/* -------------------------------------------------------------------- git */

/** The child environment for git: every GIT_* variable from the unit is dropped
 *  (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE would point git at another repository),
 *  then the two we do want are set. */
export function gitChildEnv(env = process.env) {
  const child = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!key.startsWith("GIT_")) child[key] = value;
  }
  child.GIT_TERMINAL_PROMPT = "0";
  child.GIT_ASKPASS = "true";
  return child;
}

export function gitRun(root, args, { timeout = 30_000, env = process.env } = {}) {
  try {
    const r = spawnSync("git", [...GIT_HOOKS_OFF, "-C", root, ...args], {
      timeout,
      encoding: "utf8",
      env: gitChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      code: typeof r.status === "number" ? r.status : 1,
      stdout: String(r.stdout || "").trim(),
      stderr: String(r.stderr || "").trim(),
      timedOut: r.error?.code === "ETIMEDOUT",
    };
  } catch (err) {
    return { code: 1, stdout: "", stderr: String(err?.message || err), timedOut: false };
  }
}

function gitText(root, args, opts) {
  const r = gitRun(root, args, opts);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

function isAncestor(root, ancestor, descendant) {
  if (!FULL_SHA_RE.test(String(ancestor || "")) || !FULL_SHA_RE.test(String(descendant || ""))) return false;
  return gitRun(root, ["merge-base", "--is-ancestor", ancestor, descendant], { timeout: 20_000 }).code === 0;
}

export function gitDirFor(root) {
  return gitText(root, ["rev-parse", "--absolute-git-dir"]);
}

/** Same semantics as treeIsExternal(): a git dir this user cannot write is a
 *  read-only or externally-pulled checkout, and this instance must not reset it. */
function gitDirWritable(gitDir) {
  try {
    const st = lstatSync(gitDir);
    if (!st.isDirectory()) return false;
    accessSync(gitDir, fsConstants.W_OK);
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ state */

export function freshState() {
  return {
    v: STATE_FORMAT,
    state: "ok",
    last_ok_sha: null,
    stable_at: null,
    previous_sha: null,
    pending_sha: null,
    armed_at: null,
    previous_proven: false,
    failures: 0,
    attempt: null,
    db_path: null,
    deps_changed: false,
    result: null,
    alerted: {},
    launcher_ran_at: null,
    launcher_finished_at: null,
    prev_launcher_ran_at: null,
    launcher_version: null,
    recorder_ran_at: null,
    deps_attempts: 0,
  };
}

const shaOrNull = (v) => v == null || (typeof v === "string" && FULL_SHA_RE.test(v));
const strOrNull = (v) => (typeof v === "string" && v ? v : null);

/** Shape validation. Anything not understood is refused, never "repaired". */
export function validateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.v !== STATE_FORMAT) return null;
  if (!STATES.includes(raw.state)) return null;
  if (!shaOrNull(raw.last_ok_sha) || !shaOrNull(raw.previous_sha) || !shaOrNull(raw.pending_sha)) return null;
  if (raw.failures != null && (!Number.isInteger(raw.failures) || raw.failures < 0)) return null;
  if (raw.db_path != null && (typeof raw.db_path !== "string" || !isAbsolute(raw.db_path))) return null;
  if (raw.attempt != null) {
    const a = raw.attempt;
    if (typeof a !== "object" || Array.isArray(a)) return null;
    if (a.id != null && typeof a.id !== "string") return null;
    if (a.exit != null && (typeof a.exit !== "object" || Array.isArray(a.exit))) return null;
  }
  if (raw.result != null && (typeof raw.result !== "object" || Array.isArray(raw.result))) return null;
  if (raw.alerted != null && (typeof raw.alerted !== "object" || Array.isArray(raw.alerted))) return null;
  return {
    ...freshState(),
    ...raw,
    failures: Number.isInteger(raw.failures) ? raw.failures : 0,
    previous_proven: raw.previous_proven === true,
    deps_changed: raw.deps_changed === true,
    alerted: raw.alerted && !Array.isArray(raw.alerted) ? raw.alerted : {},
  };
}

/** 0700, always, and never through a planted symlink. */
function ensureDir(dir) {
  let st = null;
  try { st = lstatSync(dir); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  if (st === null) {
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
  try { chmodSync(dir, 0o700); } catch { /* best effort: umask may already be stricter */ }
}

function ensureHome(crowHome) {
  // CROW_HOME itself may legitimately be a symlink (alert-spool.js takes the
  // same stance); only the boot-guard directory below it is checked.
  try { lstatSync(crowHome); } catch { mkdirSync(crowHome, { recursive: true, mode: 0o700 }); }
}

/**
 * Read + validate `<CROW_HOME>/boot-guard/state.json`.
 *
 * lstat, never stat: a symlink planted at the path must not be followed, and
 * neither must a fifo or a device. Size-capped so a huge file cannot be parsed
 * into memory, and owned by this uid so another account's record is ignored.
 *
 * @returns {{state: object|null, error: string|null}}
 */
export function loadState(stateDir, { readFile = readFileSync, lstat = lstatSync, uid = process.getuid?.() } = {}) {
  const path = join(stateDir, STATE_FILE);
  let st;
  try { st = lstat(path); } catch (err) {
    if (err?.code === "ENOENT") return { state: null, error: null };
    return { state: null, error: err?.message || "unreadable" };
  }
  if (st.isSymbolicLink()) return { state: null, error: "state file is a symlink" };
  if (!st.isFile()) return { state: null, error: "state file is not a regular file" };
  if (st.size > STATE_MAX_BYTES) return { state: null, error: "state file is oversized" };
  if (typeof uid === "number" && typeof st.uid === "number" && st.uid !== uid) {
    return { state: null, error: "state file belongs to another user" };
  }
  let raw;
  try { raw = readFile(path, "utf8"); } catch (err) { return { state: null, error: err?.message || "unreadable" }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { state: null, error: "state file is not JSON" }; }
  const state = validateState(parsed);
  if (!state) return { state: null, error: "state file does not match the format" };
  return { state, error: null };
}

/** Atomic, symlink-safe write: temp + rename, "wx" so a planted file is never followed. */
export function saveState(stateDir, state) {
  try {
    ensureDir(stateDir);
    const path = join(stateDir, STATE_FILE);
    const tmp = join(stateDir, `.${STATE_FILE}.${process.pid}.tmp`);
    let fd = null;
    try {
      try {
        fd = openSync(tmp, "wx", 0o600);
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        try { unlinkSync(tmp); } catch { /* raced with our own leftovers */ }
        fd = openSync(tmp, "wx", 0o600);
      }
      writeSync(fd, JSON.stringify(state, null, 2));
      closeSync(fd);
      fd = null;
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (err) {
      if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw err;
    }
    return true;
  } catch (err) {
    log(`could not write the state file: ${err?.message || err}`);
    return false;
  }
}

/* -------------------------------------------------------------- counting */

/**
 * Is this recorded exit a crash (S5)?
 *
 * Under `npm run gateway` (the live unit shape) these fields describe npm, not
 * node: a killed node reads as `exited 1` and IS counted. That is the intended,
 * conservative direction — npm propagates the status.
 */
export function exitCountsAsCrash(record, { planned = false } = {}) {
  if (!record || typeof record !== "object") return false; // a missing record never counts
  if (planned) return false; // crow:shutdown / SIGTERM / bundle restart
  if (String(record.service_result || "") === "oom-kill") return false;
  const code = String(record.exit_code || "");
  const status = String(record.exit_status || "").trim();
  if (code === "exited") {
    const n = Number(status);
    if (!Number.isFinite(n)) return false;
    return n !== 0 && n !== 78; // 78 = refused instance paths, a config error
  }
  if (code === "dumped") return true;
  if (code === "killed") {
    const sig = status.replace(/^SIG/, "").toUpperCase();
    return !NON_CRASH_SIGNALS.includes(sig);
  }
  return false; // timeout, watchdog, core-dump-free stop: not evidence of a bad commit
}

export function attemptIdFor(env = process.env) {
  // systemd keeps INVOCATION_ID stable across ExecStartPre/ExecStart/ExecStopPost
  // of ONE start, which is exactly the attempt the record belongs to (R3).
  const inv = String(env?.INVOCATION_ID || "").trim();
  return inv || `pid-${process.pid}`;
}

/* --------------------------------------------------------------- decisions */

/**
 * Is self-arming allowed? B2/R2: from any non-pending state, when main moved
 * forward to an UPSTREAM commit on top of the last commit we proved healthy.
 * A developer's local commit on main is never rolled back, and a missing
 * origin/main ref means no arming at all (log only).
 */
function armDecision(state, facts) {
  const head = String(facts.head || "");
  const lastOk = String(state?.last_ok_sha || "");
  if (!FULL_SHA_RE.test(head)) return { action: "idle", reason: "no-head" };
  if (!FULL_SHA_RE.test(lastOk)) return { action: "idle", reason: "no-baseline" };
  if (head === lastOk) return { action: "idle", reason: "current" };
  // A permanent refusal cannot clear by itself, so arming the same sha again
  // would only boot the failing commit three more times per cycle.
  if (state?.state === "refused"
      && String(state.pending_sha || "") === head
      && PERMANENT_REFUSAL_REASONS.includes(String(state.result?.reason || ""))) {
    return { action: "idle", reason: "permanent-refusal" };
  }
  if (facts.branch !== "refs/heads/main") return { action: "idle", reason: "not-on-main" };
  if (!FULL_SHA_RE.test(String(facts.originMain || ""))) return { action: "idle", reason: "no-origin-main" };
  if (!facts.headIsAncestorOfOrigin) return { action: "idle", reason: "not-upstream" };
  if (!facts.lastOkIsAncestorOfHead) return { action: "idle", reason: "baseline-not-ancestor" };
  return { action: "arm" };
}

/** The state a finished trial leaves behind (no pending fields, no result). */
export function clearTrialFields(state) {
  return {
    ...state,
    state: "ok",
    previous_sha: null,
    pending_sha: null,
    armed_at: null,
    previous_proven: false,
    failures: 0,
    attempt: null,
    deps_changed: false,
    deps_pending: false,
    deps_attempts: 0,
    result: null,
    alerted: {},
    last_crash: null,
  };
}

/**
 * Is a `HEAD === previous` state a rollback by a co-hosted instance?
 *
 * Only the boot guard's own marker for THIS sha is evidence of that: a manual
 * `git reset --keep <last good>` (or `scripts/crow-update.sh`) leaves the tree
 * in exactly the same place and must never ring "crashed on startup on another
 * instance".
 */
export function peerRollbackEvidence(marker, pending) {
  return Boolean(marker)
    && marker.sha === pending
    && String(marker.reason || "") === "startup-crash"
    && String(marker.by || "") === "boot-guard";
}

/**
 * The whole decision, pure.
 *
 * @param {object} state validated state record
 * @param {object} facts
 *   { now, head, branch, originMain, headIsAncestorOfOrigin,
 *     lastOkIsAncestorOfHead, previousIsAncestorOfPending, failures,
 *     gitDirWritable, indexLock, schema: {ok, reason, detail},
 *     quarantine, deadlineRemainingMs }
 * @returns {{action: string, reason?: string, failures?: number, detail?: object}}
 */
export function decide(state, facts = {}) {
  const head = String(facts.head || "");
  const failures = Number.isFinite(facts.failures) ? facts.failures : num(state?.failures, 0);

  // A dependency install that timed out after a rollback: finish it first, it is
  // the only thing between this checkout and booting the previous commit. Once
  // the retries are exhausted it never runs npm on a start again.
  if (state?.state === "rolled-back-deps-pending") {
    if (num(state.deps_attempts, 0) >= DEPS_MAX_ATTEMPTS) return { action: "idle", reason: "deps-blocked" };
    if (head && head === state.previous_sha) return { action: "deps-retry" };
    return { action: "discard", reason: "tree-moved" };
  }

  if (state?.state !== "pending") return armDecision(state, facts);

  const pending = String(state.pending_sha || "");
  if (!FULL_SHA_RE.test(pending)) return { action: "discard", reason: "malformed-pending" };

  if (head !== pending) {
    // Peers: another instance on this shared checkout already moved main back.
    if (head && head === state.previous_sha && peerRollbackEvidence(facts.quarantine, pending)) {
      return { action: "peer", failures };
    }
    // Not evidence of a peer: the record is about a commit the tree no longer
    // holds. Discard it — and let the shell arm whatever the tree holds now, so
    // a discarded trial never leaves the next commit unguarded (`rearm`).
    const reason = head && head === state.previous_sha ? "not-a-peer" : "tree-moved";
    return { action: "discard", reason, failures, rearm: armDecision(clearTrialFields(state), facts) };
  }

  if (failures < FAILURE_THRESHOLD) return { action: "wait", failures };

  const refuse = (reason, detail) => ({ action: "refuse", reason, detail, failures });
  const blocked = (reason, detail) => ({ action: "blocked", reason, detail, failures });

  if (!state.previous_proven) return refuse("unproven-previous");
  if (facts.branch !== "refs/heads/main") return refuse("not-on-main");
  if (!facts.previousIsAncestorOfPending) return refuse("previous-not-ancestor");
  if (!facts.gitDirWritable) return blocked("read-only");
  if (facts.indexLock) return blocked("index.lock");
  const schema = facts.schema;
  if (!schema || !schema.ok) return refuse(schema?.reason || "schema-unreadable", schema?.detail);

  // S6: decide BEFORE any git write whether the remaining budget covers it.
  const remaining = Number.isFinite(facts.deadlineRemainingMs) ? facts.deadlineRemainingMs : DEADLINE_MS;
  if (remaining < MIN_REMAINING_MS) return { action: "defer", reason: "deadline", failures };

  return { action: "rollback", failures };
}

/* --------------------------------------------------------------- locking */

export function readLockFile(path, { readFile = readFileSync, stat = statSync } = {}) {
  try {
    const [pidLine, tsLine] = readFile(path, "utf8").split("\n");
    let mtimeMs = NaN;
    try { mtimeMs = stat(path).mtimeMs; } catch { /* gone between read and stat */ }
    return { pid: parseInt(pidLine, 10), ts: Date.parse(tsLine || ""), mtimeMs };
  } catch { return null; }
}

/** Byte-for-byte the rule in auto-update.js's lockIsStale (contract test). */
export function lockIsStale(info, now = Date.now()) {
  if (!info) return true;
  if (!Number.isFinite(info.pid)) {
    return !(Number.isFinite(info.mtimeMs) && now - info.mtimeMs < LOCK_WRITE_GRACE_MS);
  }
  let alive = true;
  // EPERM: the pid exists but belongs to another user, so it is alive.
  try { process.kill(info.pid, 0); } catch (e) { alive = !!(e && e.code === "EPERM"); }
  const old = !Number.isFinite(info.ts) || now - info.ts > LOCK_STALE_MS;
  return !alive || old;
}

export function acquireLockFile(path, { pid = process.pid, now = Date.now() } = {}) {
  // Sweep crash-orphaned quarantine files older than the staleness window.
  try {
    const dir = dirname(path);
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(basename(path) + ".stale.")) continue;
      const full = join(dir, f);
      try { if (now - statSync(full).mtimeMs > LOCK_STALE_MS) unlinkSync(full); } catch { /* raced */ }
    }
  } catch { /* no git dir listing: the acquire below is the real test */ }
  const body = `${pid}\n${new Date(now).toISOString()}\n`;
  const writeLock = () => {
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, body); } finally { closeSync(fd); }
  };
  try {
    writeLock();
    return path;
  } catch (err) {
    if (err?.code !== "EEXIST") return null;
  }
  if (!lockIsStale(readLockFile(path), now)) return null;
  // Atomic reclaim: rename-quarantine — exactly one winner among reclaimers of
  // the same stale inode (rename is not compare-and-swap; the lapping residual
  // is the accepted one, as in auto-update.js).
  const quarantine = `${path}.stale.${pid}`;
  try { renameSync(path, quarantine); } catch { return null; }
  try { unlinkSync(quarantine); } catch { /* already gone */ }
  try { writeLock(); return path; } catch { return null; }
}

export function releaseLockFile(path, { pid = process.pid } = {}) {
  try {
    const info = readLockFile(path);
    if (info && info.pid === pid) unlinkSync(path);
  } catch { /* someone else's lock, or already released */ }
}

/** Wait at most `waitMs` for the checkout lock (60 s on a real unit). */
function sleepSync(ms) {
  // A sync sleep with no child process: the launcher has to stay synchronous so
  // a hung peer can never leave an async timer behind to run a later git write.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* not available: spin */ }
}

export function acquireLockFileWaiting(path, { waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS, pid = process.pid } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const held = acquireLockFile(path, { pid });
    if (held) return held;
    if (Date.now() >= deadline) return null;
    sleepSync(Math.max(0, Math.min(pollMs, deadline - Date.now())));
  }
}

/* ----------------------------------------------------- quarantine marker */

/**
 * The update quarantine record, byte-compatible with
 * servers/shared/update-quarantine.js (contract test compares both readers).
 *
 * `persist` is that module's HELD write: a refusal leaves the bad commit
 * CHECKED OUT, so its marker must never expire into a silent "Up to date".
 */
export function buildUpdateQuarantine({
  sha, previous = null, reason, by = "boot-guard", now = Date.now(), persist = false,
} = {}) {
  if (!FULL_SHA_RE.test(String(sha || ""))) return null;
  if (typeof reason !== "string" || !reason.trim()) return null;
  const held = persist === true;
  const ttl = held ? 0 : TRANSIENT_QUARANTINE_MS[reason];
  return {
    v: 1,
    sha,
    previous: FULL_SHA_RE.test(String(previous || "")) ? previous : null,
    reason,
    at: iso(now),
    by,
    ...(ttl ? { expires_at: iso(now + ttl) } : {}),
    ...(held ? { held: true } : {}),
  };
}

export function readUpdateQuarantineFile(gitDir, { readFile = readFileSync, lstat = lstatSync } = {}) {
  if (!gitDir) return null;
  const path = join(gitDir, "crow-update-quarantine.json");
  try {
    const st = lstat(path);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > STATE_MAX_BYTES) return null;
  } catch { return null; }
  try {
    const m = JSON.parse(readFile(path, "utf8"));
    if (!m || typeof m !== "object" || m.v !== 1) return null;
    if (!FULL_SHA_RE.test(String(m.sha || ""))) return null;
    return m;
  } catch { return null; }
}

/** Written BEFORE the reset, so a crash in between still stops a re-pull. */
export function writeUpdateQuarantineFile(gitDir, record) {
  if (!gitDir || !record) return false;
  const path = join(gitDir, "crow-update-quarantine.json");
  const tmp = `${path}.tmp.${process.pid}`;
  let fd = null;
  try {
    try {
      fd = openSync(tmp, "wx", 0o600);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try { unlinkSync(tmp); } catch { /* our own leftover */ }
      fd = openSync(tmp, "wx", 0o600);
    }
    writeSync(fd, JSON.stringify(record, null, 2));
    closeSync(fd);
    fd = null;
    renameSync(tmp, path); // rename replaces a planted symlink, never follows it
    return true;
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    log(`could not write the update quarantine: ${err?.message || err}`);
    return false;
  }
}

/* ----------------------------------------------------------- alert spool */

/** Same slug rule as alert-spool.js, so the file names sort chronologically. */
function slugFor(code) {
  const slug = String(code || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "alert";
}

/**
 * The alert-spool format (servers/shared/alert-spool.js), re-implemented: the
 * installed copy cannot import it. The gateway's drainAlertSpool delivers these
 * to the bell once a healthy gateway is up (contract test).
 */
export function writeSpoolAlert({ crowHome, code = "alert", title, body = null, at = new Date().toISOString() } = {}) {
  let tmp = null;
  try {
    const root = join(crowHome, "alerts");
    const pending = join(root, "pending");
    // Walk both levels BEFORE creating anything: a planted symlink is refused,
    // never followed, so no write can land outside CROW_HOME.
    for (const d of [root, pending]) {
      let st = null;
      try { st = lstatSync(d); } catch (err) { if (err?.code !== "ENOENT") throw err; }
      if (st === null) { mkdirSync(d, { mode: 0o700 }); st = lstatSync(d); }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a plain directory`);
      try { chmodSync(d, 0o700); } catch { /* best effort */ }
    }
    const stamp = String(at).replace(/[:.]/g, "-");
    const name = `${stamp}-${slugFor(code)}.json`;
    const record = { code: String(code), title: String(title ?? "Crow alert"), body: body == null ? null : String(body), at: String(at) };
    tmp = join(pending, `.${name}.${process.pid}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, JSON.stringify(record, null, 2)); } finally { closeSync(fd); }
    try { chmodSync(tmp, 0o600); } catch { /* umask can only clear bits */ }
    renameSync(tmp, join(pending, name));
    tmp = null;
    // Keep the newest 50, like alert-spool.js: a wedged instance must not fill
    // the disk with one file per failed boot.
    const files = readdirSync(pending).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 50))) {
      try { unlinkSync(join(pending, f)); } catch { /* raced with the drain */ }
    }
    return join(pending, name);
  } catch (err) {
    if (tmp) { try { unlinkSync(tmp); } catch { /* nothing to clean */ } }
    log(`could not spool the ${code} alert: ${err?.message || err}`);
    return null;
  }
}

/* ----------------------------------------------------------------- schema */

export function validateDbPath(dbPath, { lstat = lstatSync, uid = process.getuid?.() } = {}) {
  if (typeof dbPath !== "string" || !dbPath) return "db-unknown";
  if (!isAbsolute(dbPath)) return "db-path-invalid";
  if (basename(dbPath) !== "crow.db") return "db-path-invalid";
  let st;
  try { st = lstat(dbPath); } catch { return "db-unreadable"; }
  if (st.isSymbolicLink() || !st.isFile()) return "db-path-invalid";
  if (typeof uid === "number" && typeof st.uid === "number" && st.uid !== uid) return "db-path-invalid";
  return null;
}

/**
 * The schema rule (§3 / B1 / S8).
 *
 * Rolling code back onto a database that the new code already reshaped is the
 * one thing this guard must never do, so it refuses on:
 *   - `user_version` above the generation the PREVIOUS commit expects (a failed
 *     parse refuses too: "the DB is ahead of P; the cause may not be B");
 *   - any difference in scripts/init-db.js between P and B (it DROPs and
 *     rebuilds tables with no generation bump);
 *   - a registry id whose migration file is neither byte-identical in P and B nor
 *     declared `rollbackSafe = true` in B — read as TEXT with `git show`, never
 *     imported, because importing it would run the bad sha's code.
 *
 * @returns {{ok:boolean, reason?:string, detail?:object, userVersion?:number,
 *   previousGeneration?:number, migrationIds?:string[]}}
 */
export function evaluateSchema({ root, previous, pending, dbPath, git = gitText } = {}) {
  const badPath = validateDbPath(dbPath);
  if (badPath) return { ok: false, reason: badPath };

  const genSrc = git(root, ["show", `${previous}:servers/shared/schema-version.js`]);
  const genMatch = genSrc == null ? null : /SCHEMA_GENERATION\s*=\s*(\d+)/.exec(genSrc);
  if (!genMatch) return { ok: false, reason: "generation-unreadable" };
  const previousGeneration = Number(genMatch[1]);

  const prevInit = git(root, ["rev-parse", `${previous}:scripts/init-db.js`]);
  const pendInit = git(root, ["rev-parse", `${pending}:scripts/init-db.js`]);
  if (!prevInit || !pendInit) return { ok: false, reason: "init-db-unknown" };
  if (prevInit !== pendInit) return { ok: false, reason: "init-db-changed" };

  let db = null;
  let userVersion = 0;
  let ids = [];
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA user_version").get();
    userVersion = Number(row?.user_version ?? 0);
    try {
      ids = db.prepare("SELECT id FROM schema_migrations").all().map((r) => String(r.id));
    } catch (err) {
      // A DB that never ran the registry has no such table: an EMPTY set, not an
      // unreadable one (S8).
      if (!/no such table/i.test(String(err?.message || ""))) return { ok: false, reason: "db-unreadable" };
      ids = [];
    }
  } catch {
    return { ok: false, reason: "db-unreadable" };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  if (!Number.isFinite(userVersion)) return { ok: false, reason: "db-unreadable" };
  if (userVersion > previousGeneration) {
    return { ok: false, reason: "db-ahead", detail: { userVersion, previousGeneration } };
  }

  for (const id of ids) {
    if (!MIGRATION_ID_RE.test(id) || id.includes("..")) {
      return { ok: false, reason: "migration-unknown", detail: { id } };
    }
    const path = `scripts/migrations/${id}.mjs`;
    const inPrev = git(root, ["rev-parse", `${previous}:${path}`]);
    const inPend = git(root, ["rev-parse", `${pending}:${path}`]);
    if (inPrev && inPend && inPrev === inPend) continue; // rule (a): byte-identical
    const text = git(root, ["show", `${pending}:${path}`]);
    if (text == null) return { ok: false, reason: "migration-unknown", detail: { id } };
    const declarations = text.split("\n").map((l) => l.trim())
      .filter((l) => /^export const rollbackSafe = (true|false);$/.test(l));
    if (declarations.length !== 1 || declarations[0] !== "export const rollbackSafe = true;") {
      return { ok: false, reason: "migration-not-rollback-safe", detail: { id } };
    }
  }
  return { ok: true, userVersion, previousGeneration, migrationIds: ids };
}

/** S9: does the update rewrite dependencies? */
export function depsChangedBetween(root, previous, pending, git = gitText) {
  for (const file of ["package.json", "package-lock.json"]) {
    const inPrev = git(root, ["rev-parse", `${previous}:${file}`]) || "";
    const inPend = git(root, ["rev-parse", `${pending}:${file}`]) || "";
    if (inPrev !== inPend) return true;
  }
  return false;
}

/* --------------------------------------------------------------- messages */

/** Where the migration guard writes its pre-migration backups. Re-derived here
 *  because the installed copy cannot import servers/shared/migration-guard.js
 *  (contract test), and a refusal has to name the real directory, not a guess. */
export function backupDirFor(dbPath) {
  if (typeof dbPath !== "string" || !dbPath) return null;
  return join(dirname(dbPath), "backups", "migrations");
}

/** Does that directory actually hold a backup? A missing or empty one is not a
 *  backup, and "restore the backup" when there is none wastes the only window
 *  the operator has. */
function hasBackup(dir) {
  if (!dir) return false;
  try { return readdirSync(dir).some((f) => f.endsWith(".db")); } catch { return false; }
}

/** Registry migrations (an id the DB records whose file changed) run through the
 *  convergence pass and take NO backup of their own — only a guarded init-db run
 *  does. The two kinds must not share one recovery sentence (F3). */
const REGISTRY_REFUSALS = new Set(["migration-not-rollback-safe", "migration-unknown"]);

export function refusalText(reason, { root, detail = {}, failures, pending, previous, dbPath = null }) {
  const b = short(pending);
  const p = short(previous);
  const n = `${failures} times`;
  const dir = backupDirFor(dbPath);
  const backupExists = hasBackup(dir);
  // Every refusal names where the backups ARE, or says this kind of change has
  // none to restore.
  const backups = backupExists
    ? (REGISTRY_REFUSALS.has(reason)
      ? `A registry migration takes no backup of its own; the migration guard's earlier backups are in ${dir}.`
      : `The migration guard's pre-migration backups are in ${dir}.`)
    : (REGISTRY_REFUSALS.has(reason)
      ? "A registry migration takes no automatic backup, so there is nothing to restore."
      : "No automatic backup exists for this kind of change, so there is nothing to restore.");
  // Only a backup that exists can be restored, and only for a change that took one.
  const restoreStep = backupExists && !REGISTRY_REFUSALS.has(reason)
    ? `restore the newest pre-migration backup from ${dir}, ` : "";
  const recover = `To recover: stop the gateway, ${restoreStep}run git -C ${root} log --oneline -5, `
    + `choose a commit known to start, run git -C ${root} reset --keep <that commit>, then start the gateway.`;
  const restore = `To recover: stop the gateway, ${restoreStep}run git -C ${root} reset --keep ${previous}, `
    + "then start the gateway.";
  switch (reason) {
    case "db-ahead":
      return `Commit ${b} crashed on startup ${n}. The DB is ahead of ${p}: its schema generation is now `
        + `${detail.userVersion} and ${p} expects ${detail.previousGeneration}, so the previous code may not `
        + `understand the database, and nothing was changed. The cause may not be ${b}. ${backups} ${restore}`;
    case "init-db-changed":
      return `Commit ${b} crashed on startup ${n} and also changed scripts/init-db.js, which rebuilds tables `
        + `without bumping the schema generation, so ${p} may not understand the database. Nothing was changed. ${backups} ${restore}`;
    case "migration-not-rollback-safe":
      return `Commit ${b} crashed on startup ${n} and applied database migration ${detail.id}, which does not `
        + `declare that the previous code can run on the new shape. Nothing was changed. ${backups} ${restore}`;
    case "migration-unknown":
      return `Commit ${b} crashed on startup ${n} and the database records migration ${detail.id}, which is not `
        + `readable in ${b}. Nothing was changed. ${backups} ${restore}`;
    case "generation-unreadable":
      return `Commit ${b} crashed on startup ${n}, and Crow could not read the schema generation of ${p}, so it `
        + `cannot tell whether the database is still safe for the previous code. Nothing was changed. ${backups} ${recover}`;
    case "init-db-unknown":
      return `Commit ${b} crashed on startup ${n}, and scripts/init-db.js could not be compared between ${p} and `
        + `${b}, so the database may have been rebuilt. Nothing was changed. ${backups} ${recover}`;
    case "db-unreadable":
    case "db-path-invalid":
    case "db-unknown":
      return `Commit ${b} crashed on startup ${n}, and Crow could not read this instance's database to check `
        + `whether the previous code can still use it. Nothing was changed. ${backups} ${recover}`;
    case "unproven-previous":
      return `Commit ${b} crashed on startup ${n}, and Crow has no record of a commit that booted healthily `
        + `before it, so it cannot know what to move back to. Nothing was changed. ${backups} ${recover}`;
    case "not-on-main":
      return `Commit ${b} crashed on startup ${n}, and the checkout is not on main, so moving it back would `
        + `detach HEAD and stop updates. Nothing was changed. ${backups} To recover: put the checkout back on main `
        + `(git -C ${root} checkout main), then run git -C ${root} reset --keep ${previous}.`;
    case "previous-not-ancestor":
      return `Commit ${b} crashed on startup ${n}, and the recorded previous commit ${p} is not an ancestor of `
        + `it, so moving back would drop commits. Nothing was changed. ${backups} ${recover}`;
    default:
      return `Commit ${b} crashed on startup ${n}, and Crow could not check that moving back to ${p} is safe `
        + `(${reason}). Nothing was changed. ${backups} ${recover}`;
  }
}

function blockedText(reason, { root, gitDir, failures, pending, previous }) {
  const b = short(pending);
  const p = short(previous);
  const n = `${failures} times`;
  switch (reason) {
    case "read-only":
      return `Commit ${b} crashed on startup ${n}, but this checkout is read-only here, so nothing was changed. `
        + `The instance that pulls this checkout has to roll it back.`;
    case "index.lock":
      return `Commit ${b} crashed on startup ${n}, and a git index.lock file exists in ${gitDir}, so nothing was `
        + `changed. If no git command is running, remove that file and restart the gateway.`;
    case "reset-failed":
      return `Commit ${b} crashed on startup ${n}. Moving the checkout back to ${p} was refused (local changes `
        + `overlap it), so ${b} is still checked out and the next restart boots it. To recover: run `
        + `git -C ${root} reset --keep ${previous}, then start the gateway.`;
    case "reset-mismatch":
      return `Commit ${b} crashed on startup ${n}. The checkout did not move to ${p} as expected, so ${b} may `
        + `still be checked out. To recover: run git -C ${root} reset --keep ${previous}, then start the gateway.`;
    case "quarantine-unwritable":
      return `Commit ${b} crashed on startup ${n}, but the update quarantine could not be written in ${gitDir}, `
        + `so nothing was changed (an update could pull the same commit again). Check that the git directory is `
        + `writable, then restart the gateway.`;
    default:
      return `Commit ${b} crashed on startup ${n}, and Crow could not roll it back (${reason}). Nothing was changed.`;
  }
}

/* ------------------------------------------------------------------ shell */

const NO_ROLLBACK_TITLE = "Crow could not roll back an update that would not start";

function spoolOnce(state, crowHome, code, { title, body, now }) {
  const key = `${code}`;
  if (state.alerted?.[key] === state.pending_sha) return false;
  const path = writeSpoolAlert({ crowHome, code, title, body, at: iso(now) });
  if (!path) return false;
  state.alerted = { ...(state.alerted || {}), [key]: state.pending_sha };
  return true;
}

function writeStatusFile(stateDir, text) {
  try {
    ensureDir(stateDir);
    const path = join(stateDir, STATUS_FILE);
    const tmp = join(stateDir, `.${STATUS_FILE}.${process.pid}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, `${text}\n`); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    log(`could not write the STATUS file: ${err?.message || err}`);
  }
}

function clearStatusFile(stateDir) {
  try { unlinkSync(join(stateDir, STATUS_FILE)); } catch { /* none left */ }
}

/**
 * A refusal or a block: same record shape either way (spool alert once per
 * pending sha + the STATUS file + the state), so the two paths that can reach it
 * — before the lock and again under it — cannot drift apart.
 */
function reportRefusal({ root, gitDir, state, stateDir, crowHome, now, decision, pending, previous, kind }) {
  const code = kind === "refuse" ? "update-rollback-refused" : "update-rollback-blocked";
  const text = kind === "refuse"
    ? refusalText(decision.reason, {
      root, detail: decision.detail, failures: decision.failures, pending, previous, dbPath: state.db_path,
    })
    : blockedText(decision.reason, { root, gitDir, failures: decision.failures, pending, previous });
  // A refusal leaves the bad commit CHECKED OUT — nothing was changed, so the
  // next update tick would pull the same sha again and re-enter the crash loop
  // the moment the operator follows the recovery steps (F2). HELD (`persist`),
  // because the sha really is still checked out: only the checkout moving off it
  // gives the marker its expiry back.
  if (kind === "refuse") {
    const quarantined = writeUpdateQuarantineFile(gitDir, buildUpdateQuarantine({
      sha: pending, previous, reason: "startup-crash", by: "boot-guard", now, persist: true,
    }));
    if (!quarantined) log(`could not write the update quarantine for ${short(pending)}`);
  }
  const next = {
    ...state,
    state: kind === "refuse" ? "refused" : "blocked",
    failures: decision.failures,
    result: {
      code,
      from: pending,
      to: previous,
      failures: decision.failures,
      reason: decision.reason,
      at: iso(now),
      recorded: true, // nothing to record in the DB: the tree did not move
    },
  };
  spoolOnce(next, crowHome, code, { title: NO_ROLLBACK_TITLE, body: text, now });
  writeStatusFile(stateDir, text);
  saveState(stateDir, next);
  log(`${kind === "refuse" ? "refused" : "blocked"} the rollback of ${short(pending)} (${decision.reason})`);
  return decision;
}

export function parseArgs(argv = []) {
  const out = { appRoot: null, recordExit: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === "--record-exit") out.recordExit = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--app-root") { out.appRoot = argv[i + 1] ?? null; i += 1; }
    else if (arg.startsWith("--app-root=")) out.appRoot = arg.slice("--app-root=".length);
    else log(`ignoring unknown argument ${arg}`);
  }
  return out;
}

/** Real path, or null. Never throws. */
export function realpathOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

/** ExecStopPost: attribute the exit to the attempt the last start opened (R3). */
export function runRecordExit({ stateDir, env = process.env, now = Date.now() } = {}) {
  const loaded = loadState(stateDir);
  if (loaded.error) { log(`record-exit: state ignored (${loaded.error})`); return; }
  const state = loaded.state;
  if (!state) return;
  // The stamp lands on EVERY run: the gateway's fix-it card uses it to prove the
  // recorder is wired up at all, which is true outside a trial too (S13).
  state.recorder_ran_at = iso(now);
  if (state.state !== "pending") { saveState(stateDir, state); return; }
  const attempt = state.attempt;
  if (!attempt || !attempt.started_at) { saveState(stateDir, state); return; }
  const invocation = String(env.INVOCATION_ID || "").trim();
  if (invocation && attempt.id && attempt.id !== invocation) {
    log("record-exit: the record belongs to another attempt — ignored");
    saveState(stateDir, state);
    return;
  }
  if (attempt.exit) { saveState(stateDir, state); return; } // one record per attempt
  state.attempt = {
    ...attempt,
    exit: {
      service_result: String(env.SERVICE_RESULT || ""),
      exit_code: String(env.EXIT_CODE || ""),
      exit_status: String(env.EXIT_STATUS || ""),
      at: iso(now),
    },
  };
  saveState(stateDir, state);
}

/**
 * ExecStartPre. Gathers facts, calls decide(), and performs what it returned.
 * Returns the decision so tests can assert on it directly.
 */
export function runPreStart({ appRoot, env = process.env, cwd = process.cwd(), now = Date.now() } = {}) {
  // 1. The app root comes from argv and must be the directory we were started in.
  const cwdReal = realpathOrNull(cwd);
  const root = appRoot ? realpathOrNull(appRoot) : null;
  if (!root || !cwdReal || root !== cwdReal) {
    log("the app root does not match the working directory — doing nothing");
    return { action: "idle", reason: "app-root-mismatch" };
  }

  const crowHome = crowHomeFor(env);
  const stateDir = join(crowHome, BOOT_GUARD_DIR);
  try { ensureHome(crowHome); } catch (err) { log(`cannot use ${crowHome}: ${err?.message || err}`); return { action: "idle", reason: "home" }; }

  const loaded = loadState(stateDir);
  if (loaded.error) {
    log(`state file ignored (${loaded.error}) — doing nothing`);
    return { action: "idle", reason: "bad-state" };
  }
  const state = loaded.state || freshState();

  // S13 stamps. `launcher_ran_at` marks the START; the stamp the fix-it card
  // checks is `launcher_finished_at`, written at the very end of this run — a
  // rollback can spend minutes in npm after this line, and the gateway starts
  // after it, so the start stamp alone would look stale on exactly the boot that
  // was guarded. The previous start's stamp is kept so the card can ask whether
  // the recorder ran AFTER it.
  state.prev_launcher_ran_at = state.launcher_ran_at || null;
  state.launcher_ran_at = iso(now);
  state.launcher_version = LAUNCHER_VERSION;

  try {
    return preStartOnce({ root, crowHome, stateDir, state, env, now });
  } finally {
    stampLauncherFinished(stateDir);
  }
}

/** END of the pre-start run (S13): reload whatever the run saved and stamp it. */
function stampLauncherFinished(stateDir) {
  const { state, error } = loadState(stateDir);
  if (error || !state) return;
  state.launcher_finished_at = iso(Date.now());
  saveState(stateDir, state);
}

function preStartOnce({ root, crowHome, stateDir, state, env, now }) {
  const startedAt = now;
  const budget = envMs(env, "CROW_BOOT_GUARD_DEADLINE_MS", DEADLINE_MS);
  const deadlineRemainingMs = () => startedAt + budget - Date.now();

  const gitDir = gitDirFor(root);
  if (!gitDir) {
    saveState(stateDir, state);
    log("not a git checkout — nothing to guard");
    return { action: "idle", reason: "no-git" };
  }

  const attemptId = attemptIdFor(env);
  // Whether the attempt that just ended was one we asked for. The "wait" log
  // below must not call a planned restart a crash (F8).
  let plannedExit = false;

  // 2. Count the attempt that just ended, then open this one (S5/R3). The first
  // start after arming has no previous attempt, so it is never counted.
  if (state.state === "pending") {
    const prev = state.attempt;
    if (prev && prev.started_at) {
      const planned = Boolean(prev.planned_at);
      if (exitCountsAsCrash(prev.exit, { planned })) {
        state.failures = num(state.failures, 0) + 1;
        if (prev.exit) state.last_crash = { ...prev.exit };
      } else if (prev.exit && planned) {
        plannedExit = true;
      } else if (prev.exit && String(prev.exit.service_result || "") === "oom-kill") {
        // OOM is never evidence about the commit (operator ruling 4): one alert.
        if (spoolOnce(state, crowHome, "update-oom-during-trial", {
          title: "Crow ran out of memory during an update trial",
          body: `The gateway was killed by the kernel for running out of memory while trying `
            + `${short(state.pending_sha)}. Out-of-memory kills never count toward an automatic rollback, `
            + `because the cause is usually the machine, not the commit.`,
          now,
        })) log(`spooled update-oom-during-trial for ${short(state.pending_sha)}`);
      }
    }
    state.attempt = { id: attemptId, started_at: iso(now), planned_at: null, exit: null };
  }

  const head = gitText(root, ["rev-parse", "HEAD"]) || "";
  const branch = gitText(root, ["symbolic-ref", "-q", "HEAD"]) || "";
  const originMain = gitText(root, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]) || "";
  const previous = state.previous_sha;
  const pending = state.pending_sha;

  const facts = {
    now,
    head,
    branch,
    originMain,
    headIsAncestorOfOrigin: false,
    lastOkIsAncestorOfHead: false,
    previousIsAncestorOfPending: false,
    failures: num(state.failures, 0),
    gitDirWritable: null,
    indexLock: false,
    schema: null,
    quarantine: null,
    deadlineRemainingMs: Infinity,
  };

  // Ancestry git calls only where the answer can change the decision.
  if (state.state !== "pending") {
    facts.headIsAncestorOfOrigin = isAncestor(root, head, originMain);
    facts.lastOkIsAncestorOfHead = isAncestor(root, state.last_ok_sha, head);
  } else if (previous && pending && head === pending && facts.failures >= FAILURE_THRESHOLD) {
    facts.previousIsAncestorOfPending = isAncestor(root, previous, pending);
    facts.gitDirWritable = gitDirWritable(gitDir);
    facts.indexLock = fileExists(join(gitDir, "index.lock"));
    facts.schema = evaluateSchema({ root, previous, pending, dbPath: state.db_path });
  }

  // A peer rollback is only believed with the boot guard's own marker for this
  // sha, so the marker is read before deciding (a manual reset to the previous
  // commit looks identical otherwise).
  if (state.state === "pending") facts.quarantine = readUpdateQuarantineFile(gitDir);
  // S6: the budget is measured AFTER the facts above, so a slow schema read
  // cannot make the remaining time look bigger than it is.
  facts.deadlineRemainingMs = deadlineRemainingMs();

  const decision = decide(state, facts);

  if (decision.action === "arm") {
    armTrial({ state, stateDir, head, attemptId, now });
    return decision;
  }

  if (decision.action === "idle") {
    saveState(stateDir, state);
    if (decision.reason === "no-origin-main") log("no refs/remotes/origin/main — not arming");
    if (decision.reason === "permanent-refusal") {
      log(`${short(head)} was refused for a reason that cannot clear on its own — not re-arming it`);
    }
    return decision;
  }

  if (decision.action === "discard") {
    // The record described a commit the tree no longer holds. Clear it, then arm
    // whatever the tree holds now: returning here would leave the next commit
    // unguarded and its first crash uncounted.
    const cleared = clearTrialFields(state);
    saveState(stateDir, cleared);
    // The refusal text described a commit the tree no longer holds.
    clearStatusFile(stateDir);
    log(`discarded the trial record (${decision.reason}): the tree holds ${short(head)}`);
    const armFacts = {
      ...facts,
      headIsAncestorOfOrigin: isAncestor(root, head, originMain),
      lastOkIsAncestorOfHead: isAncestor(root, state.last_ok_sha, head),
    };
    if (decide(cleared, armFacts).action === "arm") {
      armTrial({ state: cleared, stateDir, head, attemptId, now });
    }
    return decision;
  }

  if (decision.action === "wait" || decision.action === "defer") {
    saveState(stateDir, state);
    if (decision.action === "defer") {
      log(`${short(pending)} is still failing, but this start deferred (${decision.reason})`);
    } else if (plannedExit) {
      // A restart Crow asked for says nothing about the commit being tried (F8).
      log(`${short(pending)}: planned restart, not counted (${state.failures} of ${FAILURE_THRESHOLD})`);
    } else {
      log(`${short(pending)} crashed ${state.failures} of ${FAILURE_THRESHOLD} times`);
    }
    return decision;
  }

  if (decision.action === "peer") {
    const result = {
      code: "update-rolled-back",
      from: pending,
      to: previous,
      failures: decision.failures,
      reason: "peer",
      at: iso(now),
      recorded: false,
    };
    const next = { ...state, state: "rolled-back-by-peer", result, failures: decision.failures };
    spoolOnce(next, crowHome, "update-rolled-back", {
      title: "Crow rolled back an update that would not start",
      body: `Commit ${short(pending)} crashed on startup on another instance sharing this checkout, which `
        + `moved the checkout back to ${short(previous)}. That commit is quarantined: updates resume by `
        + `themselves when main moves past it.`,
      now,
    });
    saveState(stateDir, next);
    clearStatusFile(stateDir);
    log(`another instance already moved the checkout back to ${short(previous)}`);
    return decision;
  }

  if (decision.action === "refuse" || decision.action === "blocked") {
    return reportRefusal({
      root, gitDir, state, stateDir, crowHome, now, decision, pending, previous, kind: decision.action,
    });
  }

  if (decision.action === "deps-retry") {
    const done = retryDependencyInstall({ root, gitDir, state, stateDir, crowHome, env, now });
    return { ...decision, installed: done };
  }

  if (decision.action !== "rollback") {
    saveState(stateDir, state);
    log(`nothing to do (${decision.action})`);
    return decision;
  }

  return performRollback({
    root, gitDir, state, stateDir, crowHome, env, now, facts, decision,
    deadlineAt: startedAt + budget,
  });
}

/** Open a trial for `head` on top of the last commit this host proved (B2/R2). */
function armTrial({ state, stateDir, head, attemptId, now }) {
  const armed = {
    ...state,
    state: "pending",
    previous_sha: state.last_ok_sha,
    pending_sha: head,
    armed_at: iso(now),
    previous_proven: true,
    failures: 0,
    last_crash: null,
    deps_changed: false,
    deps_attempts: 0,
    result: null,
    attempt: { id: attemptId, started_at: iso(now), planned_at: null, exit: null },
  };
  saveState(stateDir, armed);
  // A STATUS file describes the previous trial; a new commit starts clean.
  if (state.pending_sha !== head) clearStatusFile(stateDir);
  log(`armed: ${short(head)} on top of the last healthy ${short(armed.previous_sha)}`);
  return armed;
}

function fileExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/** `npm install --omit=dev` with its own kill, as the puller does it. */
function runNpmInstall({ root, env, timeoutMs }) {
  const timeout = num(timeoutMs, NPM_TIMEOUT_MS);
  try {
    const r = spawnSync("npm", ["install", "--omit=dev"], {
      cwd: root,
      env: { ...env, npm_config_update_notifier: "false" },
      timeout,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: typeof r.status === "number" ? r.status : 1, timedOut: r.error?.code === "ETIMEDOUT" };
  } catch (err) {
    return { code: 1, timedOut: false, error: String(err?.message || err) };
  }
}

/**
 * Retry the install a rollback left unfinished (S6). It runs under the SAME
 * checkout lock as the puller: a peer's update tick rewrites the shared
 * node_modules, and two npm runs at once break both instances.
 */
function retryDependencyInstall({ root, gitDir, state, stateDir, crowHome, env, now }) {
  const lockPath = join(gitDir, LOCK_FILE);
  const lock = acquireLockFileWaiting(lockPath, {
    waitMs: envMs(env, "CROW_BOOT_GUARD_LOCK_WAIT_MS", LOCK_WAIT_MS),
  });
  if (!lock) {
    log("the checkout lock is held elsewhere — the dependency retry waits for the next start");
    return false;
  }
  try {
    // Re-read HEAD under the lock: the tree may have moved while we waited.
    const headNow = gitText(root, ["rev-parse", "HEAD"]) || "";
    if (headNow !== state.previous_sha) {
      log(`the tree holds ${short(headNow)}, not ${short(state.previous_sha)} — not reinstalling`);
      return false;
    }
    log("retrying the dependency install that a rollback left unfinished");
    const r = runNpmInstall({ root, env, timeoutMs: envMs(env, "CROW_BOOT_GUARD_NPM_TIMEOUT_MS", NPM_TIMEOUT_MS) });
    if (r.code === 0) {
      const settled = { ...state, state: state.result ? "rolled-back" : "ok", deps_pending: false, deps_attempts: 0 };
      saveState(stateDir, settled);
      log("dependencies reinstalled — the previous commit is bootable");
      return true;
    }
    const attempts = num(state.deps_attempts, 0) + 1;
    const next = { ...state, deps_pending: true, deps_attempts: attempts };
    if (attempts >= DEPS_MAX_ATTEMPTS) {
      // Stop paying for npm on every start, and say so: the previous code cannot
      // boot without its dependencies, and a silent loop helps nobody.
      spoolOnce(next, crowHome, "update-rollback-blocked", {
        title: NO_ROLLBACK_TITLE,
        body: `Commit ${short(state.pending_sha)} was rolled back, but the dependencies for `
          + `${short(state.previous_sha)} could not be reinstalled (${DEPS_MAX_ATTEMPTS} attempts; the last `
          + `${r.timedOut ? "one timed out" : `one exited ${r.code}`}), so the previous code may not start `
          + `and nothing more will be retried automatically. To recover: run `
          + `npm install --omit=dev in ${root} by hand, then restart the gateway.`,
        now,
      });
      saveState(stateDir, next);
      log(`the dependency install failed ${attempts} times — stopped retrying and spooled an alert`);
      return false;
    }
    saveState(stateDir, next);
    log(`dependency install still failing (${r.timedOut ? "timed out" : `exit ${r.code}`}) — retried on the next start`);
    return false;
  } finally {
    releaseLockFile(lock);
  }
}

/** Lock, re-read HEAD, quarantine, reset, dependencies. */
function performRollback({ root, gitDir, state, stateDir, crowHome, env, now, facts, decision, deadlineAt }) {
  const pending = state.pending_sha;
  const previous = state.previous_sha;
  const lockPath = join(gitDir, LOCK_FILE);
  const lock = acquireLockFileWaiting(lockPath, {
    waitMs: envMs(env, "CROW_BOOT_GUARD_LOCK_WAIT_MS", LOCK_WAIT_MS),
  });
  if (!lock) {
    state.failures = decision.failures;
    saveState(stateDir, state);
    log(`the checkout lock is held elsewhere — deferred, ${short(pending)} will be retried on the next start`);
    return { action: "defer", reason: "locked" };
  }
  try {
    // 1. Re-read HEAD: a peer may have rolled back while we waited.
    const headNow = gitText(root, ["rev-parse", "HEAD"]) || "";
    // Re-read the schema too: a co-hosted instance could have applied forward
    // migrations during the wait, which is exactly what the schema rule exists
    // to catch.
    const schemaNow = headNow === pending
      ? evaluateSchema({ root, previous, pending, dbPath: state.db_path })
      : facts.schema;
    const again = decide(state, {
      ...facts,
      head: headNow,
      schema: schemaNow,
      // Re-read under the lock: the peer's marker was written before its reset.
      quarantine: readUpdateQuarantineFile(gitDir),
      failures: decision.failures,
      // Recomputed: the wait for the lock may have eaten the budget (S6).
      deadlineRemainingMs: deadlineAt - Date.now(),
    });
    if (again.action === "peer") {
      const result = {
        code: "update-rolled-back", from: pending, to: previous, failures: decision.failures,
        reason: "peer", at: iso(now), recorded: false,
      };
      const next = { ...state, state: "rolled-back-by-peer", failures: decision.failures, result };
      spoolOnce(next, crowHome, "update-rolled-back", {
        title: "Crow rolled back an update that would not start",
        body: `Commit ${short(pending)} crashed on startup on another instance sharing this checkout, which `
          + `moved the checkout back to ${short(previous)}. That commit is quarantined: updates resume by `
          + `themselves when main moves past it.`,
        now,
      });
      saveState(stateDir, next);
      clearStatusFile(stateDir);
      log(`another instance moved the checkout back to ${short(previous)} while we waited for the lock`);
      return again;
    }
    if (again.action !== "rollback") {
      // Report a schema refusal found under the lock like any other refusal.
      if (again.action === "refuse" || again.action === "blocked") {
        return reportRefusal({
          root, gitDir, state, stateDir, crowHome, now, decision: again, pending, previous, kind: again.action,
        });
      }
      if (again.action === "discard") {
        // The tree moved while we waited, and not to the previous commit with a
        // marker: the record is about a sha this checkout no longer holds.
        saveState(stateDir, clearTrialFields(state));
        clearStatusFile(stateDir);
        log(`discarded the trial record under the lock (${again.reason}): the tree holds ${short(headNow)}`);
        return again;
      }
      state.failures = decision.failures;
      saveState(stateDir, state);
      log(`deferred after taking the lock (${again.action}${again.reason ? `: ${again.reason}` : ""})`);
      return again;
    }

    // 2. Quarantine BEFORE the tree moves: a crash in between must still stop
    //    every instance on this checkout from re-pulling the commit.
    const quarantined = writeUpdateQuarantineFile(gitDir, buildUpdateQuarantine({
      sha: pending, previous, reason: "startup-crash", by: "boot-guard", now,
    }));
    if (!quarantined) {
      return reportRefusal({
        root, gitDir, state, stateDir, crowHome, now, pending, previous, kind: "blocked",
        decision: { reason: "quarantine-unwritable", failures: decision.failures },
      });
    }

    // 3. Move main back, keeping HEAD attached and unrelated local edits alive.
    //    `--keep` refuses instead of destroying WIP that overlaps (B3 change 2).
    const reset = gitRun(root, ["reset", "--keep", previous], { timeout: RESET_TIMEOUT_MS });
    if (reset.code !== 0) {
      log(`the checkout could not be moved back to ${short(previous)}`);
      return reportRefusal({
        root, gitDir, state, stateDir, crowHome, now, pending, previous, kind: "blocked",
        decision: { reason: "reset-failed", failures: decision.failures },
      });
    }

    const headAfter = gitText(root, ["rev-parse", "HEAD"]) || "";
    if (headAfter !== previous) {
      return reportRefusal({
        root, gitDir, state, stateDir, crowHome, now, pending, previous, kind: "blocked",
        decision: { reason: "reset-mismatch", failures: decision.failures },
      });
    }

    // 4. Dependencies: the lockfile/package.json may differ, and node_modules now
    //    belongs to the bad commit's install until this runs.
    const depsChanged = state.deps_changed || depsChangedBetween(root, previous, pending);
    let depsState = "rolled-back";
    if (depsChanged) {
      log("dependencies changed — reinstalling for the previous commit");
      const npm = runNpmInstall({ root, env, timeoutMs: envMs(env, "CROW_BOOT_GUARD_NPM_TIMEOUT_MS", NPM_TIMEOUT_MS) });
      if (npm.code !== 0) {
        depsState = "rolled-back-deps-pending";
        log(`dependency install ${npm.timedOut ? "timed out" : `failed (exit ${npm.code})`} — the next start retries it`);
      }
    }

    const next = {
      ...state,
      state: depsState,
      failures: decision.failures,
      deps_changed: depsChanged,
      deps_pending: depsState === "rolled-back-deps-pending",
      deps_attempts: 0,
      result: {
        code: "update-rolled-back",
        from: pending,
        to: previous,
        failures: decision.failures,
        reason: "startup-crash",
        at: iso(now),
        recorded: false,
      },
    };
    spoolOnce(next, crowHome, "update-rolled-back", {
      title: "Crow rolled back an update that would not start",
      body: `Commit ${short(pending)} crashed on startup ${decision.failures} times, so the checkout was moved `
        + `back to ${short(previous)} and the previous code is running again. ${short(pending)} is quarantined: `
        + `updates resume by themselves when main moves past it.`,
      now,
    });
    saveState(stateDir, next);
    clearStatusFile(stateDir);
    log(`rolled back ${short(pending)} → ${short(previous)} after ${decision.failures} crashes`);
    return { action: "rolled-back", depsState };
  } finally {
    releaseLockFile(lock);
  }
}

/* -------------------------------------------------------------------- CLI */

export function main(argv = process.argv.slice(2), env = process.env, { cwd = process.cwd(), now = Date.now() } = {}) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(
        "usage: crow-boot-guard.mjs --app-root <checkout> [--record-exit]\n"
        + "  default        ExecStartPre: count crash exits and roll a bad commit back\n"
        + "  --record-exit  ExecStopPost: record how the attempt the last start opened ended\n",
      );
      return { action: "help" };
    }
    const stateDir = join(crowHomeFor(env), BOOT_GUARD_DIR);
    if (opts.recordExit) {
      // The recorder never touches the tree, so it does not check the app root:
      // it must still work when the checkout is mid-rollback.
      runRecordExit({ stateDir, env, now });
      return { action: "recorded" };
    }
    return runPreStart({ appRoot: opts.appRoot, env, cwd, now });
  } catch (err) {
    // Every exit is 0: a confused guard must never block the service from starting.
    log(`unexpected error: ${err?.message || err}`);
    return { action: "error" };
  } finally {
    process.exitCode = 0;
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
  } catch { return false; }
})();

if (invokedDirectly) main();