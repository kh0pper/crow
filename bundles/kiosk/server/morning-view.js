/**
 * The kiosk's "Your morning" window (For You spec §13): the weather, up to three news headlines
 * and today's move, and nothing else. It is household-safe by construction — the sections are read
 * through For You's own loaders (settings, weather, news, moves) and mapped onto the window's fixed
 * shape, so no Board card, project name, bot, mail, calendar or "needs you" line can reach a shared
 * display. for-you/morning.js (the private section) and for-you/listen.js are never imported.
 *
 *   loadMorningView({ db, lang, crowHome, now, importApp }) → the window's data, per the contract:
 *     { weather: null | { temp, high, low, unit: "F"|"C", sky: string|null },
 *       headlines: [ { title, source } ],            // 0..3, title ≤ 140 chars, source ≤ 40
 *       move: null | { title, minutes: number|null },
 *       updated_at: <ms epoch> }
 *
 *   createMorningSweep({ wm, hub, media, now, isSessionDisplay, enabled, load, log }) → sweep(id):
 *     the idle rule, the once-a-morning date per display, and the open itself (used by runtime.js).
 *   `sky` is the conditions in the display's language (weather.js weatherKind → STRINGS.wx_<kind>); the
 *   place name is never in the window.
 *
 * Every part degrades on its own: a section that is off in the For You settings, an add-on that is
 * not installed, or a read that failed gives null / [] and the rest of the window still fills. A
 * section that is off is null / [] for the same reason (the window never says why).
 *
 * Every string is plain text (no markup, no control characters): the page renders with textContent.
 */
import { appImport } from "./app-root.js";
import { STRINGS } from "./strings.js";
import { result } from "./executor.js";

/** The window opens itself, on an idle kiosk, in this local hour range: hour ≥ start and < end. */
export const MORNING_HOURS = Object.freeze({ start: 6, end: 11 });
/** How many of the news loader's stories the window carries. */
export const MORNING_HEADLINES = 3;
/** The contract's length limits (plain characters). */
export const HEADLINE_MAX = 140;
export const SOURCE_MAX = 40;
/** The weather kinds the window knows (weather.js weatherKind's own names). */
export const SKY_KINDS = Object.freeze(["clear", "partly", "cloudy", "fog", "drizzle", "rain", "snow", "storm"]);
/** The For You modules this window reads, through the app root (a bundle cannot import core by repo path). */
export const MORNING_MODULES = Object.freeze({
  settings: "servers/gateway/for-you/settings.js",
  weather: "servers/gateway/for-you/weather.js",
  news: "servers/gateway/for-you/news.js",
  moves: "servers/gateway/for-you/moves.js",
});

// C0/C1 controls, the line and paragraph separators, a BOM and the invisible joiners: a window string is one line.
const TEXT_JUNK = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff]+/g;
/** A value as one plain, bounded line of text ("" when there is nothing). */
const plain = (v, max) => String(v ?? "").replace(TEXT_JUNK, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** A number as an integer, or null (never NaN, never a string). */
const int = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

/**
 * The weather chip's numbers (weather.js parseForecast) → the contract's weather, or null when there
 * is nothing to show. `sky` is the code's conditions in the display's language (never the place, and
 * never the module's own words); `unit` is the module's "fahrenheit"/"celsius" as "F"/"C".
 */
function weatherView(w, S, kindOf) {
  if (!w || typeof w !== "object") return null;
  const temp = int(w.temp), high = int(w.high), low = int(w.low);
  if (temp === null && high === null && low === null) return null;
  const kind = typeof kindOf === "function" ? kindOf(w.code) : null;
  const sky = SKY_KINDS.includes(kind) ? S?.[`wx_${kind}`] : null;
  return { temp, high, low, unit: w.unit === "fahrenheit" ? "F" : "C", sky: typeof sky === "string" ? sky : null };
}

/** Today's move (moves.js loadMoves → { ramble, moves }) → the contract's move, or null (missing, outdated, off, no challenge, a finished one). */
function moveView(mv) {
  const m = mv && typeof mv === "object" && mv.ramble === "ok" && mv.moves && typeof mv.moves === "object" ? mv.moves : null;
  if (!m || m.off === true) return null;
  const c = m.challenge;
  if (!c || typeof c !== "object" || c.done === true) return null;
  const title = plain(c.title, HEADLINE_MAX);
  if (!title) return null;
  const n = Number(c.minutes);
  return { title, minutes: Number.isFinite(n) && n >= 0 ? Math.round(n) : null };
}

/** The news loader's stories → title and source name only (no summary, no "why", no url): the first three that have a title. */
function headlineView(news) {
  const stories = Array.isArray(news?.stories) ? news.stories : [];
  return stories
    .map((s) => ({ title: plain(s?.title, HEADLINE_MAX), source: plain(s?.sourceName, SOURCE_MAX) }))
    .filter((h) => h.title)
    .slice(0, MORNING_HEADLINES);
}

/** loadNews's own failure is a headline list of none: the rest of the window still fills. */
async function headlinesOf(app, db, opts) {
  try {
    const { loadNews } = await app(MORNING_MODULES.news);
    return headlineView(await loadNews(db, opts));
  } catch { return []; }
}

/** loadMoves's failure hides only the move (the same rule the For You page uses). */
async function moveOf(app, db, opts) {
  try {
    const { loadMoves } = await app(MORNING_MODULES.moves);
    return moveView(await loadMoves(db, opts));
  } catch { return null; }
}

/**
 * The morning window's data. `importApp` defaults to the bundle's app-root loader and is injectable
 * for tests (a fake mapping the four MORNING_MODULES ids to fake modules). `now` may be a function
 * (the runtime's clock) or a number; it is read ONCE, so every part of one window shares one stamp.
 * `weather` is passed to the moves loader in the shape the For You page passes (the forecast object).
 * Never throws: an unreadable settings row means every section is off.
 */
export async function loadMorningView({ db, lang = "en", crowHome = null, now = Date.now, importApp = appImport } = {}) {
  const L = lang === "es" ? "es" : "en";
  const S = STRINGS[L];
  const at = typeof now === "function" ? Number(now()) : Number(now);
  const stamp = Number.isFinite(at) ? at : Date.now();
  const app = typeof importApp === "function" ? importApp : appImport;
  const home = crowHome ? { crowHome } : {};
  let settings = null;
  try {
    const { readForYouSettings } = await app(MORNING_MODULES.settings);
    settings = await readForYouSettings(db);
  } catch { settings = null; }
  if (!settings || typeof settings !== "object") return { weather: null, headlines: [], move: null, updated_at: stamp };
  const sections = settings.sections && typeof settings.sections === "object" ? settings.sections : {};
  // An absent section is on (For You's own default, normalizeSettings): only an explicit false is off.
  const on = (k) => sections[k] !== false;
  let weather = null, forecast = null;
  if (on("weather") && settings.place) {
    let mod = null;
    try { mod = await app(MORNING_MODULES.weather); } catch { mod = null; }
    try { forecast = mod ? await mod.weatherFor(settings.place, { now: () => stamp }) : null; }
    catch { forecast = null; }
    weather = weatherView(forecast, S, mod?.weatherKind);
  }
  const [headlines, move] = await Promise.all([
    on("news") ? headlinesOf(app, db, { ...home, now: stamp }) : [],
    on("moves") ? moveOf(app, db, { ...home, now: stamp, weather: forecast, lang: L }) : null,
  ]);
  return { weather, headlines, move, updated_at: stamp };
}

/**
 * The wm spec for the window (the contract's object): the wm store adds its own id, opened_at and
 * touched_at. A view that lost a part still gives a window — its parts are simply null / [].
 */
export function morningWindow(view, S) {
  const strings = S && typeof S === "object" ? S : STRINGS.en;
  return { kind: "morning", title: String(strings.morning_title ?? ""), ...(view && typeof view === "object" ? view : {}) };
}

/** The local hour of a stamp (the server's zone: a display shows the household's morning). */
export function localHour(at = Date.now()) {
  return new Date(Number(at) || 0).getHours();
}

/** The local date of a stamp as YYYY-MM-DD (what the once-a-morning rule remembers per display). */
export function localDate(at = Date.now()) {
  const d = new Date(Number(at) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * May the morning window open itself on this display now? (runtime.js's minute sweep calls this and
 * acts on a true.) Every condition must hold: a paired kiosk (never the phone overlay), For You on,
 * the local hour inside MORNING_HOURS, a page that draws the kind, nothing open, no turn or speech,
 * no media playing, and not already auto-opened on this device on this local date.
 */
export function shouldAutoOpenMorning({ hour, sessionDisplay, enabled, kinds, windows, busy, mediaActive, lastDate, today } = {}) {
  if (sessionDisplay === true) return false;
  if (enabled !== true) return false;
  const h = Number(hour);
  if (!Number.isFinite(h) || h < MORNING_HOURS.start || h >= MORNING_HOURS.end) return false;
  if (!Array.isArray(kinds) || !kinds.includes("morning")) return false;
  if (!Array.isArray(windows) || windows.length > 0) return false;
  if (busy === true) return false;
  if (mediaActive === true) return false;
  if (typeof today !== "string" || !today) return false;
  if (typeof lastDate === "string" && lastDate === today) return false;
  return true;
}

/**
 * Opening the window by voice: runtime.js's ctx.openItem for the "morning" app. The pattern is
 * play.js's nowPlayingWindow — an existing morning window is replaced by the same-title put, an
 * eviction closes first — with the view read on the way (load() is the caller's db-bound
 * loadMorningView). A display that does not draw the kind answers like every other unavailable app,
 * and a strict phrase (T0/T1, no model) gets nothing at all.
 */
export async function openMorningItem({ store, deviceId, caps, S, strict = false, load } = {}) {
  const strings = S && typeof S === "object" ? S : STRINGS.en;
  if (!Array.isArray(caps?.kinds) || !caps.kinds.includes("morning")) return strict ? null : result(false, "unavailable", strings.say_open_unavailable);
  let view = null;
  try { view = typeof load === "function" ? await load() : null; }
  catch { return strict ? null : result(false, "unavailable", strings.say_open_unavailable); }
  const had = store.list(deviceId).some((w) => w.kind === "morning");
  const { window, evicted, updated } = store.put(deviceId, morningWindow(view, strings));
  return result(true, had || updated ? "focused" : "opened", strings.say_morning, {
    events: [...evicted.map((e) => ({ type: "wm", action: "close", id: e.id })), { type: "wm", action: "open", window }],
  });
}

/**
 * The idle sweep's per-display logic (runtime.js's minute timer builds one of these and calls it for
 * each connected display): open the morning window once a morning on an idle kiosk, and only then.
 * The date it remembers is kept here, one per display.
 *   load(id, at) → the window spec (morningWindow) to put; a throw is logged and leaves nothing.
 * A sweep already running for a display returns false at once; the display's state is read AGAIN after
 * the load, so a window, a turn or media that arrived meanwhile cancels the open. Evicted windows are
 * closed before the open, and an open the page did not get leaves nothing behind for the next minute.
 */
export function createMorningSweep({ wm, hub, media, now = Date.now, isSessionDisplay = () => false, enabled = () => true, load, log = () => {} } = {}) {
  const openedAt = new Map();   // device id → the local date it was auto-opened
  const inFlight = new Set();   // device ids whose sweep is running
  const isOn = () => (typeof enabled === "function" ? enabled() === true : enabled === true);
  async function sweep(id) {
    if (inFlight.has(id)) return false;
    inFlight.add(id);
    try {
      const today = localDate(now());
      const mayOpen = () => shouldAutoOpenMorning({
        hour: localHour(now()), sessionDisplay: isSessionDisplay(id) === true, enabled: isOn(),
        kinds: hub?.capsOf?.(id)?.kinds, windows: wm.list(id), busy: hub?.isBusy?.(id) === true,
        mediaActive: media?.active?.(id) === true, lastDate: openedAt.get(id) || null, today,
      });
      if (!mayOpen()) return false;
      let spec = null;
      try { spec = await load(id, now()); }
      catch (err) { log(`[kiosk] morning view not read: ${err?.message}`); return false; }
      if (!spec) return false;
      if (!mayOpen()) return false;   // the screen changed while the view was read
      const { window, evicted } = wm.put(id, spec);
      for (const e of evicted) hub.sendTo(id, { type: "wm", action: "close", id: e.id });   // defensive: the re-check needs an empty screen
      if (hub.sendTo(id, { type: "wm", action: "open", window }) === true) { openedAt.set(id, today); return true; }
      wm.close(id, window.id);   // the page never got it: leave nothing behind for the next try
      return false;
    } finally { inFlight.delete(id); }
  }
  return sweep;
}