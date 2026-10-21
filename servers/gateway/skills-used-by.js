/**
 * Which bots use each skill (skills panel option C, PR 2; review I2).
 *
 * Computed through the pi spawn's own skillNamesFor (bot-world.mjs), never a
 * copy of its rules: explicit def.skills, plus the artifacts skill a grant
 * attaches (only when its file resolves), plus design-frontend with the Design
 * kit (and design-themes when the bot's default house style is one the kit
 * knows), each only when the user-dir file exists. A project's house style is
 * only known inside a spawn, so design-themes through a project theme is not
 * counted here.
 *
 * Auto-attached names come from the chat (pi) spawn only; voice and job runs
 * load def.skills as selected. Rows carry `auto: true` for those.
 *
 * The Skills panel imports this module lazily (it pulls bot-world.mjs in).
 */
import { skillNamesFor } from "../../scripts/pi-bots/bot-world.mjs";
import { installedKitDir, readKitThemes, botThemeOf, pickHouseStyle } from "../shared/design-kit.js";

/** pi_bot_defs rows, or [] when the table is missing / the query fails. */
export async function loadBotRows(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition FROM pi_bot_defs ORDER BY bot_id", args: [] });
    return rows || [];
  } catch { return []; }
}

/**
 * @returns {Map<string, Array<{botId, name, paused: boolean, auto: boolean}>>} skill name → bots
 */
export function skillUsage({ crowHome, botRows, kitInstalled = !!installedKitDir(crowHome), knownThemes = null }) {
  const known = knownThemes || new Set(kitInstalled ? readKitThemes(crowHome).keys() : []);
  const usage = new Map();
  for (const row of botRows || []) {
    let def;
    try { def = typeof row.definition === "string" ? JSON.parse(row.definition) : row.definition; } catch { continue; }
    if (!def || typeof def !== "object") continue;
    const themeId = pickHouseStyle({ botTheme: botThemeOf(def), known });
    let names;
    try { names = skillNamesFor(def, { crowHome, kitInstalled, houseStyle: themeId ? { id: themeId } : null }); } catch { continue; }
    const explicit = new Set(Array.isArray(def.skills) ? def.skills : []);
    for (const n of new Set(names)) {
      if (typeof n !== "string") continue;
      if (!usage.has(n)) usage.set(n, []);
      usage.get(n).push({ botId: row.bot_id, name: row.display_name || row.bot_id, paused: Number(row.enabled) === 0, auto: !explicit.has(n) });
    }
  }
  return usage;
}
