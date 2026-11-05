/**
 * bundle-pull-alert — one bell when a bundle install cannot download its images.
 *
 * The install job only appended a warning line to a log the owner usually never
 * opens ("Warning: docker compose pull failed: …"), so an install that fell back
 * to a stale local image, or started with no image at all, announced itself
 * nowhere (security audit N1c-7). This module rings the in-app bell instead.
 *
 * Rules, matching the audit's brief and the way the other repeated alerts
 * (auto-update's notifyUpdateFailure) behave:
 *   - type `system`, a FIXED message that names the bundle — never the command's
 *     output, which can carry registry URLs, credentials in a proxy URL, or paths;
 *   - at most once per bundle per 24 h, so a collection install or a retry loop
 *     cannot turn one registry outage into a wall of bells;
 *   - never throws: the install continues exactly as before.
 *
 * The marker is a local `dashboard_settings` row (one per bundle), written with
 * plain SQL rather than the settings registry: an alert cooldown is not a
 * setting, it must not sync to a paired instance, and an older install without
 * that table must still install.
 */
import { createDbClient } from "../db.js";
import { createNotification } from "../shared/notifications.js";
import { t, fill } from "./dashboard/shared/i18n.js";

/** Re-ring window for the same bundle. */
export const PULL_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** `bundle_pull_alert:<id>` → ISO time of the last bell. */
export const PULL_ALERT_KEY_PREFIX = "bundle_pull_alert:";
export const pullAlertSettingKey = (bundleId) => `${PULL_ALERT_KEY_PREFIX}${bundleId}`;

export const PULL_ALERT_TITLE_KEY = "bundles.imagePullFailed.title";
export const PULL_ALERT_BODY_KEY = "bundles.imagePullFailed.body";

/** The per-bundle page in Extensions (its search box starts on the id). */
export function bundlePageUrl(bundleId) {
  return `/dashboard/extensions?q=${encodeURIComponent(bundleId)}`;
}

/**
 * Ring the bell once per bundle per window.
 *
 * @param {object} o
 * @param {object} o.db            libsql-shaped client
 * @param {string} o.bundleId
 * @param {string} [o.bundleName]  the manifest's display name (else the id)
 * @param {number} [o.nowMs]       clock seam
 * @param {Function} [o.notify]    createNotification-shaped seam (tests)
 * @param {string} [o.lang]        force a language (else the dashboard setting)
 * @param {object} [o.log]         console-shaped logger
 * @returns {Promise<object|null>} the notification row, or null when silent
 */
export async function notifyImagePullFailure({
  db,
  bundleId,
  bundleName = null,
  nowMs = Date.now(),
  notify = createNotification,
  lang = null,
  log = console,
}) {
  if (!db || !bundleId) return null;
  const key = pullAlertSettingKey(bundleId);
  try {
    let lastAt = null;
    try {
      const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
      lastAt = rows?.[0]?.value ?? null;
    } catch {
      /* unreadable marker: ring rather than stay silent (a missing bell is the worse error) */
    }
    const lastMs = Date.parse(lastAt || "");
    if (Number.isFinite(lastMs) && nowMs - lastMs < PULL_ALERT_COOLDOWN_MS) return null;

    const language = lang ?? await readLanguage(db);
    const row = await notify(db, {
      title: fill(t(PULL_ALERT_TITLE_KEY, language), { name: bundleName || bundleId }),
      body: t(PULL_ALERT_BODY_KEY, language),
      type: "system",
      source: "bundle-installer",
      priority: "normal",
      action_url: bundlePageUrl(bundleId),
      metadata: { kind: "bundle-image-pull", bundle: bundleId },
    });
    // Stamped even when the type is switched off (createNotification returns
    // null): the owner's preference is a choice, and retrying every install
    // does not deliver it either.
    const stamp = new Date(nowMs).toISOString();
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [key, stamp, stamp],
    });
    return row;
  } catch (err) {
    try { log.warn(`[bundles] image-pull notification skipped: ${err?.message ?? err}`); } catch { /* console gone */ }
    return null;
  }
}

/** The dashboard language, read straight from dashboard_settings; "en" when it cannot be read. */
async function readLanguage(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: [] });
    const v = rows?.[0]?.value;
    return v === "es" || v === "en" ? v : "en";
  } catch {
    return "en";
  }
}

/**
 * The install path's entry point: owns its database client (the install job has
 * none) and never throws into the caller.
 *
 * @param {object} [o]
 * @param {string} o.bundleId
 * @param {string} [o.bundleName]
 * @param {Function} [o.dbFactory]  test seam
 */
export async function reportImagePullFailure({ bundleId, bundleName = null, dbFactory = createDbClient, log = console, ...rest } = {}) {
  let db = null;
  try {
    db = dbFactory();
    return await notifyImagePullFailure({ db, bundleId, bundleName, log, ...rest });
  } catch (err) {
    try { log.warn(`[bundles] image-pull notification skipped: ${err?.message ?? err}`); } catch { /* console gone */ }
    return null;
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}