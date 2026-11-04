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
export async function stripBotGrantsForBundle(db, bundle, { log = () => {} } = {}) {
  const changed = [];
  let rows = [];
  try { rows = (await db.execute({ sql: "SELECT bot_id, definition FROM pi_bot_defs", args: [] })).rows; } catch { return changed; }
  for (const row of rows) {
    let def;
    try { def = JSON.parse(row.definition || "{}") || {}; } catch { continue; }
    const mcp = list(def?.tools?.crow_mcp);
    if (!mcp) continue;
    const kept = mcp.filter((k) => { const e = splitEntry(k); return !(e && e[0] === bundle) && k !== bundle; });
    if (kept.length === mcp.length) continue;
    def.tools.crow_mcp = kept;
    const r = await db.execute({ sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = ? AND definition = ?", args: [JSON.stringify(def), row.bot_id, row.definition] });
    // Compare-and-swap: a concurrent edit makes this miss; never report it as cleared.
    if (Number(r?.rowsAffected ?? 0) > 0) changed.push(String(row.bot_id));
    else log(`[satellites] ${bundle}: bot ${row.bot_id} changed meanwhile; its grants for ${bundle} were not cleared — check it in Bot Builder`);
  }
  if (changed.length) log(`[satellites] ${bundle} is satellite-hosted now: cleared its grants on ${changed.length} bot(s); grant them again in Bot Builder`);
  return changed;
}
