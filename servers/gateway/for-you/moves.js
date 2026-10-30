/**
 * For You's "Move" card (For You v1): today's Ramble challenge, Done/Swap, and the bird's Health,
 * today's steps and the streak. Ramble's data comes from the INSTALLED bundle's own
 * server/for-you.js (forYouMoves), loaded the way news.js loads Media Hub and never from its
 * tables. Each failure hides only this section: `ramble: "missing"` (not installed), `"update"`
 * (an installed copy that predates the module), `"error"` (the read threw) — the page renders
 * nothing for all three.
 *
 *   loadMoves(db, { crowHome, now, weather, lang }) -> { ramble: "missing" | "update" | "error" | "ok", moves? }
 *
 * `weather` is the forecast the page already loaded for its chip ({ temp, code, rain, ... });
 * `moveWeather` narrows it to the picker's shape. `lang` is the page's language, so the why line
 * comes back in it. The bundle fetches nothing and reaches no gateway file — this loader is the
 * whole seam.
 *
 * The bundle's writes (today's card, the day's pause fact) go through the same emit hook Ramble's
 * own routes build: pass-through with the gateway's live manager, a durable queue without one, so
 * `ramble_settings`' last-writer-wins rows replicate from here exactly as they do from the panel.
 * A missing emit only means the write stays local; it can never fail the page.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { installedBundleIds } from "../skills-catalog.js";

let override = null;
/** Test seam: a stand-in for the bundle module ({ forYouMoves }); null restores. */
export function _setMovesModuleForTest(mod) { override = mod || null; }

/** The installed Ramble's for-you module, or null when its copy predates it. */
export async function rambleModule(crowHome) {
  if (override) return override;
  const file = join(crowHome, "bundles", "ramble", "server", "for-you.js");
  if (!existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

/** True when Ramble is installed (or a test stands in for it). */
export function rambleInstalled(crowHome) {
  if (override) return true;
  try { return installedBundleIds(crowHome).includes("ramble"); } catch { return false; }
}

/** The weather chip's numbers -> the picker's shape ({ rain, temp, code }), or null. */
export function moveWeather(w) {
  if (!w || typeof w !== "object") return null;
  const out = {};
  for (const key of ["rain", "temp", "code"]) {
    const n = Number(w[key]);
    if (w[key] != null && Number.isFinite(n)) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** The bundle's emit hook, the shape panel/routes.js builds; undefined when neither module loads. */
async function bundleEmit(db) {
  try {
    const [emitMod, managers] = await Promise.all([
      import("../../shared/sync-emit.js"),
      import("../../sharing/managers.js"),
    ]);
    let manager = null;
    try { manager = managers.getInstanceSyncManager(); } catch { manager = null; }
    return (table, op, row) => emitMod.emitOrQueue(manager, db, table, op, row).catch(() => {});
  } catch { return undefined; }
}

export async function loadMoves(db, {
  crowHome = resolveCrowHome(), now = Date.now(), weather = null, lang = "en",
} = {}) {
  if (!rambleInstalled(crowHome)) return { ramble: "missing" };
  let mod;
  try {
    mod = await rambleModule(crowHome);
  } catch (err) {
    console.warn("[for-you] Ramble module failed to load:", err && err.message);
    return { ramble: "error" };
  }
  if (!mod || typeof mod.forYouMoves !== "function") return { ramble: "update" };
  try {
    const moves = await mod.forYouMoves(db, {
      now, weather: moveWeather(weather), lang, emit: await bundleEmit(db),
    });
    return { ramble: "ok", moves: moves && typeof moves === "object" ? moves : null };
  } catch (err) {
    console.warn("[for-you] Ramble moves failed:", err && err.message);
    return { ramble: "error" };
  }
}