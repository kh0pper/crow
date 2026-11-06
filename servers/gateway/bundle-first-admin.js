/**
 * bundle-first-admin — how a bundle's OWN first admin account comes to exist,
 * and the "finish this app's setup now" notice (security audit N3-4).
 *
 * The finding: a freshly installed app's own first-run admin page is reachable
 * over loopback by anyone or anything else on the machine, and an audit VM run
 * showed another account claiming uptime-kuma's setup page before the owner
 * did. Every web app bundle declares which answer applies (manifest
 * `firstAdmin.mode`):
 *
 *   crow           Crow creates the admin at install — a generated password in
 *                  the keychain, or a postInstall hook. Nothing to claim, and
 *                  nothing to show the operator.
 *   finish-setup   the app has its own first-run admin page. The operator is
 *                  told, plainly, to finish it NOW, with a direct link.
 *   default-login  the app ships a documented default login (user + password).
 *                  Same notice, different first sentence.
 *   external       it connects to an app you already run; its login is that
 *                  app's. Nothing of ours to claim, so no notice.
 *   none           no login of its own. No notice.
 *
 * A web UI bundle that says nothing (a community-store manifest written before
 * the field existed) falls back to `finish-setup` — see firstAdminOf.
 *
 * This module owns the two operator-facing pieces of that:
 *   - the card on Extensions (pendingFirstAdminNotices(). `done` is the
 *     operator's own word — nothing can detect that an app's setup is finished,
 *     so the card has a Done button and a local-only setting remembers it),
 *   - one bell per bundle INSTALL (notifyFirstAdmin / reportFirstAdminNotice),
 *     deduped on the install's own timestamp so a reinstall after an uninstall
 *     rings again.
 *
 * Both markers are `dashboard_settings` rows written with plain SQL, like
 * bundle-pull-alert's cooldown: they are per-install state, they must never
 * sync to a paired instance, and they must not need a settings-registry entry.
 * `first_admin_*` is also listed in INSTANCE_SCOPE_KEYS for that reason.
 *
 * Never throws into the install path, and never logs a secret: the only value
 * either marker holds is a timestamp.
 */
import { createDbClient } from "../db.js";
import { createNotification } from "../shared/notifications.js";
import { bundlePageUrl } from "./bundle-pull-alert.js";
import {
  firstAdminOf,
  firstAdminNeedsOperator,
  firstAdminTitle,
  firstAdminBody,
} from "./dashboard/shared/first-admin.js";

// The manifest-shape half (modes, the contract rules, the link rule) is pure and
// shared with the Extensions renderer: dashboard/shared/first-admin.js.
export {
  FIRST_ADMIN_MODES,
  OPERATOR_FIRST_ADMIN_MODES,
  FIRST_ADMIN_TITLE_KEY,
  FIRST_ADMIN_FINISH_BODY_KEY,
  FIRST_ADMIN_DEFAULT_LOGIN_BODY_KEY,
  firstAdminOf,
  firstAdminNeedsOperator,
  firstAdminLink,
  firstAdminTitle,
  firstAdminBody,
  pendingFirstAdminNotices,
} from "./dashboard/shared/first-admin.js";

export const FIRST_ADMIN_DONE_PREFIX = "first_admin_done:";
export const FIRST_ADMIN_NOTICE_PREFIX = "first_admin_notice:";

/** The operator pressed Done for this bundle at this install (`<installedAt>`). */
export const firstAdminDoneKey = (bundleId) => `${FIRST_ADMIN_DONE_PREFIX}${bundleId}`;
/** The install (`<installedAt>`) whose bell already rang. */
export const firstAdminNoticeKey = (bundleId) => `${FIRST_ADMIN_NOTICE_PREFIX}${bundleId}`;

/**
 * Every `first_admin_done:<id>` marker, as id → install timestamp. One query;
 * an unreadable table yields {} (the card shows, which is the safe direction).
 */
export async function firstAdminDoneValues(db) {
  const out = {};
  if (!db || typeof db.execute !== "function") return out;
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE ?",
      args: [`${FIRST_ADMIN_DONE_PREFIX}%`],
    });
    for (const row of rows || []) {
      const key = String(row?.key || "");
      if (!key.startsWith(FIRST_ADMIN_DONE_PREFIX)) continue;
      const id = key.slice(FIRST_ADMIN_DONE_PREFIX.length);
      if (id) out[id] = String(row?.value ?? "");
    }
  } catch {
    /* no marker read: show the cards rather than hide them */
  }
  return out;
}

/** Write one `dashboard_settings` row (plain SQL: never synced, no registry entry). */
async function writeMarker(db, key, value) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
    args: [key, value, value],
  });
}

/**
 * The operator says this app's setup is finished. Stamped with the CURRENT
 * install, so the card stays away until this bundle is installed again.
 *
 * @returns {Promise<string|null>} the stamp written, or null
 */
export async function markFirstAdminDone(db, bundleId, installId, { nowMs = Date.now() } = {}) {
  if (!db || typeof bundleId !== "string" || !bundleId) return null;
  const stamp = typeof installId === "string" && installId ? installId : new Date(nowMs).toISOString();
  await writeMarker(db, firstAdminDoneKey(bundleId), stamp);
  return stamp;
}

/** The dashboard language, read straight from dashboard_settings; "en" when unreadable. */
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
 * Ring the bell ONCE per bundle install.
 *
 * Silent for `crow`/`external`/`none`, silent when this install's bell already
 * rang. A web UI bundle that declares nothing falls back to `finish-setup`
 * (firstAdminOf), so an undeclared third-party install still rings once.
 *
 * @param {object} o
 * @param {object} o.db                   libsql-shaped client
 * @param {string} o.bundleId
 * @param {object} o.manifest             the installed manifest
 * @param {string} [o.bundleName]         display name (else the manifest's, else the id)
 * @param {string} [o.installId]          installed.json's installedAt for this install
 * @param {number} [o.nowMs]              clock seam
 * @param {Function} [o.notify]           createNotification-shaped seam (tests)
 * @param {string} [o.lang]               force a language (else the dashboard setting)
 * @param {object} [o.log]                console-shaped logger
 * @returns {Promise<object|null>} the notification row, or null when silent
 */
export async function notifyFirstAdmin({
  db,
  bundleId,
  manifest,
  bundleName = null,
  installId = null,
  nowMs = Date.now(),
  notify = createNotification,
  lang = null,
  log = console,
}) {
  if (!db || !bundleId || !firstAdminNeedsOperator(manifest)) return null;
  const key = firstAdminNoticeKey(bundleId);
  const stamp = typeof installId === "string" && installId ? installId : new Date(nowMs).toISOString();
  try {
    let lastAt = null;
    try {
      const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
      lastAt = rows?.[0]?.value ?? null;
    } catch {
      /* unreadable marker: ring rather than stay silent (a missing bell is the worse error) */
    }
    if (lastAt === stamp) return null; // this install already rang

    const name = bundleName || (manifest && manifest.name) || bundleId;
    const language = lang || await readLanguage(db);
    const fa = firstAdminOf(manifest);
    const row = await notify(db, {
      title: firstAdminTitle(name, language),
      body: firstAdminBody(fa, name, language),
      type: "system",
      source: "bundle-installer",
      priority: "normal",
      action_url: bundlePageUrl(bundleId),
      metadata: { kind: "bundle-first-admin", bundle: bundleId, mode: fa.mode },
    });
    // Stamped even when the type is switched off (createNotification returns
    // null): the owner's preference is a choice, and a reinstall is a new notice.
    await writeMarker(db, key, stamp);
    return row;
  } catch (err) {
    try { log.warn(`[bundles] first-admin notification skipped: ${err?.message ?? err}`); } catch { /* console gone */ }
    return null;
  }
}

/**
 * The install path's entry point: owns its database client (the install job has
 * none) and never throws into the caller.
 */
export async function reportFirstAdminNotice({
  bundleId,
  manifest,
  bundleName = null,
  installId = null,
  dbFactory = createDbClient,
  log = console,
  ...rest
} = {}) {
  let db = null;
  try {
    if (!firstAdminNeedsOperator(manifest)) return null;
    db = dbFactory();
    return await notifyFirstAdmin({ db, bundleId, manifest, bundleName, installId, log, ...rest });
  } catch (err) {
    try { log.warn(`[bundles] first-admin notification skipped: ${err?.message ?? err}`); } catch { /* console gone */ }
    return null;
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}
