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
 *                  the keychain, a postInstall hook, or (via "setup") a script
 *                  the installer runs with the password on stdin. Nothing to
 *                  claim, and nothing to show the operator once it worked.
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
 * This module owns the operator-facing pieces of that:
 *   - the card on Extensions (pendingFirstAdminNotices(). `done` is the
 *     operator's own word — nothing can detect that an app's setup is finished,
 *     so the card has a Done button and a local-only setting remembers it; the
 *     keychain holding the app's admin login hides it too),
 *   - one bell per bundle INSTALL (notifyFirstAdmin / reportFirstAdminNotice),
 *     deduped on the install's own timestamp so a reinstall after an uninstall
 *     rings again,
 *   - what Crow's own setup run did for this install (writeFirstAdminAutoResult,
 *     runFirstAdminSetup in bundle-first-admin-setup.js), which decides whether
 *     a `crow`/`via: "setup"` bundle still owes the operator a card and a bell.
 *
 * Every marker is a `dashboard_settings` row written with plain SQL, like
 * bundle-pull-alert's cooldown: they are per-install state, they must never
 * sync to a paired instance, and they must not need a settings-registry entry.
 * `first_admin_*` is also listed in INSTANCE_SCOPE_KEYS for that reason.
 *
 * Never throws into the install path, and never logs a secret: the only values
 * the markers hold are a timestamp and a result word.
 */
import { createDbClient } from "../db.js";
import { createNotification } from "../shared/notifications.js";
import { bundlePageUrl } from "./bundle-pull-alert.js";
import {
  FIRST_ADMIN_SAVED_KEY,
  firstAdminOf,
  firstAdminNeedsNotice,
  firstAdminSavedKey,
  firstAdminVia,
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
  FIRST_ADMIN_SETUP_BODY_KEY,
  FIRST_ADMIN_KEPT_BODY_KEY,
  FIRST_ADMIN_SAVED_KEY,
  firstAdminOf,
  firstAdminNeedsOperator,
  firstAdminNeedsNotice,
  firstAdminSavedKey,
  firstAdminVia,
  firstAdminLink,
  firstAdminTitle,
  firstAdminBody,
  pendingFirstAdminNotices,
} from "./dashboard/shared/first-admin.js";

export const FIRST_ADMIN_DONE_PREFIX = "first_admin_done:";
export const FIRST_ADMIN_NOTICE_PREFIX = "first_admin_notice:";
/** `notifications.source` of a bundle's first-admin bell (the Removal row shares it). */
export const FIRST_ADMIN_NOTIFICATION_SOURCE = "bundle-installer";
/** What Crow's own setup run did for this bundle, at this install (`firstAdmin.via: "setup"`). */
export const FIRST_ADMIN_AUTO_PREFIX = "first_admin_auto:";

/** The operator pressed Done for this bundle at this install (`<installedAt>`). */
export const firstAdminDoneKey = (bundleId) => `${FIRST_ADMIN_DONE_PREFIX}${bundleId}`;
/** The install (`<installedAt>`) whose bell already rang. */
export const firstAdminNoticeKey = (bundleId) => `${FIRST_ADMIN_NOTICE_PREFIX}${bundleId}`;
/** This bundle's most recent automatic setup outcome (`{install, result}`). */
export const firstAdminAutoKey = (bundleId) => `${FIRST_ADMIN_AUTO_PREFIX}${bundleId}`;

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
 * Every `first_admin_auto:<id>` marker, as id → {install, result}. One query; an
 * unreadable value is skipped (the card shows, which is the safe direction).
 */
export async function firstAdminAutoResults(db) {
  const out = {};
  if (!db || typeof db.execute !== "function") return out;
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE ?",
      args: [`${FIRST_ADMIN_AUTO_PREFIX}%`],
    });
    for (const row of rows || []) {
      const key = String(row?.key || "");
      if (!key.startsWith(FIRST_ADMIN_AUTO_PREFIX)) continue;
      const id = key.slice(FIRST_ADMIN_AUTO_PREFIX.length);
      if (!id) continue;
      try {
        const v = JSON.parse(String(row?.value ?? ""));
        if (v && typeof v === "object") out[id] = { install: typeof v.install === "string" ? v.install : null, result: typeof v.result === "string" ? v.result : null };
      } catch { /* an unreadable marker is not a result */ }
    }
  } catch {
    /* no marker read: show the cards rather than hide them */
  }
  return out;
}

/**
 * Record what the automatic first-admin run did: `{install, result}`, plain SQL like
 * the Done marker (per install, local only — `first_admin_*` is in INSTANCE_SCOPE_KEYS).
 */
export async function writeFirstAdminAutoResult(db, bundleId, { install = null, result } = {}) {
  if (!db || typeof bundleId !== "string" || !bundleId) return false;
  try {
    await writeMarker(db, firstAdminAutoKey(bundleId), JSON.stringify({ install: install || null, result: result || null }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Installed bundles whose keychain holds an ACTIVE extension entry named by that
 * bundle's own admin key (FIRST_ADMIN_SAVED_KEY when the manifest declares none).
 * Metadata only — nothing is decrypted, no keychain key is needed. ONE query; an
 * unreadable table yields an empty set, which shows the cards (the safe direction).
 *
 * @returns {Promise<Set<string>>}
 */
export async function firstAdminSavedBundleIds(db, manifests = {}) {
  const out = new Set();
  if (!db || typeof db.execute !== "function") return out;
  try {
    const { rows } = await db.execute({
      sql: "SELECT bundle_id, env_key FROM crow_keychain WHERE kind = 'extension' AND status = 'active'",
      args: [],
    });
    const byBundle = new Map();
    for (const row of rows || []) {
      const id = String(row?.bundle_id || "");
      const key = String(row?.env_key || "");
      if (!id || !key) continue;
      if (!byBundle.has(id)) byBundle.set(id, new Set());
      byBundle.get(id).add(key);
    }
    for (const [id, keys] of byBundle) {
      const manifest = manifests ? manifests[id] : null;
      if (keys.has(firstAdminSavedKey(manifest))) out.add(id);
    }
  } catch {
    return new Set();
  }
  return out;
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
 * A bundle was REMOVED: its "Finish <app>'s setup now" bell goes with it (audit N5-4).
 *
 * The card itself is built from installed.json (pendingFirstAdminNotices), so the removal
 * already empties it; the Done marker written here keeps a stale render from bringing one
 * back and records that there is nothing left to finish. The bell is the row that does NOT
 * disappear on its own, so it is dismissed the same way crow_dismiss_notification does it
 * (is_dismissed = 1, the row is kept for History) — and ONLY this bundle's first-admin
 * notice: the "Removed: X" row from the same source, and every other bundle's bell, stay.
 *
 * Never throws: an uninstall must not fail over a bell.
 *
 * @returns {Promise<{dismissed: number, done: string|null}>}
 */
export async function clearFirstAdminNotice(db, bundleId, { nowMs = Date.now(), installId = null, log = console } = {}) {
  if (!db || typeof bundleId !== "string" || !bundleId) return { dismissed: 0, done: null };
  let dismissed = 0;
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, metadata FROM notifications WHERE source = ? AND is_dismissed = 0",
      args: [FIRST_ADMIN_NOTIFICATION_SOURCE],
    });
    const mine = [];
    for (const row of rows || []) {
      let meta = null;
      try { meta = JSON.parse(String((row && row.metadata) || "")); } catch { meta = null; }
      if (!meta || meta.kind !== "bundle-first-admin" || meta.bundle !== bundleId) continue;
      if (row && row.id != null) mine.push(row.id);
    }
    for (const id of mine) {
      await db.execute({
        sql: "UPDATE notifications SET is_dismissed = 1, updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
    }
    dismissed = mine.length;
  } catch (err) {
    try { log.warn(`[bundles] first-admin notice not cleared: ${err?.message ?? err}`); } catch { /* console gone */ }
  }
  let done = null;
  // Stamped with THIS install when the caller still knows it (the uninstall path
  // reads installed.json before the record goes), so the marker really is "this
  // install owes nothing" — the same stamp the Done button writes.
  try { done = await markFirstAdminDone(db, bundleId, installId, { nowMs }); } catch { done = null; }
  return { dismissed, done };
}

/**
 * Ring the bell ONCE per bundle install.
 *
 * Silent for `crow` (via env/postInstall), `external` and `none`, silent when this
 * install's bell already rang. A `crow`/`via: "setup"` bundle is owed the bell unless
 * ITS OWN automatic run for this install returned "ok" (autoResult): a script that
 * failed, found the app not answering, or found an admin already in place is exactly
 * what the operator must hear about. A web UI bundle that declares nothing falls back
 * to `finish-setup` (firstAdminOf), so an undeclared third-party install still rings.
 *
 * @param {object} o
 * @param {object} o.db                   libsql-shaped client
 * @param {string} o.bundleId
 * @param {object} o.manifest             the installed manifest
 * @param {string} [o.bundleName]         display name (else the manifest's, else the id)
 * @param {string} [o.installId]          installed.json's installedAt for this install
 * @param {string} [o.autoResult]         runFirstAdminSetup's result for THIS install
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
  autoResult = null,
  nowMs = Date.now(),
  notify = createNotification,
  lang = null,
  log = console,
}) {
  if (!db || !bundleId || !firstAdminNeedsNotice(manifest, { autoResult })) return null;
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
    const setup = firstAdminVia(manifest) === "setup";
    const row = await notify(db, {
      title: firstAdminTitle(name, language),
      body: firstAdminBody({ ...fa, via: setup ? "setup" : null, kept: autoResult === "kept" }, name, language),
      type: "system",
      source: FIRST_ADMIN_NOTIFICATION_SOURCE,
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
  autoResult = null,
  dbFactory = createDbClient,
  log = console,
  ...rest
} = {}) {
  let db = null;
  try {
    if (!firstAdminNeedsNotice(manifest, { autoResult })) return null;
    db = dbFactory();
    return await notifyFirstAdmin({ db, bundleId, manifest, bundleName, installId, autoResult, log, ...rest });
  } catch (err) {
    try { log.warn(`[bundles] first-admin notification skipped: ${err?.message ?? err}`); } catch { /* console gone */ }
    return null;
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}
