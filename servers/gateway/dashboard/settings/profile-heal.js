/**
 * profile-heal.js — Cluster B D3: one-shot heal for F-SETTINGS-1's stranded
 * profile values.
 *
 * During the settings-scope era in which the profile keys were not
 * sync-allowlisted, every UI profile save was silently downgraded to a
 * dashboard_settings_overrides row that NO reader consults (all profile
 * readers are global-direct by design, D6). Users' typed values are stranded
 * there. This promotes them to the global scope once, so the name a user
 * saved into the "broken" UI comes back — and starts syncing — at upgrade,
 * with no re-save.
 *
 * Rules (spec §D3):
 *  - non-empty override → promote to global (writeSetting, which emits to
 *    peers when the sync manager is wired) THEN delete the override. Promote
 *    strictly BEFORE delete: reversed, a crash between the two loses the
 *    value forever (override gone, global never written, flag prevents retry).
 *    Promote-first re-runs are idempotent.
 *  - empty/whitespace override → delete only. Promoting "" could blank a
 *    peer's real pre-refactor global value fleet-wide.
 *  - flag row __profile_override_heal_v1 is RAW SQL into dashboard_settings
 *    (NOT upsertSetting — a non-allowlisted flag key would silently downgrade
 *    to an overrides row and never read back as done → heal re-runs forever).
 *  - feedsDisabled=true (a --no-auth companion sharing the primary's DB) is a
 *    FULL no-op — no promotion, no flag write — or the companion would mark
 *    the flag and the primary would skip its own heal (R2 MAJOR-A). Gate on
 *    feedsDisabled, NOT manager truthiness (the manager is constructed
 *    unconditionally) and NOT outFeeds.size (a peerless single-instance
 *    install still needs the local half of the heal).
 */
import { writeSetting, deleteLocalSetting } from "./registry.js";
import { PROFILE_SYNC_KEYS } from "./sync-allowlist.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";

const FLAG_KEY = "__profile_override_heal_v1";

export async function healProfileOverridesOnce(db, { feedsDisabled = false } = {}) {
  if (feedsDisabled) return 0;

  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?",
      args: [FLAG_KEY],
    });
    if (typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:")) return 0;
  } catch {
    return 0; // unreadable flag → do nothing rather than risk a re-run loop
  }

  const localId = getOrCreateLocalInstanceId();
  let promoted = 0;
  for (const key of PROFILE_SYNC_KEYS) {
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
        args: [key, localId],
      });
      if (rows.length === 0) continue;
      const value = rows[0].value;
      if (typeof value === "string" && value.trim() !== "") {
        await writeSetting(db, key, value, { scope: "global" });
        promoted++;
      }
      await deleteLocalSetting(db, key);
    } catch (err) {
      console.warn(`[settings] profile heal for ${key} failed: ${err.message}`);
    }
  }

  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [FLAG_KEY, `done:${promoted}`],
    });
  } catch {}

  if (promoted > 0) {
    console.log(`[settings] profile heal: promoted ${promoted} stranded profile value(s) to the global scope`);
  }
  return promoted;
}
