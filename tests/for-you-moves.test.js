/**
 * For You v1 — the Move card (Ramble's today's challenge, Done/Swap, the bird's Health, steps and
 * streak).
 *
 * What is pinned here:
 *   - the gateway loader (for-you/moves.js): Ramble missing is "missing", an old copy "update", a
 *     throwing copy "error" (each hides only this section), and the page's weather reaches the
 *     bundle as { rain, temp, code } and nothing else;
 *   - Ramble's own module (bundles/ramble/server/for-you.js) over a scratch ramble db: the
 *     challenge shape, Done filed under the challenge's day, the streak, and challenges off;
 *   - the card's markup: an escaped title, Start/Done/Swap/something-else, the health bar, steps,
 *     the streak, and the quiet line when challenges are off;
 *   - the page: the Move card sits after Your morning and before Listen, its Customize switch
 *     hides it, and with Ramble absent (or failing) the page renders without it and without an
 *     error — and the owner gate still answers 404 for anyone else;
 *   - the client JS: no backtick (it is emitted inside a template literal), Done posts the
 *     challenge's own day, and the card is repainted from the returned JSON with textContent only.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { csrfTokenFor } from "./helpers/csrf-token.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "for-you-moves-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_FOR_YOU = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-for-you-moves");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const DAY = "2026-10-30";
/** Ramble's forYouMoves shape (what the bundle module returns and the card renders). */
function snapshot(over = {}) {
  return {
    challenge: {
      day: DAY, title: "Morning stretch", minutes: 10, why: "A good way to start the morning.",
      done: false, entryId: "ex-1", ...(over.challenge || {}),
    },
    health: { energy: 18, max: 30, ...(over.health || {}) },
    steps: { today: 3200, goal: 6000, ...(over.steps || {}) },
    streak: { days: 4, ...(over.streak || {}) },
  };
}

/** The routes' own snapshot shape (the JSON a Done or a Swap returns): the entry is nested. */
function routeSnapshot(over = {}) {
  return {
    challenge: {
      day: DAY, entry: { id: "ex-1", title: "Morning stretch", minutes: 10 },
      reasons: ["slot:day"], why: "A good way to start the morning.", done: false, off: false, swap: 0,
      ...(over.challenge || {}),
    },
    health: { energy: 18, max: 30, ...(over.health || {}) },
    steps: { day: DAY, steps: 3200, goal: 6000, ...(over.steps || {}) },
    streak: { days: 4, ...(over.streak || {}) },
  };
}

// ---- the gateway loader ------------------------------------------------------

let M, B, H;
before(async () => {
  M = await import("../servers/gateway/for-you/moves.js");
  B = await import("../bundles/ramble/server/for-you.js");
  H = await import("../servers/gateway/dashboard/panels/for-you/html.js");
});

test("loader: Ramble absent is 'missing'; an old copy 'update'; a copy that throws is 'error', never the page's", async () => {
  writeFileSync(join(HOME, "installed.json"), "[]");
  M._setMovesModuleForTest(null);
  const db = createClient({ url: "file::memory:" });
  try {
    assert.deepEqual(await M.loadMoves(db, { crowHome: HOME }), { ramble: "missing" });
    M._setMovesModuleForTest({});
    assert.deepEqual(await M.loadMoves(db, { crowHome: HOME }), { ramble: "update" });
    M._setMovesModuleForTest({ forYouMoves: async () => { throw new Error("no such column: moves"); } });
    assert.deepEqual(await M.loadMoves(db, { crowHome: HOME }), { ramble: "error" });
  } finally { M._setMovesModuleForTest(null); db.close(); }
});

test("loader: the page's weather reaches Ramble as { rain, temp, code }, and nothing else does", async () => {
  const seen = [];
  M._setMovesModuleForTest({ forYouMoves: async (db, opts) => { seen.push(opts); return snapshot(); } });
  const db = createClient({ url: "file::memory:" });
  try {
    const ok = await M.loadMoves(db, {
      crowHome: HOME, now: 1_000,
      weather: { temp: 21, code: 0, high: 25, low: 12, rain: 30, unit: "celsius" },
    });
    assert.equal(ok.ramble, "ok");
    assert.equal(ok.moves.challenge.title, "Morning stretch");
    assert.deepEqual(seen[0].weather, { rain: 30, temp: 21, code: 0 });
    assert.equal(seen[0].now, 1_000);
    assert.equal(seen[0].lang, "en", "the page's language defaults to English");
    await M.loadMoves(db, { crowHome: HOME, now: 2_000, weather: null });
    assert.equal(seen[1].weather, null);
    await M.loadMoves(db, { crowHome: HOME, now: 3_000, weather: null, lang: "es" });
    assert.equal(seen[2].lang, "es", "the page's language reaches the bundle, so the why line is Spanish");
    assert.deepEqual(M.moveWeather({ temp: 21 }), { temp: 21 });
    for (const junk of [{}, { temp: "warm" }, null, "hot", 4]) assert.equal(M.moveWeather(junk), null, String(junk));
  } finally { M._setMovesModuleForTest(null); db.close(); }
});

// ---- Ramble's module ---------------------------------------------------------

/** A picker- and ledger-shaped entry. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "routine",
    title: "A short bodyweight flow",
    minutes: 10,
    level: 2,
    indoor: true,
    activity: "bodyweight",
    equipment: ["none"],
    tags: [],
    steps: ["do the thing"],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [],
    reviewed: true,
    pose: {},
    ...over,
  };
}

async function rambleDb() {
  const { initRambleTables } = await import("../bundles/ramble/server/init-tables.js");
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

test("Ramble's module: today's challenge, the bird's Health, today's steps and the streak; Done files under the card's day", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime(); // local noon: the picker's "day" slot
    const lib = [entry()];
    const first = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.equal(first.off, false);
    assert.deepEqual(Object.keys(first.challenge).sort(), ["day", "done", "entryId", "minutes", "title", "why"]);
    assert.equal(first.challenge.day, DAY);
    assert.equal(first.challenge.title, "A short bodyweight flow");
    assert.equal(first.challenge.minutes, 10);
    assert.equal(first.challenge.entryId, "ex-1");
    assert.equal(first.challenge.done, false);
    assert.equal(first.challenge.why, "A good way to break up the day.");
    assert.equal(first.health.max >= first.health.energy, true);
    assert.deepEqual(first.steps, { today: 0, goal: 6000 });
    assert.equal(first.streak.days, 0);

    // The why line follows the page's language, from the same stored reason codes.
    const es = await B.forYouMoves(db, { now, weather: null, library: lib, lang: "es" });
    assert.equal(es.challenge.why, "Una buena forma de cortar el día.");

    const { recordChallengeDone } = await import("../bundles/ramble/server/moves/ledger.js");
    await recordChallengeDone(db, { day: first.challenge.day, entry: entry(), now });
    const after = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.equal(after.challenge.done, true, "Done is per day: the card stays, marked done");
    assert.equal(after.challenge.day, DAY);
    assert.ok(after.health.energy >= first.health.energy, "the move pays Health");
    assert.equal(after.streak.days, 1, "a Done day is a streak day");

    // Nothing free-text can ride out: the challenge is these six fields, health/steps/streak these,
    // and the day's own fields are the slot name, the lengths, one flag per slot, the minutes and
    // the week's total.
    assert.deepEqual(Object.keys(after).sort(), [
      "challenge", "health", "lengths", "minutesToday", "off", "slot", "slots", "steps", "streak", "week",
    ]);
    assert.deepEqual(Object.keys(after.health).sort(), ["energy", "max"]);
    assert.deepEqual(Object.keys(after.steps).sort(), ["goal", "today"]);
    assert.deepEqual(Object.keys(after.streak), ["days"]);
  } finally { db.close(); }
});

test("Ramble's module: a fresh day carries the Now slot, the three lengths, one entry per non-empty slot and an empty week", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime(); // local noon: the picker's midday
    const lib = areaChunks();
    const card = await B.forYouMoves(db, { now, weather: null, library: lib });
    const { dayCards } = await import("../bundles/ramble/server/moves/slots.js");
    const day = await dayCards(db, { now, weather: null, library: lib });

    assert.equal(card.slot, day.nowSlot, "the Now slot of the day the card was drawn from");
    assert.equal(card.slot, "midday");
    assert.deepEqual(card.lengths, [10, 20, 30]);

    const filled = day.slots.filter((item) => item.empty !== true);
    assert.ok(filled.length > 0, "the day has cards");
    assert.deepEqual(card.slots.map((item) => item.slot), filled.map((item) => item.slot),
      "one entry per non-empty slot, in the day's order");
    for (const item of card.slots) {
      assert.deepEqual(Object.keys(item).sort(), ["done", "slot"]);
      assert.equal(item.done, false, item.slot);
    }

    assert.equal(card.minutesToday, 0, "no movemin row yet");
    assert.deepEqual(card.week, { total: 0 });
  } finally { db.close(); }
});

test("Ramble's module: a done card reads done in its own slot only, and minutesToday is the day's movemin row", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
    const lib = areaChunks();
    const fresh = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.ok(fresh.slots.length > 1, "a fresh day has more than one card to tell apart");
    assert.equal(fresh.minutesToday, 0);

    const target = fresh.slots[fresh.slots.length - 1];
    const { recordSlotDone } = await import("../bundles/ramble/server/moves/day.js");
    await recordSlotDone(db, {
      day: fresh.challenge.day, slot: target.slot, entry: { kind: "routine", areas: ["mobility"] }, via: "player", now,
    });
    const { insertOnce } = await import("../bundles/ramble/server/steps.js");
    const { MOVE_MIN_KIND } = await import("../bundles/ramble/server/moves/progress.js");
    await insertOnce(db, MOVE_MIN_KIND, fresh.challenge.day, 12, now);

    const after = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.deepEqual(after.slots.map((item) => item.slot), fresh.slots.map((item) => item.slot),
      "the day's slots stay the day's slots");
    assert.equal(after.slots.find((item) => item.slot === target.slot).done, true,
      "the closed slot reads done");
    for (const item of after.slots) {
      if (item.slot === target.slot) continue;
      assert.equal(item.done, false, item.slot);
    }
    assert.equal(after.minutesToday, 12, "the day's whole active minutes");
  } finally { db.close(); }
});

test("Ramble's module: challenges off leaves the answer without the day's fields, and off is still the reason", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
    const { writePrefs } = await import("../bundles/ramble/server/moves/today.js");
    await writePrefs(db, { on: false });

    const off = await B.forYouMoves(db, { now, weather: null, library: areaChunks() });
    assert.equal(off.off, true);
    assert.equal(off.challenge, null);
    for (const key of ["slot", "lengths", "slots", "minutesToday", "week"]) {
      assert.equal(Object.hasOwn(off, key), false, `${key} is absent on an off day`);
    }
    assert.deepEqual(Object.keys(off).sort(), ["challenge", "health", "off", "steps", "streak"],
      "exactly the shape the card has always been handed");
  } finally { db.close(); }
});

test("Ramble's module: no entry the picker can serve is a null challenge; challenges off is the quiet flag, not an error", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
    const none = await B.forYouMoves(db, { now, library: [] });
    assert.equal(none.challenge, null);
    assert.equal(none.off, false);
    assert.equal(none.streak.days, 0);

    const { writePrefs } = await import("../bundles/ramble/server/moves/today.js");
    await writePrefs(db, { on: false });
    const off = await B.forYouMoves(db, { now, library: [entry()] });
    assert.equal(off.off, true);
    assert.equal(off.challenge, null);
    assert.deepEqual(Object.keys(off.health).sort(), ["energy", "max"], "Health still shows");
  } finally { db.close(); }
});

/** One chunk per area, three of each, so every slot of a three-card day fills. */
function areaChunks() {
  const out = [];
  for (const area of ["mobility", "heart", "lower", "upper", "core"]) {
    for (const n of [1, 2, 3]) {
      out.push(entry({ id: `${area}-${n}`, title: `A ${area} chunk, number ${n}`, areas: [area] }));
    }
  }
  return out;
}

async function readMovesSetting(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key],
  });
  return rows[0]?.value ?? null;
}

test("Ramble's module: read first, the card is the day's Now slot; the day after that is a read", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime(); // local noon: the picker's midday
    const lib = areaChunks();
    const card = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.ok(card.challenge, "the day has a card");

    const { dayCards } = await import("../bundles/ramble/server/moves/slots.js");
    const day = await dayCards(db, { now, weather: null, library: lib });
    const nowSlot = day.slots.find((item) => item.slot === day.nowSlot);
    assert.ok(nowSlot?.entryId, "the Now slot holds a card");
    assert.equal(card.challenge.entryId, nowSlot.entryId,
      "the single card is the Now slot of the day's cards");

    const mirror = await readMovesSetting(db, "moves.today");
    assert.equal(JSON.parse(mirror).entryId, nowSlot.entryId);
    await dayCards(db, { now, weather: null, library: lib });
    assert.equal(await readMovesSetting(db, "moves.today"), mirror,
      "a second read of the day writes no moves.today change");
  } finally { db.close(); }
});

/**
 * A library whose heart slot can go either way: one heart chunk needs the outdoors, one does not,
 * and every other chunk is indoor. The outdoor one also trains upper, so it is the picker's
 * preferred heart chunk while the forecast lets it through.
 */
function weatherChunks() {
  return [
    entry({ id: "heart-out", title: "A heart walk in the park", areas: ["heart", "upper"], indoor: false }),
    entry({ id: "heart-in", title: "A heart chunk indoors", areas: ["heart"] }),
    entry({ id: "mobility-1", title: "A mobility chunk", areas: ["mobility"] }),
    entry({ id: "upper-1", title: "An upper chunk", areas: ["upper"] }),
    entry({ id: "lower-1", title: "A lower chunk", areas: ["lower"] }),
    entry({ id: "core-1", title: "A core chunk", areas: ["core"] }),
  ];
}

test("Ramble's module: the weather switch reaches the day's cards, so a forecast the user turned off draws no slot", async () => {
  const now = new Date(2026, 9, 30, 12, 0, 0).getTime(); // local noon: the picker's midday, the heart slot
  const rain = { rain: 90, temp: 14, code: 61 };
  const lib = weatherChunks();
  const { dayCards } = await import("../bundles/ramble/server/moves/slots.js");
  const { writePrefs } = await import("../bundles/ramble/server/moves/today.js");
  const middayOf = (day) => day.slots.find((item) => item.slot === "midday");

  // Weather on (the default): the rain keeps every slot of the day indoors.
  const wet = await rambleDb();
  try {
    const card = await B.forYouMoves(wet, { now, weather: rain, library: lib });
    const day = await dayCards(wet, { now, weather: rain, library: lib });
    for (const item of day.slots) {
      assert.notEqual(item.entryId, null, item.slot);
      assert.equal(lib.find((e) => e.id === item.entryId).indoor, true, item.slot);
    }
    assert.equal(middayOf(day).entryId, "heart-in", "the heart slot takes the indoor chunk");
    assert.equal(card.challenge.entryId, middayOf(day).entryId, "the card is the day's Now slot");
  } finally { wet.close(); }

  // Weather off: the page's rain never reaches the picker, so the day is drawn as it is with no
  // weather at all — the picker's own no-weather draw on a second fresh db is the expectation.
  const none = await rambleDb();
  const off = await rambleDb();
  try {
    const noWeather = await dayCards(none, { now, weather: null, library: lib });
    assert.equal(middayOf(noWeather).entryId, "heart-out",
      "with no weather the picker is free to take the outdoor heart chunk");

    await writePrefs(off, { weather: false });
    const card = await B.forYouMoves(off, { now, weather: rain, library: lib });
    const stored = JSON.parse(await readMovesSetting(off, "moves.slot.midday"));
    assert.equal(stored.entryId, middayOf(noWeather).entryId,
      "the heart slot is drawn exactly as it is with weather null");
    assert.notEqual(stored.entryId, "heart-in", "the rain no longer reaches the slot");
    assert.equal(card.challenge.entryId, stored.entryId, "and the card is that slot");
  } finally { none.close(); off.close(); }
});

// ---- the card's markup -------------------------------------------------------

const movesOk = () => ({
  ramble: "ok",
  moves: {
    challenge: { day: DAY, title: "Morning stretch", minutes: 10, why: "A good way to start the morning.", done: false, entryId: "ex-1" },
    off: false,
    health: { energy: 18, max: 30 },
    steps: { today: 3200, goal: 6000 },
    streak: { days: 4 },
  },
});

/** The same card with the day's block (P13): the Now slot, the lengths, the dots, today, the week. */
const movesDay = (over = {}) => ({
  ramble: "ok",
  moves: {
    ...movesOk().moves,
    slot: "morning",
    lengths: [10, 20, 30],
    slots: [{ slot: "morning", done: true }, { slot: "midday", done: false }, { slot: "evening", done: false }],
    minutesToday: 20,
    week: { total: 6 },
    ...over,
  },
});

test("the card: the title and the why line are escaped, and Start, Done, Swap and something else are there", () => {
  const out = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, challenge: {
    day: DAY, title: 'He said "<b>hi</b>" & left', minutes: 10, why: "A & B <script>", done: false, entryId: "ex-1",
  } } }, "en");
  assert.match(out, /He said &quot;&lt;b&gt;hi&lt;\/b&gt;&quot; &amp; left/);
  assert.doesNotMatch(out, /<b>hi<\/b>|<script>/);
  assert.match(out, /A &amp; B &lt;script&gt;/);

  const page = H.movesHtml(movesOk(), "en");
  assert.match(page, /<h2 class="fy-kicker" id="fy-moves-h">Move<\/h2>/);
  assert.match(page, /<a class="fy-btn fy-btn--primary" href="\/dashboard\/ramble\?moves=start">Start<\/a>/);
  assert.match(page, /<button type="button" class="fy-btn" data-fy-move="done" data-day="2026-10-30">Done<\/button>/);
  assert.match(page, /<button type="button" class="fy-btn" data-fy-move="swap">Swap<\/button>/);
  assert.match(page, /<a class="fy-more-link" href="\/dashboard\/ramble\?moves=log">I did something else<\/a>/);
  assert.match(page, /10 min/);
  assert.match(page, /A good way to start the morning\./);
  assert.match(page, /18 of 30 health/);
  assert.match(page, /width:60%/);
  assert.match(page, /3200 of 6000 steps/);
  assert.match(page, /4-day streak/);
  assert.match(page, /aria-label="18 of 30 health"/);
});

test("the card: a done challenge shows the done state; challenges off is one quiet line with the way back on", () => {
  const done = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, challenge: { ...movesOk().moves.challenge, done: true } } }, "en");
  assert.match(done, /<button type="button" class="fy-btn" data-fy-move="done" data-day="2026-10-30" disabled>Done today<\/button>/);

  const off = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, off: true, challenge: null } }, "en");
  assert.match(off, /Daily challenges are off\./);
  assert.match(off, /href="\/dashboard\/ramble\?moves=prefs">Turn them on<\/a>/);
  assert.doesNotMatch(off, /data-fy-move="/, "nothing to press while they are off");

  const none = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, challenge: null } }, "en");
  assert.match(none, /No challenge today\./);
  assert.match(none, /href="\/dashboard\/ramble\?moves=start">Open Ramble</);
});

test("the card: missing, outdated or failing Ramble hides the whole section; es has its own words", () => {
  for (const state of [{ ramble: "missing" }, { ramble: "update" }, { ramble: "error" }, { ramble: "ok", moves: null }, null]) {
    assert.equal(H.movesHtml(state, "en"), "", JSON.stringify(state));
  }
  const es = H.movesHtml(movesOk(), "es");
  assert.match(es, /id="fy-moves-h">Movimiento</);
  assert.match(es, />Empezar</);
  assert.match(es, />Hecho</);
  assert.match(es, />Cambiar</);
  assert.match(es, />Hice otra cosa</);
  assert.match(es, /18 de 30 de salud/);
  assert.match(es, /3200 de 6000 pasos/);
  assert.match(es, /4 días seguidos/);
  // A single day reads in the singular.
  assert.match(H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, streak: { days: 1 } } }, "es"), /1 día seguido/);
});

test("the card: the day's block draws the Now slot's Start link, the lengths, the dots, today and the week", () => {
  const out = H.movesHtml(movesDay(), "en");
  assert.match(out, /10 min/);
  assert.match(out, /data-fy-move-lengths/);
  assert.match(out, /or 20/, "a longer length is a button");
  assert.match(out, /or 30/);
  assert.match(out, /<button type="button" class="fy-btn fy-len" data-fy-len="20" aria-pressed="false">or 20<\/button>/);
  assert.match(out, /<button type="button" class="fy-btn fy-len" data-fy-len="30" aria-pressed="false">or 30<\/button>/);
  assert.doesNotMatch(out, /data-fy-len="10"/, "the card's own length is not offered again");
  assert.match(out, /data-fy-move-dots/);
  assert.match(out, /<span class="fy-move-dot" data-fy-dot="morning" data-done="1" role="img" aria-label="Morning · Done today"/);
  assert.match(out, /data-fy-dot="midday" data-done="0" role="img" aria-label="Midday"/);
  assert.match(out, /data-fy-dot="evening" data-done="0" role="img" aria-label="Evening"/);
  assert.equal((out.match(/fy-move-dot"/g) || []).length, 3, "one dot per slot");
  assert.match(out, /20 min today/);
  assert.match(out, /Week: 6 of 10/);
  assert.match(out, /<a class="fy-btn fy-btn--primary" href="\/dashboard\/ramble\?moves=start&amp;slot=morning" data-fy-move-start data-fy-start-base="\/dashboard\/ramble\?moves=start&amp;slot=morning">Start<\/a>/);
});

test("the card: the day's block hides the old length line and gives the lengths line its own first span", () => {
  const out = H.movesHtml(movesDay(), "en");
  assert.match(out, /<p class="fy-tile-meta" data-fy-move-minutes hidden>10 min<\/p>/,
    "the length is shown once, by the lengths line");
  assert.match(out, /<p class="fy-tile-meta" data-fy-move-lengths><span data-fy-move-len-first>10 min<\/span>/);
  assert.equal(out.includes("data-fy-move-len-first"), true);

  const older = H.movesHtml(movesOk(), "en");
  assert.match(older, /<p class="fy-tile-meta" data-fy-move-minutes>10 min<\/p>/,
    "without a day block the old line is not hidden");
  assert.equal(older.includes("data-fy-move-len-first"), false);
});

test("the card: a card of 0 minutes offers no other length", () => {
  const out = H.movesHtml(movesDay({ challenge: {
    day: DAY, title: "Stand up", minutes: 0, why: "", done: false, entryId: "ex-1",
  } }), "en");
  assert.match(out, /data-fy-move-lengths/, "the day block is still drawn");
  assert.match(out, /data-fy-move-len-first>0 min</);
  assert.doesNotMatch(out, /data-fy-len/, "nothing to press next to 0 min");
  assert.doesNotMatch(out, /or 20|or 30/);
});

test("the card: no minutes today says nothing about them; an unknown slot name keeps the old Start link", () => {
  const none = H.movesHtml(movesDay({ minutesToday: 0 }), "en");
  assert.doesNotMatch(none, /min today/);
  assert.doesNotMatch(none, /data-fy-move-minutes-today/);
  assert.match(none, /Week: 6 of 10/, "the week still shows");

  const odd = H.movesHtml(movesDay({ slot: "eveningish", week: { total: 40 } }), "en");
  assert.match(odd, /href="\/dashboard\/ramble\?moves=start" data-fy-move-start/);
  assert.doesNotMatch(odd, /data-fy-move-slot/, "no Now slot to mark done");
  assert.match(odd, /Week: 10 of 10/, "the week's total is clamped");
});

test("the card: without slots (an older Ramble) the markup is the card it has always been", () => {
  const out = H.movesHtml(movesOk(), "en");
  assert.match(out, /<a class="fy-btn fy-btn--primary" href="\/dashboard\/ramble\?moves=start">Start<\/a>/);
  assert.doesNotMatch(out, /data-fy-move-lengths|data-fy-dot|data-fy-len|data-fy-move-start|data-fy-start-base|data-fy-move-slot/);
  assert.doesNotMatch(out, /min today|Week:/);
  assert.equal(H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, slots: [] } }, "en"), out,
    "an empty slot list is no block at all");
});

test("the card: a title with markup in it is still escaped on the day's card", () => {
  const out = H.movesHtml(movesDay({ challenge: {
    day: DAY, title: 'He said "<b>hi</b>" & left', minutes: 10, why: "A & B <script>", done: false, entryId: "ex-1",
  } }), "en");
  assert.match(out, /He said &quot;&lt;b&gt;hi&lt;\/b&gt;&quot; &amp; left/);
  assert.doesNotMatch(out, /<b>hi<\/b>|<script>/);
});

test("the page puts Move after Your morning and before Listen; every section off says so", () => {
  const settings = { sections: { morning: true, moves: true, listen: true, news: false, weather: false }, city: "", place: null };
  const morning = { needs: { total: 0, items: [] }, due: { total: 0, items: [] }, finished: { total: 0, items: [] }, leftOff: null };
  const page = H.forYouPageHtml({
    settings, dateText: "Friday, October 30", morning, moves: movesOk(), listen: { media: "missing", music: false }, news: null, weather: null,
  }, "en");
  const at = (re) => page.search(re);
  assert.ok(at(/id="fy-moves-h">Move</) > at(/id="fy-morning-h"/), "after Your morning");
  assert.ok(at(/id="fy-moves-h">Move</) < at(/id="fy-listen-h">Listen</), "before Listen");
  assert.match(page, /data-fy-move="done" data-day="2026-10-30"/);

  const offPage = H.forYouPageHtml({
    settings: { ...settings, sections: { morning: true, moves: false, listen: true, news: false, weather: false } },
    dateText: "Friday, October 30", morning, moves: movesOk(), listen: { media: "missing", music: false }, news: null, weather: null,
  }, "en");
  assert.doesNotMatch(offPage, /fy-moves-h/, "the switch hides the card");
  assert.match(offPage, /fy-listen-h/, "and only that card");
});

// ---- the client JS -----------------------------------------------------------

test("the client JS has no backtick (it is emitted inside a template literal)", async () => {
  const { forYouClientJs } = await import("../servers/gateway/dashboard/panels/for-you/client.js");
  assert.ok(!forYouClientJs().includes("`"));
});

function movesRig(moves) {
  return import("../servers/gateway/dashboard/panels/for-you/client.js").then(({ forYouClientJs }) => {
    const card = H.movesHtml({ ramble: "ok", moves: moves || movesOk().moves }, "en");
    const { document, window } = parseHTML(`<!doctype html><html><body><main data-fy data-fy-failed="That didn't save">${card}</main></body></html>`);
    Object.defineProperty(document, "cookie", { value: "crow_csrf=t", configurable: true });
    const posts = [];
    let reply = routeSnapshot({ challenge: { entry: { id: "ex-1", title: "New <img src=x onerror=alert(1)>", minutes: 10 }, done: true, why: "" } });
    let fail = false;
    const fetchStub = (url, opts) => {
      posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (fail) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200, json: async () => reply });
    };
    const ctx = vm.createContext({ window, document, fetch: fetchStub, JSON, String, Number, Math, encodeURIComponent, decodeURIComponent, Promise });
    vm.runInContext(forYouClientJs().replace(/^<script>|<\/script>\s*$/g, ""), ctx);
    const click = (verb) => document.querySelector('[data-fy-move="' + verb + '"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    const clickOn = (sel) => document.querySelector(sel).dispatchEvent(new window.Event("click", { bubbles: true }));
    return {
      document, posts, click, clickOn,
      reply(next) { reply = next; },
      failOn() { fail = true; },
      async settle() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); },
    };
  });
}

test("the client: Done posts the challenge's own day, and the card is repainted from the JSON with textContent only", async () => {
  const r = await movesRig();
  r.click("done");
  await r.settle();
  assert.deepEqual(r.posts, [{ url: "/api/ramble/moves/done", body: { day: DAY } }]);
  const title = r.document.querySelector("[data-fy-move-title]");
  assert.equal(title.textContent, "New <img src=x onerror=alert(1)>");
  assert.equal(r.document.querySelectorAll("img").length, 0, "never parsed as HTML");
  const done = r.document.querySelector('[data-fy-move="done"]');
  assert.equal(done.textContent, "Done today");
  assert.equal(done.disabled, true);
  assert.equal(r.document.querySelector("[data-fy-move-why]").hasAttribute("hidden"), true, "an empty why line is hidden");
  assert.equal(r.document.querySelector("[data-fy-move-energy]").textContent, "18 of 30 health");
});

test("the client: the streak line is singular at one day", async () => {
  const r = await movesRig();
  r.reply(routeSnapshot({ streak: { days: 1 } }));
  r.click("done");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-streak]").textContent, "1-day streak");

  const plural = await movesRig();
  plural.click("done");
  await plural.settle();
  assert.equal(plural.document.querySelector("[data-fy-move-streak]").textContent, "4-day streak");
});

test("the client: a Swap repaint writes the new length into the lengths line's first span", async () => {
  const r = await movesRig(movesDay().moves);
  const first = () => r.document.querySelector("[data-fy-move-len-first]");
  assert.equal(first().textContent, "10 min");
  r.reply(routeSnapshot({ challenge: { entry: { id: "ex-2", title: "Another one", minutes: 25 } } }));
  r.click("swap");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-minutes]").textContent, "25 min");
  assert.equal(first().textContent, "25 min", "the line that is shown follows the card too");
});

test("the client: a length button rewrites the Start link, one at a time, with no call", async () => {
  const r = await movesRig(movesDay().moves);
  const start = () => r.document.querySelector("[data-fy-move-start]").getAttribute("href");
  const pressed = (n) => r.document.querySelector('[data-fy-len="' + n + '"]').getAttribute("aria-pressed");
  assert.equal(start(), "/dashboard/ramble?moves=start&slot=morning");
  r.clickOn('[data-fy-len="20"]');
  assert.equal(start(), "/dashboard/ramble?moves=start&slot=morning&len=20");
  assert.equal(pressed(20), "true");
  r.clickOn('[data-fy-len="20"]');
  assert.equal(start(), "/dashboard/ramble?moves=start&slot=morning", "pressing it again clears it");
  assert.equal(pressed(20), "false");
  r.clickOn('[data-fy-len="20"]');
  r.clickOn('[data-fy-len="30"]');
  assert.equal(start(), "/dashboard/ramble?moves=start&slot=morning&len=30", "one length at a time");
  assert.equal(pressed(20), "false");
  assert.equal(pressed(30), "true");
  assert.deepEqual(r.posts, [], "no network call");
  await r.settle();
});

test("the client: a Done fills the Now slot's dot and says so in its label", async () => {
  const r = await movesRig({ ...movesDay().moves, slots: [{ slot: "morning", done: false }, { slot: "midday", done: false }] });
  const dot = (slot) => r.document.querySelector('[data-fy-dot="' + slot + '"]');
  assert.equal(dot("morning").getAttribute("data-done"), "0");
  assert.equal(dot("morning").getAttribute("aria-label"), "Morning");
  r.click("done");
  await r.settle();
  assert.equal(dot("morning").getAttribute("data-done"), "1");
  assert.match(dot("morning").getAttribute("style"), /var\(--crow-accent\)/);
  assert.equal(dot("morning").getAttribute("aria-label"), "Morning · Done today");
  assert.equal(dot("midday").getAttribute("data-done"), "0", "only the Now slot closed");
  assert.equal(dot("midday").getAttribute("aria-label"), "Midday");
});

test("the client: a repaint that throws never leaves the Done/Swap buttons stuck", async () => {
  const r = await movesRig();
  r.reply({ challenge: { day: DAY, done: false, get entry() { throw new Error("paint failed"); } } });
  r.click("done");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-status]").textContent, "That didn't save");
  for (const verb of ["done", "swap"]) {
    assert.equal(r.document.querySelector('[data-fy-move="' + verb + '"]').disabled, false, verb);
  }
});

test("the client: Swap posts to Ramble's swap route; a refusal is said in the card, a failure leaves it usable", async () => {
  const r = await movesRig();
  r.reply({ ...routeSnapshot({ challenge: { entry: { id: "ex-2", title: "Another one", minutes: 5 } } }), refused: true });
  r.click("swap");
  await r.settle();
  assert.deepEqual(r.posts, [{ url: "/api/ramble/moves/swap", body: {} }]);
  assert.equal(r.document.querySelector("[data-fy-move-title]").textContent, "Another one");
  assert.equal(r.document.querySelector("[data-fy-move-minutes]").textContent, "5 min");
  assert.equal(r.document.querySelector("[data-fy-move-status]").textContent, "That's all the swaps for today.");
  assert.equal(r.document.querySelector('[data-fy-move="swap"]').disabled, false, "the buttons come back");

  r.failOn();
  r.click("swap");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-status]").textContent, "That didn't save");
  assert.equal(r.document.querySelector('[data-fy-move="swap"]').disabled, false);
});

// ---- the page (the real dashboard router) ------------------------------------

let server, base, MODE;
before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("moves-owner"), "dashboard");
  tok.run(hashToken("moves-plain"), "");
  c.close();

  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  M?._setMovesModuleForTest(null);
  delete process.env.CROW_FOR_YOU;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  M?._setMovesModuleForTest(null);
  writeFileSync(join(HOME, "installed.json"), "[]");
  const c = new Database(DB_FILE);
  try { c.prepare("DELETE FROM dashboard_settings_overrides WHERE key = 'for_you_settings'").run(); } finally { c.close(); }
});

const NET = serveHeaders("operator@example.com");
// The server-bound CSRF token for the harness's owner session.
const CSRF = csrfTokenFor("moves-owner");
const jar = (sess) => `crow_session=${sess}; ${MODE}=new`;
async function get(path, sess = "moves-owner") {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: jar(sess) } });
  return { status: r.status, body: await r.text() };
}
async function save(fields) {
  const body = new URLSearchParams({ _csrf: CSRF, ...fields });
  const r = await fetch(base + "/dashboard/for-you", {
    method: "POST", redirect: "manual",
    headers: { ...NET, cookie: jar("moves-owner"), "content-type": "application/x-www-form-urlencoded" }, body,
  });
  return { status: r.status, location: r.headers.get("location") };
}

test("page: Ramble absent is no card and no error; installed, the card is there between Your morning and Listen", async () => {
  const absent = await get("/dashboard/for-you");
  assert.equal(absent.status, 200);
  assert.match(absent.body, /Your morning/);
  assert.doesNotMatch(absent.body, /fy-moves/, "no card at all");

  M._setMovesModuleForTest({ forYouMoves: async () => snapshot() });
  const page = (await get("/dashboard/for-you")).body;
  assert.match(page, /id="fy-moves-h">Move</);
  assert.match(page, /data-fy-move="done" data-day="2026-10-30"/);
  const at = (re) => page.search(re);
  assert.ok(at(/id="fy-moves-h"/) > at(/id="fy-morning-h"/), "after Your morning");
  assert.ok(at(/id="fy-moves-h"/) < at(/id="fy-listen-h"/), "before Listen");
});

test("page: a failing Ramble hides only its own card, and the rest of the page renders", async () => {
  M._setMovesModuleForTest({ forYouMoves: async () => { throw new Error("no such column: moves"); } });
  const r = await get("/dashboard/for-you");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /fy-moves/);
  assert.match(r.body, /Your morning/);
  assert.match(r.body, /Install Media Hub/, "Listen still renders");
});

test("page: the Move switch turns the card off and on again, like every other section", async () => {
  M._setMovesModuleForTest({ forYouMoves: async () => snapshot() });
  assert.equal((await save({ city: "", section_morning: "1" })).status, 303);
  const off = await get("/dashboard/for-you");
  assert.doesNotMatch(off.body, /fy-moves/);
  assert.match(off.body, /Your morning/);

  const cz = await get("/dashboard/for-you?view=customize");
  assert.match(cz.body, /<span>Move<\/span><input type="checkbox" name="section_moves" value="1">/);

  await save({ city: "", section_moves: "1" });
  assert.match((await get("/dashboard/for-you")).body, /id="fy-moves-h">Move</);
  assert.match((await get("/dashboard/for-you?view=customize")).body, /<input type="checkbox" name="section_moves" value="1" checked>/);
});

test("page: a non-owner session still gets 404 for the page (and never the card)", async () => {
  M._setMovesModuleForTest({ forYouMoves: async () => snapshot() });
  for (const sess of ["moves-plain"]) {
    const r = await get("/dashboard/for-you", sess);
    assert.equal(r.status, 404, sess);
    assert.doesNotMatch(r.body, /fy-moves|data-fy-move/, sess);
    assert.equal((await get("/dashboard/for-you?view=customize", sess)).status, 404, sess);
  }
});