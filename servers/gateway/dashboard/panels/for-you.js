/**
 * For You (v1, widgets phase 2): /dashboard/for-you, the operator's morning page beside the Crow
 * home. What needs me (widgets phase 1: the summary widgets/needs-me.js builds, answered in place
 * where the item offers it) sits above Your morning (Board facts, for-you/morning.js), Move (today's
 * Ramble challenge with Done and Swap, the bird's Health, steps and streak, for-you/moves.js, which
 * reads the installed bundle's own module), Listen (today's spoken briefing, podcasts and the Music
 * app, for-you/listen.js) and Your news (Media Hub's picks, for-you/news.js); a weather chip
 * (Open-Meteo, for-you/weather.js) stays in the header. Since widgets phase 2 those five are one
 * grid of widgets (widgets/registry.js, widgets/grid-html.js): the server draws them in that order,
 * and the device rearranges, resizes and removes them in Edit mode (widgets/grid-client.js), its
 * layout kept in localStorage and never synced. ?view=customize turns a section on or off (which now
 * decides whether the widget is offered at all) and sets the weather city.
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
import { loadNews } from "../../for-you/news.js";
import { loadNeedsMe } from "../../widgets/needs-me.js";
import { loadWidgets, widgetsForPage, WIDGET_TIMEOUT_MS } from "../../widgets/registry.js";
import { splitForPage } from "../../widgets/grid-html.js";
import { widgetsGridCss } from "../../widgets/grid-css.js";
import { widgetsMoreCss } from "../../widgets/more-html.js";
import { gridClientJs } from "../../widgets/grid-client.js";
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
 * The "What needs me" summary this page draws as its first widget (widgets/needs-me.js). Its own
 * reads degrade here: an unknown project list costs the project names, a missing or unreadable tasks
 * store costs the Board's rows, a malformed snooze setting reads as none. The registry's loader
 * still catches: a throw is this widget's own error line, and every other cell renders as usual.
 * Exported for the generic widget page (panels/widgets.js), whose first default card is this same
 * widget: it must be read here, not by a second copy of these reads.
 */
export async function loadNeedsMeForPage(db, { now, lang }) {
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

/**
 * One request's shared reads, handed to the widget registry's loads (widgets/registry.js). Each is
 * read at most once — the weather is both the header chip and the Move card's input, and the
 * project list feeds Your morning — and each keeps For You's own test seams. A read that fails is
 * that widget's own error line, never the page's: the caller's `loadWidgets` catches.
 * context here, so "What needs me", the weather and the project list are read exactly as For You
 * reads them, with the same seams and the same single-read caching.
 */
export function forYouContext(db, { settings, crowHome, now, tz, lang }) {
  let wx = null;
  const weatherOf = () => {
    if (!wx) {
      wx = settings.sections.weather && settings.place
        ? Promise.resolve()
          .then(() => weather(settings.place))
          .catch((err) => { console.warn(`[for-you] weather failed: ${err && err.message}`); return null; })
        : Promise.resolve(null);
    }
    return wx;
  };
  let projects = null;
  const projectsOf = () => {
    if (!projects) projects = Promise.resolve().then(() => listProjects(db));
    return projects;
  };
  let needs = null;
  const needsOf = () => {
    if (!needs) needs = Promise.resolve().then(() => needsMeForPage(db, { now, lang }));
    return needs;
  };
  return { db, now, tz, lang, crowHome, settings, weather: weatherOf, projects: projectsOf, needsMe: needsOf };
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
    const context = forYouContext(db, { settings, crowHome, now, tz, lang });
    // The header's chip is the same reading the weather widget would draw, so it is read once.
    // Bounded like every widget: a weather service that hangs costs the chip, never the page.
    let wxTimer;
    const wx = await Promise.race([
      Promise.resolve().then(() => context.weather()).catch(() => null),
      new Promise((resolve) => { wxTimer = setTimeout(() => resolve(null), WIDGET_TIMEOUT_MS); wxTimer.unref?.(); }),
    ]).finally(() => clearTimeout(wxTimer));
    // Each widget degrades alone: a failed read is its own one-line error cell, never the page's.
    // `crowHome` is where the installed add-ons' own widgets come from (widgets/addons.js).
    // Only the widgets this page's default layout holds are loaded with the page; the rest are drawn
    // as lazy cells and fetched by the device when it shows one (widgets/grid-html.js, grid-client.js).
    const offered = widgetsForPage("for-you", { settings, crowHome });
    const { eager, lazy } = splitForPage(offered, "for-you");
    const loaded = await loadWidgets(eager, context);
    const isLazy = new Set(lazy);
    const cells = offered.map((widget) => (isLazy.has(widget) ? { widget, lazy: true } : loaded.shift()));
    return layout({
      title: t("forYou.title", lang),
      content: forYouCss() + widgetsGridCss() + widgetsMoreCss()
        + forYouPageHtml({ settings, dateText: dateText(now, tz, lang), weather: wx, cells }, lang, now)
        + forYouClientJs() + gridClientJs(),
    });
  },
};
