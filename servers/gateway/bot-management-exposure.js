/**
 * F4a Layer 3 — owner-side gate for cross-instance bot edit/run.
 *
 * DEFAULT-DENY. A trusted peer may edit/enable one of this instance's bots ONLY
 * if BOTH hold: (1) feature_flags.remote_bot_management is true (master switch),
 * AND (2) the bot_id is in remote_managed_bots (per-bot opt-in). Mirrors the
 * L2a exposure model (peer-exposure.js). Both settings are local-only and
 * deliberately absent from sync-allowlist.js. This gate is the security
 * keystone — it is enforced server-side on every federation endpoint,
 * independent of any UI affordance.
 */
import { readSetting } from "./dashboard/settings/registry.js";

/** feature_flags key (boolean master switch). */
export const REMOTE_BOT_MGMT_FLAG = "remote_bot_management";
/** Local-only (never-synced) per-bot opt-in list key. */
export const MANAGED_BOTS_SETTING_KEY = "remote_managed_bots";

/** Pure: parse the stored JSON array → Set<bot_id>. Never throws. */
export function parseManagedBots(raw) {
  if (raw == null) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((x) => typeof x === "string" && x.length > 0));
}

/** Master switch. Absent/malformed → false (deny). Never throws. */
export async function remoteBotManagementEnabled(db) {
  try {
    const raw = await readSetting(db, "feature_flags");
    if (!raw) return false;
    return (JSON.parse(raw) || {})[REMOTE_BOT_MGMT_FLAG] === true;
  } catch { return false; }
}

/**
 * The set of bot_ids exposed to trusted peers. Empty unless the master switch
 * is on (default-deny). Never throws.
 */
export async function getPeerManagedBots(db) {
  if (!(await remoteBotManagementEnabled(db))) return new Set();
  let raw;
  try { raw = await readSetting(db, MANAGED_BOTS_SETTING_KEY); } catch { return new Set(); }
  return parseManagedBots(raw);
}

/** Authoritative per-call check. */
export async function botPeerManageable(db, botId) {
  if (typeof botId !== "string" || !botId) return false;
  return (await getPeerManagedBots(db)).has(botId);
}
