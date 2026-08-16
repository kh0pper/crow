/**
 * Theme-keys retirement migration (Track 2 visual language, Task 5, spec §3.4).
 *
 * Glass retires product-wide, not just the dashboard's own theme state (that
 * was Task 4). This migration deletes the four keys glass/dashboard-override
 * leaves behind:
 *
 *   - blog_theme_glass           — the glass aesthetic toggle
 *   - blog_theme_dashboard_mode  — the dashboard color-mode override (dead
 *                                   now that the dashboard has no theme state)
 *   - dashboard_theme            — the pre-consolidation legacy key
 *   - blog_theme                 — the pre-consolidation legacy key (superseded
 *                                   by blog_theme_mode/blog_theme_serif)
 *
 * `blog_theme_mode`, `blog_theme_blog_mode`, and `blog_theme_serif` are NOT
 * touched — the frozen blog still reads all three.
 *
 * Deletes from BOTH `dashboard_settings` (global) and
 * `dashboard_settings_overrides` (every instance_id — not just this
 * install's) so a stray override on another paired instance can't keep a
 * retired key alive after this instance's migration runs.
 *
 * Invocation pattern matches `llm-settings-migration.js`: not self-registered,
 * dynamically imported and run once at boot from
 * `servers/gateway/boot/admin-api.js`, guarded by its own
 * `dashboard_settings` flag key (deliberately NOT in SYNC_ALLOWLIST — each
 * instance runs its own pass, same rationale as the LLM migration's flag).
 */

import { readSetting, upsertSetting } from "../registry.js";

const FLAG_KEY = "theme_keys_migration_v1_done";

const RETIRED_KEYS = [
  "blog_theme_glass",
  "blog_theme_dashboard_mode",
  "dashboard_theme",
  "blog_theme",
];

/**
 * Entry point. Idempotent. Returns a summary for logging.
 */
export async function migrateThemeKeys(db) {
  if (await readSetting(db, FLAG_KEY)) {
    return { skipped: "already_migrated" };
  }

  const placeholders = RETIRED_KEYS.map(() => "?").join(",");

  const globalResult = await db.execute({
    sql: `DELETE FROM dashboard_settings WHERE key IN (${placeholders})`,
    args: RETIRED_KEYS,
  });

  const overridesResult = await db.execute({
    sql: `DELETE FROM dashboard_settings_overrides WHERE key IN (${placeholders})`,
    args: RETIRED_KEYS,
  });

  await upsertSetting(
    db,
    FLAG_KEY,
    JSON.stringify({ at: new Date().toISOString(), version: 1 }),
  );

  return {
    deleted_global: globalResult.rowsAffected ?? 0,
    deleted_overrides: overridesResult.rowsAffected ?? 0,
  };
}
