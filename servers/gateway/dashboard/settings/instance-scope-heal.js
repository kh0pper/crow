/**
 * instance-scope-heal.js — settings-scope coherence D2: one-shot heal for
 * values stranded in dashboard_settings_overrides by the broken-era
 * upsertSetting downgrade (the F-SETTINGS-1 §6 bug class).
 *
 * For every override row of THIS instance whose key isInstanceScope:
 *   - no global row            → promote to global, delete override
 *   - global row exists        → NEWEST updated_at wins (both tables' writers
 *     use datetime('now') on one host/clock — unlike Cluster B's cross-
 *     instance case, a timestamp compare is safe here). NULL precedence:
 *     global ts NULL/empty → override wins; else override ts NULL/empty →
 *     global wins; else lexicographic (>= : tie → override, the broken-era
 *     UI write being healed). The override row is deleted EITHER WAY —
 *     post-D1, overrides for instance-scope keys are meaningless and would
 *     keep shadowing readSetting-based readers (blog_theme_* chrome).
 *   - promote strictly BEFORE delete (a crash between re-runs idempotently).
 *
 * Flag __instance_scope_heal_v1 is RAW SQL into dashboard_settings (an
 * upsertSetting'd flag key would be misfiled by the very routing this PR
 * adds). FAILURE-TRACKED: one key's error skips that key, and the flag stays
 * UNWRITTEN so the next boot retries — a DELIBERATE divergence from
 * profile-heal.js, which writes its flag unconditionally and never retries.
 * Do not "simplify" back to that shape (mutation-tested).
 *
 * Deliberately UNGATED (contrast profile-heal's feedsDisabled gate): this
 * heal has ZERO sync side effects (writeSetting does not emit instance-scope
 * keys), so any process sharing the data dir — primary, --no-auth companion —
 * reaches the identical result, and a null-syncManager boot still heals.
 */
import { writeSetting, deleteLocalSetting } from "./registry.js";
import { isInstanceScope } from "./sync-allowlist.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";

const FLAG_KEY = "__instance_scope_heal_v1";

function overrideWins(overrideTs, globalTs) {
  if (globalTs == null || String(globalTs).trim() === "") return true;
  if (overrideTs == null || String(overrideTs).trim() === "") return false;
  return String(overrideTs) >= String(globalTs);
}

export async function healInstanceScopeOverridesOnce(db) {
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
  let overrides;
  try {
    ({ rows: overrides } = await db.execute({
      sql: "SELECT key, value, updated_at FROM dashboard_settings_overrides WHERE instance_id = ?",
      args: [localId],
    }));
  } catch {
    return 0;
  }

  let promoted = 0;
  let hadFailure = false;
  for (const row of overrides) {
    if (!isInstanceScope(row.key)) continue;
    try {
      const g = await db.execute({
        sql: "SELECT value, updated_at FROM dashboard_settings WHERE key = ?",
        args: [row.key],
      });
      const globalRow = g.rows[0];
      if (!globalRow || overrideWins(row.updated_at, globalRow.updated_at)) {
        await writeSetting(db, row.key, row.value, { scope: "global" });
        promoted++;
      }
      await deleteLocalSetting(db, row.key);
    } catch (err) {
      hadFailure = true;
      console.warn(`[settings] instance-scope heal for ${row.key} failed: ${err.message}`);
    }
  }

  if (!hadFailure) {
    try {
      await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [FLAG_KEY, `done:${promoted}`],
      });
    } catch {}
  }

  if (promoted > 0) {
    console.log(`[settings] instance-scope heal: promoted ${promoted} stranded per-instance value(s) to the global scope`);
  }
  return promoted;
}
