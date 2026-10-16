// Crow Artifacts — the Design kit seam (spec §4.1–§4.4). The kit is used only
// when it is INSTALLED on this instance; everything degrades to "no kit".
// The kit module is imported from the installed copy, keyed by its manifest's
// mtime so an upgrade is picked up without a restart.
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appImport } from "./app-root.js";

export function createDesign({ crowHome, db = null, renderUrl = process.env.CROW_DESIGN_RENDER_URL || null, importKit = (p, key) => import(pathToFileURL(p).href + "?v=" + encodeURIComponent(key)) } = {}) {
  let cache = null;
  async function kit() {
    const { installedKitDir } = await appImport("servers/shared/design-kit.js");
    const dir = installedKitDir(crowHome);
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
  async function houseStyleFor(_botId) { return null; }   // Task 14
  return { kit, houseStyleFor };
}
