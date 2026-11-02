/**
 * The kiosk's "Your morning" window (For You spec §13): the data loader and the window spec, the
 * crow_open item, the voice open, and the once-a-morning idle rule. Every For You module is a fake
 * injected through importApp: no network, no real ~/.crow, no Media Hub or Ramble install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadMorningView, morningWindow, openMorningItem, shouldAutoOpenMorning, createMorningSweep,
  MORNING_HOURS, MORNING_HEADLINES, MORNING_MODULES, HEADLINE_MAX, SOURCE_MAX, localDate, localHour,
} from "../bundles/kiosk/server/morning-view.js";
import { displayItems } from "../bundles/kiosk/server/runtime.js";
import { asksOpen, mentionsOpen, asksCard } from "../bundles/kiosk/server/patterns.js";
import { weatherKind } from "../servers/gateway/for-you/weather.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const db = { fake: true };
const PLACE = { name: "Springfield", admin1: "Oregon", country: "US", lat: 44.05, lon: -123.02, unit: "fahrenheit" };
const sections = (off = []) => Object.fromEntries(["morning", "moves", "listen", "news", "weather"].map((k) => [k, !off.includes(k)]));
const STORY = (n, extra = {}) => ({ id: `a${n}`, title: `Headline ${n}`, sourceName: `Source ${n}`, sourceId: `s${n}`, summary: "a summary that never reaches the window", url: "https://example.test/a", publishedAt: null, ...extra });

/** Fake For You modules; `over` replaces any of them (a throwing loader, a different settings row). */
function fakes({ over = {}, settings = { sections: sections(), city: "Springfield", place: PLACE } } = {}) {
  const mods = {
    [MORNING_MODULES.settings]: { readForYouSettings: async () => settings },
    [MORNING_MODULES.weather]: { weatherFor: async () => ({ temp: 12.4, code: 3, high: 15.6, low: 4.2, rain: 20, unit: "celsius" }), weatherKind },
    [MORNING_MODULES.news]: { loadNews: async () => ({ state: "ok", stories: [STORY(1), STORY(2), STORY(3), STORY(4), STORY(5)], hidden: [] }) },
    [MORNING_MODULES.moves]: {
      loadMoves: async () => ({ ramble: "ok", moves: { off: false, challenge: { title: "Walk 20 min", minutes: 20, why: "sunny", day: "2026-11-03", done: false }, health: { energy: 3, max: 5 } } }),
    },
    ...over,
  };
  const importApp = async (rel) => {
    if (!Object.hasOwn(mods, rel)) throw new Error(`no fake for ${rel}`);
    return mods[rel];
  };
  return { importApp };
}

const keysOf = (o) => Object.keys(o).sort();
/** Every key at every level (the privacy walk: a key that must never reach a shared display). */
function allKeys(v, out = []) {
  if (!v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  return out;
}
const NOW = 1_793_000_000_000;   // fixed ms stamp for every call

test("loadMorningView maps the For You outputs onto exactly the contract's keys and values", async () => {
  const { importApp } = fakes();
  const view = await loadMorningView({ db, lang: "en", now: NOW, importApp });
  assert.deepEqual(keysOf(view), ["headlines", "move", "updated_at", "weather"]);
  assert.equal(view.updated_at, NOW);
  // Weather: numbers rounded, the module's unit as F/C, the sky from the code in the display's language.
  assert.deepEqual(keysOf(view.weather), ["high", "low", "sky", "temp", "unit"]);
  assert.deepEqual(view.weather, { temp: 12, high: 16, low: 4, unit: "C", sky: "Cloudy" });
  assert.ok(!("label" in view.weather), "the window carries no label");
  assert.ok(!JSON.stringify(morningWindow(view, STRINGS.en)).includes("Springfield"), "the place name is never in the window");
  // Headlines: three stories, title and source name only.
  assert.equal(view.headlines.length, MORNING_HEADLINES);
  for (const h of view.headlines) assert.deepEqual(keysOf(h), ["source", "title"]);
  assert.deepEqual(view.headlines[0], { title: "Headline 1", source: "Source 1" });
  // Move: today's challenge, title and minutes.
  assert.deepEqual(keysOf(view.move), ["minutes", "title"]);
  assert.deepEqual(view.move, { title: "Walk 20 min", minutes: 20 });
});

test("the window spec is the contract's object: kind, the display's title, then the view's own parts", async () => {
  const { importApp } = fakes();
  const view = await loadMorningView({ db, lang: "es", now: NOW, importApp });
  const w = morningWindow(view, STRINGS.es);
  assert.deepEqual(keysOf(w), ["headlines", "kind", "move", "title", "updated_at", "weather"]);
  assert.equal(w.kind, "morning");
  assert.equal(w.title, STRINGS.es.morning_title);
  assert.equal(view.weather.sky, "Nublado", "the sky is in the display's language");
  assert.deepEqual(morningWindow(null, STRINGS.en), { kind: "morning", title: "Your morning" });
});

test("each section off on its own: that part is null / [], the others still fill", async () => {
  for (const [off, check] of [
    ["weather", (v) => { assert.equal(v.weather, null); assert.ok(v.headlines.length); assert.ok(v.move); }],
    ["news", (v) => { assert.deepEqual(v.headlines, []); assert.ok(v.weather); assert.ok(v.move); }],
    ["moves", (v) => { assert.equal(v.move, null); assert.ok(v.weather); assert.ok(v.headlines.length); }],
  ]) {
    const { importApp } = fakes({ settings: { sections: sections([off]), city: "Springfield", place: PLACE } });
    const view = await loadMorningView({ db, lang: "en", now: NOW, importApp });
    check(view);
    assert.deepEqual(keysOf(view), ["headlines", "move", "updated_at", "weather"]);
  }
  // Weather is also off with no city: the section is on, but there is no place to read.
  const noPlace = fakes({ settings: { sections: sections(), city: "", place: null } });
  const view = await loadMorningView({ db, lang: "en", now: NOW, importApp: noPlace.importApp });
  assert.equal(view.weather, null);
  assert.ok(view.headlines.length && view.move, "the other sections do not depend on the city");
});

test("a failing read hides only its own part: a throwing news module leaves weather and move", async () => {
  const { importApp } = fakes({ over: { [MORNING_MODULES.news]: { loadNews: () => { throw new Error("boom"); } } } });
  const view = await loadMorningView({ db, lang: "en", now: NOW, importApp });
  assert.deepEqual(view.headlines, []);
  assert.ok(view.weather);
  assert.ok(view.move);
  // A module that cannot even be loaded, and loaders that return their own failure shapes, behave the same.
  const missing = fakes({ over: { [MORNING_MODULES.moves]: undefined } });
  const broke = await loadMorningView({ db, lang: "en", now: NOW, importApp: missing.importApp });
  assert.equal(broke.move, null);
  assert.ok(broke.weather && broke.headlines.length);
  const failures = fakes({
    over: {
      [MORNING_MODULES.news]: { loadNews: async () => ({ state: "missing", stories: [], hidden: [] }) },
      [MORNING_MODULES.moves]: { loadMoves: async () => ({ ramble: "missing" }) },
      [MORNING_MODULES.weather]: { weatherFor: async () => null },
    },
  });
  const degraded = await loadMorningView({ db, lang: "en", now: NOW, importApp: failures.importApp });
  assert.equal(degraded.weather, null);
  assert.deepEqual(degraded.headlines, []);
  assert.equal(degraded.move, null);
  assert.deepEqual(keysOf(degraded), ["headlines", "move", "updated_at", "weather"], "the window still exists");
  // An unreadable settings row: every section is off (nothing is guessed).
  const noSettings = fakes({ over: { [MORNING_MODULES.settings]: { readForYouSettings: async () => { throw new Error("db gone"); } } } });
  const blank = await loadMorningView({ db, lang: "en", now: NOW, importApp: noSettings.importApp });
  assert.deepEqual([blank.weather, blank.headlines, blank.move], [null, [], null]);
});

test("headlines are capped at three and trimmed to the contract's lengths; a story with no title is dropped", async () => {
  const longTitle = "T".repeat(HEADLINE_MAX + 60);
  const longSource = "S".repeat(SOURCE_MAX + 20);
  const { importApp } = fakes({
    over: {
      [MORNING_MODULES.news]: {
        loadNews: async () => ({
          state: "ok",
          hidden: [],
          stories: [STORY(1, { title: longTitle, sourceName: longSource }), { title: "", sourceName: "Nobody" }, STORY(2), STORY(3), STORY(4)],
        }),
      },
    },
  });
  const view = await loadMorningView({ db, lang: "en", now: NOW, importApp });
  assert.equal(view.headlines.length, 3);
  assert.equal(view.headlines[0].title.length, HEADLINE_MAX);
  assert.equal(view.headlines[0].source.length, SOURCE_MAX);
  assert.deepEqual(view.headlines.map((h) => h.title), [longTitle.slice(0, HEADLINE_MAX), "Headline 2", "Headline 3"]);
  // Newlines (and other control characters) never ride along: a window string is one plain line.
  const dirty = fakes({ over: { [MORNING_MODULES.news]: { loadNews: async () => ({ state: "ok", stories: [{ title: "Two\nlines\u2028here", sourceName: " A\tB " }], hidden: [] }) } } });
  const clean = await loadMorningView({ db, lang: "en", now: NOW, importApp: dirty.importApp });
  assert.deepEqual(clean.headlines, [{ title: "Two lines here", source: "A B" }]);
});

test("the weather, the news and the moves are asked for the way the For You page asks (weather in, language through)", async () => {
  const calls = [];
  const { importApp } = fakes({
    over: {
      [MORNING_MODULES.news]: { loadNews: async (_db, opts) => { calls.push({ what: "news", opts }); return { state: "ok", stories: [STORY(1)], hidden: [] }; } },
      [MORNING_MODULES.moves]: { loadMoves: async (_db, opts) => { calls.push({ what: "moves", opts }); return { ramble: "ok", moves: { challenge: { title: "Stretch", minutes: 5 } } }; } },
    },
  });
  const view = await loadMorningView({ db, lang: "es", now: NOW, importApp });
  assert.deepEqual(view.move, { title: "Stretch", minutes: 5 });
  const news = calls.find((c) => c.what === "news");
  const moves = calls.find((c) => c.what === "moves");
  assert.equal(news.opts.now, NOW, "the loader's own now (a number, not a clock)");
  assert.equal(moves.opts.now, NOW);
  assert.equal(moves.opts.lang, "es");
  assert.deepEqual(moves.opts.weather, { temp: 12.4, code: 3, high: 15.6, low: 4.2, rain: 20, unit: "celsius" }, "the page passes the forecast itself, not the chip's shape");
  // A crowHome is passed through only when the caller has one (the modules resolve their own otherwise).
  calls.length = 0;
  await loadMorningView({ db, lang: "en", now: NOW, crowHome: "/tmp/crow-home", importApp });
  assert.equal(calls.find((c) => c.what === "news").opts.crowHome, "/tmp/crow-home");
});

test("the window JSON carries no private For You keys anywhere (a walk over every level)", () => {
  const forbidden = ["morning", "needs", "cards", "project", "bots", "mail", "calendar"];
  const view = {
    weather: { temp: 12, high: 16, low: 4, unit: "C", sky: "Cloudy" },
    headlines: [{ title: "Headline 1", source: "Source 1" }, { title: "Headline 2", source: "Source 2" }],
    move: { title: "Walk 20 min", minutes: 20 },
    updated_at: NOW,
  };
  const w = morningWindow(view, STRINGS.en);
  const keys = allKeys(w);
  for (const bad of forbidden) assert.ok(!keys.includes(bad), `the window carries a "${bad}" key`);
  // The walk really walks: a planted key is found, so the assertion above means something.
  assert.ok(allKeys({ ...w, weather: { ...w.weather, cards: [] } }).includes("cards"));
  assert.deepEqual(JSON.parse(JSON.stringify(w)), w, "plain JSON");
});

test("the morning item is offered to crow_open only while For You is on; now playing keeps its own rule", () => {
  const saved = process.env.CROW_FOR_YOU;
  try {
    delete process.env.CROW_FOR_YOU;
    assert.deepEqual(displayItems({ lang: "en", sources: ["radio"] }).map((i) => i.id), ["now_playing"]);
    assert.deepEqual(displayItems({ lang: "en", sources: [] }), [], "no source, no item, no morning: For You is off");
    process.env.CROW_FOR_YOU = "1";
    assert.deepEqual(displayItems({ lang: "en", sources: ["radio"] }).map((i) => i.id), ["now_playing", "morning"]);
    const en = displayItems({ lang: "en", sources: ["radio"] })[1];
    assert.deepEqual(en, { id: "morning", title: STRINGS.en.morning_title, aliases: ["my morning"], tail: true });
    const es = displayItems({ lang: "es", sources: [] })[0];
    assert.deepEqual(es, { id: "morning", title: "Tu mañana", aliases: ["mi mañana"], tail: true });
    assert.equal(STRINGS.en.now_playing_title, "Now playing");
    assert.equal(STRINGS.es.now_playing_title, "Sonando ahora");
  } finally {
    if (saved === undefined) delete process.env.CROW_FOR_YOU; else process.env.CROW_FOR_YOU = saved;
  }
});

test("openItem for the morning app: unavailable without the kind, an eviction-then-open with it, replaced never piled", async () => {
  const store = createWmStore({ now: () => MORNING_AT(), setTimer: () => ({}), clearTimer: () => {} });
  const S = STRINGS.en;
  const view = { weather: null, headlines: [{ title: "One", source: "Src" }], move: null, updated_at: NOW };
  const load = async () => view;
  // A page that does not draw the kind: the same shape openItem uses for an unavailable app.
  const no = await openMorningItem({ store, deviceId: "k", caps: { kinds: ["card", "timer"] }, S, load });
  assert.deepEqual([no.ok, no.outcome, no.final], [false, "unavailable", true]);
  assert.equal(no.say, S.say_open_unavailable);
  assert.deepEqual(no.events, []);
  assert.deepEqual(store.list("k"), [], "nothing was opened");
  assert.equal(await openMorningItem({ store, deviceId: "k", caps: { kinds: [] }, S, strict: true, load }), null, "a strict phrase does not fire");
  // A display that draws it: the last event is a wm open of kind morning, and the window is in the store.
  const r = await openMorningItem({ store, deviceId: "k", caps: { kinds: ["card", "morning"] }, S, load });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "opened");
  assert.equal(r.say, S.say_morning);
  const last = r.events.at(-1);
  assert.equal(last.type, "wm");
  assert.equal(last.action, "open");
  assert.equal(last.window.kind, "morning");
  assert.equal(last.window.title, S.morning_title);
  assert.deepEqual(last.window.headlines, view.headlines);
  assert.deepEqual(store.list("k").map((w) => w.kind), ["morning"]);
  // Asked again: the existing morning window is replaced (never a second one), and the old one is closed first.
  const again = await openMorningItem({ store, deviceId: "k", caps: { kinds: ["morning"] }, S, load });
  assert.equal(again.outcome, "focused");
  assert.deepEqual(again.events.map((e) => e.action), ["close", "open"]);
  assert.equal(store.list("k").length, 1);
  // Another window in front is not pushed out: a full display still replaces only its own morning window.
  store.put("k", { kind: "content", title: "Notes", blocks: [] });
  const withCard = await openMorningItem({ store, deviceId: "k", caps: { kinds: ["card", "morning"] }, S, load });
  assert.deepEqual(withCard.events.map((e) => e.action), ["close", "open"]);
  assert.deepEqual(store.list("k").map((w) => w.kind).sort(), ["content", "morning"]);
  // The view failing is unavailable, never an empty window.
  const broken = await openMorningItem({ store, deviceId: "b", caps: { kinds: ["morning"] }, S, load: async () => { throw new Error("x"); } });
  assert.equal(broken.outcome, "unavailable");
  assert.deepEqual(store.list("b"), []);
});

test("shouldAutoOpenMorning: every condition, the hour bounds, and 'already opened today'", () => {
  assert.deepEqual(MORNING_HOURS, { start: 6, end: 11 });
  const base = { hour: 7, sessionDisplay: false, enabled: true, kinds: ["card", "morning"], windows: [], busy: false, mediaActive: false, lastDate: null, today: "2026-11-03" };
  assert.equal(shouldAutoOpenMorning(base), true);
  for (const [what, bad] of [
    ["the phone overlay", { sessionDisplay: true }],
    ["For You off", { enabled: false }],
    ["For You unknown", { enabled: undefined }],
    ["before six", { hour: 5 }],
    ["eleven or later", { hour: 11 }],
    ["a nonsense hour", { hour: "seven" }],
    ["a page without the kind", { kinds: ["card", "timer"] }],
    ["no caps at all", { kinds: null }],
    ["a window open", { windows: [{ kind: "content", title: "Notes" }] }],
    ["a turn or speech in progress", { busy: true }],
    ["music playing", { mediaActive: true }],
    ["already opened today", { lastDate: "2026-11-03" }],
    ["no date to record", { today: "" }],
  ]) assert.equal(shouldAutoOpenMorning({ ...base, ...bad }), false, what);
  // The boundary hours are in, the hour after is out.
  assert.equal(shouldAutoOpenMorning({ ...base, hour: 6 }), true, "six is inside");
  assert.equal(shouldAutoOpenMorning({ ...base, hour: 10 }), true, "ten is inside");
  assert.equal(shouldAutoOpenMorning({ ...base, hour: 12 }), false, "noon is out");
  // A stamp from another day is no memory at all.
  assert.equal(shouldAutoOpenMorning({ ...base, lastDate: "2026-11-02" }), true);
  assert.equal(shouldAutoOpenMorning(), false, "no arguments: nothing opens");
  // The date and hour helpers the sweep uses are the LOCAL clock, not UTC.
  const sixAm = new Date(2026, 10, 3, 6, 30, 0, 0).getTime();
  assert.equal(localHour(sixAm), 6);
  assert.equal(localDate(sixAm), "2026-11-03");
  assert.equal(localHour(new Date(2026, 10, 3, 23, 59, 0, 0).getTime()), 23);
});

test("the weather's sky is the code's conditions in the display's language, and null for a code it does not know", async () => {
  const wx = (code) => fakes({ over: { [MORNING_MODULES.weather]: { weatherFor: async () => ({ temp: 5, code, high: 8, low: 1, unit: "celsius" }), weatherKind } } });
  for (const [code, en, es] of [
    [0, "Clear", "Despejado"], [2, "Partly cloudy", "Parcialmente nublado"], [3, "Cloudy", "Nublado"], [45, "Fog", "Niebla"],
    [53, "Drizzle", "Llovizna"], [63, "Rain", "Lluvia"], [73, "Snow", "Nieve"], [95, "Thunderstorms", "Tormentas"], [42, null, null],
  ]) {
    const e = await loadMorningView({ db, lang: "en", now: NOW, importApp: wx(code).importApp });
    const s = await loadMorningView({ db, lang: "es", now: NOW, importApp: wx(code).importApp });
    assert.equal(e.weather.sky, en, `en code ${code}`);
    assert.equal(s.weather.sky, es, `es code ${code}`);
    assert.ok(!("label" in e.weather), `code ${code} carries no label`);
  }
});

test("a finished challenge is not today's move", async () => {
  const moves = (challenge) => fakes({ over: { [MORNING_MODULES.moves]: { loadMoves: async () => ({ ramble: "ok", moves: { challenge } }) } } });
  const done = await loadMorningView({ db, lang: "en", now: NOW, importApp: moves({ title: "Walk 20 min", minutes: 20, done: true }).importApp });
  assert.equal(done.move, null, "a done move is not shown");
  const open = await loadMorningView({ db, lang: "en", now: NOW, importApp: moves({ title: "Walk 20 min", minutes: 20, done: false }).importApp });
  assert.deepEqual(open.move, { title: "Walk 20 min", minutes: 20 });
});

test("only \"my morning\" / \"mi mañana\" name the window: an ordinary morning turn is not an open", () => {
  const en = displayItems({ lang: "en", sources: [], forYou: true });
  const es = displayItems({ lang: "es", sources: [], forYou: true });
  for (const said of ["Can you tell me the weather this morning?", "Please wake me up tomorrow morning"]) {
    assert.equal(asksOpen(said, en), false, said);
    assert.equal(mentionsOpen(said, en), false, said);
  }
  for (const said of ["¿Puedes poner una alarma para mañana?", "Pon una alarma mañana a las siete"]) {
    assert.equal(asksOpen(said, es), false, said);
    assert.equal(mentionsOpen(said, es), false, said);
  }
  assert.equal(asksCard("make me a list for Monday morning", en), asksCard("make me a list for Monday morning", []), "a card request is unchanged by the item");
  for (const said of ["Can you move my morning alarm to 7?", "please remind me about my morning meds", "¿Puedes cambiar mi mañana libre?"]) {
    const items = /[¿ñ]/.test(said) ? es : en;
    assert.equal(asksOpen(said, items), false, said);
    assert.equal(mentionsOpen(said, items), false, said);
  }
  assert.equal(asksOpen("can you open my morning please", en), true, "a polite word after the name still names it");
  assert.equal(asksOpen("can you open my morning", en), true);
  assert.equal(asksOpen("¿puedes abrir mi mañana?", es), true, "the Spanish alias still opens it when asked");
});

// ── the idle sweep (morning-view.js createMorningSweep) ─────────────────────────────────────────
const MORNING_AT = (h = 7, m = 0) => new Date(2026, 10, 3, h, m, 0, 0).getTime();
const MORNING_SPEC = { kind: "morning", title: "Your morning", weather: null, headlines: [], move: null, updated_at: 0 };

/** The real wm store, a fake hub and media, and a clock the test moves; each test overrides one thing. */
function sweepRig({ now = () => MORNING_AT(), enabled = () => true, isSessionDisplay = () => false, hub = {}, media = {}, load = async () => MORNING_SPEC, store = null } = {}) {
  const wm = store || createWmStore({ now, setTimer: () => ({}), clearTimer: () => {} });
  const events = [];
  const sweep = createMorningSweep({
    wm, now, enabled, isSessionDisplay, load,
    hub: { capsOf: () => ({ kinds: ["card", "morning"] }), isBusy: () => false, sendTo: (id, m) => { events.push(m); return true; }, ...hub },
    media: { active: () => false, ...media },
  });
  return { wm, events, sweep };
}

test("the morning sweep opens once on the first idle minute in the window, and not again that morning", async () => {
  let clock = MORNING_AT();
  const rig = sweepRig({ now: () => clock });
  assert.equal(await rig.sweep("k"), true);
  assert.deepEqual(rig.wm.list("k").map((w) => w.kind), ["morning"]);
  assert.deepEqual(rig.events.map((e) => e.action), ["open"]);
  assert.equal(rig.events[0].window.title, "Your morning", "the loaded window is the one put up");
  clock += 60_000;
  assert.equal(await rig.sweep("k"), false, "already auto-opened today");
  assert.equal(rig.wm.list("k").length, 1);
  assert.equal(rig.events.length, 1, "no second open");
});

test("a sweep whose open the page never got leaves no window, and the next minute tries again", async () => {
  let clock = MORNING_AT();
  let deliver = false;
  const rig = sweepRig({ now: () => clock, hub: { sendTo: (id, m) => (m.action === "open" ? deliver : true) } });
  assert.equal(await rig.sweep("k"), false);
  assert.deepEqual(rig.wm.list("k"), [], "nothing is left behind");
  clock += 60_000;
  deliver = true;
  assert.equal(await rig.sweep("k"), true, "a failed send is retried on a later minute");
  assert.equal(rig.wm.list("k").length, 1);
});

test("the phone overlay is never swept: a session display opens nothing", async () => {
  const rig = sweepRig({ isSessionDisplay: (id) => id === "phone" });
  assert.equal(await rig.sweep("phone"), false);
  assert.deepEqual(rig.wm.list("phone"), []);
  assert.equal(await rig.sweep("kiosk"), true, "a paired display still opens");
});

test("two sweeps for one display at once: a slow view read opens one window only", async () => {
  const rig = sweepRig({ load: async () => { await new Promise((r) => setTimeout(r, 20)); return MORNING_SPEC; } });
  const [a, b] = await Promise.all([rig.sweep("k"), rig.sweep("k")]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(rig.wm.list("k").length, 1);
  assert.equal(rig.events.filter((e) => e.action === "open").length, 1);
});

test("a window that opens while the view is being read cancels the auto-open", async () => {
  const store = createWmStore({ now: () => MORNING_AT(), setTimer: () => ({}), clearTimer: () => {} });
  const rig = sweepRig({ store, load: async () => { store.put("k", { kind: "content", title: "Notes", blocks: [] }); return MORNING_SPEC; } });
  assert.equal(await rig.sweep("k"), false);
  assert.deepEqual(rig.wm.list("k").map((w) => w.kind), ["content"], "the morning window did not open over it");
  assert.deepEqual(rig.events, []);
});

// T1: "show …" opens an item only when the rest is exactly its name or alias (Claude, lane A).
test("T1: 'show my morning' opens the morning window; other show requests are left alone", async () => {
  const { matchT1, parseShowItem } = await import("../bundles/kiosk/server/patterns.js");
  const items = [{ id: "morning", title: "Your morning", aliases: ["my morning"] }];
  const ctx = { items, sources: [], deviceId: "k1" };
  for (const said of ["Show my morning.", "show me my morning", "Show me your morning", "open my morning"]) {
    assert.deepEqual(matchT1(said, ctx), { verb: "open", app: "morning" }, said);
  }
  for (const said of ["show me a recipe for pancakes", "show my notes", "show me the morning news", "show"]) {
    assert.equal(parseShowItem(said, items), null, said);
    const r = matchT1(said, ctx);
    assert.ok(!r || r.app !== "morning", said);
  }
  // The real Spanish item: "abre mi mañana" / "muéstrame mi mañana" open it; "mi" is part of the alias.
  const es = { items: displayItems({ lang: "es", sources: [], forYou: true }), sources: [], deviceId: "k1" };
  for (const said of ["Abre mi mañana", "muéstrame mi mañana"]) assert.deepEqual(matchT1(said, es), { verb: "open", app: "morning" }, said);
  assert.equal(matchT1("pon una alarma para mañana", es), null);
  // Without the item (For You off), "show my morning" is not an open at all.
  assert.equal(matchT1("show my morning", { items: [], sources: [], deviceId: "k1" }), null);
});
