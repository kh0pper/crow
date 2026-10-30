/**
 * For You (v1): /dashboard/for-you, the operator's morning page beside the Crow home. Your morning
 * (Board facts, for-you/morning.js), Your news (Media Hub's picks, for-you/news.js) and a weather
 * chip (Open-Meteo, for-you/weather.js); ?view=customize turns sections on or off and sets the
 * weather city.
 *
 * Gates, in this order, on every method:
 *   - CROW_FOR_YOU must be "1" (forYouEnabled), else 404;
 *   - the request must be the owner's own local password session (isLocalPasswordSessionOn), else
 *     404: a shared-project member's or a paired instance's SSO session never sees this page.
 * The GET only reads (Turbo prefetches it). POST is the customize form's save, behind the
 * dashboard's CSRF check (csrfMiddleware runs before every /dashboard route) and the gates above.
 *
 * Hidden from the classic sidebar; the shell's drawer, the mascot sheet and the phone swipe reach
 * it (shell/chrome.js, shell/client.js) while the flag is on.
 */
import { t } from "../shared/i18n.js";
import { isLocalPasswordSessionOn } from "../local-session.js";
import { forYouEnabled } from "../../for-you/flag.js";
import { readForYouSettings, writeForYouSettings, CITY_MAX, SECTIONS } from "../../for-you/settings.js";
import { geocodeCity, weatherFor } from "../../for-you/weather.js";
import { loadMorning } from "../../for-you/morning.js";
import { loadNews } from "../../for-you/news.js";
import { instanceZone } from "../../../shared/schedule-store.js";
import { activeProjects } from "../../../shared/shell-items.js";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { installedBundleIds } from "../../skills-catalog.js";
import { forYouPageHtml, customizeHtml } from "./for-you/html.js";
import { forYouCss } from "./for-you/css.js";
import { forYouClientJs } from "./for-you/client.js";

const FLASHES = new Set(["saved", "notfound", "failed"]);

/** Test seams: the geocoder, the weather fetch and the project list. null restores each. */
let geocode = geocodeCity;
let weather = weatherFor;
let listProjects = activeProjects;
export function _setForYouSeamsForTest({ geocode: g, weather: w, projects: p } = {}) {
  geocode = g || geocodeCity; weather = w || weatherFor; listProjects = p || activeProjects;
}

/**
 * The customize form's save. Sections are the checked boxes; the city is trimmed text. A city that
 * changed (or has no place yet) is geocoded now, once, so the page GET never has to; a city it
 * can't find, or a lookup that fails, is saved without a place (no chip) and the screen says so.
 */
export async function saveForYouSettings(req, res, db, { lang = "en" } = {}) {
  const body = req.body || {};
  const cur = await readForYouSettings(db);
  const next = {
    sections: Object.fromEntries(SECTIONS.map((k) => [k, body[`section_${k}`] === "1"])),
    city: String(body.city ?? "").slice(0, CITY_MAX * 2),
    place: null,
  };
  let flash = "saved";
  const city = next.city.replace(/\s+/g, " ").trim();
  if (city && city === cur.city && cur.place) {
    next.place = cur.place;
  } else if (city) {
    try {
      next.place = await geocode(city, { lang });
      if (!next.place) flash = "notfound";
    } catch (err) {
      console.warn(`[for-you] geocoding failed: ${err && err.message}`);
      flash = "failed";
    }
  }
  await writeForYouSettings(db, next);
  return res.redirect(303, `/dashboard/for-you?view=customize&flash=${flash}`);
}

function dateText(now, tz, lang) {
  try {
    return new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(new Date(now));
  } catch {
    return new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date(now));
  }
}

export default {
  id: "for-you",
  name: "For You",
  icon: "sparkles",
  route: "/dashboard/for-you",
  navOrder: 15.7,
  category: "ai",
  hidden: true, // reached from the new shell's drawer, mascot sheet and phone swipe

  async handler(req, res, { db, layout, lang, enabled = forYouEnabled }) {
    if (!enabled() || !(await isLocalPasswordSessionOn(db, req))) {
      res.status(404).type("text").send("Not found");
      return null;
    }
    if (req.method === "POST") return saveForYouSettings(req, res, db, { lang });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).type("text").send("Not found");
      return null;
    }
    const settings = await readForYouSettings(db);
    const crowHome = resolveCrowHome();

    if (req.query.view === "customize") {
      const mediaInstalled = installedBundleIds(crowHome).includes("media");
      const hidden = mediaInstalled ? (await loadNews(db, { crowHome, limit: 0 })).hidden : [];
      const flash = FLASHES.has(req.query.flash) ? req.query.flash : null;
      return layout({
        title: t("forYou.customize", lang),
        content: forYouCss() + customizeHtml({ settings, hidden, mediaInstalled, flash, csrf: req.csrfToken }, lang) + forYouClientJs(),
      });
    }

    const now = Date.now();
    let tz;
    try { tz = await instanceZone(db); } catch { tz = undefined; }
    // Each section degrades alone: a failed read costs its section one line, never the page.
    const failed = (what, fallback) => (err) => { console.warn(`[for-you] ${what} failed: ${err && err.message}`); return fallback; };
    const [morning, news, wx] = await Promise.all([
      settings.sections.morning
        ? listProjects(db).then((projects) => loadMorning(db, { projects, tz, now })).catch(failed("morning", { error: true }))
        : null,
      settings.sections.news ? loadNews(db, { crowHome, now }).catch(failed("news", { state: "error", stories: [], hidden: [] })) : null,
      settings.sections.weather && settings.place ? weather(settings.place).catch(failed("weather", null)) : null,
    ]);
    return layout({
      title: t("forYou.title", lang),
      content: forYouCss() + forYouPageHtml({ settings, dateText: dateText(now, tz, lang), morning, news, weather: wx }, lang, now) + forYouClientJs(),
    });
  },
};
