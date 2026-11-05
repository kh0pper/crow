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
import { homedir, uptime as osUptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOT_GUARD_DIR, FULL_SHA_RE, LAUNCHER_FILE, LAUNCHER_VERSION, freshState, loadState, saveState,
} from "../../scripts/boot-guard/crow-boot-guard.mjs";
import { readUpdateQuarantine, ownerForHome, writeUpdateQuarantine } from "../shared/update-quarantine.js";

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

/**
 * This instance's owner id — the same value the launcher stamps on every HELD
 * marker it writes: sha256(realpath(CROW_HOME)).slice(0, 16).
 *
 * It is derived from the state dir because `stateDirFor()` is
 * `<CROW_HOME>/boot-guard`, so the parent of the state dir IS this instance's
 * home (and a test that retargets `stateDir` at a scratch CROW_HOME gets the same
 * answer without a second seam to keep in step).
 */
export function instanceOwnerIdFor(stateDir = stateDirFor()) {
  return ownerForHome(dirname(String(stateDir || "")) || ".");
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
 * `<appRoot>`'s absolute git dir, found with the SAME hooks-off flags as every
 * other git call on the live checkout (a live install points core.hooksPath into
 * the tree). Null when this is not a readable checkout.
 */
function gitDirForAppRoot(appRoot, execFile) {
  try {
    const out = execFile("git", [...GIT_HOOKS_OFF, "-C", appRoot, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
    });
    const dir = String(out || "").trim();
    return dir || null;
  } catch {
    return null;
  }
}

/**
 * Demote the boot guard's own HELD refusal marker for a commit that has just
 * proven it runs (S1).
 *
 * A refusal writes `held: true` because the refused sha is still checked out, and
 * a held marker naming local HEAD is never deleted, never expires and refuses
 * every convergence — which is right for a sha that keeps crashing and wrong for
 * one that boots. The refusal text itself says "the cause may not be B", and a
 * box where B later runs stably would otherwise never pull another update: every
 * tick would answer "still checked out" even after a fix landed on main.
 *
 * A stable mark is the proof that it runs, so the marker is rewritten WITHOUT
 * `held` through the shared writer (atomic temp+rename, one format, same path
 * rules as the launcher): the ordinary expiry / "main moved" rules apply again,
 * and a newer commit on main is pulled normally. Only the guard's own marker
 * (`by: "boot-guard"`) naming exactly the stable HEAD is touched — a marker for
 * another sha, or one a blocked rollback in the gateway wrote, says nothing about
 * this boot.
 *
 * The marker is shared by every instance on one checkout, but a refusal belongs
 * to the instance that refused: `markStable` therefore calls this only for its
 * OWN refusal record, and passes that record's `owner` and `at` (see there). A
 * peer that boots the same sha fine says nothing about the instance that refused
 * it — and a marker written by a release before ownership existed carries no
 * `owner`, so it can never be shown to be ours and is left alone.
 *
 * The decision is taken on a read, and the write is a rename of a record built
 * from it, so a peer that rewrites the marker in between would be overwritten
 * with stale fields (`at` would go back in time and un-spend the TTL). The
 * marker is therefore re-read immediately before the write and left alone if
 * anything this function decided on has changed.
 *
 * @param {string} [owner] this instance's owner id: the marker must carry it.
 * @param {string} [expectedAt] the `at` recorded with the refusal: the marker
 *   must still be the very record this instance wrote.
 * @param {function} [readMarker] test seam: the shared reader, twice.
 */
export function demoteHeldMarker({
  appRoot = APP_ROOT, bootSha, gitDir = null, execFile = execFileSync, readMarker = readUpdateQuarantine,
  owner = null, expectedAt = null,
} = {}) {
  try {
    if (!FULL_SHA_RE.test(String(bootSha || ""))) return { demoted: false, reason: "no-sha" };
    const dir = gitDir || gitDirForAppRoot(appRoot, execFile);
    if (!dir) return { demoted: false, reason: "no-git-dir" };
    const marker = readMarker({ gitDir: dir });
    if (!marker) return { demoted: false, reason: "no-marker" };
    if (marker.held !== true) return { demoted: false, reason: "not-held" };
    if (marker.sha !== bootSha) return { demoted: false, reason: "other-sha" };
    if (String(marker.by || "") !== "boot-guard") return { demoted: false, reason: "other-writer" };
    // Whose refusal is it? Only a marker THIS instance stamped (and whose stamp
    // matches the record it kept) is the record its own stable mark proves
    // wrong; anything else belongs to a peer or to an earlier release.
    if (owner != null && marker.owner !== owner) return { demoted: false, reason: "other-owner" };
    if (expectedAt != null && marker.at !== expectedAt) return { demoted: false, reason: "changed-at" };
    // Close the read-then-write race: exactly the fields below are the ones the
    // write carries over, so a marker that changed in any of them (a peer's
    // fresher refusal, a different sha, another writer, another owner, a
    // demotion already done) is left as it is.
    const latest = readMarker({ gitDir: dir });
    if (!sameMarkerForDemotion(marker, latest)) return { demoted: false, reason: "changed" };
    const written = writeUpdateQuarantine({
      gitDir: dir,
      sha: marker.sha,
      previous: marker.previous,
      reason: marker.reason,
      by: String(marker.by),
      // Counted from the original write: an ordinary marker of a transient reason
      // gets exactly the TTL the rollback's own marker would have had.
      now: Number.isFinite(Date.parse(marker.at)) ? Date.parse(marker.at) : Date.now(),
      // `owner` is deliberately NOT carried over: it named the refusal, and this
      // record no longer is one (the stable mark withdrew it).
    });
    return written ? { demoted: true, marker: written } : { demoted: false, reason: "write-failed" };
  } catch (err) {
    return { demoted: false, reason: "error", detail: String(err?.message || err) };
  }
}

/** The fields `demoteHeldMarker` decides on and copies into its rewrite. */
function sameMarkerForDemotion(a, b) {
  return Boolean(a) && Boolean(b)
    && a.sha === b.sha
    && a.at === b.at
    && a.by === b.by
    && a.owner === b.owner
    && (a.held === true) === (b.held === true);
}

/** Reasons that leave `state.refusal` in place for a later stable mark to retry:
 *  the marker could not be written (or the state could not be saved first).
 *  Everything else — a demotion, or a marker that is gone, names another sha,
 *  another writer, another owner or another stamp — is terminal: the record no
 *  longer describes a marker this instance wrote. */
const DEMOTE_RETRY_REASONS = new Set(["write-failed", "not-saved", "error"]);

function demoteIsTerminal(result) {
  if (result?.demoted === true) return true;
  return !DEMOTE_RETRY_REASONS.has(String(result?.reason || ""));
}

/**
 * The commit has been up for the stable window.
 *
 * No-op while a trial is pending for a DIFFERENT sha: the launcher owns that
 * record and this process never booted it. When the pending sha IS this boot's,
 * this call is what flips it to ok (S4) — and, because ten minutes up is the
 * proof that the commit runs, it also demotes the guard's HELD refusal marker for
 * that same sha (S1; see demoteHeldMarker).
 *
 * The demotion happens ONLY for the refusal THIS instance recorded, and only for
 * the very marker that record names. `state.refusal` is written by the launcher
 * at the moment it writes a HELD marker (`{ sha, marker_at }`), and it survives
 * every later transition — a re-armed trial, a discard, a rollback — so:
 *
 *   - `state.refusal.sha` must be the sha this boot just proved, which is what a
 *     re-armed refusal (`state: "pending"` again) still carries. Round 2 keyed
 *     the gate on `state: refused|blocked`, so a non-permanent refusal that the
 *     next start re-armed could never be demoted and updates froze at HEAD;
 *   - the marker must carry this instance's `owner`, so a co-hosted instance's
 *     refusal is never demoted on a peer's say-so (the marker file is shared; the
 *     refusal is not);
 *   - the marker's `at` must equal the recorded `marker_at`, so a peer that
 *     rewrote the marker for the same sha is not mistaken for ours;
 *   - and a `blocked` state that wrote no marker at all (`index.lock`, a
 *     read-only git dir) has no record, so it can demote nothing.
 *
 * A terminal answer (demoted, or the marker is gone / another sha / another
 * writer / another owner / another stamp) clears the record; a WRITE failure
 * keeps it, so the next stable mark retries.
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
    // Install FIRST: what the state claims about the installed copy has to be
    // what actually happened.
    const launcher = install
      ? installLauncherCopy({ appRoot, bootSha, stateDir, execFile })
      : { installed: false, reason: "skipped" };
    const copyOk = launcher.installed || launcher.reason === "current";
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
      deps_attempts: 0,
      previous_sha: null,
      pending_sha: null,
      armed_at: null,
      previous_proven: false,
      // An UNRECORDED rollback result survives the stable mark: the launcher may
      // have rolled back while the DB was not up (or npm was still finishing) and
      // the next boot still has to write the dashboard line. Everything else is
      // stale here.
      result: current.result && !current.result.recorded ? current.result : null,
      alerted: {},
      // Only claim the version of the copy that is actually installed (a failed
      // copy leaves the old file — and so the old version — in place).
      launcher_version: copyOk ? LAUNCHER_VERSION : current.launcher_version,
    };
    const saved = saveState(stateDir, next);
    // Only a committed stable mark is evidence: a failed save leaves the launcher
    // free to keep refusing the sha. And only the refusal record for THIS sha —
    // read from `current`, before the stable mark replaced it — may demote the
    // shared marker (see the doc comment above). `refusal` was carried into
    // `next`; it is cleared below once the marker is settled, so a crash between
    // the two leaves it recorded and the next stable mark retries.
    const refusal = current.refusal && current.refusal.sha === bootSha ? current.refusal : null;
    let marker;
    if (!saved) marker = { demoted: false, reason: "not-saved" };
    else if (!refusal) marker = { demoted: false, reason: "no-refusal" };
    else {
      marker = demoteHeldMarker({
        appRoot,
        bootSha,
        execFile,
        owner: instanceOwnerIdFor(stateDir),
        expectedAt: refusal.marker_at,
      });
    }
    if (refusal && demoteIsTerminal(marker)) {
      next.refusal = null;
      saveState(stateDir, next);
    }
    return { ok: saved, launcher, marker };
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
  // The reason travels with the record, not with the state: markStable closes the
  // trial but keeps an unrecorded result for the next boot to report.
  const byPeer = r.reason === "peer" || state.state === "rolled-back-by-peer";
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
    // Any state can carry an unrecorded rollback result: the launcher's own
    // `rolled-back`, `rolled-back-by-peer`, and `rolled-back-deps-pending` (the
    // previous commit is running, its dependencies are still being reinstalled),
    // plus whatever markStable carried over from one of those.
    if (!state.result || state.result.recorded) return null;
    const text = rolledBackResultText(state);
    if (!text) return null;
    // The launcher spooled this same rollback into the alert spool, and the drain
    // delivers it as a notification (source "migrations"). Ringing the
    // auto-update bell as well would put TWO rows on one rollback (F4) — and the
    // spool row is the one whose wording names the real cause. Only a spool that
    // was NOT written leaves the bell as the sole channel.
    const spooled = state.alerted?.[state.result.code] === state.result.from;
    const write = record || (async (value) => {
      const au = await import("./auto-update.js");
      return au.recordUpdateResult(value, { notify: !spooled });
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
 * Two stamps, two questions:
 *   - `launcher_finished_at` must sit just before this process started. It is
 *     written at the END of the pre-start run, not the start: a rollback can
 *     wait for the checkout lock and spend five minutes in npm, and the gateway
 *     starts after that, so `launcher_ran_at` alone looks stale on exactly the
 *     boot the guard did most of its work.
 *   - `recorder_ran_at` (ExecStopPost of the previous run) must be no older than
 *     the PREVIOUS launcher run (`prev_launcher_ran_at`, which the launcher copies
 *     before overwriting its start stamp). That is a fact about the previous
 *     stop, not about boot time, so a slow stop cannot look broken.
 *
 * A previous start that happened before this boot (a power loss, a reboot, a
 * planned `systemctl stop` long before the restart) never had a recorder stamp
 * due in this boot. That case is reported as `unknown` and raises no card.
 *
 * @returns {null|{reason: "unreadable"|"missing"|"launcher"|"recorder"|"unknown", …}}
 */
export function bootGuardProblem({
  env = process.env, stateDir = stateDirFor(), now = Date.now(), uptimeMs = process.uptime() * 1000,
  systemUptimeMs = osUptime() * 1000,
} = {}) {
  if (String(env?.CROW_BOOT_GUARD || "") !== "1") return null;
  const { state, error } = loadState(stateDir);
  if (error) return { reason: "unreadable", detail: error };
  if (!state) return { reason: "missing" };
  const bootAt = now - uptimeMs;
  // The machine's own boot time: what separates "the previous start was in this
  // boot" from "the previous start was before a reboot".
  const machineBootAt = now - systemUptimeMs;
  const fresh = (stamp) => {
    const t = Date.parse(stamp || "");
    return Number.isFinite(t) && t >= bootAt - STAMP_TOLERANCE_MS && t <= now + STAMP_TOLERANCE_MS;
  };
  if (!fresh(state.launcher_finished_at)) {
    return { reason: "launcher", detail: state.launcher_finished_at || state.launcher_ran_at || "never" };
  }
  // The recorder only runs when a previous process ended; before the first
  // stable mark there is no earlier boot, so there is nothing to check.
  const hadEarlierBoot = Boolean(state.stable_at || state.result);
  if (!hadEarlierBoot) return null;
  const prevLauncherAt = Date.parse(state.prev_launcher_ran_at || "");
  if (!Number.isFinite(prevLauncherAt)) return null; // no earlier start recorded
  // Only judge the recorder when the previous start happened in THIS boot: after
  // a power loss or a reboot no ExecStopPost ran at all, so a missing stamp says
  // nothing about whether the recorder works.
  if (prevLauncherAt < machineBootAt - STAMP_TOLERANCE_MS) {
    return { reason: "unknown", detail: `the previous start (${state.prev_launcher_ran_at}) was before this boot` };
  }
  const recorderAt = Date.parse(state.recorder_ran_at || "");
  if (!Number.isFinite(recorderAt) || recorderAt < prevLauncherAt) {
    return { reason: "recorder", detail: state.recorder_ran_at || "never" };
  }
  return null;
}

export { APP_ROOT as BOOT_GUARD_APP_ROOT };