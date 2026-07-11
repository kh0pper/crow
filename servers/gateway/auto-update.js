/**
 * Auto-Update Module — Periodically pulls latest code from git
 *
 * Enabled by default. Users can toggle via Settings panel or CROW_AUTO_UPDATE env var.
 * Stores state in dashboard_settings DB table.
 *
 * On update: git pull → npm install → init-db → restart (if supervised)
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isSupervised } from "../shared/supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let APP_ROOT = dirname(dirname(__dirname));

/** Test-only: retarget git/npm/lock operations at a fixture repo. */
export function _setAppRootForTest(dir) {
  APP_ROOT = dir;
}

const DEFAULT_INTERVAL_HOURS = 6;
const MIN_INTERVAL_HOURS = 1;

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
 */
async function saveSetting(key, value) {
  if (!db) return;
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [key, value, value],
    });
  } catch (err) {
    console.warn(`[auto-update] Failed to save ${key}:`, err.message);
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

async function lockPath() {
  const r = await run("git", ["rev-parse", "--absolute-git-dir"]);
  if (r.code !== 0 || !r.stdout) return null; // not a git checkout → no lock possible
  return join(r.stdout, "crow-auto-update.lock");
}

function readLock(path) {
  try {
    const [pidLine, tsLine] = readFileSync(path, "utf8").split("\n");
    return { pid: parseInt(pidLine, 10), ts: Date.parse(tsLine || "") };
  } catch { return null; }
}

function lockIsStale(info) {
  if (!info || !Number.isFinite(info.pid)) return true;
  let alive = true;
  try { process.kill(info.pid, 0); } catch { alive = false; }
  const old = !Number.isFinite(info.ts) || Date.now() - info.ts > LOCK_STALE_MS;
  return !alive || old; // reclaim on (dead PID) OR (age>30min) — a wedged live updater must not block forever
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

/** Test-only: the lock primitives, unit-tested directly (they are not
 *  exported for production use — checkForUpdates()/runLockedUpdate() are the
 *  real callers). */
export const _lockPrimitivesForTest = { acquireLock, releaseLock, lockIsStale };

/**
 * Check for and apply updates
 * Returns { updated, from, to, error, skipped?, message?, branch? }
 */
export async function checkForUpdates() {
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
    const lock = await lockPath();
    const held = lock ? acquireLock(lock) : null;
    if (lock && !held) {
      const info = readLock(lock);
      const msg = `Skipped: another updater is running (pid ${info?.pid ?? "unknown"})`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "locked", message: msg };
    }
    try {
      return await runLockedUpdate(log);
    } finally {
      if (held) releaseLock(held);
    }
  } catch (err) {
    const msg = `Update error: ${err.message}`;
    console.error(`[auto-update] ${msg}`);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }
}

/** The mutating sequence; exported ONLY as the test seam for the under-lock
 *  branch re-check (spec D3b — the outer guard would abort a branch fixture
 *  before the lock). */
export async function runLockedUpdate(log = (m) => console.log(`[auto-update] ${m}`)) {
  // Get current version
  const currentRef = await run("git", ["rev-parse", "--short", "HEAD"]);
  const currentVersion = currentRef.stdout;

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
  if (changedFiles.stdout.includes("package-lock.json") || changedFiles.stdout.includes("package.json")) {
    log("Dependencies changed — running npm install...");
    const npmResult = await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
    if (npmResult.code !== 0) {
      log(`npm install warning: ${npmResult.stderr}`);
    }
  }

  // Run init-db for any schema changes
  log("Running database migrations...");
  await run("node", ["scripts/init-db.js"]);

  const newRef = await run("git", ["rev-parse", "--short", "HEAD"]);
  const newVersion = newRef.stdout;

  await saveSetting("auto_update_last_check", new Date().toISOString());
  await saveSetting("auto_update_last_result", `Updated ${currentVersion} → ${newVersion}`);
  await saveSetting("auto_update_current_version", newVersion);
  await saveSetting("auto_update_latest_version", newVersion);

  log(`Updated: ${currentVersion} → ${newVersion}`);

  // Restart to load the new code when supervised (systemd, launchd
  // KeepAlive, Docker, etc.). Without a supervisor the pulled code only
  // takes effect on the next manual restart.
  if (isSupervised()) {
    log("Restarting gateway to apply update...");
    // Close the HTTP server first to release the port, then exit
    // so the supervisor's restart doesn't hit EADDRINUSE
    setTimeout(() => {
      process.emit("crow:shutdown");
      setTimeout(() => process.exit(1), 1000);
    }, 1500);
  }

  return { updated: true, from: currentVersion, to: newVersion };
}

/**
 * Start the auto-update timer
 */
export async function startAutoUpdate(database) {
  db = database;

  // Respect CROW_AUTO_UPDATE env var (overrides DB setting)
  if (process.env.CROW_AUTO_UPDATE === "0" || process.env.CROW_AUTO_UPDATE === "false") {
    console.log("[auto-update] Disabled via CROW_AUTO_UPDATE env var");
    return;
  }

  const settings = await getSettings();

  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Disabled in settings");
    return;
  }

  // Save current version on startup
  try {
    const ref = await run("git", ["rev-parse", "--short", "HEAD"]);
    await saveSetting("auto_update_current_version", ref.stdout);
  } catch {}

  const hours = Math.max(MIN_INTERVAL_HOURS, parseInt(settings.auto_update_interval_hours, 10) || DEFAULT_INTERVAL_HOURS);
  const intervalMs = hours * 60 * 60 * 1000;

  console.log(`[auto-update] Enabled — checking every ${hours}h`);

  // First check after 5 minutes (let gateway fully start)
  updateTimer = setTimeout(async () => {
    await tickCheck();
    // Then schedule recurring checks
    updateTimer = setInterval(() => { tickCheck().catch(() => {}); }, intervalMs);
  }, 5 * 60 * 1000);
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
    currentVersion: settings.auto_update_current_version,
    latestVersion: settings.auto_update_latest_version,
  };
}
