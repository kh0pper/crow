/**
 * Ramble moves — the week view and settling a full week (private engineering
 * notes).
 *
 * What is pinned here:
 *   - `weekView` answers the week's balance plus a seven-entry strip, Monday
 *     first, with each day's "movemin" minutes and the areas it marked, and it
 *     writes nothing at all,
 *   - an area counts at most two days, one row per day and area, so ten marks
 *     over two days in each of the five areas is a full week,
 *   - `comingUp` lists the plan for the days after today, and nothing on the
 *     last day of the week,
 *   - a "something else" log marks the area its activity trains once it is a
 *     ten-minute chunk (`markLogArea`), and `other` or a short log marks
 *     nothing,
 *   - coverage pays no Health and no seed: neither a marked log area nor a full
 *     week touches the pet or the seed wallet,
 *   - a chunk that tags two areas marks both on its day,
 *   - one card a day is enough for a full week, given two-area chunks,
 *   - `settleWeek` writes the week's earned item once, for the week it is asked
 *     about, and never for a week that is not full,
 *   - a month of full weeks earns a new colour each week, and owning it is
 *     derived from those rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { AREAS } from "../bundles/ramble/server/moves/library.js";
import { WEEKFULL_KIND, ownedItems } from "../bundles/ramble/server/wardrobe.js";
import { MOVE_MIN_KIND } from "../bundles/ramble/server/moves/progress.js";
import {
  MOVE_AREA_KIND, weekDays, weekIdOf, weekPlan, weekState, weekView,
  settleWeek,
} from "../bundles/ramble/server/moves/week.js";
import { markLogArea, recordSlotDone } from "../bundles/ramble/server/moves/day.js";
import { recordLog } from "../bundles/ramble/server/moves/ledger.js";

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
const W45 = "2026-W45";
const W46 = "2026-W46";
const NOON_W46 = noon(2026, 11, 12);

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

async function walletRows(db) {
  const result = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ramble_wallet", args: [] });
  return Number(result.rows[0].n);
}

/** Insert a wallet fact, leaving an existing (kind, key) row alone. */
async function fact(db, kind, key, delta = 1) {
  await db.execute({
    sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, 0)
          ON CONFLICT(kind, key) DO NOTHING`,
    args: [kind, key, delta],
  });
}

async function insertMark(db, key) {
  await fact(db, MOVE_AREA_KIND, key);
}

/** The rows of one wallet kind, as a count. */
async function rowsOfKind(db, kind) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM ramble_wallet WHERE kind = ?", args: [kind],
  });
  return Number(rows[0].n);
}

/** Seed and spend as the wallet holds them: their count and their total. */
async function seedAndSpend(db) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS total FROM ramble_wallet WHERE kind IN ('seed', 'spend')",
    args: [],
  });
  return { count: Number(rows[0].n), total: Number(rows[0].total) };
}

/** The bird's energy, or null while the instance has no pet row yet. */
async function petEnergy(db) {
  const { rows } = await db.execute({
    sql: "SELECT energy FROM ramble_pet WHERE owner = 'self'", args: [],
  });
  return rows.length ? Number(rows[0].energy) : null;
}

/** Two days in each of the five areas: a full week. */
async function fillWeek(db, days) {
  for (const area of AREAS) {
    await insertMark(db, `${days[0]}:${area}`);
    await insertMark(db, `${days[2]}:${area}`);
  }
}

/** A finished card's entry; only `kind` and `areas` are read. */
function entry(areas, kind = "routine") {
  return { kind, areas };
}

test("weekView: a fresh db is an empty week with seven empty days, and the read writes nothing", async () => {
  const db = await freshDb();
  const view = await weekView(db, { now: NOON_W46 });

  assert.equal(view.weekId, W46);
  assert.equal(view.total, 0);
  assert.equal(view.full, false);
  assert.deepEqual(view.marks, {
    upper: [], core: [], lower: [], heart: [], mobility: [],
  });

  const days = weekDays(W46);
  assert.equal(view.strip.length, 7);
  assert.deepEqual(view.strip.map((day) => day.day), days);
  for (const day of view.strip) {
    assert.equal(day.minutes, 0, "no minutes on " + day.day);
    assert.deepEqual(day.areas, [], "no areas on " + day.day);
  }

  const before = await walletRows(db);
  await weekView(db, { now: NOON_W46 });
  assert.equal(await walletRows(db), before, "reading the week adds no rows");
});

test("weekView: an area counts two days, and one day is one key however often it is marked", async () => {
  const db = await freshDb();
  await insertMark(db, "2026-11-09:lower");
  await insertMark(db, "2026-11-11:lower");

  let view = await weekView(db, { now: NOON_W46 });
  assert.deepEqual(view.marks.lower, ["2026-11-09", "2026-11-11"]);
  assert.equal(view.total, 2, "two days of one area count 2");
  assert.equal(view.strip[0].areas.includes("lower"), true);
  assert.equal(view.strip[2].areas.includes("lower"), true);

  // The same day and area is one wallet key, so a repeat cannot add a mark.
  await insertMark(db, "2026-11-09:lower");
  view = await weekView(db, { now: NOON_W46 });
  assert.deepEqual(view.marks.lower, ["2026-11-09", "2026-11-11"]);
  assert.equal(view.total, 2);
  assert.equal(await rowsOfKind(db, MOVE_AREA_KIND), 2);
});

test("weekView: ten marks, two days in each area, is a full week", async () => {
  const db = await freshDb();
  await fillWeek(db, weekDays(W46));

  const view = await weekView(db, { now: NOON_W46 });
  for (const area of AREAS) {
    assert.deepEqual(view.marks[area], ["2026-11-09", "2026-11-11"], area);
  }
  assert.equal(view.total, 10);
  assert.equal(view.full, true);
});

test("weekView: the strip carries each day's minutes and its areas in AREAS order", async () => {
  const db = await freshDb();
  await fact(db, MOVE_MIN_KIND, "2026-11-09", 25);
  await fact(db, MOVE_MIN_KIND, "2026-11-11", 40);
  // Minutes of another week stay out of this week's strip.
  await fact(db, MOVE_MIN_KIND, "2026-11-02", 99);
  await fact(db, MOVE_MIN_KIND, "2026-11-16", 7);

  await insertMark(db, "2026-11-09:mobility");
  await insertMark(db, "2026-11-09:lower");
  await insertMark(db, "2026-11-11:heart");

  const view = await weekView(db, { now: NOON_W46 });
  assert.deepEqual(view.strip.map((day) => day.minutes), [25, 0, 40, 0, 0, 0, 0]);
  assert.deepEqual(view.strip[0].areas, ["lower", "mobility"], "AREAS order, not insertion order");
  assert.deepEqual(view.strip[2].areas, ["heart"]);
  assert.deepEqual(view.strip[1].areas, []);
});

test("weekView: comingUp is the plan for the days after today, and empty on the last day", async () => {
  const db = await freshDb();
  const wednesday = noon(2026, 11, 11);

  const three = await weekView(db, { now: wednesday, prefs: { cards: 3 } });
  assert.deepEqual(three.comingUp.map((d) => d.day), ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.deepEqual(three.comingUp.map((d) => d.dayIndex), [3, 4, 5, 6]);
  const planThree = weekPlan(W46, 3);
  for (const day of three.comingUp) {
    assert.deepEqual(day.slots, planThree[day.dayIndex].slots, "day " + day.day);
    assert.deepEqual(Object.keys(day.slots), ["morning", "midday", "evening"]);
  }

  const one = await weekView(db, { now: wednesday, prefs: { cards: 1 } });
  assert.equal(one.comingUp.length, 4);
  const planOne = weekPlan(W46, 1);
  for (const day of one.comingUp) {
    assert.deepEqual(Object.keys(day.slots), ["midday"], "one card, one slot: " + day.day);
    assert.equal(day.slots.midday, planOne[day.dayIndex].slots.midday);
  }

  const sunday = await weekView(db, { now: noon(2026, 11, 15), prefs: { cards: 3 } });
  assert.deepEqual(sunday.comingUp, [], "nothing comes after the last day of the week");
  assert.equal(sunday.strip.length, 7, "the strip is still the whole week");
});

test("weekView: a now that is not a clock still draws a week", async () => {
  const db = await freshDb();
  const view = await weekView(db, { now: "not a clock" });
  assert.equal(view.weekId, weekIdOf(Date.now()), "the wall clock's week");
  assert.equal(view.strip.length, 7, "seven days to draw");
  assert.equal(Array.isArray(view.comingUp), true);
});

test("a something-else log marks the area its activity trains", async () => {
  const db = await freshDb();
  const at = noon(2026, 11, 12);

  const marked = async (activity, { area, minutes = 20 } = {}) => {
    const log = await recordLog(db, { activity, minutes, effort: "moderate", area, now: at });
    const got = await markLogArea(db, { day: log.day, activity, minutes, area, now: at });
    return got;
  };

  for (const activity of ["walk", "jog", "run", "cycle", "swim", "sport"]) {
    // eslint-disable-next-line no-await-in-loop
    const got = await marked(activity);
    assert.equal(got.marked, true, activity + " marks its day");
    assert.equal(got.area, "heart", activity + " trains the heart");
  }

  const yoga = await marked("yoga");
  assert.deepEqual(yoga, { marked: true, area: "mobility", fresh: true });
  const band = await marked("band");
  assert.deepEqual(band, { marked: true, area: "upper", fresh: true });
  const bandCore = await marked("band", { area: "core" });
  assert.deepEqual(bandCore, { marked: true, area: "core", fresh: true });
  const bodyweight = await marked("bodyweight");
  assert.deepEqual(bodyweight, { marked: true, area: "core", fresh: false }, "core already marked today");
  const bodyweightLower = await marked("bodyweight", { area: "lower" });
  assert.deepEqual(bodyweightLower, { marked: true, area: "lower", fresh: true });

  const other = await marked("other");
  assert.deepEqual(other, { marked: false, area: null }, "other names no area");
  const short = await marked("walk", { minutes: 5 });
  assert.deepEqual(short, { marked: false, area: null }, "under ten minutes is not a chunk");

  // No day at all: the row is keyed by the day it files under.
  const noDay = await markLogArea(db, { activity: "yoga", minutes: 20, now: at });
  assert.deepEqual(noDay, { marked: false, area: null });
  const badDay = await markLogArea(db, { day: "yesterday", activity: "yoga", minutes: 20, now: at });
  assert.deepEqual(badDay, { marked: false, area: null });
});

test("coverage pays no Health and no seed: neither a marked log nor a full week", async () => {
  const db = await freshDb();
  const at = noon(2026, 11, 12);
  await fillWeek(db, weekDays(W46));

  const seedBefore = await seedAndSpend(db);
  const energyBefore = await petEnergy(db);

  await markLogArea(db, { day: "2026-11-12", activity: "walk", minutes: 20, now: at });
  assert.deepEqual(await seedAndSpend(db), seedBefore, "a marked area writes no seed and no spend");
  assert.equal(await petEnergy(db), energyBefore, "a marked area feeds nobody");

  const settled = await settleWeek(db, { now: at });
  assert.equal(settled.full, true);
  assert.deepEqual(await seedAndSpend(db), seedBefore, "a full week writes no seed and no spend");
  assert.equal(await petEnergy(db), energyBefore, "a full week feeds nobody");
  assert.equal(await rowsOfKind(db, WEEKFULL_KIND), 1, "the week's one earned row");
});

test("a chunk tagging two areas marks both on its day", async () => {
  const db = await freshDb();
  const got = await recordSlotDone(db, {
    day: "2026-11-12",
    slot: "midday",
    entry: entry(["mobility", "core"]),
    via: "player",
    now: NOON_W46,
  });
  assert.equal(got.fresh, true);
  assert.equal(await rowsOfKind(db, MOVE_AREA_KIND), 2);
  const view = await weekView(db, { now: NOON_W46 });
  assert.deepEqual(view.strip[3].areas, ["core", "mobility"], "AREAS order");
  assert.deepEqual(view.marks.mobility, ["2026-11-12"]);
  assert.deepEqual(view.marks.core, ["2026-11-12"]);
});

test("a one-card week of two-area chunks can be full", async () => {
  const db = await freshDb();
  const days = weekDays(W46);
  // Two areas a day, so every area of the five reaches at least two days.
  const pairs = [
    ["mobility", "lower"],
    ["mobility", "upper"],
    ["core", "upper"],
    ["core", "lower"],
    ["heart", "mobility"],
    ["heart", "core"],
    ["upper", "lower"],
  ];

  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const at = noon(2026, 11, 9 + i);
    // eslint-disable-next-line no-await-in-loop
    await recordSlotDone(db, {
      day, slot: "midday", entry: entry(pairs[i]), via: "player", now: at, need: 1,
    });
  }

  const state = await weekState(db, { now: noon(2026, 11, 15) });
  assert.equal(state.full, true, "one card a day is enough for a full week");
  assert.equal(state.total, 10);
  for (const area of AREAS) {
    assert.equal(Math.min(2, state.marks[area].length), 2, area + " on two days");
  }
  assert.equal(await rowsOfKind(db, WEEKFULL_KIND), 1, "the seventh day settles the week");
  assert.equal(await rowsOfKind(db, MOVE_AREA_KIND), 14, "two marks a day, one row each");
});

test("the week's item is written once, for the week it is asked about", async () => {
  const db = await freshDb();
  await fillWeek(db, weekDays(W46));

  const emitted = [];
  const emit = async (table, op, row) => {
    if (table === "ramble_wallet") emitted.push(`${row.kind} ${row.key}`);
  };

  const first = await settleWeek(db, { now: NOON_W46, emit });
  assert.deepEqual(first, { weekId: W46, full: true, fresh: true, itemId: "scarf.kerchief2" });
  const second = await settleWeek(db, { now: NOON_W46, emit });
  assert.deepEqual(second, { weekId: W46, full: true, fresh: false, itemId: "scarf.kerchief2" });
  assert.deepEqual(emitted, [`${WEEKFULL_KIND} ${W46}`], "one row, one emit");
  assert.equal(await rowsOfKind(db, WEEKFULL_KIND), 1);

  // The day decides the week that is judged, not the clock.
  const lastWeek = await settleWeek(db, { now: NOON_W46, day: "2026-11-05" });
  assert.deepEqual(lastWeek, { weekId: W45, full: false, fresh: false, itemId: null });
  assert.equal(await rowsOfKind(db, WEEKFULL_KIND), 1, "a week that is not full writes nothing");
});

test("a week that is not full writes nothing", async () => {
  const db = await freshDb();
  await insertMark(db, "2026-11-09:lower");
  const before = await walletRows(db);

  const got = await settleWeek(db, { now: NOON_W46, day: "2026-11-10" });
  assert.deepEqual(got, { weekId: W46, full: false, fresh: false, itemId: null });
  assert.equal(await walletRows(db), before, "no row for a week that is not full");
  assert.equal(await rowsOfKind(db, WEEKFULL_KIND), 0);
});

test("a month of full weeks earns a new colour each week, and owning it is derived", async () => {
  const db = await freshDb();
  await fillWeek(db, weekDays(W45));
  await fillWeek(db, weekDays(W46));

  const first = await settleWeek(db, { now: NOON_W46, day: "2026-11-05" });
  assert.deepEqual(first, { weekId: W45, full: true, fresh: true, itemId: "scarf.kerchief1" });
  const second = await settleWeek(db, { now: NOON_W46, day: "2026-11-12" });
  assert.deepEqual(second, { weekId: W46, full: true, fresh: true, itemId: "scarf.kerchief2" });

  const owned = await ownedItems(db);
  assert.equal(owned.has("scarf.kerchief1"), true);
  assert.equal(owned.has("scarf.kerchief2"), true);
  assert.equal(owned.size, 2);

  const again = await settleWeek(db, { now: NOON_W46, day: "2026-11-12" });
  assert.deepEqual(again, { weekId: W46, full: true, fresh: false, itemId: "scarf.kerchief2" });
  assert.equal(await rowsOfKind(db, WEEKFULL_KIND), 2, "one row a week, never a second");
  assert.equal((await ownedItems(db)).size, 2, "settling again changes nothing");
});

/* ----------------------------------------- the week view on the Today page */

/* static/week.js draws the week into #rb-week-view from the week route: the
 * title and the balance, the body outline whose five areas fill by lightness
 * and pattern alone, the five areas as a list with two pips each, the
 * seven-day strip and the plan for the days still ahead. It runs here in a vm
 * against a mini DOM and a stub of the hooks moves.js exposes, so a missing
 * copy key can be seen to draw nothing at all. */

const WEEK_TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEEK_ROOT = resolve(WEEK_TEST_DIR, "..");
const WEEK_SRC = readFileSync(resolve(WEEK_ROOT, "bundles/ramble/panel/static/week.js"), "utf8");
const WEEK_COPY = JSON.parse(readFileSync(resolve(WEEK_ROOT, "bundles/ramble/server/moves/player-copy.en.json"), "utf8"));

/** A table line with its {placeholders} filled the way moves.js fills them. */
function weekFill(table, key, values) {
  const line = typeof table[key] === "string" ? table[key] : "";
  if (line === "") return "";
  return line.replace(/\{([a-z]+)\}/g, (whole, name) => (
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  ));
}

function weekExpected(key, values) { return weekFill(WEEK_COPY, key, values); }

/* --------------------------------------------------------------- the mini DOM */

class MiniNode {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.className = "";
    this.type = "";
    this.disabled = false;
    this._text = "";
  }

  get firstChild() { return this.children.length > 0 ? this.children[0] : null; }

  get textContent() {
    let out = this._text;
    for (const kid of this.children) out += kid.textContent;
    return out;
  }

  set textContent(value) {
    for (const kid of this.children) kid.parentNode = null;
    this.children = [];
    this._text = value === null || value === undefined ? "" : String(value);
  }

  /* Nothing the week view draws is markup: setting this at all is a bug. */
  get innerHTML() { return ""; }
  set innerHTML(value) { throw new Error("the week view must never set innerHTML"); }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    /* A real element reflects its class attribute both ways. */
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  click() {
    for (const fn of (this.listeners.click || []).slice()) fn({ type: "click", target: this });
  }

  /** Every descendant (not this element itself) the predicate takes. */
  findAll(predicate) {
    const out = [];
    const walk = (parent) => {
      for (const kid of parent.children) {
        if (predicate(kid)) out.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return out;
  }
}

function weekHasClass(node, name) {
  return String(node.className || "").split(/\s+/).indexOf(name) !== -1;
}

/* --------------------------------------------------------------- fixtures */

/** A week of 6: legs and stretch twice, upper body and heart once, core never. */
function weekPayload() {
  const empty = [];
  return {
    weekId: W46,
    marks: {
      upper: ["2026-11-09"],
      core: empty.slice(),
      lower: ["2026-11-09", "2026-11-11"],
      heart: ["2026-11-11"],
      mobility: ["2026-11-09", "2026-11-11"],
    },
    total: 6,
    full: false,
    strip: [
      { day: "2026-11-09", minutes: 25, areas: ["lower", "mobility"] },
      { day: "2026-11-10", minutes: 0, areas: [] },
      { day: "2026-11-11", minutes: 0, areas: ["lower", "mobility", "heart"] },
      { day: "2026-11-12", minutes: 0, areas: [] },
      { day: "2026-11-13", minutes: 0, areas: [] },
      { day: "2026-11-14", minutes: 0, areas: [] },
      { day: "2026-11-15", minutes: 0, areas: [] },
    ],
    comingUp: [
      { day: "2026-11-12", dayIndex: 3, slots: { morning: "upper", midday: "free", evening: "core" } },
    ],
    stageOffer: null,
    earned: null,
  };
}

function weekDeep(value) { return JSON.parse(JSON.stringify(value)); }

/* ------------------------------------------------------------------ the boot */

async function weekFlush() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

function weekBoot(opts) {
  const options = opts || {};
  const byId = new Map();
  const host = new MiniNode("div");
  host.id = "rb-week-view";
  byId.set("rb-week-view", host);
  const todayHost = new MiniNode("div");
  todayHost.id = "rb-today-view";
  byId.set("rb-today-view", todayHost);

  let table = options.table === undefined ? WEEK_COPY : options.table;
  const state = { week: options.week || weekPayload() };
  const calls = [];
  const timers = [];
  const observers = [];
  const pageListeners = Object.create(null);

  function answer(body, ok = true) {
    return Promise.resolve({ status: ok ? 200 : 500, ok, json: () => Promise.resolve(body) });
  }

  const fetchStub = (url, init) => {
    const o = init || {};
    const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;
    calls.push({
      url: String(url),
      method: o.method || "GET",
      body,
      credentials: o.credentials,
      headers: o.headers || null,
    });
    if (String(url) === "/api/ramble/moves/week") return answer(state.week);
    if (String(url) === "/api/ramble/moves/stage") return answer({ ok: true });
    return answer({});
  };

  const sandbox = {
    console,
    fetch: fetchStub,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    addEventListener: (type, fn) => {
      (pageListeners[type] || (pageListeners[type] = [])).push(fn);
    },
    document: {
      visibilityState: "visible",
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => new MiniNode(tag),
      createElementNS: (ns, tag) => new MiniNode(tag),
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.RambleMoves = {
    whenCopy: () => Promise.resolve(table),
    copy: (key, values) => weekFill(table, key, values || {}),
  };
  /* The day's cards redraw themselves; only a page carrying the watcher can be
   * told to notice. A page without it is the default the other boots keep. */
  if (options.observer === true) {
    sandbox.MutationObserver = class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, settings) { this.target = target; this.settings = settings; }
    };
  }

  vm.createContext(sandbox);
  new vm.Script(WEEK_SRC, { filename: "week.js" }).runInContext(sandbox);

  return {
    host,
    sandbox,
    calls,
    observers,
    pageListeners,
    setWeek(next) { state.week = next; },
    setTable(next) { table = next; },
    runTimers() {
      const due = timers.splice(0, timers.length).filter((fn) => typeof fn === "function");
      for (const fn of due) fn();
    },
  };
}

function weekReads(booted) {
  return booted.calls.filter((call) => call.url === "/api/ramble/moves/week").length;
}

function weekPosts(booted) {
  return booted.calls.filter((call) => call.url === "/api/ramble/moves/stage");
}

function weekListRow(booted, area) {
  return booted.host.findAll((node) => (
    node.tagName === "LI" && node.getAttribute("data-area") === area
  ))[0] || null;
}

function weekShape(booted, area) {
  return booted.host.findAll((node) => (
    weekHasClass(node, "rb-wk-shape") && node.getAttribute("data-area") === area
  ))[0] || null;
}

function weekRing(booted) {
  return booted.host.findAll((node) => weekHasClass(node, "rb-wk-ring"))[0] || null;
}

function weekButton(booted, label) {
  return booted.host.findAll((node) => node.tagName === "BUTTON" && node.textContent === label)[0] || null;
}

/* ------------------------------------------------------------ what it draws */

test("week view: the title, the balance, five rows, seven days and the outline's states", async () => {
  const booted = weekBoot({});
  await weekFlush();

  assert.equal(weekReads(booted), 1, "the week was read once");
  const read = booted.calls[0];
  assert.equal(read.method, "GET");
  assert.equal(read.credentials, "same-origin");

  assert.ok(booted.host.textContent.includes(WEEK_COPY["week.title"]), "the week's own title");
  assert.ok(booted.host.textContent.includes("6 / 10"), "and the balance as digits only");

  const rows = booted.host.findAll((node) => node.tagName === "LI" && weekHasClass(node, "rb-wk-row"));
  assert.equal(rows.length, 5, "one row per area");
  assert.deepEqual(rows.map((row) => row.getAttribute("data-area")),
    ["lower", "mobility", "upper", "heart", "core"], "in the order the list reads");

  const progress = { lower: 2, mobility: 2, upper: 1, heart: 1, core: 0 };
  for (const area of ["lower", "mobility", "upper", "heart", "core"]) {
    const row = weekListRow(booted, area);
    assert.ok(row.textContent.includes(weekExpected("week.area." + area)), area + "'s own label");
    assert.ok(row.textContent.includes(weekExpected("week.area.progress", { done: progress[area] })),
      area + "'s progress line");
    const pips = row.findAll((node) => weekHasClass(node, "rb-wk-pip"));
    assert.equal(pips.length, 2, area + " has two pips");
    assert.equal(pips.filter((pip) => weekHasClass(pip, "rb-wk-pip-on")).length,
      Math.min(2, progress[area]), area + "'s pips are filled once per day");
  }

  const cells = booted.host.findAll((node) => weekHasClass(node, "rb-wk-day"));
  assert.equal(cells.length, 7, "seven days in the strip");
  assert.deepEqual(cells.map((cell) => cell.getAttribute("data-day")),
    ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.ok(cells[0].textContent.includes(weekExpected("week.dayMinutes", { minutes: 25 })),
    "the day's minutes say so");
  assert.equal(cells[1].textContent.includes(weekExpected("week.dayMinutes", { minutes: 0 })), false,
    "and a day of no minutes says nothing");
  const marks = cells[0].findAll((node) => weekHasClass(node, "rb-wk-mark"));
  assert.equal(marks.length, 2, "one mark per area worked");
  assert.deepEqual(marks.map((mark) => mark.getAttribute("title")),
    [weekExpected("week.area.lower"), weekExpected("week.area.mobility")], "each mark names its area");

  assert.equal(weekHasClass(weekShape(booted, "lower"), "rb-wk-a2"), true, "two days of legs are solid");
  assert.equal(weekHasClass(weekShape(booted, "upper"), "rb-wk-a1"), true, "one day of upper body is tinted");
  assert.equal(weekHasClass(weekShape(booted, "core"), "rb-wk-a0"), true, "no core day is the surface");
  assert.equal(weekHasClass(weekShape(booted, "heart"), "rb-wk-a1"), true);
  assert.equal(weekHasClass(weekRing(booted), "rb-wk-a2"), true, "and stretch is the solid ring");

  const svg = booted.host.findAll((node) => weekHasClass(node, "rb-wk-outline"))[0];
  assert.ok(svg, "the outline is on the page");
  assert.equal(svg.getAttribute("role"), "img");
  const label = svg.getAttribute("aria-label");
  assert.ok(label.includes(weekExpected("week.area.lower")) && label.includes(weekExpected("week.area.core")),
    "the outline names every area");
  assert.ok(label.includes(weekExpected("week.area.progress", { done: 2 })),
    "and says how far each one has come");

  assert.ok(booted.host.textContent.includes(WEEK_COPY["week.comingUp"]), "the week ahead is named");
  assert.ok(booted.host.textContent.includes(weekExpected("week.area.upper")), "and lists its areas");
});

test("week view: a copy key the table does not carry draws nothing, and never throws", async () => {
  const booted = weekBoot({ table: {} });
  await weekFlush();

  assert.equal(booted.host.findAll((node) => node.tagName === "H3").length, 0,
    "no title without its line");
  const text = booted.host.textContent;
  assert.ok(text.includes("6 / 10"), "the balance is digits, so it needs no words");
  for (const key of ["week.title", "week.comingUp", "week.whole", "week.stage.ask"]) {
    assert.equal(text.includes(WEEK_COPY[key]), false, key + " has no line to draw");
  }
  assert.equal(/of 2 days/.test(text), false, "nor any progress line");
  assert.equal(weekListRow(booted, "lower"), null, "no row without its words");
  assert.equal(weekButton(booted, WEEK_COPY["week.stage.yes"]), null, "and no button either");
  assert.equal(booted.host.findAll((node) => weekHasClass(node, "rb-wk-mark")).length, 0,
    "a mark with no area to name is left out");
  assert.equal(booted.host.findAll((node) => weekHasClass(node, "rb-wk-day")).length, 7,
    "the seven days are still drawn");
  assert.equal(WEEK_SRC.includes("innerHTML"), false, "and every word went in as text");
});

test("week view: the stage offer asks its question and posts the answer it was given", async () => {
  const offered = weekDeep(weekPayload());
  offered.stageOffer = { routineId: "rt-week-1", title: "Steady ten", stage: 2, total: 3 };
  const booted = weekBoot({ week: offered });
  await weekFlush();

  assert.ok(booted.host.textContent.includes(WEEK_COPY["week.stage.ask"]), "the question is asked");
  assert.ok(booted.host.textContent.includes("Steady ten"), "over the routine's own title");
  const yes = weekButton(booted, weekExpected("week.stage.yes"));
  const no = weekButton(booted, weekExpected("week.stage.no"));
  assert.ok(yes, "and there is a yes");
  assert.ok(no, "and a no");
  assert.equal(yes.type, "button", "both are real buttons");
  assert.equal(no.type, "button");

  const before = weekReads(booted);
  yes.click();
  await weekFlush();

  const posts = weekPosts(booted);
  assert.equal(posts.length, 1, "one answer was sent");
  assert.equal(posts[0].method, "POST");
  assert.equal(posts[0].credentials, "same-origin");
  assert.match(String(posts[0].headers["Content-Type"]), /application\/json/);
  assert.deepEqual(posts[0].body, { routineId: "rt-week-1", answer: "yes" }, "naming the routine it answers");
  assert.equal(weekReads(booted), before + 1, "and the week is read again afterwards");

  const declined = weekBoot({ week: offered });
  await weekFlush();
  weekButton(declined, weekExpected("week.stage.no")).click();
  await weekFlush();
  assert.deepEqual(weekPosts(declined)[0].body, { routineId: "rt-week-1", answer: "no" });
});

test("week view: a full week says so, and a week that is not full does not", async () => {
  const full = weekDeep(weekPayload());
  full.full = true;
  full.total = 10;
  full.earned = { itemId: "scarf.kerchief2", name: "Fern" };
  const whole = weekBoot({ week: full });
  await weekFlush();
  assert.ok(whole.host.textContent.includes(WEEK_COPY["week.whole"]), "the whole week's line");
  assert.ok(whole.host.textContent.includes("10 / 10"), "and the balance that earned it");

  const partial = weekBoot({ week: weekPayload() });
  await weekFlush();
  assert.equal(partial.host.textContent.includes(WEEK_COPY["week.whole"]), false,
    "a week still filling says nothing of the sort");
});

test("week view: a change in the day's cards reads the week again once it settles", async () => {
  const booted = weekBoot({ observer: true });
  await weekFlush();
  const before = weekReads(booted);

  assert.equal(booted.observers.length, 1, "the day's host is watched");
  assert.equal(booted.observers[0].settings.childList, true, "for its children changing");
  booted.observers[0].callback([], {});
  assert.equal(weekReads(booted), before, "a burst of changes waits");

  booted.runTimers();
  await weekFlush();
  assert.equal(weekReads(booted), before + 1, "and is read as one week afterwards");
});

test("week.js carries no backtick, and writes no markup", () => {
  assert.equal((WEEK_SRC.match(/`/g) || []).length, 0,
    "panel client scripts must not carry a backtick: the tooling treats it as its own delimiter");
  assert.equal(WEEK_SRC.includes("innerHTML"), false, "every server string is written with textContent");
  assert.ok(WEEK_SRC.endsWith("\n"), "the file ends with a newline");
  assert.ok(readFileSync(fileURLToPath(import.meta.url), "utf8").endsWith("\n"), "and so does this test file");
});
