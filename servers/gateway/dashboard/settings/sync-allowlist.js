/**
 * Sync Allowlist — canonical set of dashboard_settings keys that replicate
 * across paired Crow instances.
 *
 * Only rows whose `key` matches an allowlist entry AND whose `instance_id IS NULL`
 * (i.e. the "global" scope) are broadcast by InstanceSyncManager. Anything else
 * stays local. This is the security trade-off the operator chose — a curated,
 * explicit list rather than blanket replication.
 *
 * Entries may end with "*" to match a prefix.
 */

export const SYNC_ALLOWLIST = {
  ai_profiles:               "AI conversation profiles",
  tts_profiles:              "Text-to-Speech voice profiles",
  stt_profiles:              "Speech-to-Text profiles",
  vision_profiles:           "Vision-language model profiles (image understanding + OCR)",
  "integration_*":           "External-service integration enablement",
  "companion_*":             "Companion persona / household config (sync-safe subset)",
  nav_groups:                "Sidebar group layout",
  nav_panel_assignments:     "Panel-to-group assignments",
  "storage.shared.*":        "Shared MinIO / S3 object-store config (secrets sealed via secret-box)",
  unified_dashboard_enabled: "Unified multi-instance dashboard opt-in",
  // Cluster B (F-SETTINGS-1/F-CONTACT-5): own-profile identity is user-level
  // data — it follows the user across instances like contacts/groups do.
  // SECURITY NOTE: the sync-apply path (_applyDashboardSetting) writes peer
  // values RAW. The defense is (a) every dashboard render of profile values is
  // escapeHtml'd and (b) both handshake readers re-sanitize via
  // sanitizeDisplayName at READ time. Any future reader of profile_* must
  // follow the same rule.
  profile_display_name:      "Own profile — display name (sent in pairing handshakes)",
  profile_avatar_url:        "Own profile — avatar URL",
  profile_bio:               "Own profile — bio",
  // companion_wm_federation removed — the kiosk button's federation is
  // driven by real-time overview availability now, not a separate opt-in
  // flag. Rollback to local-only kiosk is CROW_UNIFIED_DASHBOARD=0.
};

/**
 * Check whether a settings key may be written as a global (synced) row.
 * Non-allowlisted keys can still be stored — but only as local-scoped.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSyncable(key) {
  if (!key) return false;
  for (const pattern of Object.keys(SYNC_ALLOWLIST)) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (key.startsWith(prefix)) return true;
    } else if (pattern === key) {
      return true;
    }
  }
  return false;
}

/**
 * List allowlist entries (for docs / settings UI).
 */
export function listSyncableKeys() {
  return Object.entries(SYNC_ALLOWLIST).map(([pattern, description]) => ({ pattern, description }));
}

/**
 * Advisory drift check. Verifies that every settings section's declared
 * `syncKeys` is actually covered by SYNC_ALLOWLIST. The allowlist stays the
 * single ENFORCEMENT source of truth — `writeSetting` consults `isSyncable`,
 * not this function. This only catches the "a section declares a synced key
 * but nobody added it to the allowlist" class of bug, logging it once at
 * boot so the operator notices a key that silently won't replicate. Never
 * throws; returns the drift list for tests.
 *
 * @param {Array<{id?:string, syncKeys?:string[]}>} sections
 * @returns {Array<{section:string, key:string}>}
 */
export function checkSyncKeyDrift(sections) {
  const drift = [];
  for (const s of sections || []) {
    const keys = Array.isArray(s?.syncKeys) ? s.syncKeys : [];
    for (const key of keys) {
      if (!isSyncable(key)) drift.push({ section: s?.id || "(unknown)", key });
    }
  }
  if (drift.length) {
    const lines = drift.map((d) => `  - ${d.section}: "${d.key}"`).join("\n");
    console.warn(
      "[settings] sync-allowlist drift — section(s) declare syncKeys absent from " +
        "SYNC_ALLOWLIST; these keys will NOT replicate to paired instances:\n" +
        lines,
    );
  }
  return drift;
}

/**
 * The three own-profile keys (explicit list, deliberately NOT a "profile_*"
 * allowlist prefix — a future profile_ key must be consciously added).
 * Consumed by the save-path override clear, the one-shot heal, and the
 * re-emit empty-value guard.
 */
export const PROFILE_SYNC_KEYS = ["profile_display_name", "profile_avatar_url", "profile_bio"];
