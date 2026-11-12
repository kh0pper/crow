/**
 * Ramble moves — stand-ins (moves design; private engineering notes): a log the
 * player already recorded, or a step count that reached the goal, standing in
 * for one of the day's open cards.
 *
 * What is pinned here:
 *   - a log of ten minutes or more fills one open card: the caller's named slot,
 *     else the card of the log's own area, else the first open one;
 *   - a log under ten minutes, a second log stand-in of the day, a day that is
 *     not today, a log key of another day and a body outside the source
 *     vocabulary are all refused, and a refusal writes nothing;
 *   - a log of yoga, band or bodyweight whose area is a balancing one IS the
 *     balancing chunk: it writes the day's `movebal` row. A walk log never does,
 *     and the log's own area is what decides it;
 *   - the step goal fills the midday card, or — on a day without one — the first
 *     open heart card and then the first open free one, and never balances;
 *   - the stand-ins a day already carries count against `need - 1`, so steps, a
 *     walk and a walk log together leave the day unfinished;
 *   - a stand-in writes one `movestand` row and never pays: no budget row, no
 *     pet feed;
 *   - the day's flags are a local setting, and writing today's prunes the flags
 *     of the days older than yesterday.
 *
 * The shipped library is filled elsewhere, so every test injects its own
 * chunks. The clocks are fixed local days (a Monday, a Tuesday, a Saturday), so
 * the plan each one carries is the same on every machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { localDay, startOfLocalDay } from "../bundles/ramble/server/eggs.js";
import { recordStepReading, rowDelta } from "../bundles/ramble/server/steps.js";
import { petState } from "../bundles/ramble/server/pet.js";
import {
  MOVE_INDOOR_KIND, MOVE_OUTDOOR_KIND, recordLog,
} from "../bundles/ramble/server/moves/ledger.js";
import { MOVE_AREA_KIND } from "../bundles/ramble/server/moves/week.js";
import {
  MOVE_BAL_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND, isDayComplete,
} from "../bundles/ramble/server/moves/day-complete.js";
import { BALANCE_AREAS } from "../bundles/ramble/server/moves/library.js";
import { writePrefs } from "../bundles/ramble/server/moves/today.js";
import { dayCards } from "../bundles/ramble/server/moves/slots.js";
import {
  STANDIN_DAY_KEY, assignStandIn, finishOutdoor, startOutdoor,
} from "../bundles/ramble/server/moves/day.js";

const H = 3_600_000;
const M = 60_000;
/** The start of a fixed local Monday, Tuesday and Saturday. */
const MON0 = startOfLocalDay(new Date(2026, 9, 5, 12, 0, 0, 0).getTime());
const TUE0 = startOfLocalDay(new Date(2026, 9, 6, 12, 0, 0, 0).getTime());
const SAT0 = startOfLocalDay(new Date(2026, 9, 10, 12, 0, 0, 0).getTime());
const AT = (h, m = 0) => MON0 + h * H + m * M;
const AT_TUE = (h, m = 0) => TUE0 + h * H + m * M;
const AT_SAT = (h, m = 0) => SAT0 + h * H + m * M;
const DAY = localDay(AT(12));
const DAY_TUE = localDay(AT_TUE(12));
const DAY_SAT = localDay(AT_SAT(12));

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

/** One chunk per area, so any planned area can be filled and a slot is never re-picked. */
function library() {
  return [
    chunk({ id: "mob-1", areas: ["mobility"] }),
    chunk({ id: "heart-1", areas: ["heart"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "core-1", areas: ["core"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
  ];
}

/** The day's cards as the routes would draw them. */
function cardsFor(db, now = AT(9), lib = library()) {
  return dayCards(db, { now, library: lib });
}

/** Rows of one wallet kind, so an assertion can say how many were written. */
async function keysOf(db, kind) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? ORDER BY key", args: [kind],
  });
  return rows.map((row) => String(row.key));
}

/** Record a log the way the panel's route does, at a fixed minute of the day. */
function log(db, {
  activity = "walk", minutes = 10, effort = "easy", area, at = AT(10),
} = {}) {
  return recordLog(db, { activity, minutes, effort, area, now: at });
}

/** Credit a step reading of `counter` steps walked over the last four hours. */
async function stepsReading(db, now, counter = 6000) {
  return recordStepReading(db, {
    device_id: "stand-in-dev", boot_count: 1, counter, elapsed_ms: 4 * H,
  }, { now });
}

/** Open a walk at 09:00 and finish it `minutes` later. */
async function walked(db, minutes, { cards = null, start = AT(9) } = {}) {
  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: start });
  return finishOutdoor(db, { day: DAY, now: start + minutes * M, cards });
}

/**
 * A day with the step goal standing in for its midday card and a ten-minute
 * walk filling the next one: two of the three cards, and the day still owes a
 * balancing chunk.
 */
async function stepGoalAndWalk(db) {
  const cards = await cardsFor(db);
  await stepsReading(db, AT(8));
  const stepIn = await assignStandIn(db, { day: DAY, source: "steps", now: AT(8), cards });
  assert.equal(stepIn.ok, true);
  assert.equal(stepIn.slot, "midday");
  const walk = await walked(db, 10, { cards, start: AT(9) });
  assert.deepEqual(walk.filled, ["morning"], "the stand-in already used counts against need - 1");
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null);
  return cards;
}

/* ------------------------------------------------------------------- fixture */

test("the fixed days carry the plans these tests lean on", async () => {
  assert.equal(DAY, "2026-10-05");
  assert.equal(DAY_TUE, "2026-10-06");
  assert.equal(DAY_SAT, "2026-10-10");

  const db = await freshDb();
  const cards = await cardsFor(db);
  assert.equal(cards.need, 3);
  assert.deepEqual(cards.slots.map((item) => [item.slot, item.area]), [
    ["morning", "mobility"], ["midday", "heart"], ["evening", "lower"],
  ]);
});

/* ----------------------------------------------------------------- the slot */

test("a ten-minute log stands in for the open card the caller names", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, slot: "morning", source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: true, slot: "morning", all: false });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:morning`]);
  assert.equal(await rowDelta(db, MOVE_STAND_KIND, `${DAY}:morning`), 1);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), 1, "the log's own area is marked");
});

test("with no slot named, the log fills the open card of its own area", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: true, slot: "midday", all: false }, "a walk leans on the heart card");
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:midday`]);
});

test("a named slot that is not an open card is refused", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, slot: "afternoon", source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: false, reason: "bad_slot" });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), []);
});

/* --------------------------------------------------------------- the balance */

test("a walk log stand-in sets no movebal", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { activity: "walk", minutes: 12, at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.equal(out.ok, true);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null);
});

test("a yoga log with a mobility area sets movebal", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { activity: "yoga", minutes: 10, at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: true, slot: "morning", all: false }, "the mobility card");
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), 1);
});

test("a bodyweight log with a heart area does not balance the day", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, {
    activity: "bodyweight", minutes: 10, area: "heart", at: AT(10),
  });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, area: "heart", now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: true, slot: "midday", all: false }, "the heart card");
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null,
    "the log's own area, not its activity, is what decides the balance");
});

/* ------------------------------------------------- refusals */

test("a log whose area is the last balancing card takes another open card instead", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  assert.deepEqual(cards.slots.map((item) => [item.slot, item.area]), [
    ["morning", "mobility"], ["midday", "heart"], ["evening", "lower"],
  ]);
  // A lower-area log leans on the evening card, which is the last open card a
  // balancing chunk fits: the stand-in goes to another open card instead.
  const logged = await log(db, { activity: "walk", minutes: 10, area: "lower", at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, area: "lower", now: AT(10), cards,
  });
  assert.equal(out.ok, true, "another open card is a card this stand-in may take");
  assert.equal(out.slot, "morning", "the first open card that is not the one kept open");
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:morning`]);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null, "a walk log never balances the day");
});

test("a named slot that is the last balancing card is still refused", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { activity: "walk", minutes: 10, area: "lower", at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, slot: "evening", source: "log", logKey: logged.key, area: "lower", now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: false, reason: "last_balance" }, "a named slot is answered as asked");
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), []);
});

test("a nine-minute log is too short to stand in for a card", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { minutes: 9, at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: false, reason: "too_short" });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), []);
});

test("one log stand-in a day: a second log is refused", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const first = await log(db, { at: AT(10) });
  const ok = await assignStandIn(db, {
    day: DAY, source: "log", logKey: first.key, now: AT(10), cards,
  });
  assert.equal(ok.ok, true);

  const second = await log(db, { at: AT(11) });
  assert.notEqual(second.key, first.key, "a new minute is a new log");
  const refused = await assignStandIn(db, {
    day: DAY, source: "log", logKey: second.key, now: AT(11), cards,
  });
  assert.deepEqual(refused, { ok: false, reason: "already_used" });
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 1);
  assert.equal((await keysOf(db, MOVE_STAND_KIND)).length, 1);
});

test("a stand-in for a day that is not today writes nothing", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { at: AT(10) });

  const out = await assignStandIn(db, {
    day: DAY_TUE, source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(out, { ok: false, reason: "not_today" });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), []);
});

test("a body that is neither a log nor the goal is refused", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  for (const source of [undefined, "", "walk", "outdoor", 7]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await assignStandIn(db, { day: DAY, source, now: AT(10), cards });
    assert.deepEqual(out, { ok: false, reason: "bad_source" }, String(source));
  }
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
});

test("a log key that is not one of the day's logs is refused", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { at: AT(10) });
  const junk = [
    undefined,
    "",
    "not-a-key",
    `${DAY}:600:walk`,
    `${DAY}:600:walk:10`,
    `${DAY_TUE}:600:walk:10:easy`,
    logged.key + ":x",
  ];
  for (const logKey of junk) {
    // eslint-disable-next-line no-await-in-loop
    const out = await assignStandIn(db, { day: DAY, source: "log", logKey, now: AT(10), cards });
    assert.deepEqual(out, { ok: false, reason: "no_log" }, String(logKey));
  }
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
});

/* ---------------------------------------------------- one row, and no pay */

test("a stand-in writes one movestand row, and a second assign for the slot adds none", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const logged = await log(db, { at: AT(10) });
  const first = await assignStandIn(db, {
    day: DAY, slot: "morning", source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.deepEqual(first, { ok: true, slot: "morning", all: false });

  const again = await assignStandIn(db, {
    day: DAY, slot: "morning", source: "log", logKey: logged.key, now: AT(10), cards,
  });
  assert.equal(again.ok, false);
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), [`${DAY}:morning`]);
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:morning`]);
});

test("a stand-in never pays: no budget row grows and the bird is not fed", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  await stepsReading(db, AT(9));
  const before = await petState(db, { now: AT(10) });

  const out = await assignStandIn(db, { day: DAY, source: "steps", now: AT(10), cards });
  assert.deepEqual(out, { ok: true, slot: "midday", all: false });
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY), null, "no indoor budget was claimed");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY), null, "no outdoor budget was claimed");

  const after = await petState(db, { now: AT(10) });
  assert.equal(after.energy, before.energy, "the pet is never fed by a stand-in");
});

/* ------------------------------------------------------------ the step goal */

test("the step goal fills the midday card and no other slot", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  await stepsReading(db, AT(9));

  const out = await assignStandIn(db, { day: DAY, source: "steps", now: AT(10), cards });
  assert.deepEqual(out, { ok: true, slot: "midday", all: false });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:midday`]);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), 1);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null, "steps never balance a day");
});

test("a step count under the goal does not stand in for a card", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  await stepsReading(db, AT(9), 3000);

  const out = await assignStandIn(db, { day: DAY, source: "steps", now: AT(10), cards });
  assert.deepEqual(out, { ok: false, reason: "goal_not_reached" });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), []);
});

test("on a two-card day without a midday card the goal fills the heart card", async () => {
  const db = await freshDb();
  await writePrefs(db, { cards: 2 });
  const cards = await cardsFor(db, AT_TUE(9));
  assert.deepEqual(cards.slots.map((item) => [item.slot, item.area]), [
    ["morning", "heart"], ["evening", "upper"],
  ]);
  await stepsReading(db, AT_TUE(9));

  const out = await assignStandIn(db, { day: DAY_TUE, source: "steps", now: AT_TUE(10), cards });
  assert.deepEqual(out, { ok: true, slot: "morning", all: false });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY_TUE}:morning`]);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY_TUE), null);
});

test("with no heart card either, the goal fills the first open free card", async () => {
  const db = await freshDb();
  await writePrefs(db, { cards: 2 });
  const cards = await cardsFor(db, AT_SAT(9));
  assert.deepEqual(cards.slots.map((item) => [item.slot, item.area]), [
    ["morning", "mobility"], ["evening", "free"],
  ]);
  await stepsReading(db, AT_SAT(9));

  const out = await assignStandIn(db, { day: DAY_SAT, source: "steps", now: AT_SAT(10), cards });
  assert.deepEqual(out, { ok: true, slot: "evening", all: false });
  const filled = cards.slots.find((item) => item.slot === "evening");
  assert.equal(BALANCE_AREAS.includes(filled.area), false, "never a card a balancing chunk is kept for");
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY_SAT), null);
});

test("with neither a heart nor a free card open, the goal has no card to fill", async () => {
  const db = await freshDb();
  await writePrefs(db, { cards: 2 });
  const cards = await cardsFor(db);
  assert.deepEqual(cards.slots.map((item) => item.area), ["mobility", "lower"],
    "both cards of a Monday pair are ones a balancing chunk fits");
  await stepsReading(db, AT(9));

  const out = await assignStandIn(db, { day: DAY, source: "steps", now: AT(10), cards });
  assert.deepEqual(out, { ok: false, reason: "no_card" });
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
});

test("a step goal and a walk stop at need - 1 cards together", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  await stepsReading(db, AT(8));
  const stepIn = await assignStandIn(db, { day: DAY, source: "steps", now: AT(8), cards });
  assert.deepEqual(stepIn, { ok: true, slot: "midday", all: false });

  const first = await walked(db, 10, { cards, start: AT(9) });
  assert.deepEqual(first.filled, ["morning"], "one card left by the stand-in the day already used");
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 2, "two of the day's three cards");

  const second = await walked(db, 30, { cards, start: AT(11) });
  assert.deepEqual(second.filled, []);
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 2, "and no more");
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null);
});

/* ------------------------------------------- the day still needs a balance */

test("three cards filled by steps, a walk and a walk log is impossible", async () => {
  const db = await freshDb();
  const cards = await stepGoalAndWalk(db);
  const logged = await log(db, { at: AT(11) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, now: AT(11), cards,
  });
  assert.deepEqual(out, { ok: false, reason: "last_balance" });
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 2);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null);
  assert.equal(await isDayComplete(db, DAY, { need: cards.need }), false);
});

test("the same day completed by a yoga log whose area is a balancing one", async () => {
  const db = await freshDb();
  const cards = await stepGoalAndWalk(db);
  const logged = await log(db, { activity: "yoga", minutes: 10, area: "mobility", at: AT(11) });

  const out = await assignStandIn(db, {
    day: DAY, source: "log", logKey: logged.key, area: "mobility", now: AT(11), cards,
  });
  assert.deepEqual(out, { ok: true, slot: "evening", all: true });
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 3);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), 1);
  assert.equal(await isDayComplete(db, DAY, { need: cards.need }), true);
  assert.equal(await rowDelta(db, MOVE_STAND_KIND, `${DAY}:evening`), 1,
    "the balancing stand-in is marked as one");

  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [STANDIN_DAY_KEY + DAY],
  });
  assert.deepEqual(JSON.parse(String(rows[0].value)), { steps: true, log: true },
    "both stand-ins the day used are kept in the one local row");
});

/* ------------------------------------------------------ the local flag rows */

test("writing today's flags prunes the stand-in rows older than yesterday", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const seedFlag = (dayStr, value) => db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?)",
    args: [STANDIN_DAY_KEY + dayStr, JSON.stringify(value)],
  });
  await seedFlag("2026-09-28", { steps: true });
  await seedFlag("2026-10-03", { log: true });
  await seedFlag("2026-10-04", { steps: true, log: true });

  const writes = [];
  const emit = async (table, op, row) => { writes.push({ table, op, row }); };
  await stepsReading(db, AT(9));
  const out = await assignStandIn(db, { day: DAY, source: "steps", now: AT(10), cards, emit });
  assert.deepEqual(out, { ok: true, slot: "midday", all: false });

  const { rows } = await db.execute({
    sql: "SELECT key, value FROM ramble_settings WHERE key LIKE ? ORDER BY key",
    args: [STANDIN_DAY_KEY + "%"],
  });
  assert.deepEqual(rows.map((row) => String(row.key).slice(STANDIN_DAY_KEY.length)),
    ["2026-10-04", DAY],
    "yesterday's flag and today's stay, and the two older days are gone");
  assert.deepEqual(JSON.parse(String(rows[0].value)), { steps: true, log: true },
    "yesterday's own flags are left as they were");
  assert.deepEqual(JSON.parse(String(rows[1].value)), { log: false, steps: true },
    "and today carries the stand-in just used");
  assert.deepEqual(writes.filter((call) => call.table === "ramble_settings"), [],
    "a local key and its pruning never leave the box");
});