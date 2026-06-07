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
