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
 *   - never for an image this repo BUILDS itself: a `build:` service (or an
 *     image in scripts/image-pin-allowlist.txt) has nothing to download, so its
 *     pull failure is expected and stays a job-log line (see
 *     imagePullFailureRings);
 *   - never throws: the install continues exactly as before.
 *
 * The marker is a local `dashboard_settings` row (one per bundle), written with
 * plain SQL rather than the settings registry: an alert cooldown is not a
 * setting, it must not sync to a paired instance, and an older install without
 * that table must still install.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../db.js";
import { createNotification } from "../shared/notifications.js";
import { parseImagePinAllowlist } from "../shared/image-pin-allowlist.js";
import { t, fill } from "./dashboard/shared/i18n.js";

/** `scripts/image-pin-allowlist.txt` — the images this repo builds itself. */
export const IMAGE_PIN_ALLOWLIST_PATH = fileURLToPath(new URL("../../scripts/image-pin-allowlist.txt", import.meta.url));

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

export function readImagePinAllowlist(path = IMAGE_PIN_ALLOWLIST_PATH) {
  try { return parseImagePinAllowlist(readFileSync(path, "utf8")); } catch { return []; }
}

/** A compose scalar without the quotes compose allows around it. */
function unquote(raw) {
  const s = String(raw ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).trim();
  return s;
}

/**
 * The services of one compose text, in file order: `{ name, image, hasBuild }`.
 *
 * Deliberately a line reader, not a YAML parser: the install path only needs to
 * know which services exist, which of them declare `build:`, and what image tag
 * each names. Flow-style compose files yield no services, and the caller falls
 * back to "does this file build anything at all" (see imagePullFailureRings).
 */
export function parseComposeServices(text) {
  const services = [];
  let inServices = false;
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    if (/^\S/.test(line)) {
      // A top-level key ends the block: only `services:` opens it.
      inServices = /^services:\s*(?:#.*)?$/.test(line.trim());
      current = null;
      continue;
    }
    if (!inServices) continue;
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line);
    if (svc) {
      current = { name: svc[1], image: null, hasBuild: false };
      services.push(current);
      continue;
    }
    if (!current) continue;
    if (/^ {3,}build:\s*(?:\S|$)/.test(line)) current.hasBuild = true;
    const img = /^ {3,}image:\s*(.+?)\s*$/.exec(line.replace(/\s+#.*$/, ""));
    if (img) current.image = unquote(img[1]);
  }
  return services;
}

/** Does the compose text declare a `build:` for anything, in any style? Comments never count. */
function composeBuildsAnything(text) {
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (/(?:^|[\s{,])build\s*:/.test(line.replace(/\s+#.*$/, ""))) return true;
  }
  return false;
}

/**
 * Should a failed `docker compose pull` ring the owner's bell?
 *
 * A compose service with a `build:` section, or one whose image is in
 * scripts/image-pin-allowlist.txt, has nothing to download: `compose pull`
 * failing on it is expected (companion, sdxl, scratch-offline) and must stay a
 * job-log line, or every install of a locally built bundle rings once a day.
 *
 * Attribution first: the error output usually names the image it could not
 * pull, so a bundle with BOTH a built service and a pulled sidecar (a database)
 * still rings when the sidecar is what failed. When the output names nothing we
 * can place, the fallback is deliberately blunt: a compose that builds
 * something, for a bundle the allowlist knows, does not ring.
 *
 * @param {object} o
 * @param {string} o.bundleId
 * @param {string} [o.composeText]    the installed compose file, as read
 * @param {string} [o.output]        the command's stderr + message
 * @param {string} [o.allowlistText] scripts/image-pin-allowlist.txt contents
 * @param {string} [o.allowlistPath] read from this file when allowlistText is null
 * @returns {boolean} true when the bell should ring
 */
export function imagePullFailureRings({ bundleId, composeText = "", output = "", allowlistText = null, allowlistPath = IMAGE_PIN_ALLOWLIST_PATH } = {}) {
  // No compose to judge (or no bundle): keep the old behaviour and ring.
  if (!composeText) return true;
  const allowlist = allowlistText === null ? readImagePinAllowlist(allowlistPath) : parseImagePinAllowlist(allowlistText);
  const bundleCompose = `bundles/${bundleId}/docker-compose.yml`;
  const builtImages = allowlist.filter((e) => e.path === bundleCompose).map((e) => e.image);
  const allowlistedBundle = builtImages.length > 0;
  const serviceBuildsItself = (s) => s.hasBuild || (!!s.image && builtImages.includes(s.image));

  const services = parseComposeServices(composeText);
  if (services.length === 0) {
    // Nothing parsed to place the failure on: skip only for a bundle the
    // allowlist calls locally built, whose compose does actually build.
    return !(allowlistedBundle && composeBuildsAnything(composeText));
  }

  const out = String(output ?? "");
  const named = services.filter((s) => s.image && !s.image.includes("${") && out.includes(s.image));
  if (named.length === 0) {
    return !(allowlistedBundle && services.some((s) => s.hasBuild));
  }
  return !named.every(serviceBuildsItself);
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
 * none) and never throws into the caller. Silent (no client opened at all) when
 * the failed pull can only have been a locally built image.
 *
 * @param {object} [o]
 * @param {string} o.bundleId
 * @param {string} [o.bundleName]
 * @param {string} [o.composeText]   the installed compose file's text
 * @param {string} [o.output]       the pull command's stderr + message
 * @param {string} [o.allowlistText] scripts/image-pin-allowlist.txt contents
 * @param {Function} [o.dbFactory]  test seam
 */
export async function reportImagePullFailure({ bundleId, bundleName = null, dbFactory = createDbClient, log = console, composeText = "", output = "", allowlistText = null, ...rest } = {}) {
  let db = null;
  try {
    if (!imagePullFailureRings({ bundleId, composeText, output, allowlistText })) return null;
    db = dbFactory();
    return await notifyImagePullFailure({ db, bundleId, bundleName, log, ...rest });
  } catch (err) {
    try { log.warn(`[bundles] image-pull notification skipped: ${err?.message ?? err}`); } catch { /* console gone */ }
    return null;
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}