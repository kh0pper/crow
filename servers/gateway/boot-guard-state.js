/**
 * boot-guard-state.js — the gateway's half of the boot guard (audit N1c-3, L1).
 *
 * The launcher (scripts/boot-guard/crow-boot-guard.mjs) runs outside the tree and
 * owns every decision. This module only tells it two things a running gateway
 * knows and it does not:
 *
 *   - `markPlanned()`: this exit is a restart we asked for, not a crash. Called
 *     from the `crow:shutdown` hook (supervised restart, bundle install) and from
 *     gracefulShutdown (SIGTERM, `systemctl restart`).
 *   - `markStable(bootSha)`: ten minutes up means the commit works. That is also
 *     the only moment the installed copy of the launcher is refreshed — always
 *     from `git show <bootSha>:…`, never from the working tree, which may already
 *     be the next commit (S4).
 *
 * Plus `recordGuardResult()`, which turns a rollback the launcher performed into
 * the same `auto_update_last_result` line the Layer 0 paths write.
 *
 * Everything here is fire-and-forget: a bookkeeping failure must never cost the
 * gateway its boot, so nothing throws and every write is atomic.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOT_GUARD_DIR, FULL_SHA_RE, LAUNCHER_FILE, LAUNCHER_VERSION, freshState, loadState, saveState,
} from "../../scripts/boot-guard/crow-boot-guard.mjs";

/** Ten minutes up = proven. Matches the drop-in's TimeoutStartSec headroom. */
export const STABLE_WINDOW_MS = 10 * 60 * 1000;
/** Clock tolerance when judging "did this stamp come from THIS boot". */
export const STAMP_TOLERANCE_MS = 60 * 1000;

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

let _home = null;
/** Test-only: retarget the boot-guard directory at a scratch CROW_HOME. */
export function _setBootGuardHomeForTest(dir) { _home = dir; }

/** `<CROW_HOME>/boot-guard`, resolved exactly as the launcher resolves it. */
export function bootGuardHome(env = process.env) {
  if (_home) return _home;
  const raw = String(env?.CROW_HOME || "").trim();
  return raw || join(homedir(), ".crow");
}

export function stateDirFor(env = process.env) {
  return join(bootGuardHome(env), BOOT_GUARD_DIR);
}

/* ---------------------------------------------------------------- planned */

/**
 * Mark the attempt in flight as a planned exit, so the launcher does not count
 * it (S5). Covers `crow:shutdown` (supervised restart, bundle install) and
 * gracefulShutdown (SIGTERM from `systemctl restart`/stop).
 */
export function markPlanned({ stateDir = stateDirFor(), now = Date.now() } = {}) {
  try {
    const { state } = loadState(stateDir);
    if (!state || state.state !== "pending") return false;
    if (!state.attempt?.started_at) return false;
    state.attempt = { ...state.attempt, planned_at: new Date(now).toISOString() };
    return saveState(stateDir, state);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- launcher IO */

function ensurePlainDir(dir) {
  let st = null;
  try { st = lstatSync(dir); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  if (st === null) { mkdirSync(dir, { mode: 0o700 }); st = lstatSync(dir); }
  // A symlink here would let a planted link decide what code the unit runs
  // before every start, so it is refused, never followed.
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
  chmodSync(dir, 0o700);
}

/** The launcher blob as committed, not as checked out. */
export function launcherFromCommit({ appRoot = APP_ROOT, bootSha, execFile = execFileSync } = {}) {
  if (!FULL_SHA_RE.test(String(bootSha || ""))) return null;
  try {
    return String(execFile("git", [...GIT_HOOKS_OFF, "-C", appRoot, "show", `${bootSha}:scripts/boot-guard/${LAUNCHER_FILE}`], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return null; // the commit predates the guard, or this is not a git checkout
  }
}

/**
 * Refresh `<CROW_HOME>/boot-guard/crow-boot-guard.mjs` from a commit that booted.
 * 0700 dir / 0600 file, temp + rename, only when the content differs.
 */
export function installLauncherCopy({ appRoot = APP_ROOT, bootSha, stateDir = stateDirFor(), execFile = execFileSync } = {}) {
  try {
    const content = launcherFromCommit({ appRoot, bootSha, execFile });
    if (content == null) return { installed: false, reason: "no-launcher-in-commit" };
    ensurePlainDir(stateDir);
    const target = join(stateDir, LAUNCHER_FILE);
    try {
      if (readFileSync(target, "utf8") === content) return { installed: false, reason: "current" };
    } catch { /* not installed yet */ }
    const tmp = join(stateDir, `.${LAUNCHER_FILE}.${process.pid}.tmp`);
    let fd = null;
    try {
      try {
        fd = openSync(tmp, "wx", 0o600);
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        try { unlinkSync(tmp); } catch { /* our own leftover */ }
        fd = openSync(tmp, "wx", 0o600);
      }
      writeSync(fd, content);
      closeSync(fd);
      fd = null;
      chmodSync(tmp, 0o600);
      renameSync(tmp, target); // rename replaces a planted symlink, never follows it
    } catch (err) {
      if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw err;
    }
    return { installed: true, reason: "updated", path: target };
  } catch (err) {
    return { installed: false, reason: String(err?.message || err) };
  }
}

/* --------------------------------------------------------------- stable */

/**
 * The commit has been up for the stable window.
 *
 * No-op while a trial is pending for a DIFFERENT sha: the launcher owns that
 * record and this process never booted it. When the pending sha IS this boot's,
 * this call is what flips it to ok (S4).
 */
export function markStable(bootSha, {
  appRoot = APP_ROOT, dbPath = null, stateDir = stateDirFor(), now = Date.now(),
  install = true, execFile = execFileSync,
} = {}) {
  try {
    if (!FULL_SHA_RE.test(String(bootSha || ""))) return { ok: false, reason: "no-sha" };
    const { state, error } = loadState(stateDir);
    if (error) return { ok: false, reason: error };
    const current = state || freshState();
    if (current.state === "pending" && current.pending_sha && current.pending_sha !== bootSha) {
      return { ok: false, skipped: "pending-other" };
    }
    const next = {
      ...current,
      state: "ok",
      last_ok_sha: bootSha,
      stable_at: new Date(now).toISOString(),
      db_path: dbPath || current.db_path || null,
      failures: 0,
      attempt: null,
      deps_changed: false,
      deps_pending: false,
      previous_sha: null,
      pending_sha: null,
      armed_at: null,
      previous_proven: false,
      result: null,
      alerted: {},
      launcher_version: LAUNCHER_VERSION,
    };
    const saved = saveState(stateDir, next);
    const launcher = install ? installLauncherCopy({ appRoot, bootSha, stateDir, execFile }) : { installed: false, reason: "skipped" };
    return { ok: saved, launcher };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Arm the stable mark on an UNREF'd timer: a socket-activation or one-shot
 * gateway must not be held open by the guard's bookkeeping.
 */
export function scheduleStableMark({
  bootSha, dbPath = null, windowMs = STABLE_WINDOW_MS, stateDir = stateDirFor(), log = null,
} = {}) {
  const timer = setTimeout(() => {
    const r = markStable(bootSha, { dbPath, stateDir });
    if (log) {
      log(r.ok
        ? `${String(bootSha).slice(0, 9)} is stable${r.launcher?.installed ? " (boot guard refreshed)" : ""}`
        : `stable mark skipped: ${r.reason || r.skipped || "unknown"}`);
    }
  }, Math.max(0, Number(windowMs) || 0));
  timer.unref?.();
  return timer;
}

/* ------------------------------------------------------------- roll result */

/** `Rolled back: <B9> crashed on startup <n> times; …` — starts with the Layer 0
 *  prefix, so classifyUpdateResult() reads it as update-rolled-back. */
export function rolledBackResultText(state) {
  const r = state?.result;
  if (!r) return null;
  const from = String(r.from || state.pending_sha || "");
  const to = String(r.to || state.previous_sha || "");
  if (!from || !to) return null;
  const n = Number.isFinite(r.failures) ? r.failures : 0;
  const byPeer = state.state === "rolled-back-by-peer";
  return `Rolled back: ${from.slice(0, 9)} crashed on startup ${n} times; `
    + `${byPeer ? "a co-hosted instance rolled it back; " : ""}running ${to.slice(0, 9)}; `
    + `updates resume when main moves past it`;
}

/**
 * Record the launcher's rollback in `auto_update_last_result`, ONCE per record.
 * `record` is injectable so tests need no database.
 */
export async function recordGuardResult({ record = null, stateDir = stateDirFor(), now = Date.now(), log = null } = {}) {
  try {
    const { state } = loadState(stateDir);
    if (!state) return null;
    if (state.state !== "rolled-back" && state.state !== "rolled-back-by-peer") return null;
    if (!state.result || state.result.recorded) return null;
    const text = rolledBackResultText(state);
    if (!text) return null;
    const write = record || (async (value) => {
      const au = await import("./auto-update.js");
      return au.recordUpdateResult(value);
    });
    const written = await write(text);
    // Only mark it recorded when the write really happened: with no db handle
    // (auto-update disabled for this instance) it is retried on the next boot.
    if (written === false) {
      if (log) log("the rollback result could not be stored yet — retried on the next boot");
      return null;
    }
    state.result = { ...state.result, recorded: true, recorded_at: new Date(now).toISOString() };
    saveState(stateDir, state);
    if (log) log(text);
    return text;
  } catch (err) {
    if (log) log(`could not record the rollback: ${err?.message || err}`);
    return null;
  }
}

/* ------------------------------------------------------- fix-it (S13) card */

/**
 * Did the guard actually run for THIS boot?
 *
 * The launcher's ExecStartPre stamp must be no older than this process's own
 * start (a minute of slack for the fork), and — once a previous boot existed —
 * the ExecStopPost recorder must have stamped too. A missing stamp means the
 * unit's drop-in points at nothing (a wrong node path, a deleted launcher copy),
 * which is exactly the silent breakage S13 is about: the gateway boots, and the
 * next bad update simply is not rolled back.
 *
 * @returns {null|{reason: "unreadable"|"missing"|"launcher"|"recorder", …}}
 */
export function bootGuardProblem({
  env = process.env, stateDir = stateDirFor(), now = Date.now(), uptimeMs = process.uptime() * 1000,
} = {}) {
  if (String(env?.CROW_BOOT_GUARD || "") !== "1") return null;
  const { state, error } = loadState(stateDir);
  if (error) return { reason: "unreadable", detail: error };
  if (!state) return { reason: "missing" };
  const bootAt = now - uptimeMs;
  const fresh = (stamp) => {
    const t = Date.parse(stamp || "");
    return Number.isFinite(t) && t >= bootAt - STAMP_TOLERANCE_MS && t <= now + STAMP_TOLERANCE_MS;
  };
  if (!fresh(state.launcher_ran_at)) {
    return { reason: "launcher", detail: state.launcher_ran_at || "never" };
  }
  // The recorder only runs when a previous process ended; before the first
  // stable mark there is no earlier boot, so there is nothing to check.
  const hadEarlierBoot = Boolean(state.stable_at || state.result);
  if (hadEarlierBoot && !fresh(state.recorder_ran_at)) {
    return { reason: "recorder", detail: state.recorder_ran_at || "never" };
  }
  return null;
}

export { APP_ROOT as BOOT_GUARD_APP_ROOT };