// Crow Artifacts — the Design kit seam (spec §4.1–§4.4). The kit is used only
// when it is INSTALLED on this instance; everything degrades to "no kit".
// The kit module is imported from the installed copy, keyed by its manifest's
// mtime so an upgrade is picked up without a restart.
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appImport } from "./app-root.js";

export function createDesign({ crowHome, db = null, renderUrl = process.env.CROW_DESIGN_RENDER_URL || null, importKit = (p, key) => import(pathToFileURL(p).href + "?v=" + encodeURIComponent(key)), importShared = () => appImport("servers/shared/design-kit.js") } = {}) {
  let cache = null;
  // The shared module failing to load degrades to "no kit" (and no house
  // style): saves without libs keep working instead of every save refusing.
  async function shared() {
    try { return await importShared(); } catch (e) {
      console.warn(`[artifacts] the Design kit helper could not be loaded (${(e && e.code) || "error"})`);
      return null;
    }
  }
  async function kit() {
    const mod = await shared();
    const dir = mod ? mod.installedKitDir(crowHome) : null;
    if (!dir) { cache = null; return null; }
    let key;
    try { key = String(statSync(join(dir, "lib", "manifest.json")).mtimeMs); } catch { return null; }
    if (cache && cache.dir === dir && cache.key === key) return cache.kit;
    try {
      const mod = await importKit(join(dir, "server", "kit.js"), key);
      cache = { dir, key, kit: mod.openKit(dir, renderUrl ? { renderUrl } : {}) };
      return cache.kit;
    } catch (e) {
      console.warn(`[artifacts] the Design kit could not be opened (${(e && e.code) || "error"})`);
      cache = null;
      return null;
    }
  }
  /** The bot's house style (project theme, else its default), or null: off
   *  unless set (D4), and only a theme the installed kit knows. */
  async function houseStyleFor(botId) {
    if (!db || !botId) return null;
    const k = await kit();
    if (!k) return null;
    const mod = await shared();
    if (!mod) return null;
    return mod.readHouseStyle(db, botId, { known: new Set(k.themes.keys()) });
  }
  return { kit, houseStyleFor };
}
