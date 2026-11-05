/**
 * Auto-Update Module — Periodically pulls latest code from git
 *
 * Enabled by default. Users can toggle via Settings panel or CROW_AUTO_UPDATE env var.
 * Stores state in dashboard_settings DB table.
 *
 * On update: git pull → npm install → import check → init-db → restart (if supervised)
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, accessSync, existsSync, constants as fsConstants } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isSupervised } from "../shared/supervisor.js";
import { isInstallSetRunning } from "./install-lock.js";
import { classifyCheckRuns } from "../shared/ci-check-runs.js";
import { checkTreeImport, IMPORT_CHECK_ENV } from "./boot/import-check.js";
import {
  evaluateUpdateQuarantine, writeUpdateQuarantine,
} from "../shared/update-quarantine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let APP_ROOT = dirname(dirname(__dirname));

/** Test-only: retarget git/npm/lock operations at a fixture repo. */
export function _setAppRootForTest(dir) {
  APP_ROOT = dir;
}

const JITTER_WINDOW_MS = 10 * 60 * 1000;

/**
 * A stable per-instance offset for the first update check.
 *
 * Co-hosted gateways restart together, so a fixed 5-minute first check put all
 * of them on the same millisecond forever: their checks landed 475ms apart and
 * the same instance lost the lock every single tick. Deriving the offset from
 * the instance's data dir de-phases them permanently and survives restarts.
 *
 * This is robustness, not the fix — the fix is that the lock loser converges
 * anyway (see convergence.js). Jitter only makes contention rare.
 */
export function instanceJitterMs(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % JITTER_WINDOW_MS;
}

export const DEFAULT_INTERVAL_HOURS = 6;
export const MIN_INTERVAL_HOURS = 1;

/**
 * Every string this module writes to `auto_update_last_result`, classified ONCE
 * so the Nest's Updates card reads this table instead of matching the free text
 * in a second place (audit N1c-1). First matching prefix wins.
 *
 *   ok        — the tick did what it should. The two "Tree pull skipped" cases
 *               are the co-hosted by-design ones: this gateway never pulls the
 *               shared checkout, and the INSTANCE half still converges.
 *   transient — the tick retries on its own. The card waits 2x the interval
 *               before calling it stuck, so a CI run in progress never reads as
 *               a broken updater.
 *   failure   — updates stop until someone acts.
 *
 * An unrecognised string is a failure (code "other"), never ok: a new message
 * must be added here rather than silently read as fine. tests/health-signals
 * checks that every literal this file writes is covered.
 */
export const UPDATE_RESULT_PREFIXES = Object.freeze([
  { prefix: "Updated ", kind: "ok", code: "updated" },
  { prefix: "Up to date", kind: "ok", code: "up-to-date" },
  { prefix: "Tree pull skipped: the checkout is read-only", kind: "ok", code: "tree-external" },
  { prefix: "Tree pull skipped: another instance holds the checkout lock", kind: "ok", code: "tree-locked" },
  { prefix: "Skipped: CI still running", kind: "transient", code: "ci-pending" },
  { prefix: "Skipped: branch changed mid-update", kind: "transient", code: "branch-changed" },
  { prefix: "Skipped: not on main", kind: "failure", code: "not-on-main" },
  { prefix: "Skipped: cannot determine branch", kind: "failure", code: "branch-unknown" },
  { prefix: "Skipped: CI is RED", kind: "failure", code: "ci-red" },
  { prefix: "Skipped: migration quarantined", kind: "failure", code: "migration-quarantined" },
  { prefix: "Skipped: update quarantined", kind: "failure", code: "update-quarantined" },
  { prefix: "Update rollback blocked", kind: "failure", code: "update-rollback-blocked" },
  { prefix: "Rolled back: ", kind: "failure", code: "update-rolled-back" },
  { prefix: "Fetch failed", kind: "failure", code: "fetch-failed" },
  { prefix: "Pull failed", kind: "failure", code: "pull-failed" },
  { prefix: "Update error", kind: "failure", code: "update-error" },
  { prefix: "Migration quarantined", kind: "failure", code: "migration-quarantined" },
  { prefix: "Migration failed", kind: "failure", code: "migration-failed" },
  { prefix: "init-db failed", kind: "failure", code: "init-db-failed" },
]);

/**
 * Classify one `auto_update_last_result` value.
 *
 * @param {string|null|undefined} result
 * @returns {null|{kind: "ok"|"transient"|"failure", code: string}} null when
 *   nothing has been recorded yet.
 */
export function classifyUpdateResult(result) {
  // Only the leading space is trimmed: "Updated " ends in one, and a real result
  // is "Updated <a> → <b>".
  const value = String(result ?? "").trimStart();
  if (!value.trim()) return null;
  const hit = UPDATE_RESULT_PREFIXES.find((entry) => value.startsWith(entry.prefix));
  return hit ? { kind: hit.kind, code: hit.code } : { kind: "failure", code: "other" };
}

let updateTimer = null;
let db = null;

/**
 * Get auto-update settings from DB
 */
async function getSettings() {
  const defaults = {
    auto_update_enabled: "true",
    auto_update_interval_hours: String(DEFAULT_INTERVAL_HOURS),
    auto_update_last_check: null,
    auto_update_last_result: null,
    auto_update_result_since: null,
    auto_update_current_version: null,
    auto_update_latest_version: null,
  };

  if (!db) return defaults;

  try {
    const rows = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'auto_update_%'",
      args: [],
    });
    const settings = { ...defaults };
    for (const row of rows.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  } catch {
    return defaults;
  }
}

/**
 * Timer-tick wrapper: re-reads auto_update_enabled each tick so a UI disable
 * takes effect within one interval, no restart. The gate lives HERE and NOT
 * in checkForUpdates() — the manual "Check for updates now" settings action
 * calls checkForUpdates() directly and must work while auto-update is
 * disabled (that is the point of a manual button). getSettings() cannot
 * throw: on DB error it returns defaults (enabled:"true"), indistinguishable
 * from a fresh install, so a blip proceeds for that one tick — consistent
 * with the boot gate's identical defaulting; self-corrects next tick.
 * `check` is injectable for tests only.
 */
export async function tickCheck(check = checkForUpdates) {
  // A collection install runs N installs against one job and ends in a single
  // deferred restart. An auto-update pull+exit here would kill that runner
  // mid-flight (partial collection, lost summary). Manual Check-now stays
  // ungated — that's explicit operator intent.
  if (isInstallSetRunning()) {
    console.log("[auto-update] Skipping scheduled check — a collection install is in progress");
    return null;
  }
  const settings = await getSettings();
  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Skipping scheduled check — disabled in settings");
    return null;
  }
  return check();
}

/** Test-only: inject the module-level db handle without starting timers. */
export function _setDbForTest(database) {
  db = database;
}

/**
 * Save a setting to DB
 *
 * `auto_update_last_result` is the one key with a companion: every tick rewrites
 * `auto_update_last_check`, so the age of THAT value says nothing about how long
 * the current result has been repeating — a CI run still in progress stays
 * "fresh" forever (audit N1c-1 follow-up). `auto_update_result_since` records
 * when the current result's CLASSIFICATION CODE first appeared, and the Nest's
 * Updates card ages a transient result from it.
 */
const RESULT_KEY = "auto_update_last_result";
const RESULT_SINCE_KEY = "auto_update_result_since";

/**
 * Auto-update failure bell (audit N1c-2): the ntfy/email sends below are
 * unconfigured by default, so "updates have stopped" only ever reached the
 * Settings → Updates card. These two keys are the 24 h cooldown, stored the
 * way every other auto-update key is (dashboard_settings).
 */
export const UPDATE_NOTIFIED_CODE_KEY = "auto_update_notified_code";
export const UPDATE_NOTIFIED_AT_KEY = "auto_update_notified_at";
export const UPDATE_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Cause + action per classification code, keyed by exactly the codes
 * classifyUpdateResult() yields, so a result prefix can never become a silent
 * failure (`other` is the floor). The recorded result is quoted on top of this
 * only for the codes in RESULT_TEXT_IS_SAFE below — those are our own fixed
 * sentences — because `Pull failed: …` and `Update error: …` embed git/npm
 * stderr, which can hold paths and secrets, and a bell is pushed off-device.
 * The full result text always stays in Settings → Updates and the log.
 */
const UPDATE_FAILURE_TEXT = Object.freeze({
  "not-on-main": ["Crow updates stopped: not on the main branch", "The checkout is on another branch, so updates are skipped. Switch it back to main, then run Check for updates now."],
  "branch-unknown": ["Crow updates stopped: branch could not be read", "The checkout could not report its branch (a broken or shallow git checkout). Repair the checkout, then run Check for updates now."],
  "ci-red": ["Crow updates stopped: CI is red", "Updates are held back because the latest build failed its required tests. Retries continue on their own; once main is green again the next check deploys it."],
  "migration-quarantined": ["Crow updates paused: migration quarantined", "A migration damaged data and was rolled back, so that commit is quarantined. Updates resume by themselves when a fix lands on main; after 3 attempts the quarantine marker files have to be deleted."],
  "fetch-failed": ["Crow updates stopped: fetch failed", "The updater could not reach the git remote. Check network access and the remote URL, then run Check for updates now."],
  "pull-failed": ["Crow updates stopped: pull failed", "The update could not be applied, usually because local changes overlap it. Resolve them, then run Check for updates now."],
  "update-error": ["Crow updates stopped: update error", "The updater hit an unexpected error. See Settings → Updates and the gateway log for the exact result, then run Check for updates now."],
  "migration-failed": ["Crow updates stopped: migration failed", "The database migration after the pull failed, so the restart was withheld and the previous code is still running. Read the log, then run node scripts/guarded-init-db.mjs."],
  "init-db-failed": ["Crow updates stopped: init-db failed", "Database setup after the pull failed, so the restart was withheld and the previous code is still running. Read the log, then run node scripts/guarded-init-db.mjs."],
  "update-rolled-back": ["Crow rolled back an update that would not start", "The pulled commit was rolled back automatically because its code fails to load, so the previous version is still running. The bad commit is quarantined: updates resume by themselves when main moves past it."],
  "update-quarantined": ["Crow updates paused: a commit is quarantined", "The newest commit on main was rolled back because it would not start, so it is skipped. Fix forward on main and the next check deploys it; a rollback taken for a machine-side reason retries after a few hours."],
  "update-rollback-blocked": ["Crow updates paused: rollback blocked", "The pulled commit fails to load and could not be rolled back because local changes overlap it, so the restart is withheld. Commit or revert those changes in the checkout, then run Check for updates now."],
  other: ["Crow updates stopped: unrecognised result", "The updater recorded a result it cannot classify. See Settings → Updates for the exact text and the gateway log for the cause."],
});

/**
 * Codes whose recorded result is OUR fixed sentence, with no captured command
 * output, so it can be quoted in the bell verbatim — the same words Settings
 * shows. Everything else (fetch/pull/update-error, and any future code that
 * lands on `other`) gets the table text only: those strings embed git/npm
 * stderr, which can hold paths and secrets (audit N1c-2).
 */
const RESULT_TEXT_IS_SAFE = new Set([
  "not-on-main", "ci-red", "migration-quarantined", "migration-failed", "init-db-failed",
  "update-rolled-back", "update-quarantined", "update-rollback-blocked",
]);

/**
 * Ring the in-app bell for a FAILURE result, at most once per code per 24 h.
 * ok / transient / skip-by-design results never ring. Never throws: this runs
 * inside every result write and must not cost the updater its bookkeeping.
 *
 * @param {string} value the `auto_update_last_result` value being recorded
 * @param {number} [nowMs] clock seam
 * @returns {Promise<object|null>} the notification row, or null when silent
 */
async function notifyUpdateFailure(value, nowMs = Date.now()) {
  try {
    if (!db) return null;
    const klass = classifyUpdateResult(value);
    if (!klass || klass.kind !== "failure") return null;

    let lastCode = null;
    let lastAt = null;
    try {
      const { rows } = await db.execute({
        sql: "SELECT key, value FROM dashboard_settings WHERE key IN (?, ?)",
        args: [UPDATE_NOTIFIED_CODE_KEY, UPDATE_NOTIFIED_AT_KEY],
      });
      lastCode = rows?.find((r) => r.key === UPDATE_NOTIFIED_CODE_KEY)?.value ?? null;
      lastAt = rows?.find((r) => r.key === UPDATE_NOTIFIED_AT_KEY)?.value ?? null;
    } catch { /* unreadable cooldown: notify rather than stay silent */ }
    const lastAtMs = Date.parse(lastAt || "");
    if (lastCode === klass.code && Number.isFinite(lastAtMs) && nowMs - lastAtMs < UPDATE_NOTIFY_COOLDOWN_MS) {
      return null; // same condition, already rung within the window
    }

    const [title, action] = UPDATE_FAILURE_TEXT[klass.code] || UPDATE_FAILURE_TEXT.other;
    const recorded = typeof value === "string" ? value.trim().slice(0, 300) : "";
    const body = RESULT_TEXT_IS_SAFE.has(klass.code) && recorded ? `${recorded}\n\n${action}` : action;
    const { createNotification } = await import("../shared/notifications.js");
    const row = await createNotification(db, {
      type: "system",
      priority: "high",
      source: "auto-update",
      title,
      body,
      action_url: "/dashboard/settings?section=updates",
      metadata: { code: klass.code },
    });
    // Stamped even when the type is switched off: the operator's preference is
    // a choice, and re-attempting every tick would not deliver it either.
    await saveSetting(UPDATE_NOTIFIED_CODE_KEY, klass.code);
    await saveSetting(UPDATE_NOTIFIED_AT_KEY, new Date(nowMs).toISOString());
    return row;
  } catch (err) {
    console.warn(`[auto-update] failure notification skipped: ${err?.message}`);
    return null;
  }
}

async function saveSetting(key, value) {
  if (!db) return;
  try {
    if (key === RESULT_KEY) {
      await stampResultSince(value);
      // Every result write funnels through here, so the failure bell covers
      // each branch (including the migration-guard ones) without a per-branch
      // call to forget (audit N1c-2).
      await notifyUpdateFailure(value);
    }
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [key, value, value],
    });
  } catch (err) {
    console.warn(`[auto-update] Failed to save ${key}:`, err.message);
  }
}

/**
 * Stamp `auto_update_result_since` ONLY when the result's classification code
 * changes; the same code repeating keeps the first stamp. A changed message
 * inside one code (`Skipped: not on main (on 'a')` → `…(on 'b')`, both
 * not-on-main) is the same condition and must not restart the clock.
 *
 * Runs BEFORE the new result is written, so the SELECT still sees the previous
 * one. When the previous value cannot be read, the code cannot be compared, so
 * the stamp is reset — an old `since` must never outlive the result it described
 * and turn into a false warn.
 */
async function stampResultSince(nextValue) {
  if (!db) return;
  let prev;
  let hasSince = false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key IN (?, ?)",
      args: [RESULT_KEY, RESULT_SINCE_KEY],
    });
    prev = rows?.find((r) => r.key === RESULT_KEY)?.value ?? null;
    hasSince = Boolean(rows?.find((r) => r.key === RESULT_SINCE_KEY)?.value);
  } catch {
    prev = undefined; // unreadable: cannot compare, so re-stamp rather than age
  }
  const codeOf = (v) => classifyUpdateResult(v)?.code ?? null;
  // An install already stuck on a result when this shipped has no stamp yet:
  // stamp it on the next tick, or its wait would never start aging.
  if (prev !== undefined && hasSince && codeOf(prev) === codeOf(nextValue)) return;
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [RESULT_SINCE_KEY, now, now],
    });
  } catch (err) {
    console.warn(`[auto-update] Failed to save ${RESULT_SINCE_KEY}:`, err.message);
  }
}

/**
 * Run a command and return { stdout, stderr, code }
 */
function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: APP_ROOT, timeout: 120000, ...options }, (err, stdout, stderr) => {
      resolve({
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        code: err ? err.code || 1 : 0,
      });
    });
  });
}

const LOCK_STALE_MS = 30 * 60 * 1000;
/** acquireCheckoutLock's return for a read-only tree: observed free, not held. */
const OBSERVED_SUFFIX = "#observed";

async function lockPath(cwd) {
  const dir = await gitDirFor(cwd);
  if (!dir) return null; // not a git checkout → no lock possible
  return join(dir, "crow-auto-update.lock");
}

/**
 * The checkout's ABSOLUTE git dir, or null.
 *
 * `--absolute-git-dir`, never `--git-common-dir`: the checkout lock and the
 * update quarantine marker are per-checkout state and must sit together in the
 * one directory both co-hosted instances resolve identically.
 */
export async function gitDirFor(cwd = null) {
  const r = await run("git", ["rev-parse", "--absolute-git-dir"], cwd ? { cwd } : {});
  return r.code === 0 && r.stdout ? r.stdout : null;
}

function readLock(path) {
  try {
    const [pidLine, tsLine] = readFileSync(path, "utf8").split("\n");
    let mtimeMs = NaN;
    try { mtimeMs = statSync(path).mtimeMs; } catch {}
    return { pid: parseInt(pidLine, 10), ts: Date.parse(tsLine || ""), mtimeMs };
  } catch { return null; }
}

/** A lock file with no pid yet is being written (wx create, then write): young = held. */
const LOCK_WRITE_GRACE_MS = 5000;

function lockIsStale(info) {
  if (!info) return true;
  if (!Number.isFinite(info.pid)) {
    return !(Number.isFinite(info.mtimeMs) && Date.now() - info.mtimeMs < LOCK_WRITE_GRACE_MS);
  }
  let alive = true;
  // EPERM: the pid exists but belongs to another user, so it is alive.
  try { process.kill(info.pid, 0); } catch (e) { alive = !!(e && e.code === "EPERM"); }
  const old = !Number.isFinite(info.ts) || Date.now() - info.ts > LOCK_STALE_MS;
  return !alive || old; // reclaim on (dead PID) OR (age>30min) — a wedged live updater must not block forever
}

/**
 * Is the checkout pulled by someone else? True when CROW_AUTO_UPDATE_TREE is
 * "external", or when this process cannot write the git dir (a hardened
 * co-hosted gateway that sees the shared checkout through a read-only bind:
 * ProtectHome= + BindReadOnlyPaths=). Such a gateway never pulls and never
 * takes the checkout lock; it only observes the lock and converges onto
 * whatever the tree holds (queue item 19, migration step 1).
 */
export async function treeIsExternal(cwd = null) {
  if (String(process.env.CROW_AUTO_UPDATE_TREE || "").trim().toLowerCase() === "external") return true;
  const lock = await lockPath(cwd);
  if (!lock) return false;
  try {
    accessSync(dirname(lock), fsConstants.W_OK);
    return false;
  } catch (err) {
    return err.code === "EROFS" || err.code === "EACCES" || err.code === "EPERM";
  }
}

/** Returns the lock file path on success, null when another updater holds it. */
function acquireLock(path) {
  // Sweep crash-orphaned quarantine files older than the staleness window.
  try {
    const dir = dirname(path);
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(basename(path) + ".stale.")) continue;
      const full = join(dir, f);
      try { if (Date.now() - statSync(full).mtimeMs > LOCK_STALE_MS) unlinkSync(full); } catch {}
    }
  } catch {}
  const body = `${process.pid}\n${new Date().toISOString()}\n`;
  try {
    writeFileSync(path, body, { flag: "wx" });
    return path;
  } catch (err) {
    if (err.code !== "EEXIST") return null;
  }
  const info = readLock(path);
  if (!lockIsStale(info)) return null; // live young holder → skip
  // Atomic reclaim: rename-quarantine — exactly one winner among reclaimers
  // racing the SAME stale inode (rename is NOT compare-and-swap; the lapping
  // residual is accepted in the spec with named backstops).
  const quarantine = `${path}.stale.${process.pid}`;
  try { renameSync(path, quarantine); } catch { return null; } // ENOENT = lost the race
  try { unlinkSync(quarantine); } catch {}
  try {
    writeFileSync(path, body, { flag: "wx" });
    return path;
  } catch { return null; } // a third party acquired meanwhile
}

/** Owner-checked release: never unlink a lock we no longer own. */
function releaseLock(path) {
  try {
    const info = readLock(path);
    if (info && info.pid === process.pid) unlinkSync(path);
  } catch {}
}

/**
 * Acquire the checkout lock, waiting for a holder to finish.
 *
 * The instance half needs this: the lock-loss path is reached ONLY while
 * another co-hosted gateway holds the lock, i.e. while it is between `git pull`
 * and its `npm install --omit=dev` (up to 5 minutes of rewriting the SHARED
 * node_modules) and its init-db. Converging and restarting into that window
 * boots a gateway against a half-written dependency tree.
 *
 * Returns the lock path on success, or null if it could not be acquired within
 * `waitMs` — in which case the caller must NOT converge; it retries next tick.
 */
export async function acquireCheckoutLock({ appRoot = null, waitMs = 6 * 60 * 1000, pollMs = 2000 } = {}) {
  // Resolve against the caller's root, not the module's APP_ROOT: convergence
  // is handed an explicit appRoot, and waiting on a lock for a DIFFERENT tree
  // would silently defeat the serialization.
  const lock = await lockPath(appRoot);
  if (!lock) return null;
  const deadline = Date.now() + waitMs;
  // A read-only (externally pulled) tree cannot take the lock, only observe
  // it: proceed once no live, young holder exists. The return carries
  // OBSERVED_SUFFIX, so releaseCheckoutLock() never removes it.
  const observeOnly = await treeIsExternal(appRoot);
  for (;;) {
    if (observeOnly) {
      // A lock that exists but cannot be read (another user's 0600 file) is held:
      // fail closed, never proceed into a pull that may be mid-write.
      const info = existsSync(lock) ? readLock(lock) : null;
      if (!existsSync(lock) || (info && lockIsStale(info))) return lock + OBSERVED_SUFFIX;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const held = acquireLock(lock);
    if (held) return held;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function releaseCheckoutLock(path) {
  // An observed (never held) lock is not ours to remove, whoever holds it now.
  if (path && !path.endsWith(OBSERVED_SUFFIX)) releaseLock(path);
}

/** Test-only: the lock primitives, unit-tested directly (they are not
 *  exported for production use — checkForUpdates()/runLockedUpdate() are the
 *  real callers). */
export const _lockPrimitivesForTest = { acquireLock, releaseLock, lockIsStale };

/**
 * Check for and apply updates
 * Returns { updated, from, to, error, skipped?, message?, branch? }
 */
export async function checkForUpdates({ instance = null } = {}) {
  const log = (msg) => console.log(`[auto-update] ${msg}`);
  try {
    const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0 || branch.stdout !== "main") {
      const msg = branch.code !== 0
        ? `Skipped: cannot determine branch (${branch.stderr || "not a git checkout"})`
        : `Skipped: not on main (on '${branch.stdout}')`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "not-on-main", branch: branch.stdout, message: msg };
    }
    let treeResult = { updated: false };
    let pulled = false;
    const external = await treeIsExternal();
    const lock = external ? null : await lockPath();
    const held = lock ? acquireLock(lock) : null;

    if (external) {
      // Hardened co-hosted gateway: the shared checkout is read-only here and
      // another gateway pulls it. Skip the TREE half (no fetch, no lock) and
      // still run the INSTANCE half below.
      const msg = "Tree pull skipped: the checkout is read-only for this instance (a co-hosted gateway pulls it)";
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      treeResult = { updated: false, skipped: "read-only", message: msg };
      try {
        const om = await run("git", ["rev-parse", "--short", "origin/main"]);
        if (om.code === 0 && om.stdout) await saveSetting("auto_update_latest_version", om.stdout);
      } catch {}
    } else if (lock && !held) {
      // NOT an error, and NOT a reason to stop. The tree is shared: another
      // co-hosted gateway is pulling it, which is exactly right. This instance
      // skips the PULL and still converges itself below. Before this split it
      // returned here — and since co-hosted gateways restart together, their
      // timers are phase-locked and the same instance lost every tick forever,
      // never migrating its own stores and never restarting into the new code.
      const info = readLock(lock);
      const msg = `Tree pull skipped: another instance holds the checkout lock (pid ${info?.pid ?? "unknown"})`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      treeResult = { updated: false, skipped: "locked", message: msg };

      // Record what the tree is moving to even though we did not pull it.
      // auto_update_latest_version is otherwise written ONLY inside
      // runLockedUpdate, which the loser never enters — which is exactly why
      // the primary's latest_version sat 16 commits BEHIND its own current
      // while last_result read "another updater is running". The holder has
      // just fetched, so origin/main is fresh.
      try {
        const om = await run("git", ["rev-parse", "--short", "origin/main"]);
        if (om.code === 0 && om.stdout) await saveSetting("auto_update_latest_version", om.stdout);
      } catch {}
    } else {
      try {
        treeResult = await runLockedUpdate(log);
      } finally {
        if (held) releaseLock(held);
      }
      pulled = Boolean(treeResult?.updated);
    }

    // A process must honor its OWN refusal. runLockedUpdate returns
    // converge:false on the branches whose whole purpose is to withhold a
    // restart; a peer may still converge (it refused nothing, and the
    // quarantine markers guard the genuinely-bad shas), but this process
    // must not restart into code it just declined.
    if (treeResult?.converge === false) {
      log("instance half skipped — this process's own update refused a restart");
      return { ...treeResult, pulled, converged: false, skipped: "refused" };
    }

    // The INSTANCE half — for every gateway, lock or no lock. APP_ROOT is
    // passed explicitly: convergence's own fallback resolves from
    // import.meta.url, which is the real worktree even under a test fixture.
    const { convergeInstance } = await import("./convergence.js");
    const conv = await convergeInstance({ appRoot: APP_ROOT, instance, pulled, log });
    return { ...treeResult, pulled, converged: conv.converged, applied: conv.applied };
  } catch (err) {
    const msg = `Update error: ${err.message}`;
    console.error(`[auto-update] ${msg}`);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }
}

// Migration-quarantine re-alert cooldown (mirrors the audit-breaker pattern).
const QUARANTINE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let _quarantineAlertAt = 0;

// ---------------------------------------------------------------------------
// A5: CI gate — never pull a commit whose required CI is red or still running.
// Q6 gates merges; this gates DEPLOYS (a direct admin push to main previously
// reached every instance within 6h regardless of CI state).
// ---------------------------------------------------------------------------

// classifyCheckRuns lives in shared/ci-check-runs.js (the satellite agent reuses it without
// loading this module); re-exported here unchanged.
export { classifyCheckRuns };

let _ciVerdictOverride = null;
/** Test hook: force the CI-gate verdict (fixture repos have non-GitHub
 *  remotes, so the real fetch path naturally skips). */
export function _setCiVerdictForTest(v) { _ciVerdictOverride = v; }

/**
 * Resolve the CI verdict for the sha the pull would land on. Fail-open
 * ("unknown") on: non-GitHub origin, network failure, non-200, bad JSON.
 * One unauthenticated call per update tick — far under the anonymous limit.
 */
async function resolveCiVerdict(remoteUrl, sha) {
  if (_ciVerdictOverride) return _ciVerdictOverride;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remoteUrl || "");
  if (!m) return "unknown";
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${m[1]}/${m[2]}/commits/${sha}/check-runs`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "crow-auto-update" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!resp.ok) return "unknown";
    return classifyCheckRuns(await resp.json());
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Layer 0 rollback (audit N1c-3): a pulled sha that does not load, or whose
// init-db failed without advancing the schema, is rolled back HERE, inside the
// old healthy process, before anything restarts into it.
// ---------------------------------------------------------------------------

let _importCheckImpl = null;
/** Test-only: force the import-check verdict (the timeout branch is produced by
 *  runImportCheck, which is exercised directly). */
export function _setImportCheckForTest(fn) { _importCheckImpl = fn; }

async function pulledTreeImportCheck() {
  if (_importCheckImpl) return _importCheckImpl();
  return checkTreeImport({ appRoot: APP_ROOT });
}

/**
 * `reset --keep`, never `--hard`: an overlapping tracked change makes git
 * REFUSE instead of destroying it, and the refusal is reported to the operator
 * as `update-rollback-blocked`. There is deliberately no blanket tracked-WIP
 * guard on this path (B3) — `--keep` is the guard.
 *
 * Hooks are disabled: live installs point core.hooksPath INTO the tree, so the
 * pulled sha's own hooks would otherwise run as the updater's user (S10).
 */
function resetKeep(previous) {
  return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "reset", "--keep", previous]);
}

/**
 * Write the update quarantine, move the checkout back, put the deps back.
 *
 * The marker is written FIRST: a crash between the two must still leave the
 * record that stops every co-hosted instance from re-pulling the same sha.
 *
 * @returns {Promise<{ok:boolean, marker:object|null, detail:string}>}
 */
async function quarantineAndRollBack({ gitDir, sha, previous, reason, depsChanged, log = () => {} }) {
  const marker = writeUpdateQuarantine({ gitDir, sha, previous, reason });
  if (!marker) log(`could not write the update quarantine marker for ${String(sha).slice(0, 9)}`);
  const reset = await resetKeep(previous);
  if (reset.code !== 0) {
    return { ok: false, marker, detail: reset.stderr || `git reset --keep exited ${reset.code}` };
  }
  if (depsChanged) {
    // node_modules now hold the pulled sha's tree; the running code needs its own.
    const npmResult = await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
    if (npmResult.code !== 0) log(`npm install warning after rollback: ${npmResult.stderr}`);
  }
  return { ok: true, marker, detail: "" };
}

/**
 * L0.5: init-db failed. Quarantine the sha and roll the code back — but ONLY
 * when the schema generation did not advance. A generation crossing means new
 * code already wrote the store, and the old code was never written for that
 * shape, so the tree is left where it is (today's behaviour) and the existing
 * alert stands. The result text is unchanged either way; the marker is what
 * makes the NEXT tick say "update quarantined" instead of "Up to date".
 */
async function rollBackAfterInitDbFailure({ gitDir, sha, previous, depsChanged, advanced, log = () => {} }) {
  if (advanced) {
    log(`init-db advanced the schema generation — leaving the tree at ${String(sha).slice(0, 9)} (the old code was not written for the new shape)`);
    return { ok: false, advanced: true };
  }
  const rolled = await quarantineAndRollBack({ gitDir, sha, previous, reason: "init-db-failed", depsChanged, log });
  if (!rolled.ok) {
    await fireUpdateAlert({
      code: "update-rollback-blocked",
      title: "Crow updates paused: rollback blocked",
      body: `init-db failed after the update to ${String(sha).slice(0, 9)} and the checkout could not be reset to ${String(previous).slice(0, 9)} because local changes overlap it (${String(rolled.detail).slice(0, 200)}). It is quarantined; commit, stash or revert those changes, then restart the gateway.`,
    });
    return { ok: false, advanced: false };
  }
  log(`Rolled the checkout back to ${String(previous).slice(0, 9)} and quarantined ${String(sha).slice(0, 9)} (init-db failed, schema unchanged).`);
  return { ok: true, advanced: false };
}

/** Did init-db move the schema generation forward? If it did, the old code may
 *  not understand the store, so the tree is left where it is (L0.5). */
function schemaVersionAdvanced(pre, post) {
  return Number(post?.userVersion ?? 0) > Number(pre?.userVersion ?? 0);
}

/**
 * A loud, DB-free alert through the SAME rails the migration guard uses: the
 * instance's alert spool (drained into the in-app bell once the DB is up) plus
 * ntfy/email. Never throws.
 */
async function fireUpdateAlert(payload) {
  try {
    const { fireMigrationAlert } = await import("../shared/migration-guard.js");
    await fireMigrationAlert(payload);
  } catch (err) {
    console.warn(`[auto-update] alert failed: ${err?.message}`);
  }
}

/** The mutating sequence; exported ONLY as the test seam for the under-lock
 *  branch re-check (spec D3b — the outer guard would abort a branch fixture
 *  before the lock). */
export async function runLockedUpdate(log = (m) => console.log(`[auto-update] ${m}`)) {
  // Get current version
  const currentRef = await run("git", ["rev-parse", "--short", "HEAD"]);
  const currentVersion = currentRef.stdout;
  // Full sha alongside the short one: the quarantine marker and `reset --keep`
  // both need 40 hex (a prefix would name a different commit).
  const currentFullSha = (await run("git", ["rev-parse", "HEAD"])).stdout;
  const gitDir = await gitDirFor();

  // Fetch latest from remote
  log("Checking for updates...");
  const fetchResult = await run("git", ["fetch", "--quiet", "origin", "main"]);
  if (fetchResult.code !== 0) {
    const msg = `Fetch failed: ${fetchResult.stderr}`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }

  // A3 migration quarantine — evaluated UNDER the lock, after the fetch, so
  // both the 6h tick and the manual "Check now" button (which also lands here)
  // consult it with origin/main's fresh head sha, and co-hosted gateways
  // can't race the marker. A quarantined sha is never re-pulled; the marker
  // auto-clears when main moves (attempts-capped).
  try {
    const originHead = await run("git", ["rev-parse", "origin/main"]);
    const { evaluateQuarantine, resolveGuardDbPath } = await import("../shared/migration-guard.js");
    const { resolveDataDir } = await import("../db.js");
    const q = evaluateQuarantine({
      appRoot: APP_ROOT,
      dbPath: resolveGuardDbPath(resolveDataDir),
      originHeadSha: originHead.stdout,
    });
    if (q.blocked) {
      const msg = `Skipped: migration quarantined (gen ${q.marker.fromGeneration}->${q.marker.toGeneration}, attempt ${q.marker.attempts}) — delete the quarantine marker files to override`;
      log(msg);
      if (Date.now() - _quarantineAlertAt > QUARANTINE_ALERT_COOLDOWN_MS) {
        _quarantineAlertAt = Date.now();
        const { fireMigrationAlert } = await import("../shared/migration-guard.js");
        await fireMigrationAlert({
          code: "migration-quarantined",
          title: "Crow updates paused: migration quarantined",
          body: `Auto-update is paused because a migration (schema gen ${q.marker.fromGeneration}->${q.marker.toGeneration}) damaged data and was rolled back. Updates resume automatically when a fix lands on main (attempt ${q.marker.attempts}/3).`,
        });
      }
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "quarantined", message: msg };
    }
    if (q.cleared) log(`Quarantine cleared — main moved past ${q.marker.sha.slice(0, 9)}; retrying the migration under guard`);
  } catch (err) {
    log(`quarantine check error (proceeding): ${err?.message}`);
  }

  // L0.3 update quarantine — same under-lock spot, same fresh origin head, so
  // the 6 h tick and the manual Check-now button both consult it. A sha this
  // host already rolled back is never re-pulled; the marker clears itself when
  // main moves past it (or expires, for a machine-side reason).
  let originHeadSha = "";
  try {
    originHeadSha = (await run("git", ["rev-parse", "origin/main"])).stdout;
    const uq = evaluateUpdateQuarantine({ gitDir, originHeadSha });
    if (uq.blocked) {
      const msg = `Skipped: update quarantined (${uq.marker.sha.slice(0, 9)}, ${uq.marker.reason}); waiting for a newer commit on main`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "update-quarantined", message: msg };
    }
    if (uq.cleared) log(`Update quarantine cleared — main moved past ${uq.marker.sha.slice(0, 9)}`);
    if (uq.expired) log(`Update quarantine for ${uq.marker.sha.slice(0, 9)} expired — retrying`);
  } catch (err) {
    log(`update quarantine check error (proceeding): ${err?.message}`);
  }

  // Check if there are new commits
  const behind = await run("git", ["rev-list", "--count", "HEAD..origin/main"]);
  const behindCount = parseInt(behind.stdout, 10) || 0;

  await saveSetting("auto_update_current_version", currentVersion);

  if (behindCount === 0) {
    log("Already up to date.");
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", "Up to date");
    await saveSetting("auto_update_latest_version", currentVersion);
    return { updated: false };
  }

  log(`${behindCount} new commit(s) available. Updating...`);

  // A5: consult the target sha's required check-runs before pulling. Red or
  // still-running CI skips this tick (self-heals when main is fixed or CI
  // completes); unknown fails open. CROW_UPDATE_CI_GATE=0 disables.
  if (process.env.CROW_UPDATE_CI_GATE !== "0") {
    const remote = await run("git", ["remote", "get-url", "origin"]);
    const targetSha = (await run("git", ["rev-parse", "origin/main"])).stdout;
    const ci = await resolveCiVerdict(remote.stdout, targetSha);
    if (ci === "red" || ci === "pending") {
      const msg = ci === "red"
        ? `Skipped: CI is RED on origin/main (${targetSha.slice(0, 9)}) — not deploying a failing build; will retry next tick`
        : `Skipped: CI still running on origin/main (${targetSha.slice(0, 9)}) — will retry next tick`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: ci === "red" ? "ci-red" : "ci-pending", message: msg };
    }
  }

  // D3b: re-check the branch UNDER the lock, immediately before the pull —
  // a parallel session's raw `git checkout` races the outer guard across the
  // fetch window, and `pull --ff-only origin main` on an ancestor feature
  // branch FAST-FORWARDS that ref (R1 empirically proved it).
  const recheck = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (recheck.stdout !== "main") {
    const msg = `Skipped: branch changed mid-update (now '${recheck.stdout}')`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, skipped: "not-on-main", branch: recheck.stdout, message: msg };
  }

  // D2: pull directly — NO stash. `git pull --ff-only` refuses only when the
  // incoming diff overlaps a locally-modified file; disjoint local WIP
  // survives untouched.
  const pullResult = await run("git", ["pull", "--ff-only", "origin", "main"]);
  if (pullResult.code !== 0) {
    const msg = `Pull failed (local changes may conflict with the update — resolve manually): ${pullResult.stderr}`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }

  // Install deps (only if package-lock changed)
  const changedFiles = await run("git", ["diff", "--name-only", `${currentVersion}..HEAD`]);
  const depsChanged =
    changedFiles.stdout.includes("package-lock.json") || changedFiles.stdout.includes("package.json");
  if (depsChanged) {
    log("Dependencies changed — running npm install...");
    const npmResult = await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
    if (npmResult.code !== 0) {
      log(`npm install warning: ${npmResult.stderr}`);
    }
  }

  // L0.2 import check — AFTER npm, BEFORE init-db. Both halves matter: init-db
  // must not run its new-schema pass for a sha that will never boot, and the
  // rollback must happen while the deps still match the tree it resets to.
  const pulledSha = (await run("git", ["rev-parse", "HEAD"])).stdout;
  const importCheck = await pulledTreeImportCheck();
  if (importCheck.skipped === "no-seam") {
    // S2: a sha from before the seam existed cannot answer the check, and
    // running its gateway here would START a full server. Skip; Layer 1
    // (the boot guard) is the backstop for it.
    log(`import check unavailable in ${pulledSha.slice(0, 9)} (no ${IMPORT_CHECK_ENV} seam) — relying on the boot guard`);
  } else if (importCheck.ok !== true) {
    const reason = importCheck.reason || "import-check";
    const rolled = await quarantineAndRollBack({
      gitDir, sha: pulledSha, previous: currentFullSha, reason, depsChanged, log,
    });
    if (!rolled.ok) {
      // `reset --keep` refused: local changes overlap the rollback. The marker
      // stays (the sha is bad whatever the checkout does), the restart is
      // withheld, and the operator is told what to clean up (B3).
      const msg = `Update rollback blocked: ${pulledSha.slice(0, 9)} fails to load (${reason}) and the checkout could not be reset to ${currentFullSha.slice(0, 9)} — local changes overlap it; restart withheld`;
      log(msg);
      await fireUpdateAlert({
        code: "update-rollback-blocked",
        title: "Crow updates paused: rollback blocked",
        body: `The update to ${pulledSha.slice(0, 9)} fails to load (${reason}) and the checkout could not be reset to ${currentFullSha.slice(0, 9)} because local changes overlap it (${String(rolled.detail).slice(0, 200)}). It is quarantined, so it is not pulled again. Commit, stash or revert those changes, then run Check for updates now.`,
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, error: msg, converge: false, blocked: true, sha: pulledSha };
    }
    // The previous code is back on disk and in node_modules. init-db NEVER ran,
    // so the schema question does not arise; the marker stops a re-pull.
    const expires = rolled.marker?.expires_at ? "; the quarantine also expires in 6h" : "";
    const msg = `Rolled back: ${pulledSha.slice(0, 9)} fails to load (${reason}); running ${currentFullSha.slice(0, 9)}; updates resume when main moves past it${expires}`;
    log(msg);
    await fireUpdateAlert({
      code: "update-rolled-back",
      title: "Crow rolled back an update that would not start",
      body: `The update to ${pulledSha.slice(0, 9)} was rolled back before it was ever restarted into: its gateway code fails to load (${reason}). ${currentFullSha.slice(0, 9)} is still running, and ${pulledSha.slice(0, 9)} is quarantined — updates resume by themselves when main moves past it.`,
    });
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg, converge: false, rolledBack: true, sha: pulledSha };
  }

  // Run init-db for any schema changes — guarded (A3) when the run carries
  // migration risk: the pulled range crosses a schema generation OR touches
  // scripts/init-db.js (state-conditional rebuilds fire on DB shape, not
  // generation). Non-crossing, init-db-unchanged runs keep the bare call.
  log("Running database migrations...");
  const guard = await import("../shared/migration-guard.js");
  const { resolveDataDir: _rdd } = await import("../db.js");
  const dbPath = guard.resolveGuardDbPath(_rdd);
  const newGeneration = guard.readTreeGeneration(APP_ROOT);
  const preState = guard.readSchemaState(dbPath);
  const armed =
    (newGeneration != null && preState.readable && preState.userVersion < newGeneration) ||
    changedFiles.stdout.split("\n").includes("scripts/init-db.js");
  if (armed) {
    const headSha = (await run("git", ["rev-parse", "HEAD"])).stdout;
    const res = await guard.runGuardedInitDb({
      dbPath, appRoot: APP_ROOT, sha: headSha, newGeneration,
      log: (m) => log(`[migration-guard] ${m}`),
    });
    if (res.verdict === "loss") {
      if (!res.restored) {
        // Restore failed or no backup existed: the (damaged) migrated DB is
        // what's on disk and the running code matches it. Do NOT roll code
        // back or restart into a state the alert just told the operator to
        // repair by hand — keep running, quarantined, loudly.
        const msg = `Migration quarantined: data loss detected, automatic restore NOT possible — manual recovery required (${(res.report?.losses || []).join("; ")})`;
        log(msg);
        await saveSetting("auto_update_last_check", new Date().toISOString());
        await saveSetting("auto_update_last_result", msg);
        return { updated: false, error: msg, quarantined: true, converge: false };
      }
      // Fail closed: the guard restored the backup and quarantined the sha.
      // Roll the code back to match the restored schema — but never destroy
      // local WIP on a possibly-false verdict (quarantined boot handles the
      // code-newer-than-schema case).
      const porcelain = await run("git", ["status", "--porcelain"]);
      const trackedWip = porcelain.stdout.split("\n").filter((l) => l && !l.startsWith("??"));
      if (trackedWip.length === 0) {
        await run("git", ["reset", "--hard", currentVersion]);
        if (depsChanged) {
          await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
        }
        log(`Rolled code back to ${currentVersion} to match the restored database.`);
      } else {
        log("Local WIP present — code left at the new sha; next boot is quarantined (old schema, data intact).");
      }
      const msg = `Migration quarantined: data loss detected and rolled back (${(res.report?.losses || []).join("; ")})`;
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // The live process's DB handles still pin the pre-restore inode —
      // restart IMMEDIATELY so the process reopens the restored file.
      scheduleSupervisedRestart(log, "Restarting to reopen the restored database...");
      return { updated: false, error: msg, quarantined: true, converge: false };
    }
    if (res.initDbExit !== 0) {
      const msg = `Migration failed (init-db exit ${res.initDbExit}) — restart withheld, running code unchanged`;
      log(msg);
      await guard.fireMigrationAlert({
        code: "migration-failed",
        title: "Crow migration failed during auto-update",
        body: `init-db exited ${res.initDbExit} after pulling an update. The gateway keeps running the previous code; the next restart will retry via the boot gate. Check logs, then run \`node scripts/guarded-init-db.mjs\`.`,
      });
      // L0.5 — leave the tree at the new sha ONLY when the schema moved forward.
      // Otherwise nothing about the new code has landed in the DB, so the next
      // restart for any reason (reboot, a bundle install) would boot it and
      // crash-loop on the same failure. `--keep` refuses on overlapping WIP.
      await rollBackAfterInitDbFailure({
        gitDir, sha: pulledSha, previous: currentFullSha, depsChanged, log,
        advanced: schemaVersionAdvanced(preState, guard.readSchemaState(dbPath)),
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false — this branch exists to WITHHOLD the restart. Without
      // the flag, convergence restarts into a sha whose init-db just failed and
      // the boot guard exits 1. Note the units here run RestartSec=5 against a
      // 10s StartLimitInterval, so StartLimitBurst=5 can never trip: the result
      // is an UNBOUNDED crash loop, not a stopped unit. Each iteration re-enters
      // the boot schema guard and re-runs init-db against a live store.
      return { updated: false, error: msg, converge: false };
    }
  } else {
    // Pinned to the running instance's DB (queue item 33): the pulled code may
    // resolve the data dir differently from the code that is running.
    const initRes = await run("node", ["scripts/init-db.js"], { env: guard.initDbChildEnv(dbPath) });
    if (initRes.code !== 0) {
      const msg = `init-db failed (exit ${initRes.code}) — restart withheld, running code unchanged`;
      log(msg);
      await guard.fireMigrationAlert({
        code: "init-db-failed",
        title: "Crow init-db failed during auto-update",
        body: `init-db exited ${initRes.code} after pulling an update (no migration expected). The gateway keeps running the previous code. Check logs, then run \`node scripts/guarded-init-db.mjs\`.`,
      });
      // L0.5, same rule as the guarded branch above.
      await rollBackAfterInitDbFailure({
        gitDir, sha: pulledSha, previous: currentFullSha, depsChanged, log,
        advanced: schemaVersionAdvanced(preState, guard.readSchemaState(dbPath)),
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false — this branch exists to WITHHOLD the restart. Without
      // the flag, convergence restarts into a sha whose init-db just failed and
      // the boot guard exits 1. Note the units here run RestartSec=5 against a
      // 10s StartLimitInterval, so StartLimitBurst=5 can never trip: the result
      // is an UNBOUNDED crash loop, not a stopped unit. Each iteration re-enters
      // the boot schema guard and re-runs init-db against a live store.
      return { updated: false, error: msg, converge: false };
    }
  }

  const newRef = await run("git", ["rev-parse", "--short", "HEAD"]);
  const newVersion = newRef.stdout;

  await saveSetting("auto_update_last_check", new Date().toISOString());
  await saveSetting("auto_update_last_result", `Updated ${currentVersion} → ${newVersion}`);
  await saveSetting("auto_update_current_version", newVersion);
  await saveSetting("auto_update_latest_version", newVersion);

  log(`Updated: ${currentVersion} → ${newVersion}`);

  // NOTE: the restart is NOT scheduled here. convergeInstance() owns it, and
  // schedules it only AFTER running this instance's migrations and writing the
  // boot cookie. Restarting here would fire a 1.5s exit timer while those
  // migrations are still running — an interrupted ALTER on a live store — and
  // the cookie, which must exist before the restart, might never be written.
  // (The restart on the migration-guard LOSS path below stays: it exists to
  // reopen a restored DB file and is unrelated to convergence.)
  return { updated: true, from: currentVersion, to: newVersion };
}

/** Supervised-restart machinery, shared by the normal update path and the
 *  migration-guard loss path (which must reopen the restored DB file).
 *  No-op without a supervisor. */
export function scheduleSupervisedRestart(log, message) {
  if (!isSupervised()) return;
  log(message);
  // Close the HTTP server first to release the port, then exit
  // so the supervisor's restart doesn't hit EADDRINUSE.
  // exitCode is preset so that if the loop drains before the inner timer
  // fires (manual check-now path: crow:shutdown closes the only ref'd
  // handle), node still exits nonzero — Restart=on-failure needs it.
  // Both timers are unref'd so a pending restart chain can never hold open
  // or kill a process whose loop otherwise finished (test runners).
  process.exitCode = 1;
  const outer = setTimeout(() => {
    process.emit("crow:shutdown");
    setTimeout(() => process.exit(1), 1000).unref();
  }, 1500);
  outer.unref();
}

/**
 * D4: whether auto-update should even attempt to start. The
 * CROW_AUTO_UPDATE=0|false kill switch always wins. Otherwise, a --no-auth
 * gateway (an unauthenticated scratch/dev surface) defaults OFF and requires
 * an explicit CROW_AUTO_UPDATE=1|true opt-in; every other gateway defaults
 * ON (existing behavior preserved).
 */
export function shouldStartAutoUpdate({ env = {}, noAuth = false } = {}) {
  if (env.CROW_AUTO_UPDATE === "0" || env.CROW_AUTO_UPDATE === "false") return false;
  if (noAuth) return env.CROW_AUTO_UPDATE === "1" || env.CROW_AUTO_UPDATE === "true";
  return true;
}

/**
 * Start the auto-update timer
 */
export async function startAutoUpdate(database, { noAuth = false } = {}) {
  db = database;

  if (!shouldStartAutoUpdate({ env: process.env, noAuth })) {
    console.log(
      noAuth
        ? "[auto-update] Disabled: --no-auth gateway defaults auto-update OFF (set CROW_AUTO_UPDATE=1 to opt in)"
        : "[auto-update] Disabled via CROW_AUTO_UPDATE env var",
    );
    return;
  }

  const settings = await getSettings();

  // Record the sha this process is ACTUALLY running, BEFORE any early return.
  // This used to sit below the disabled-in-settings return, so a disabled
  // instance froze its reported version at whatever it was when it was last
  // enabled — while continuing to run whatever the shared checkout moved to.
  // The bookkeeping and the running code disagreed and nothing detected it.
  try {
    const ref = await run("git", ["rev-parse", "--short", "HEAD"]);
    if (ref.code === 0 && ref.stdout) await saveSetting("auto_update_current_version", ref.stdout);
  } catch {}

  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Disabled in settings");
    return;
  }

  const hours = Math.max(MIN_INTERVAL_HOURS, parseInt(settings.auto_update_interval_hours, 10) || DEFAULT_INTERVAL_HOURS);
  const intervalMs = hours * 60 * 60 * 1000;

  const { resolveDataDir } = await import("../db.js");
  const firstDelay = 5 * 60 * 1000 + instanceJitterMs(resolveDataDir());
  console.log(`[auto-update] Enabled — checking every ${hours}h (first check in ${Math.round(firstDelay / 1000)}s)`);

  // First check after ~5 minutes plus a per-instance offset (let the gateway
  // fully start, and keep co-hosted instances off the same millisecond).
  updateTimer = setTimeout(async () => {
    // tickCheck now reaches runMigrations, which CAN reject; an unhandled
    // rejection in this timer would take the gateway down.
    await tickCheck().catch((e) => console.error("[auto-update] tick failed:", e.message));
    updateTimer = setInterval(() => { tickCheck().catch(() => {}); }, intervalMs);
  }, firstDelay);
}

/**
 * Stop the auto-update timer
 */
export function stopAutoUpdate() {
  if (updateTimer) {
    clearTimeout(updateTimer);
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

/**
 * Get current status for the Settings panel
 */
export async function getUpdateStatus() {
  const settings = await getSettings();
  return {
    enabled: settings.auto_update_enabled === "true",
    intervalHours: parseInt(settings.auto_update_interval_hours, 10) || DEFAULT_INTERVAL_HOURS,
    lastCheck: settings.auto_update_last_check,
    lastResult: settings.auto_update_last_result,
    resultSince: settings.auto_update_result_since,
    currentVersion: settings.auto_update_current_version,
    latestVersion: settings.auto_update_latest_version,
  };
}
