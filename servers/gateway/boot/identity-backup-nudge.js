/**
 * boot/identity-backup-nudge.js — ask the owner ONCE to keep a copy of their
 * Crow identity somewhere off this machine (security audit N1c-10, the
 * operator's ruling 2026-11-05).
 *
 * Why a nudge and not a backup: `npm run backup` keeps identity.json in the
 * LOCAL backup folder only (0600, never S3, never git), because the master seed
 * does not belong on someone else's disk unmasked. So a lost disk or a dead box
 * loses the identity — every bot key, contact and share derives from it — unless
 * the owner also made the passphrase-protected identity backup
 * (buildIdentityBackup: the onboarding done step's form, Settings → Help &
 * setup, or `npm run identity:export`). That is the copy they can take anywhere.
 *
 * Exactly once, ever, per instance:
 *   - nothing to say when there is no identity.json yet;
 *   - nothing to say when `identity_backup_exported_at` is already set (the
 *     owner made the encrypted backup — handleIdentityBackupPost sets it);
 *   - `identity_backup_nudged_at` is the fence: it is CLAIMED with an atomic
 *     INSERT … ON CONFLICT DO NOTHING before the notification is created, so two
 *     gateways booting against one database cannot both send, and a claim this
 *     call made is given back when the send fails — a failed nudge leaves the
 *     flag unset and the next boot tries again. Dismissing the notification
 *     changes nothing: the flag is already set, so it never repeats.
 *
 * Runs from boot/post-listen.js after the database is ready (skipped on a
 * --no-auth gateway, which is never the operator's dashboard). Never throws out
 * of the caller.
 */
import { existsSync } from "node:fs";
import { createDbClient } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";
import { identityFilePath } from "../../shared/backup-naming.js";
import { STEP_KEYS } from "../dashboard/panels/onboarding.js";
import { t } from "../dashboard/shared/i18n.js";

/** dashboard_settings keys. `exported` is written by the onboarding handler. */
export const NUDGED_SETTING = "identity_backup_nudged_at";
export const EXPORTED_SETTING = "identity_backup_exported_at";

/** The notification's source (and the group key, should it ever be grouped). */
export const NUDGE_SOURCE = "identity-backup";

/** i18n keys for the nudge's two sentences (en + es live in dashboard/shared/i18n.js). */
export const NUDGE_TITLE_KEY = "notif.identityBackup.title";
export const NUDGE_BODY_KEY = "notif.identityBackup.body";

/** The onboarding done step's identity-backup form — where the nudge sends the owner. */
export function identityBackupActionUrl() {
  return `/dashboard/onboarding?step=${STEP_KEYS.indexOf("done")}`;
}

/** This instance's identity.json (the file servers/sharing/identity.js reads). */
export function identityBackupTarget(env = process.env) {
  return identityFilePath({ env });
}

async function readSetting(db, key) {
  const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
  return rows[0]?.value ?? null;
}

/** The dashboard language, read straight from dashboard_settings (no scope dance). */
async function readLanguage(db) {
  try {
    return (await readSetting(db, "language")) || "en";
  } catch {
    return "en";
  }
}

/**
 * Decide whether to nudge, claim the flag and send. Exported for tests.
 * @param {object} o
 * @param {object} o.db              libsql-shaped client
 * @param {Function} [o.notify]      createNotification-shaped seam
 * @param {Function} [o.identityExists] () => boolean seam
 * @param {string|null} [o.lang]     force a language (else dashboard_settings)
 * @param {Function} [o.now]         () => Date, for the recorded timestamp
 * @param {object} [o.log]           console-shaped logger
 * @returns {Promise<{sent:boolean, reason:string}>}
 */
export async function nudgeIdentityBackup({
  db,
  notify = createNotification,
  identityExists = () => existsSync(identityBackupTarget()),
  lang = null,
  now = () => new Date(),
  log = console,
}) {
  let there = false;
  try { there = Boolean(identityExists()); } catch { there = false; }
  if (!there) return { sent: false, reason: "no-identity" };

  let exported = null;
  let nudged = null;
  try {
    exported = await readSetting(db, EXPORTED_SETTING);
    if (exported) return { sent: false, reason: "exported" };
    nudged = await readSetting(db, NUDGED_SETTING);
  } catch (err) {
    log.warn(`[identity-backup] could not read the nudge flags: ${err?.message ?? err}`);
    return { sent: false, reason: "error" };
  }
  if (nudged) return { sent: false, reason: "already" };

  const at = now();
  const stamp = (at instanceof Date ? at : new Date(at)).toISOString();

  // Claim the one nudge atomically, BEFORE sending: a second boot (or a second
  // gateway on this database) cannot claim it again. A createNotification that
  // filtered the row out (the owner switched the "system" type off) still
  // counts as delivered: the flag is what keeps this from turning into a nag on
  // every boot, and overriding the owner's own preference would be worse.
  try {
    const res = await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING",
      args: [NUDGED_SETTING, stamp],
    });
    if (Number(res?.rowsAffected ?? 0) < 1) return { sent: false, reason: "already" };
  } catch (err) {
    // No flag recorded, so nothing was announced either: the next boot retries.
    log.warn(`[identity-backup] could not record the nudge: ${err?.message ?? err}`);
    return { sent: false, reason: "error" };
  }

  try {
    const language = lang ?? await readLanguage(db);
    await notify(db, {
      title: t(NUDGE_TITLE_KEY, language),
      body: t(NUDGE_BODY_KEY, language),
      type: "system",
      source: NUDGE_SOURCE,
      priority: "normal",
      action_url: identityBackupActionUrl(),
      metadata: { kind: "identity-backup" },
    });
    return { sent: true, reason: "sent" };
  } catch (err) {
    // Give the claim back: the owner was never told, so the flag must stay
    // unset for the next boot (the ruling: a failed create leaves it unset).
    try {
      await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [NUDGED_SETTING] });
    } catch { /* the send failed and so did the rollback — the row is harmless */ }
    log.warn(`[identity-backup] nudge could not be sent: ${err?.message ?? err}`);
    return { sent: false, reason: "error" };
  }
}

/**
 * The boot entry point: own database client, opened and closed here, and never
 * a throw into the caller.
 * @param {{dbFactory?:Function, log?:object}} [o]
 * @returns {Promise<{sent:boolean, reason:string}>}
 */
export async function runIdentityBackupNudge({ dbFactory = createDbClient, log = console, ...rest } = {}) {
  let db = null;
  try {
    db = dbFactory();
    const result = await nudgeIdentityBackup({ db, log, ...rest });
    if (result.sent) log.log("[identity-backup] asked the owner once to keep a copy of the identity off this machine");
    return result;
  } catch (err) {
    log.warn(`[identity-backup] nudge skipped: ${err?.message ?? err}`);
    return { sent: false, reason: "error" };
  } finally {
    try { db?.close?.(); } catch { /* already closed */ }
  }
}