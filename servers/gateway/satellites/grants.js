/**
 * A bot's satellite-bundle grants (def.tools.crow_mcp entries "<bundle>/<tool>" or
 * "<bundle>__<tool>" whose bundle is satellite-hosted) and the "always ask before" entries for
 * those tools (def.permission_policy.confirm) may be changed only by the owner's own local
 * password session (spec §8, §9.2). Every other writer — a peer's SSO session saving in Bot
 * Builder, a signed peer patching a peer-managed bot — goes through keepSatelliteGrants, which
 * puts those entries back exactly as they were.
 *
 * And a bundle that becomes satellite-hosted starts with NO bot grants (§9.4, never
 * auto-granted): stripBotGrantsForBundle clears any entry naming it, so a grant planted while
 * the bundle was not on a satellite (or by anyone) can never switch on at install time.
 */
import { satelliteBundleIds } from "./installs.js";
import { splitEntry } from "../../../scripts/pi-bots/skill-tools.mjs";

const list = (v) => (Array.isArray(v) ? v : null);

/**
 * Restore `def`'s satellite parts to `origDef`'s. Returns true when it changed anything.
 * Fails CLOSED: when the satellite bundle set cannot be read, the whole crow_mcp and confirm
 * lists go back to their stored values (the save's other changes still land).
 */
export function keepSatelliteGrants(def, origDef, { bundleIds = null, readIds = satelliteBundleIds } = {}) {
  let sat = null;
  try { sat = bundleIds || readIds(); } catch { sat = null; }
  const origMcp = list(origDef?.tools?.crow_mcp) || [];
  const origConfirm = list(origDef?.permission_policy?.confirm);
  if (sat == null) {
    const before = JSON.stringify([list(def?.tools?.crow_mcp), list(def?.permission_policy?.confirm)]);
    def.tools = def.tools || {};
    def.tools.crow_mcp = [...origMcp];
    if (origConfirm) { def.permission_policy = def.permission_policy || {}; def.permission_policy.confirm = [...origConfirm]; }
    else if (def.permission_policy) delete def.permission_policy.confirm;
    return before !== JSON.stringify([list(def.tools.crow_mcp), list(def.permission_policy?.confirm)]);
  }
  if (!sat.size) return false;
  // Both spellings that grant ("<bundle>/<tool>" and "<bundle>__<tool>"), as the mount reads them.
  const isSat = (k) => { const e = splitEntry(k); return !!e && sat.has(e[0]); };
  let changed = false;
  const restore = (cur, orig) => {
    const before = (orig || []).filter(isSat);
    const now = (cur || []).filter(isSat);
    if (JSON.stringify([...now].sort()) !== JSON.stringify([...before].sort())) changed = true;
    return [...(cur || []).filter((k) => !isSat(k)), ...before];
  };
  const cur = list(def?.tools?.crow_mcp);
  if (cur || origMcp.some(isSat)) { def.tools = def.tools || {}; def.tools.crow_mcp = restore(cur, origMcp); }
  const curConfirm = list(def?.permission_policy?.confirm);
  if (curConfirm || (origConfirm || []).some(isSat)) {
    def.permission_policy = def.permission_policy || {};
    def.permission_policy.confirm = restore(curConfirm, origConfirm);
  }
  return changed;
}

/**
 * Remove every bot's grants for `bundle` (both spellings) when it becomes satellite-hosted.
 * The "always ask before" entries stay (asking is never wider). Returns the bot ids changed.
 */
export async function stripBotGrantsForBundle(db, bundle, { log = () => {}, attempts = 3 } = {}) {
  const changed = [];
  const failed = [];
  const strip = (def) => {
    const mcp = list(def?.tools?.crow_mcp);
    if (!mcp) return false;
    const kept = mcp.filter((k) => { const e = splitEntry(k); return !(e && e[0] === bundle) && k !== bundle; });
    if (kept.length === mcp.length) return false;
    def.tools.crow_mcp = kept;
    return true;
  };
  let ids = [];
  try { ids = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs", args: [] })).rows.map((r) => String(r.bot_id)); }
  catch (err) { log(`[satellites] ${bundle}: could not read bot definitions to clear its grants (${err?.message || err}); check every bot in Bot Builder`); return { changed, failed: ["*"] }; }
  for (const botId of ids) {
    let done = false;
    // Compare-and-swap with a re-read on a miss: a concurrent edit never keeps a planted grant.
    for (let i = 0; i < attempts && !done; i++) {
      try {
        const row = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0];
        if (!row) { done = true; break; }
        let def;
        try { def = JSON.parse(row.definition || "{}") || {}; } catch { done = true; break; }
        if (!strip(def)) { done = true; break; }
        const r = await db.execute({ sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = ? AND definition = ?", args: [JSON.stringify(def), botId, row.definition] });
        if (Number(r?.rowsAffected ?? 0) > 0) { changed.push(botId); done = true; }
      } catch { /* retried */ }
    }
    if (!done) failed.push(botId);
  }
  if (changed.length) log(`[satellites] ${bundle} is satellite-hosted now: cleared its grants on ${changed.length} bot(s); grant them again in Bot Builder`);
  if (failed.length) log(`[satellites] ${bundle}: could not clear its grants on bot(s) ${failed.join(", ")}; check them in Bot Builder`);
  return { changed, failed };
}
