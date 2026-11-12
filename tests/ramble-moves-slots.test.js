/**
 * Ramble moves — the day's cards (moves design Task 4; private engineering
 * notes).
 *
 * What is pinned here:
 *   - a first open late in the day still draws every card of the day, and the
 *     card count the day asked for is a wallet fact written once,
 *   - each slot's planned area comes from the week plan for that day, and the
 *     picked chunk trains it (or the slot is empty when nothing can),
 *   - picks are deterministic: two fresh instances draw the same cards, and a
 *     second open of the same day writes nothing at all,
 *   - a `moveneed` row a peer wrote wider than the day's own choice widens the
 *     day (the extra slots are real cards), and a narrower one narrows it,
 *   - a stored slot row that no longer holds a usable pick (an entry gone from
 *     the library, or one a stated limit now rules out) is re-picked rather
 *     than shown, and a slot with nothing eligible stays empty,
 *   - the day's earlier slots are excluded from its later ones,
 *   - the `moveslot` and `movestand` flags are read off the wallet,
 *   - the Now card is mirrored into `moves.today` so the rest of moves keeps
 *     reading one card a day, and an earlier day's card folds into history,
 *   - the week's row is written once per week,
 *   - challenges off draws nothing and writes nothing.
 *
 * The shipped library is filled elsewhere, so every test injects its own
 * chunks. The clock is a fixed local Thursday, so nothing here depends on the
 * machine's timezone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { rowDelta, insertOnce } from "../bundles/ramble/server/steps.js";
import { entryById } from "../bundles/ramble/server/moves/library.js";
import {
  SLOTS, areaWeights, weekDays, weekIdOf, weekPlan, weekState,
} from "../bundles/ramble/server/moves/week.js";
import { todayChallenge, whyLine, writePrefs } from "../bundles/ramble/server/moves/today.js";
import {
  MOVE_NEED_KIND, SLOT_KEY_PREFIX, WEEK_KEY, dayCards, enabledSlots,
} from "../bundles/ramble/server/moves/slots.js";

/** A fixed local Thursday: 2026-11-12, in ISO week 2026-W46. */
const THURSDAY = new Date(2026, 10, 12, 18, 0, 0, 0).getTime();
const THURSDAY_LATE = new Date(2026, 10, 12, 23, 30, 0, 0).getTime();
const FRIDAY = new Date(2026, 10, 13, 12, 0, 0, 0).getTime();
const DAY = "2026-11-12";
const W46 = "2026-W46";
const MOVE_AREA_KIND = "movearea";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A picker-shaped chunk; each test overrides exactly what it is about. */
function chunk(over = {}) {
  return {
    id: "chunk-1",
    kind: "routine",
    title: "A test routine",
    minutes: 10,
    level: 1,
    indoor: true,
    activity: "bodyweight",
    equipment: ["none"],
    tags: [],
    areas: ["mobility"],
    steps: ["do the thing"],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [],
    reviewed: true,
    ...over,
  };
}

/** One eligible chunk for every area the plan asks for on a three-card day. */
function library() {
  return [
    chunk({ id: "mob-1", areas: ["mobility", "core"] }),
    chunk({ id: "heart-1", areas: ["heart"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
  ];
}

async function readSetting(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?",
    args: [key],
  });
  return rows[0]?.value ?? null;
}

async function writeSetting(db, key, value) {
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

/** Every settings and wallet row, as plain values, so a write shows up. */
async function snapshot(db) {
  const settings = await db.execute({
    sql: "SELECT key, value FROM ramble_settings ORDER BY key", args: [],
  });
  const wallet = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet ORDER BY kind, key", args: [],
  });
  return {
    settings: settings.rows.map((r) => [String(r.key), String(r.value)]),
    wallet: wallet.rows.map((r) => [String(r.kind), String(r.key), Number(r.delta)]),
  };
}

async function walletRows(db) {
  const { rows } = await db.execute({
    sql: "SELECT kind, key FROM ramble_wallet WHERE kind = ?", args: [MOVE_AREA_KIND],
  });
  return rows.length;
}

/** One wallet row, inserted the way the ledger writes facts. */
async function insertRow(db, kind, key, delta = 1) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, 0)",
    args: [kind, key, delta],
  });
}

const slotNamed = (result, name) => result.slots.find((item) => item.slot === name) ?? null;
const byName = (result) => Object.fromEntries(result.slots.map((item) => [item.slot, item.entryId]));

/* ------------------------------------------------------------ enabledSlots */

test("enabledSlots: the default slots for the card count", () => {
  assert.deepEqual(SLOTS, ["morning", "midday", "evening"], "the slots are re-exported");
  assert.deepEqual(enabledSlots({ cards: 3 }), ["morning", "midday", "evening"]);
  assert.deepEqual(enabledSlots({ cards: 2 }), ["morning", "evening"]);
  assert.deepEqual(enabledSlots({ cards: 1 }), ["midday"]);
  assert.deepEqual(enabledSlots({}), ["morning", "midday", "evening"]);
  assert.deepEqual(enabledSlots({ cards: 9 }), ["morning", "midday", "evening"]);
  assert.deepEqual(enabledSlots(), ["morning", "midday", "evening"]);
});

test("enabledSlots: windows are honoured when they fit, ignored otherwise", () => {
  assert.deepEqual(enabledSlots({ cards: 2, windows: ["evening", "morning"] }),
    ["morning", "evening"], "in SLOTS order, not the order they were named");
  assert.deepEqual(enabledSlots({ cards: 1, windows: ["evening"] }), ["evening"]);
  assert.deepEqual(enabledSlots({ cards: 3, windows: ["evening", "midday", "morning"] }),
    ["morning", "midday", "evening"]);

  // A wrong length, a repeat, a name that is not a slot, or no list at all.
  const ignored = [
    ["morning"],
    ["morning", "midday", "evening"],
    ["morning", "morning"],
    ["morning", "nope"],
    "evening",
    null,
    { 0: "morning", 1: "evening" },
  ];
  for (const windows of ignored) {
    assert.deepEqual(enabledSlots({ cards: 2, windows }), ["morning", "evening"],
      "falls back to the default slots: " + JSON.stringify(windows));
  }
});

/* --------------------------------------------------------------- a first open */

test("a first open at 18:00 draws all three cards, and at 23:30 the chosen two", async () => {
  const db = await freshDb();
  const lib = library();
  const result = await dayCards(db, { now: THURSDAY, library: lib });

  assert.equal(result.day, DAY);
  assert.equal(result.off, undefined, "the day is not paused");
  assert.equal(result.need, 3);
  assert.equal(result.nowSlot, "evening");
  assert.deepEqual(result.slots.map((item) => item.slot), ["morning", "midday", "evening"]);
  for (const item of result.slots) {
    assert.ok(item.entryId, "every slot has a card: " + item.slot);
    assert.equal(item.empty, false);
    assert.ok(entryById(lib, item.entryId), "the card is in the library");
  }
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 3, "the day asked for three cards");

  const late = await freshDb();
  await writePrefs(late, { cards: 2 });
  const two = await dayCards(late, { now: THURSDAY_LATE, library: lib });
  assert.equal(two.need, 2);
  assert.deepEqual(two.slots.map((item) => item.slot), ["morning", "evening"]);
  assert.equal(two.nowSlot, "evening");
  for (const item of two.slots) assert.ok(item.entryId, "both cards are drawn: " + item.slot);
  assert.equal(await rowDelta(late, MOVE_NEED_KIND, DAY), 2);
});

/* -------------------------------------------------------------- planned areas */

test("each slot asks for the area the week plan gives that day", async () => {
  const db = await freshDb();
  const lib = library();
  const result = await dayCards(db, { now: THURSDAY, library: lib });

  const plan = weekPlan(weekIdOf(THURSDAY), 3, SLOTS);
  const dayIndex = weekDays(W46).indexOf(DAY);
  assert.equal(dayIndex, 3, "2026-11-12 is the Thursday of its week");

  for (const item of result.slots) {
    assert.equal(item.plannedArea, plan[dayIndex].slots[item.slot],
      "the planned area comes from the week plan: " + item.slot);
    // The test library holds a chunk for every area, so no slot falls back.
    assert.equal(item.area, item.plannedArea, "the card trains the planned area: " + item.slot);
    const picked = entryById(lib, item.entryId);
    assert.ok(picked.areas.includes(item.area),
      "the chunk trains its area: " + item.slot + " " + item.area);
  }
});

/* ------------------------------------------------------------- deterministic */

test("two fresh instances draw the same cards, and a second open writes nothing", async () => {
  const lib = library();
  const a = await freshDb();
  const b = await freshDb();
  const first = await dayCards(a, { now: THURSDAY, library: lib });
  const other = await dayCards(b, { now: THURSDAY, library: lib });
  assert.deepEqual(first.slots.map((item) => item.entryId),
    other.slots.map((item) => item.entryId), "both instances agree on the day");

  const before = await snapshot(a);
  const again = await dayCards(a, { now: THURSDAY, library: lib });
  assert.deepEqual(await snapshot(a), before, "the second open of the day writes nothing");
  assert.deepEqual(again, first, "and answers the same day");
});

/* ------------------------------------------------------------- the card count */

test("moveneed is written once: a later card-count change leaves the day alone", async () => {
  const db = await freshDb();
  const lib = library();
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 3);

  await writePrefs(db, { cards: 1 });
  const second = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(second.need, 3, "the day keeps the count it was drawn with");
  assert.deepEqual(byName(second), byName(first), "and the cards it was drawn with");
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 3);
});

test("a wider moveneed from a peer draws the extra slots; a narrower one draws fewer", async () => {
  // The user chose one card, a peer asked for three: the day is three cards.
  const one = await freshDb();
  await writePrefs(one, { cards: 1 });
  await insertOnce(one, MOVE_NEED_KIND, DAY, 3, THURSDAY);
  const widened = await dayCards(one, { now: THURSDAY, library: library() });
  assert.equal(widened.slots.length, 3);
  assert.equal(widened.need, 3);
  assert.deepEqual([...widened.slots].map((item) => item.slot).sort(), [...SLOTS].sort(),
    "the extra slots are the day's real cards");
  for (const item of widened.slots) {
    assert.ok(item.entryId, "every widened slot has a card: " + item.slot);
    assert.equal(item.empty, false);
  }

  // Three cards chosen, a peer asked for two: the first two of the day.
  const three = await freshDb();
  await insertOnce(three, MOVE_NEED_KIND, DAY, 2, THURSDAY);
  const narrowed = await dayCards(three, { now: THURSDAY, library: library() });
  assert.deepEqual(narrowed.slots.map((item) => item.slot), ["morning", "midday"]);
  assert.equal(narrowed.need, 2);
});

/* -------------------------------------------------------------- empty slots */

test("a slot with nothing eligible is empty, and the need counts the picks", async () => {
  const db = await freshDb();
  // No heart, mobility or core chunk, so the first two slots of Thursday have
  // nothing to offer (the picker's fallbacks are mobility, then core).
  const lib = [chunk({ id: "up-1", areas: ["upper"] }), chunk({ id: "low-1", areas: ["lower"] })];
  const result = await dayCards(db, { now: THURSDAY, library: lib });

  const midday = slotNamed(result, "midday");
  assert.equal(midday.entryId, null);
  assert.equal(midday.empty, true);
  assert.equal(midday.area, midday.plannedArea, "an empty slot names the area it asked for");
  assert.equal(await readSetting(db, SLOT_KEY_PREFIX + "midday"), null,
    "no slot row is written for a slot that found nothing");

  const picks = result.slots.filter((item) => item.entryId !== null).length;
  assert.equal(picks, 1, "only the lower slot could be filled");
  assert.equal(result.need, picks);
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), picks);

  const nothing = await freshDb();
  const empty = await dayCards(nothing, { now: THURSDAY, library: [] });
  assert.equal(empty.need, 0);
  assert.equal(empty.slots.length, 3, "the day still has its slots");
  for (const item of empty.slots) {
    assert.equal(item.entryId, null);
    assert.equal(item.empty, true);
  }
  assert.equal(await rowDelta(nothing, MOVE_NEED_KIND, DAY), null, "nothing to ask for");
  assert.equal(await readSetting(nothing, "moves.today"), null, "and no card to mirror");
});

/* --------------------------------------------------------------- stale rows */

test("a slot row whose entry is gone from the library is re-picked", async () => {
  const db = await freshDb();
  const lib = library();
  await writeSetting(db, SLOT_KEY_PREFIX + "morning", JSON.stringify({
    day: DAY, entryId: "gone-1", area: "mobility", reasons: [], swap: 0, seen: ["gone-1"],
  }));
  const result = await dayCards(db, { now: THURSDAY, library: lib });
  const morning = slotNamed(result, "morning");
  assert.notEqual(morning.entryId, "gone-1");
  assert.ok(entryById(lib, morning.entryId), "the replacement is a real chunk");
  assert.equal(morning.empty, false);

  // Junk in every slot row, the week row and the today row is survivable.
  const junk = await freshDb();
  for (const slot of SLOTS) await writeSetting(junk, SLOT_KEY_PREFIX + slot, '{"day":42}');
  await writeSetting(junk, WEEK_KEY, "not a week");
  await writeSetting(junk, "moves.today", '"nope"');
  const recovered = await dayCards(junk, { now: THURSDAY, library: lib });
  assert.equal(recovered.slots.length, 3);
  for (const item of recovered.slots) assert.ok(item.entryId, "re-picked: " + item.slot);
});

test("a slot row a stated limit rules out is re-picked and never offered", async () => {
  const db = await freshDb();
  await writePrefs(db, { limits: ["knee"] });
  // The stored card is the only mobility chunk, and the knee limit rules it out.
  const lib = [
    chunk({ id: "knee-1", areas: ["mobility"], skipIf: ["knee"] }),
    chunk({ id: "heart-1", areas: ["heart"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
  ];
  await writeSetting(db, SLOT_KEY_PREFIX + "morning", JSON.stringify({
    day: DAY, entryId: "knee-1", area: "mobility", reasons: ["slot:early"], swap: 0, seen: ["knee-1"],
  }));

  const result = await dayCards(db, { now: THURSDAY, library: lib });
  for (const item of result.slots) {
    assert.notEqual(item.entryId, "knee-1", "the limited card is never offered: " + item.slot);
  }
  const morning = slotNamed(result, "morning");
  assert.equal(morning.entryId, null, "nothing else trains mobility");
  assert.equal(morning.empty, true);
  assert.ok(slotNamed(result, "midday").entryId, "the other slots still draw");
});

/* ------------------------------------------------------------- no duplicates */

test("the day's earlier picks are excluded from its later slots", async () => {
  const db = await freshDb();
  // "multi" is the only way two slots could land on one chunk: it trains the
  // morning's area and the midday's, and it is the better pick for both.
  const lib = [
    chunk({ id: "multi-1", areas: ["mobility", "heart", "lower"] }),
    chunk({ id: "mob-2", areas: ["mobility"] }),
    chunk({ id: "heart-2", areas: ["heart"] }),
    chunk({ id: "low-2", areas: ["lower"] }),
  ];
  const result = await dayCards(db, { now: THURSDAY, library: lib });
  const ids = result.slots.map((item) => item.entryId);
  assert.equal(ids.filter(Boolean).length, 3, "all three slots drew a card");
  assert.equal(new Set(ids).size, 3, "no chunk is offered twice in one day");
  assert.notEqual(ids[0], ids[1]);
});

/* ------------------------------------------------------- done and stand-in */

test("the done and stand-in flags are read from the wallet rows", async () => {
  const db = await freshDb();
  const lib = library();
  await insertRow(db, "moveslot", `${DAY}:morning`);
  await insertRow(db, "movestand", `${DAY}:midday`);
  const result = await dayCards(db, { now: THURSDAY, library: lib });

  const morning = slotNamed(result, "morning");
  assert.equal(morning.done, true);
  assert.equal(morning.standIn, false);
  const midday = slotNamed(result, "midday");
  assert.equal(midday.done, false);
  assert.equal(midday.standIn, true);
  const evening = slotNamed(result, "evening");
  assert.equal(evening.done, false);
  assert.equal(evening.standIn, false);

  // Another day's rows say nothing about this one.
  await insertRow(db, "moveslot", "2026-11-11:evening");
  const other = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(slotNamed(other, "evening").done, false);
});

/* ------------------------------------------------------------- moves.today */

test("the Now card is mirrored into moves.today", async () => {
  const db = await freshDb();
  const lib = library();
  const result = await dayCards(db, { now: THURSDAY, library: lib });
  const nowItem = slotNamed(result, result.nowSlot);
  assert.equal(result.nowSlot, "evening");

  const mirror = JSON.parse(await readSetting(db, "moves.today"));
  assert.equal(mirror.day, DAY);
  assert.equal(mirror.entryId, nowItem.entryId);
  assert.equal(mirror.swap, nowItem.swap);
  assert.deepEqual(mirror.seen, nowItem.seen);
  assert.deepEqual(mirror.reasons, nowItem.reasons);
  assert.equal(mirror.why, whyLine(nowItem.reasons));

  const challenge = await todayChallenge(db, { now: THURSDAY, library: lib });
  assert.equal(challenge.day, DAY);
  assert.equal(challenge.entry.id, nowItem.entryId, "moves.today reads the same card back");
  assert.equal(challenge.done, false);
});

test("an earlier day's card folds into history when the new day is drawn", async () => {
  const db = await freshDb();
  const lib = library();
  await writeSetting(db, "moves.today", JSON.stringify({
    day: "2026-11-11",
    entryId: "mob-1",
    swap: 1,
    seen: ["low-1", "mob-1"],
    reasons: ["slot:early"],
    why: "",
  }));

  const result = await dayCards(db, { now: THURSDAY, library: lib });
  const history = JSON.parse(await readSetting(db, "moves.history"));
  assert.equal(history.skipped["mob-1"], 1, "yesterday's card was not done");
  assert.equal(history.skipped["low-1"], undefined, "only the card on screen rolls over");
  assert.deepEqual(history.done, {});

  const mirror = JSON.parse(await readSetting(db, "moves.today"));
  assert.equal(mirror.day, DAY, "today's card replaced it");
  assert.equal(mirror.entryId, slotNamed(result, result.nowSlot).entryId);
});

/* ----------------------------------------------------------------- weights */

test("the week's marks are read without changing the shape of the day", async () => {
  const db = await freshDb();
  const lib = library();
  const marked = ["mobility", "lower"];
  for (const day of ["2026-11-09", "2026-11-10"]) {
    for (const area of marked) await insertRow(db, MOVE_AREA_KIND, `${day}:${area}`);
  }
  const state = await weekState(db, { now: THURSDAY });
  assert.equal(state.total, 4, "the marks are this week's");
  assert.equal(await walletRows(db), 4);
  assert.equal(areaWeights(state).mobility, 0.5, "a marked area is short of nothing");
  assert.equal(areaWeights(state).upper, 3, "an unmarked one is asked for");

  const result = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(result.slots.length, 3);
  for (const item of result.slots) assert.ok(item.entryId, "a card was drawn: " + item.slot);
  assert.equal(await walletRows(db), 4, "drawing the day writes no marks");
});

/* -------------------------------------------------------------- paused days */

test("prefs.on false answers off and writes nothing", async () => {
  const db = await freshDb();
  await writePrefs(db, { on: false });
  const before = await snapshot(db);
  const result = await dayCards(db, { now: THURSDAY, library: library() });

  assert.equal(result.off, true);
  assert.equal(result.need, 0);
  assert.equal(result.nowSlot, null);
  assert.deepEqual(result.slots, []);
  assert.equal(result.day, DAY);
  assert.deepEqual(await snapshot(db), before, "a paused day draws and stores nothing");
});

/* --------------------------------------------------------------- the week */

test("moves.week is written once per week, with the week's plan", async () => {
  const db = await freshDb();
  const lib = library();
  await dayCards(db, { now: THURSDAY, library: lib });

  const raw = await readSetting(db, WEEK_KEY);
  const stored = JSON.parse(raw);
  assert.equal(stored.weekId, W46);
  assert.equal(stored.cards, 3);
  assert.deepEqual(stored.days, weekPlan(W46, 3, enabledSlots({ cards: 3 })), "the whole week's plan");

  // The rest of the week keeps the row it already has.
  await dayCards(db, { now: FRIDAY, library: lib });
  assert.equal(await readSetting(db, WEEK_KEY), raw, "no rewrite inside the same week");
});