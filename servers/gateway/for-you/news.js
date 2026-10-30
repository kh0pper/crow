/**
 * For You's "Your news" (For You v1). The stories come from Media Hub, never from its tables:
 * this imports the INSTALLED bundle's own server/for-you.js (forYouStories, hiddenSources) by its
 * path under CROW_HOME and runs it on the gateway's crow.db client, the way Make reaches the
 * Workspace bundle. The page's buttons call Media Hub's own HTTP API from the browser
 * (POST /api/media/articles/:id/action, POST /api/media/sources/:id/hidden).
 *
 *   loadNews(db, opts) -> { state: "missing" | "update" | "error" | "ok", stories, hidden }
 *   whyText(why, lang) -> the one-line "why it's here" for Media Hub's evidence
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { installedBundleIds } from "../skills-catalog.js";
import { t, fill } from "../dashboard/shared/i18n.js";

export const NEWS_MAX = 8;

let override = null;
/** Test seam: a stand-in for the bundle module ({ forYouStories, hiddenSources, ... }); null restores. Listen uses it too. */
export function _setNewsModuleForTest(mod) { override = mod || null; }

/** The installed Media Hub's for-you module, or null when its copy predates it. */
export async function mediaModule(crowHome) {
  if (override) return override;
  const file = join(crowHome, "bundles", "media", "server", "for-you.js");
  if (!existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

/** True when Media Hub is installed (or a test stands in for it). */
export function mediaInstalled(crowHome) {
  return !!override || installedBundleIds(crowHome).includes("media");
}

export async function loadNews(db, { crowHome = resolveCrowHome(), limit = NEWS_MAX, now = Date.now() } = {}) {
  if (!mediaInstalled(crowHome)) return { state: "missing", stories: [], hidden: [] };
  let mod;
  try { mod = await mediaModule(crowHome); } catch (err) {
    console.warn("[for-you] Media Hub module failed to load:", err && err.message);
    return { state: "error", stories: [], hidden: [] };
  }
  if (!mod || typeof mod.forYouStories !== "function") return { state: "update", stories: [], hidden: [] };
  try {
    const stories = await mod.forYouStories(db, { limit, now });
    const hidden = typeof mod.hiddenSources === "function" ? await mod.hiddenSources(db) : [];
    return { state: "ok", stories: Array.isArray(stories) ? stories : [], hidden: Array.isArray(hidden) ? hidden : [] };
  } catch (err) {
    console.warn("[for-you] Media Hub picks failed:", err && err.message);
    return { state: "error", stories: [], hidden: [] };
  }
}

/**
 * Media Hub's evidence -> words. Only what the evidence says: a topic, source or category the
 * interest profile shows you react well to (an affinity built from your reactions, not a follow),
 * or new from a source you follow (every story's source is one you subscribed to).
 */
export function whyText(why, lang = "en") {
  const kind = why && typeof why === "object" ? why.kind : null;
  const label = why && why.label != null ? String(why.label).trim() : "";
  if ((kind === "topic" || kind === "source" || kind === "category") && label) return fill(t(`forYou.why.${kind}`, lang), { label });
  return t("forYou.why.new", lang);
}

/** "2h" / "3d" style age from a published time; "" when unknown or in the future. */
export function ageText(published, lang = "en", now = Date.now()) {
  const v = String(published || "");
  const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? v.replace(" ", "T") + "Z" : v);
  if (!Number.isFinite(at) || at > now + 5 * 60000) return "";
  const min = Math.max(0, Math.floor((now - at) / 60000));
  if (min < 60) return fill(t("forYou.ageMin", lang), { n: Math.max(1, min) });
  const h = Math.floor(min / 60);
  if (h < 48) return fill(t("forYou.ageHours", lang), { n: h });
  return fill(t("forYou.ageDays", lang), { n: Math.floor(h / 24) });
}
