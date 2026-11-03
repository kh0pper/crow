/**
 * "Today + Ramble" (widgets phase 2, Task 3): the second card of the generic /dashboard/widgets page.
 *
 * Three lines, each read on its own and each optional:
 *
 *   calendar  the next event in the Workspace bundle's CalDAV (bundles/workspace/server/pim/caldav.js
 *             queryEvents), shown only while Workspace is installed AND answers within
 *             CALENDAR_TIMEOUT_MS. The module is imported from the INSTALLED copy at call time, inside
 *             try/catch: a bundle that is absent, half-installed, out of dependencies or not set up
 *             (getConfig throws not_ready) costs the line and nothing else;
 *   move      today's Ramble challenge, through the SAME loader For You's Move card uses
 *             (for-you/moves.js loadMoves) — no second opinion about what today's move is;
 *   ramble    the bird's mood and today's steps, read SERVER-SIDE from the state Ramble's own
 *             /api/ramble/pet and /api/ramble/steps routes read (pet.js petState, steps.js
 *             stepsState). No HTTP self-call: the gateway already holds the db those two functions take.
 *
 * If none of them answers, the loader still SUCCEEDS: it returns `{ calendar: null, move: null,
 * ramble: null }` and todayHtml draws nothing, so the grid leaves the cell out altogether — the same
 * rule every other widget follows (nothing to show, no empty card), and no error line either: a card
 * whose every line is optional is never "broken".
 *
 *   loadToday(db, { crowHome, now, tz, lang, weather }) -> { calendar, move, ramble }
 *
 * Tests replace the two bundle reads with `_setTodaySeamsForTest({ calendar, ramble })`; passing null
 * restores the real reads. A seam stands in for the whole bundle (install check included), exactly as
 * For You's moves seam does.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { installedBundleIds } from "../skills-catalog.js";
import { t } from "../dashboard/shared/i18n.js";
import { loadMoves, rambleInstalled } from "./moves.js";

/** How long Workspace's calendar may hold the card before the line is left out. */
export const CALENDAR_TIMEOUT_MS = 2000;

/** The window the next-up line looks through: now, and the day ahead. */
const DAY_MS = 24 * 60 * 60 * 1000;

let calendarSeam = null;
let rambleSeam = null;

/** Test seam: `{ calendar: async ({ now, tz }) => event|null, ramble: async ({ db, now }) => state|null }`. */
export function _setTodaySeamsForTest({ calendar, ramble } = {}) {
  calendarSeam = calendar || null;
  rambleSeam = ramble || null;
}

/** True when the Workspace bundle is installed (or a test stands in for its calendar). */
export function workspaceInstalled(crowHome) {
  if (calendarSeam) return true;
  try { return installedBundleIds(crowHome).includes("workspace"); } catch { return false; }
}

/** A module of an INSTALLED bundle, or null when the file is not there. */
async function bundleModule(crowHome, bundle, rel) {
  const file = join(crowHome, "bundles", bundle, "server", rel);
  if (!existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

/** The value, or null once `ms` has passed (a read that hangs costs its line, never the page). */
function within(work, ms) {
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    try { timer?.unref?.(); } catch { /* a test's timer need not support unref */ }
  });
  return Promise.race([Promise.resolve().then(work), budget]).finally(() => { if (timer) clearTimeout(timer); });
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The next event in the first calendar Crow bot can see, as
 * `{ summary, start, all_day }`, or null. Throws on anything unexpected (the caller omits the line).
 */
async function readNextEvent(crowHome, { now }) {
  const [caldav, config] = await Promise.all([
    bundleModule(crowHome, "workspace", "pim/caldav.js"),
    bundleModule(crowHome, "workspace", "config.js"),
  ]);
  if (!caldav || !config || typeof caldav.queryEvents !== "function" || typeof caldav.expandEvents !== "function") return null;
  const cfg = config.getConfig(); // throws not_ready until Workspace's setup has finished
  const calendars = await caldav.listCalendars(cfg);
  if (!Array.isArray(calendars) || !calendars.length) return null;
  const calendar = calendars[0];
  const from = new Date(now - 60 * 1000);
  const to = new Date(now + DAY_MS);
  const objects = await caldav.queryEvents(cfg, calendar, from, to);
  const events = [];
  for (const object of Array.isArray(objects) ? objects : []) {
    try {
      // A repeat may have its own exceptions; expandEvents picks the occurrence in the window.
      events.push(...caldav.expandEvents(object.text, from, to, true, { floatStart: from.getTime(), floatEnd: to.getTime() }).events);
    } catch { /* one unreadable object costs only itself */ }
  }
  // The earliest event still running or yet to start today (an all-day event counts until its end).
  let next = null;
  for (const event of events) {
    const at = Date.parse(event && event.start);
    if (!Number.isFinite(at)) continue;
    const end = Date.parse(event && event.end);
    // Finished already? then it is not next. A date-only (all-day) event has no clock time, so its
    // start is midnight and only its END can say whether it is over.
    if (Number.isFinite(end) ? end <= now : at < now) continue;
    if (next && at >= next.at) continue;
    const summary = String((event && event.summary) || "").trim();
    if (!summary) continue;
    next = { at, event: { summary, start: String(event.start), all_day: !!event.all_day } };
  }
  return next ? next.event : null;
}

async function calendarToday(crowHome, { now, tz, lang }) {
  try {
    if (!calendarSeam && !workspaceInstalled(crowHome)) return null;
    const read = calendarSeam ? () => calendarSeam({ now, tz }) : () => readNextEvent(crowHome, { now });
    return shapeEvent(await within(read, CALENDAR_TIMEOUT_MS), { now, tz, lang });
  } catch (err) {
    console.warn(`[today] calendar line omitted: ${err && err.message}`);
    return null;
  }
}

/**
 * The next-up line's two halves: the event's own summary, and when it is ("All day", "3:00 PM" today,
 * "Friday 3:00 PM" on another day) in the instance's zone. Formatting lives here, with the request's
 * zone and language, so the renderer has nothing left to do but escape both.
 */
function shapeEvent(event, { now, tz, lang }) {
  if (!event || typeof event !== "object") return null;
  const summary = String(event.summary || "").trim();
  if (!summary) return null;
  return { summary, when: eventWhen(event, lang, tz, now) };
}

/** "All day", today's time, or the weekday and time; "" when the start cannot be read. */
export function eventWhen(event, lang = "en", tz = undefined, now = Date.now()) {
  const at = Date.parse(event && event.start);
  if (!Number.isFinite(at)) return "";
  if (event.all_day) return t("widgets.today.allDay", lang);
  const locale = lang === "es" ? "es" : "en-US";
  const fmt = (opts) => {
    try { return new Intl.DateTimeFormat(locale, { ...opts, ...(tz ? { timeZone: tz } : {}) }); }
    catch { return new Intl.DateTimeFormat(locale, opts); }
  };
  const day = (ms) => fmt({ year: "numeric", month: "numeric", day: "numeric" }).format(new Date(ms));
  const time = fmt({ hour: "numeric", minute: "2-digit" }).format(new Date(at));
  return day(at) === day(now) ? time : `${fmt({ weekday: "long" }).format(new Date(at))} ${time}`;
}

async function moveToday(db, { crowHome, now, lang, weather }) {
  try {
    const loaded = await loadMoves(db, { crowHome, now, weather, lang });
    if (!loaded || loaded.ramble !== "ok" || !loaded.moves || loaded.moves.off) return null;
    const challenge = loaded.moves.challenge;
    if (!challenge || !challenge.title) return null;
    return { title: String(challenge.title), minutes: num(challenge.minutes), done: !!challenge.done };
  } catch (err) {
    console.warn(`[today] move line omitted: ${err && err.message}`);
    return null;
  }
}

async function rambleToday(db, { crowHome, now }) {
  try {
    if (!rambleSeam && (!db || !rambleInstalled(crowHome))) return null;
    if (rambleSeam) {
      const state = await rambleSeam({ db, now });
      return state || null;
    }
    const [pet, steps] = await Promise.all([
      bundleModule(crowHome, "ramble", "pet.js"),
      bundleModule(crowHome, "ramble", "steps.js"),
    ]);
    if (!pet || !steps || typeof pet.petState !== "function" || typeof steps.stepsState !== "function") return null;
    // The state the two routes READ — petState and stepsState — and not their side effects: the steps
    // route also calls touchHome (a write), which a page GET has no business doing. petState itself
    // does persist the bird's decay (the same idempotent UPDATE the pet route makes); that is the
    // Ramble state being brought up to now, not a new write of this widget's.
    const [petState, stepsState] = await Promise.all([
      pet.petState(db, { now }),
      steps.stepsState(db, { now }),
    ]);
    if (!petState && !stepsState) return null;
    return {
      mood: String((petState && petState.mood) || ""),
      energy: num(petState && petState.energy),
      max: num(petState && petState.energy_max),
      steps: { today: num(stepsState && stepsState.steps), goal: num(stepsState && stepsState.goal) },
    };
  } catch (err) {
    console.warn(`[today] Ramble lines omitted: ${err && err.message}`);
    return null;
  }
}

export async function loadToday(db, {
  crowHome = resolveCrowHome(), now = Date.now(), tz, lang = "en", weather = null,
} = {}) {
  const [calendar, move, ramble] = await Promise.all([
    calendarToday(crowHome, { now, tz, lang }),
    moveToday(db, { crowHome, now, lang, weather }),
    rambleToday(db, { crowHome, now }),
  ]);
  // Never null: every line is optional, so "nothing came back" is an EMPTY card (the grid then draws
  // no cell), not a failure (which would be an error cell).
  return { calendar: calendar || null, move: move || null, ramble: ramble || null };
}