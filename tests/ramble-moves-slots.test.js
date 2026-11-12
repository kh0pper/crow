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
 *   - once the day has a card count its slots are the ones holding a stored
 *     pick for that day, so a slot left empty at first open cannot swallow a
 *     slot that found a card,
 *   - a stored slot row that no longer holds a usable pick (an entry gone from
 *     the library, or one a stated limit now rules out) is re-picked rather
 *     than shown, and a slot with nothing eligible stays empty,
 *   - the day's earlier slots are excluded from its later ones,
 *   - the `moveslot` and `movestand` flags are read off the wallet,
 *   - the Now card is mirrored into `moves.today` so the rest of moves keeps
 *     reading one card a day, and an earlier day's card folds into history,
 *   - the week's row is written once per week,
 *   - challenges off draws nothing and writes nothing,
 *   - a swap re-rolls ONE slot: a different card, its own swap count, and the
 *     cards it already showed on its `seen` list, so no id repeats,
 *   - a swap stays off the day's other cards, leaves `moveneed` and the other
 *     slot rows alone, and mirrors into `moves.today` only for the Now card,
 *   - a Done card, a card at the day's swap cap, a card with nothing else
 *     eligible, a slot left empty and a slot the day does not have all refuse
 *     without writing.
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
import {
  MAX_SWAPS, todayChallenge, whyLine, writePrefs,
} from "../bundles/ramble/server/moves/today.js";
import {
  MOVE_NEED_KIND, SLOT_KEY_PREFIX, WEEK_KEY, dayCards, enabledSlots, swapSlot,
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

/**
 * A library with several chunks per area, so a slot has cards to swap between.
 * Every chunk trains exactly one area, so the picker's balance rule filters
 * nothing and a slot's swaps stay inside its planned area.
 */
function swapLibrary() {
  const out = [];
  for (const [area, prefix] of [
    ["mobility", "mob"], ["heart", "heart"], ["lower", "low"], ["upper", "up"],
  ]) {
    for (let i = 1; i <= 6; i += 1) out.push(chunk({ id: `${prefix}-${i}`, areas: [area] }));
  }
  return out;
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

test("a moveneed a peer wrote before the first open gives the day three cards", async () => {
  const db = await freshDb();
  await writePrefs(db, { cards: 1 });
  await insertOnce(db, MOVE_NEED_KIND, DAY, 3, THURSDAY);

  const result = await dayCards(db, { now: THURSDAY, library: library() });
  assert.equal(result.need, 3);
  assert.deepEqual(result.slots.map((item) => item.slot), [...SLOTS]);
  for (const item of result.slots) {
    assert.ok(item.entryId, "a card was drawn: " + item.slot);
    assert.equal(item.empty, false);
  }
});

test("a moveneed wider than the picks is capped, and the row keeps its count", async () => {
  const db = await freshDb();
  // A peer asked for three cards before the day was drawn.
  await insertOnce(db, MOVE_NEED_KIND, DAY, 3, THURSDAY);
  // Thursday asks for mobility, heart and lower, and only two of those have a
  // chunk: the heart slot's mobility fallback is already the morning's card.
  const lib = [
    chunk({ id: "mob-1", areas: ["mobility"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
  ];

  const result = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(result.slots.length, 3, "the day still has its three slots");
  const picks = result.slots.filter((item) => item.entryId !== null);
  assert.equal(picks.length, 2, "only two slots could be filled");
  assert.equal(result.slots.filter((item) => item.empty).length, 1);
  assert.equal(result.need, 2, "the need never exceeds the slots that hold a pick");
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 3, "the moveneed row still reads three");
});

test("a later card-count raise leaves today's slots alone", async () => {
  const db = await freshDb();
  const lib = library();
  await writePrefs(db, { cards: 1 });
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  assert.deepEqual(first.slots.map((item) => item.slot), ["midday"]);
  assert.ok(slotNamed(first, "midday").entryId);
  assert.equal(first.need, 1);

  await writePrefs(db, { cards: 3 });
  const raised = await dayCards(db, { now: THURSDAY, library: lib });
  assert.deepEqual(raised.slots.map((item) => item.slot), ["midday"],
    "the day keeps the slots it was drawn with");
  assert.equal(raised.need, 1, "and the count it was drawn with");
  assert.equal(slotNamed(raised, "midday").entryId, slotNamed(first, "midday").entryId);
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

test("a day whose slot was empty keeps the slots that hold a pick", async () => {
  const db = await freshDb();
  // No heart chunk, so the midday slot of the three-card day has nothing to
  // offer; the other two fill.
  const lib = [
    chunk({ id: "mob-1", areas: ["mobility"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
  ];

  const first = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(first.slots.length, 3, "the day opens with its three slots");
  const midday = slotNamed(first, "midday");
  assert.equal(midday.entryId, null);
  assert.equal(midday.empty, true);
  assert.ok(slotNamed(first, "morning").entryId);
  assert.ok(slotNamed(first, "evening").entryId);
  assert.equal(first.slots.filter((item) => item.entryId !== null).length, 2);
  assert.equal(first.need, 2, "the need counts the slots that found a card");
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 2);

  const second = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(second.need, 2);
  assert.deepEqual(second.slots.map((item) => item.slot), ["morning", "evening"],
    "the day's slots are the ones holding a pick");
  for (const item of second.slots) {
    assert.ok(item.entryId, "the slot keeps a card: " + item.slot);
    assert.equal(item.empty, false);
  }
  assert.equal(slotNamed(second, "morning").entryId, slotNamed(first, "morning").entryId);
  assert.equal(slotNamed(second, "evening").entryId, slotNamed(first, "evening").entryId);

  // Finishing both cards of the day reaches the need the day asked for.
  await insertRow(db, "moveslot", `${DAY}:morning`);
  await insertRow(db, "moveslot", `${DAY}:evening`);
  const finished = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(finished.need, 2);
  assert.equal(finished.slots.length, 2);
  for (const item of finished.slots) {
    assert.equal(item.done, true, "finished: " + item.slot);
  }
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

/* ------------------------------------------------------------------- swap */

test("a swap re-rolls one slot: a different card, swap 1, the old one on its seen list", async () => {
  const db = await freshDb();
  const lib = swapLibrary();
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  const before = slotNamed(first, "midday");
  assert.ok(before.entryId, "the slot has a card to swap");

  const out = await swapSlot(db, { slot: "midday", now: THURSDAY, library: lib });
  assert.equal(out.day, DAY);
  assert.equal(out.slot, "midday");
  assert.equal(out.refused, false);
  assert.equal(out.empty, false);
  assert.equal(out.swap, 1, "the swap count was bumped");
  assert.notEqual(out.entryId, before.entryId, "the card changed");
  assert.ok(!before.seen.includes(out.entryId), "the new card was not on the slot's seen list");
  assert.deepEqual(out.seen, [before.entryId, out.entryId], "the old card stays on the seen list");
  assert.equal(out.plannedArea, before.plannedArea);
  assert.equal(out.area, before.plannedArea, "the swap keeps the week plan's area");
  assert.equal(out.standIn, before.standIn);
  assert.equal(out.done, false);

  const row = JSON.parse(await readSetting(db, SLOT_KEY_PREFIX + "midday"));
  assert.equal(row.day, DAY);
  assert.equal(row.entryId, out.entryId);
  assert.equal(row.area, out.area);
  assert.equal(row.swap, 1);
  assert.deepEqual(row.seen, out.seen);

  // The day reads the swapped card back, and its other cards are untouched.
  const again = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(slotNamed(again, "midday").entryId, out.entryId);
  assert.equal(slotNamed(again, "midday").swap, 1);
  for (const slot of ["morning", "evening"]) {
    assert.equal(slotNamed(again, slot).entryId, slotNamed(first, slot).entryId,
      "another slot's card is untouched: " + slot);
    assert.equal(slotNamed(again, slot).swap, 0);
  }
});

test("three swaps of a slot work, and the fourth refuses and writes nothing", async () => {
  const db = await freshDb();
  const lib = swapLibrary();
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  const others = first.slots.filter((item) => item.slot !== "morning").map((item) => item.entryId);

  // Every card the morning slot has shown, the first one included.
  const shown = [slotNamed(first, "morning").entryId];
  let current = slotNamed(first, "morning");

  for (let n = 1; n <= MAX_SWAPS; n += 1) {
    const out = await swapSlot(db, { slot: "morning", now: THURSDAY, library: lib });
    assert.equal(out.refused, false, `swap ${n} is allowed`);
    assert.equal(out.swap, n, `swap ${n} bumps the count`);
    assert.notEqual(out.entryId, current.entryId, `swap ${n} changes the card`);
    assert.ok(out.seen.includes(out.entryId), "the new card is on the seen list");
    assert.ok(!shown.includes(out.entryId), `swap ${n} never repeats a card the slot showed`);
    assert.ok(!others.includes(out.entryId), `swap ${n} never takes another slot's card`);
    shown.push(out.entryId);
    current = out;
  }
  assert.equal(new Set(shown).size, MAX_SWAPS + 1, "no card repeated across the swaps");
  assert.deepEqual(current.seen, shown, "the seen list holds every card the slot showed");

  const before = await snapshot(db);
  const fourth = await swapSlot(db, { slot: "morning", now: THURSDAY, library: lib });
  assert.equal(fourth.refused, true, "the cap refuses the fourth swap");
  assert.equal(fourth.entryId, current.entryId, "the card on screen stays");
  assert.equal(fourth.swap, MAX_SWAPS);
  assert.deepEqual(await snapshot(db), before, "a refused swap writes nothing");
});

test("a swap never lands on another slot's card of the same day", async () => {
  const db = await freshDb();
  // "multi-1" trains all three planned areas and is the better pick for the
  // morning, so without the day's other cards as an exclude it is exactly what
  // a midday swap would land on.
  const lib = [
    chunk({ id: "multi-1", areas: ["mobility", "heart", "lower"] }),
    chunk({ id: "mob-2", areas: ["mobility"] }),
    chunk({ id: "heart-2", areas: ["heart"] }),
    chunk({ id: "low-2", areas: ["lower"] }),
  ];
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(slotNamed(first, "morning").entryId, "multi-1", "the shared chunk opens the day");

  const dayIds = first.slots.map((item) => item.entryId);
  const out = await swapSlot(db, { slot: "midday", now: THURSDAY, library: lib });
  assert.equal(out.refused, false);
  assert.equal(out.entryId, "mob-2");
  assert.ok(!dayIds.includes(out.entryId), "the swap stays off every card of the day");
  const after = await dayCards(db, { now: THURSDAY, library: lib });
  const ids = after.slots.map((item) => item.entryId);
  assert.equal(new Set(ids).size, ids.length, "no card of the day repeats");
});

test("swapping the Now slot updates moves.today; swapping another slot does not", async () => {
  const db = await freshDb();
  const lib = swapLibrary();
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(first.nowSlot, "evening");
  const beforeMirror = await readSetting(db, "moves.today");
  assert.equal(JSON.parse(beforeMirror).entryId, slotNamed(first, "evening").entryId);

  const out = await swapSlot(db, { slot: "evening", now: THURSDAY, library: lib });
  assert.equal(out.refused, false);
  const mirror = JSON.parse(await readSetting(db, "moves.today"));
  assert.equal(mirror.day, DAY);
  assert.equal(mirror.entryId, out.entryId, "the Now card is the swapped one");
  assert.equal(mirror.swap, out.swap);
  assert.deepEqual(mirror.seen, out.seen);
  assert.deepEqual(mirror.reasons, out.reasons);
  assert.equal(mirror.why, whyLine(out.reasons));

  const challenge = await todayChallenge(db, { now: THURSDAY, library: lib });
  assert.equal(challenge.entry.id, out.entryId, "the rest of moves reads the swapped card");
  assert.equal(challenge.swap, out.swap);

  // A slot that is not the Now card leaves moves.today exactly as it was.
  const held = await readSetting(db, "moves.today");
  const morning = await swapSlot(db, { slot: "morning", now: THURSDAY, library: lib });
  assert.equal(morning.refused, false);
  assert.equal(await readSetting(db, "moves.today"), held, "another slot's swap leaves the mirror alone");
});

test("a Done slot is not swapped", async () => {
  const db = await freshDb();
  const lib = swapLibrary();
  await insertRow(db, "moveslot", `${DAY}:morning`);
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  const item = slotNamed(first, "morning");
  assert.equal(item.done, true);

  const before = await snapshot(db);
  const out = await swapSlot(db, { slot: "morning", now: THURSDAY, library: lib });
  assert.equal(out.refused, true);
  assert.equal(out.entryId, item.entryId, "a finished card stays");
  assert.equal(out.done, true);
  assert.deepEqual(await snapshot(db), before, "a refused swap writes nothing");

  // A slot that is not done still swaps.
  const open = await swapSlot(db, { slot: "midday", now: THURSDAY, library: lib });
  assert.equal(open.refused, false);
  assert.notEqual(open.entryId, slotNamed(first, "midday").entryId);
});

test("a swap with nothing else eligible refuses and writes nothing", async () => {
  const db = await freshDb();
  // One card a day, and the only chunk there is: the slot has nothing else to
  // hand out.
  await writePrefs(db, { cards: 1 });
  const lib = [chunk({ id: "core-1", areas: ["core"] })];
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  const item = slotNamed(first, "midday");
  assert.equal(item.entryId, "core-1", "the day's one card is the only chunk");

  const before = await snapshot(db);
  const out = await swapSlot(db, { slot: "midday", now: THURSDAY, library: lib });
  assert.equal(out.refused, true);
  assert.equal(out.entryId, "core-1", "the card on screen stays");
  assert.equal(out.empty, false, "the slot still holds a card");
  assert.deepEqual(await snapshot(db), before, "nothing was written");
});

test("a junk slot name, or a slot the day's card count left out, refuses", async () => {
  const db = await freshDb();
  const lib = swapLibrary();
  await dayCards(db, { now: THURSDAY, library: lib });

  const before = await snapshot(db);
  for (const slot of ["nope", "", null, undefined, "Morning"]) {
    const out = await swapSlot(db, { slot, now: THURSDAY, library: lib });
    assert.equal(out.refused, true, "refused: " + String(slot));
    assert.equal(out.empty, true);
    assert.equal(out.day, DAY);
    assert.equal(out.slot, slot);
  }
  assert.deepEqual(await snapshot(db), before, "a refused slot writes nothing");

  // One card a day is the midday; the morning is not part of the day at all.
  const one = await freshDb();
  await writePrefs(one, { cards: 1 });
  const drawn = await dayCards(one, { now: THURSDAY, library: lib });
  assert.deepEqual(drawn.slots.map((item) => item.slot), ["midday"]);
  const oneBefore = await snapshot(one);
  const out = await swapSlot(one, { slot: "morning", now: THURSDAY, library: lib });
  assert.equal(out.refused, true);
  assert.equal(out.empty, true);
  assert.deepEqual(await snapshot(one), oneBefore, "a slot outside the day writes nothing");

  // The day's own slot still swaps.
  const midday = await swapSlot(one, { slot: "midday", now: THURSDAY, library: lib });
  assert.equal(midday.refused, false);
  assert.equal(midday.swap, 1);
});

test("a swap leaves the day's card count and its other cards alone", async () => {
  const db = await freshDb();
  const lib = swapLibrary();
  const first = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 3);

  await swapSlot(db, { slot: "midday", now: THURSDAY, library: lib });
  assert.equal(await rowDelta(db, MOVE_NEED_KIND, DAY), 3, "moveneed is untouched");

  const after = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(after.need, first.need);
  assert.deepEqual(after.slots.map((item) => item.slot), first.slots.map((item) => item.slot));
  for (const item of after.slots) {
    if (item.slot === "midday") continue;
    assert.equal(item.entryId, slotNamed(first, item.slot).entryId, "untouched: " + item.slot);
  }
});

test("a limit set after the pick is re-picked first, and the slot still swaps", async () => {
  const db = await freshDb();
  const lib = [
    chunk({ id: "knee-1", areas: ["mobility"], skipIf: ["knee"] }),
    chunk({ id: "mob-2", areas: ["mobility"] }),
    chunk({ id: "mob-3", areas: ["mobility"] }),
    chunk({ id: "mob-4", areas: ["mobility"] }),
    chunk({ id: "heart-2", areas: ["heart"] }),
    chunk({ id: "low-2", areas: ["lower"] }),
  ];
  await writeSetting(db, SLOT_KEY_PREFIX + "morning", JSON.stringify({
    day: DAY, entryId: "knee-1", area: "mobility", reasons: ["slot:early"], swap: 0, seen: ["knee-1"],
  }));

  // No limit yet: the stored card is kept.
  const kept = await dayCards(db, { now: THURSDAY, library: lib });
  assert.equal(slotNamed(kept, "morning").entryId, "knee-1");

  await writePrefs(db, { limits: ["knee"] });
  const out = await swapSlot(db, { slot: "morning", now: THURSDAY, library: lib });
  assert.equal(out.refused, false, "the slot still swaps");
  assert.equal(out.swap, 1, "the re-pick kept the day's swap count");
  assert.notEqual(out.entryId, "knee-1", "the limited card is never offered");
  assert.ok(entryById(lib, out.entryId), "the swapped card is a real chunk");
  assert.ok(!entryById(lib, out.entryId).skipIf.includes("knee"));
  assert.ok(out.seen.includes("knee-1"), "the replaced card stays on the seen list");
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