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
import { isInstallSetRunning } from "./install-lock.js";

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

// Migration-quarantine re-alert cooldown (mirrors the audit-breaker pattern).
const QUARANTINE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let _quarantineAlertAt = 0;

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
        return { updated: false, error: msg, quarantined: true };
      }
      // Fail closed: the guard restored the backup and quarantined the sha.
      // Roll the code back to match the restored schema — but never destroy
      // local WIP on a possibly-false verdict (quarantined boot handles the
      // code-newer-than-schema case).
      const porcelain = await run("git", ["status", "--porcelain"]);
      const trackedWip = porcelain.stdout.split("\n").filter((l) => l && !l.startsWith("??"));
      if (trackedWip.length === 0) {
        await run("git", ["reset", "--hard", currentVersion]);
        if (changedFiles.stdout.includes("package-lock.json") || changedFiles.stdout.includes("package.json")) {
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
      return { updated: false, error: msg, quarantined: true };
    }
    if (res.initDbExit !== 0) {
      const msg = `Migration failed (init-db exit ${res.initDbExit}) — restart withheld, running code unchanged`;
      log(msg);
      await guard.fireMigrationAlert({
        title: "Crow migration failed during auto-update",
        body: `init-db exited ${res.initDbExit} after pulling an update. The gateway keeps running the previous code; the next restart will retry via the boot gate. Check logs, then run \`node scripts/guarded-init-db.mjs\`.`,
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, error: msg };
    }
  } else {
    const initRes = await run("node", ["scripts/init-db.js"]);
    if (initRes.code !== 0) {
      const msg = `init-db failed (exit ${initRes.code}) — restart withheld, running code unchanged`;
      log(msg);
      await guard.fireMigrationAlert({
        title: "Crow init-db failed during auto-update",
        body: `init-db exited ${initRes.code} after pulling an update (no migration expected). The gateway keeps running the previous code. Check logs, then run \`node scripts/guarded-init-db.mjs\`.`,
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, error: msg };
    }
  }

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
  scheduleSupervisedRestart(log, "Restarting gateway to apply update...");

  return { updated: true, from: currentVersion, to: newVersion };
}

/** Supervised-restart machinery, shared by the normal update path and the
 *  migration-guard loss path (which must reopen the restored DB file).
 *  No-op without a supervisor. */
function scheduleSupervisedRestart(log, message) {
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
