/**
 * Notification "attention" type back-fill migration (Track 3, Task 8).
 *
 * A fresh install needs no back-fill: `createNotification`'s gate
 * (servers/shared/notifications.js) reads `dashboard_settings.notification_prefs`
 * and, when no row exists at all, allows every type through by default. But
 * an EXISTING install that already saved an explicit `types_enabled` array
 * (the four original types only — reminder/media/peer/system) would have
 * every new "attention" push silently dropped by that same gate forever,
 * with no error and no operator-visible signal. This migration appends
 * "attention" to any such array that lacks it.
 *
 * Idempotent two ways: the FLAG_KEY guard (same invocation shape as
 * theme-keys-migration.js) short-circuits every run after the first, and
 * the back-fill logic itself only ever appends when "attention" is absent
 * — so even a bypassed/replayed guard can never duplicate the entry.
 *
 * Invocation pattern matches theme-keys-migration.js: not self-registered,
 * dynamically imported and run once at boot from
 * `servers/gateway/boot/admin-api.js`, guarded by its own
 * `dashboard_settings` flag key (deliberately NOT in SYNC_ALLOWLIST — each
 * instance runs its own pass, same rationale as the theme-keys migration's
 * flag). `notification_prefs` itself is an INSTANCE_SCOPE_KEYS entry (per
 * install, not synced) — writeSetting routes it to the global
 * `dashboard_settings` table directly, matching where every other
 * notification_prefs reader (the gate, the settings section, the MCP tool)
 * already looks.
 */

import { readSetting, upsertSetting } from "../registry.js";

const FLAG_KEY = "notification_attention_backfill_v1_done";

/**
 * Entry point. Idempotent. Returns a summary for logging.
 */
export async function backfillAttentionNotificationType(db) {
  if (await readSetting(db, FLAG_KEY)) {
    return { skipped: "already_migrated" };
  }

  let appended = false;

  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
    args: [],
  });
  if (rows.length > 0) {
    let prefs;
    try {
      prefs = JSON.parse(rows[0].value);
    } catch {
      prefs = null;
    }
    if (prefs && Array.isArray(prefs.types_enabled) && !prefs.types_enabled.includes("attention")) {
      prefs.types_enabled = [...prefs.types_enabled, "attention"];
      await upsertSetting(db, "notification_prefs", JSON.stringify(prefs));
      appended = true;
    }
  }

  await upsertSetting(
    db,
    FLAG_KEY,
    JSON.stringify({ at: new Date().toISOString(), version: 1 }),
  );

  return { appended };
}
