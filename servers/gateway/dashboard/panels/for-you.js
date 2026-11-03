/**
 * For You (v1): /dashboard/for-you, the operator's morning page beside the Crow home. What needs me
 * (widgets phase 1: the summary widgets/needs-me.js builds, answered in place where the item offers
 * it) sits above Your morning (Board facts, for-you/morning.js), Move (today's Ramble challenge with
 * Done and Swap, the bird's Health, steps and streak, for-you/moves.js, which reads the installed
 * bundle's own module), Listen (today's spoken briefing, podcasts and the Music app, for-you/listen.js),
 * Your news (Media Hub's picks, for-you/news.js) and a weather chip (Open-Meteo, for-you/weather.js);
 * ?view=customize turns sections on or off and sets the weather city.
 *
 * Gates, in this order, on every method:
 *   - CROW_FOR_YOU must be "1" (forYouEnabled), else 404;
 *   - the request must be the owner's own local password session (isLocalPasswordSessionOn), else
 *     404: a shared-project member's or a paired instance's SSO session never sees this page.
 * The GET only reads (Turbo prefetches it). POST is the customize form's save, behind the
 * dashboard's CSRF check (csrfMiddleware runs before every /dashboard route) and the gates above.
 *
 * Hidden from the classic sidebar; the shell's drawer, the mascot sheet and the phone drag reveal reach
 * it (shell/chrome.js, shell/client.js) only while the flag is on AND the request is the owner's own
 * local password session (the same check as the gate below, made once per page in dispatchPanel).
 */
import { t } from "../shared/i18n.js";
import { isLocalPasswordSessionOn } from "../local-session.js";
import { forYouEnabled } from "../../for-you/flag.js";
import { readForYouSettings, writeForYouSettings, normalizeSettings, CITY_MAX, SECTIONS } from "../../for-you/settings.js";
import { geocodeCity, weatherFor } from "../../for-you/weather.js";
import { loadMorning } from "../../for-you/morning.js";
import { loadNews } from "../../for-you/news.js";
import { loadListen } from "../../for-you/listen.js";
import { loadMoves } from "../../for-you/moves.js";
import { loadNeedsMe } from "../../widgets/needs-me.js";
import { WIDGETS_SNOOZED_KEY } from "../../routes/widgets.js";
import { readSetting } from "../settings/registry.js";
import { existsSync } from "node:fs";
import { createDbClient } from "../../../db.js";
import { tasksDbPath } from "../../../../scripts/pi-bots/instance-paths.mjs";
import { instanceZone } from "../../../shared/schedule-store.js";
import { activeProjects } from "../../../shared/shell-items.js";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { installedBundleIds } from "../../skills-catalog.js";
import { forYouPageHtml, customizeHtml } from "./for-you/html.js";
import { forYouCss } from "./for-you/css.js";
import { forYouClientJs } from "./for-you/client.js";

const FLASHES = new Set(["saved", "notfound", "failed"]);

/** Test seams: the geocoder, the weather fetch, the project list and the "What needs me" read. null restores each. */
let geocode = geocodeCity;
let weather = weatherFor;
let listProjects = activeProjects;
let needsMeForPage = loadNeedsMeForPage;
export function _setForYouSeamsForTest({ geocode: g, weather: w, projects: p, needsMe: n } = {}) {
  geocode = g || geocodeCity; weather = w || weatherFor; listProjects = p || activeProjects;
  needsMeForPage = n || loadNeedsMeForPage;
}

/**
 * The "What needs me" summary this page draws above Your morning (widgets/needs-me.js). Its own reads
 * degrade here: an unknown project list costs the project names, a missing or unreadable tasks store
 * costs the Board's rows, a malformed snooze setting reads as none. The caller still catches: a
 * throw is one line where the widget goes, and every other section renders as usual.
 */
async function loadNeedsMeForPage(db, { now, lang }) {
  let projects = [];
  try { projects = await listProjects(db); }
  catch (err) { console.warn(`[for-you] needs-me projects failed: ${err && err.message}`); }
  let snoozed = {};
  try {
    const raw = JSON.parse((await readSetting(db, WIDGETS_SNOOZED_KEY)) || "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, until] of Object.entries(raw)) {
        const ms = Number(until);
        if (Number.isFinite(ms)) snoozed[key] = ms;
      }
    }
  } catch { snoozed = {}; }
  const path = tasksDbPath();
  let tdb = null;
  try { if (path && existsSync(path)) tdb = createDbClient(path); }
  catch (err) { console.warn(`[for-you] needs-me tasks store failed: ${err && err.message}`); tdb = null; }
  try {
    return await loadNeedsMe(db, tdb, { now, projects: Array.isArray(projects) ? projects : [], snoozed, lang, tasksDbPath: path });
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
}

/**
 * The customize form's save. Sections are the checked boxes; the city is trimmed text. A city that
 * changed (or has no place yet) is geocoded now, once, so the page GET never has to; a city it
 * can't find, or a lookup that fails, is saved without a place (no chip) and the screen says so.
 * The geocoder gets the SAME string the setting stores (normalizeSettings: control characters
 * stripped, whitespace collapsed, cut to CITY_MAX), so "unchanged" really means unchanged and a
 * save that changed nothing never geocodes again.
 */
export async function saveForYouSettings(req, res, db, { lang = "en" } = {}) {
  const body = req.body || {};
  const cur = await readForYouSettings(db);
  const next = {
    sections: Object.fromEntries(SECTIONS.map((k) => [k, body[`section_${k}`] === "1"])),
    city: normalizeSettings({ city: String(body.city ?? "").slice(0, CITY_MAX * 2) }).city,
    place: null,
  };
  let flash = "saved";
  const city = next.city;
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
  hidden: true, // reached from the new shell's drawer, mascot sheet and phone drag reveal

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
    const [needsMe, morning, listen, news, wx] = await Promise.all([
      needsMeForPage(db, { now, lang }).catch(failed("needs me", null)),
      settings.sections.morning
        ? listProjects(db).then((projects) => loadMorning(db, { projects, tz, now })).catch(failed("morning", { error: true }))
        : null,
      settings.sections.listen ? loadListen(db, { crowHome, now }).catch(failed("listen", null)) : null,
      settings.sections.news ? loadNews(db, { crowHome, now }).catch(failed("news", { state: "error", stories: [], hidden: [] })) : null,
      settings.sections.weather && settings.place ? weather(settings.place).catch(failed("weather", null)) : null,
    ]);
    // Ramble's card weighs the weather the chip already loaded, so it reads after it (the picker
    // takes { rain, temp, code }); a missing or failing Ramble hides only this section. `lang` goes
    // along so the why line is written in the page's language.
    const moves = settings.sections.moves
      ? await loadMoves(db, { crowHome, now, weather: wx, lang }).catch(failed("moves", null))
      : null;
    return layout({
      title: t("forYou.title", lang),
      content: forYouCss() + forYouPageHtml({ settings, dateText: dateText(now, tz, lang), needsMe, morning, moves, listen, news, weather: wx }, lang, now) + forYouClientJs(),
    });
  },
};
