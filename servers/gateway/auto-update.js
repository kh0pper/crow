/**
 * Auto-Update Module — Periodically pulls latest code from git
 *
 * Enabled by default. Users can toggle via Settings panel or CROW_AUTO_UPDATE env var.
 * Stores state in dashboard_settings DB table.
 *
 * On update: git pull → npm install → init-db → restart (if systemd)
 */

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(dirname(__dirname));

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

/**
 * Check for and apply updates
 * Returns { updated, from, to, error }
 */
export async function checkForUpdates() {
  const log = (msg) => console.log(`[auto-update] ${msg}`);

  try {
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

    // Pull
    const pullResult = await run("git", ["pull", "--ff-only", "origin", "main"]);
    if (pullResult.code !== 0) {
      const msg = `Pull failed: ${pullResult.stderr}`;
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

    // Restart if running as systemd service
    if (process.env.INVOCATION_ID) {
      log("Restarting gateway via systemd...");
      // Exit with code 1 so Restart=on-failure brings the service back up
      // Delay to allow the HTTP response to complete first
      setTimeout(() => process.exit(1), 1500);
    }

    return { updated: true, from: currentVersion, to: newVersion };
  } catch (err) {
    const msg = `Update error: ${err.message}`;
    console.error(`[auto-update] ${msg}`);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }
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
    await checkForUpdates();
    // Then schedule recurring checks
    updateTimer = setInterval(() => checkForUpdates(), intervalMs);
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
