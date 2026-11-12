/**
 * Ramble moves — outdoor sessions (moves design Task 4; private engineering
 * notes).
 *
 * A walk or jog is a Start/Done session, not a chunk. What is pinned here:
 *   - the elapsed minutes are capped at 60 and pay `round(1.2 x minutes)`
 *     through the outdoor day budget, which is the ONLY cap (no CHUNK_MAX and
 *     no per-block rounding), so a session can pay more than a chunk does,
 *   - a repeated finish of the same session pays nothing more and writes
 *     nothing, and a second session of the day draws from what the budget has
 *     left,
 *   - under ten minutes a session pays and counts its minutes and nothing else;
 *     at ten minutes it also marks the day's heart area, writes the `walked`
 *     fact (the profile picture's badge) and starts standing in for cards,
 *   - a walk fills at most `need - 1` cards, counts the stand-ins the day
 *     already used, prefers the heart card, and always leaves open the last card
 *     a balancing chunk (BALANCE_AREAS) fits — so a day can never be completed
 *     by walks alone,
 *   - the day's cards are passed in (this module never imports slots.js), and a
 *     missing or not-today set of cards fills nothing while the pay, the
 *     minutes, the heart area and the walked fact still happen,
 *   - the session row is a LOCAL setting: `startOutdoor` is idempotent while a
 *     session is open, `outdoorState` reads it back, and nothing about it is
 *     ever emitted.
 *
 * The shipped library is filled elsewhere, so every test injects its own
 * chunks. The clock is a fixed local Monday (2026-10-05), whose three-card plan
 * is mobility, heart, lower, so nothing here depends on the machine's timezone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  hasRealMovement, localDay, startOfLocalDay,
} from "../bundles/ramble/server/eggs.js";
import { insertOnce, rowDelta, WALKED_KIND } from "../bundles/ramble/server/steps.js";
import {
  MOVE_OUTDOOR_KIND, OUTDOOR_DAILY_CAP,
} from "../bundles/ramble/server/moves/ledger.js";
import { MOVE_MIN_KIND } from "../bundles/ramble/server/moves/progress.js";
import { MOVE_AREA_KIND } from "../bundles/ramble/server/moves/week.js";
import {
  MOVE_BAL_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND, isDayComplete,
} from "../bundles/ramble/server/moves/day-complete.js";
import { BALANCE_AREAS } from "../bundles/ramble/server/moves/library.js";
import { writePrefs } from "../bundles/ramble/server/moves/today.js";
import { dayCards } from "../bundles/ramble/server/moves/slots.js";
import {
  OUTDOOR_SESSION_KEY, finishOutdoor, outdoorPoints, outdoorState, recordSlotDone, startOutdoor,
} from "../bundles/ramble/server/moves/day.js";
import { readPortrait, renderBirdAvatar } from "../servers/sharing/profile-avatar.js";

const H = 3_600_000;
const M = 60_000;
/** Local noon of a fixed Monday; AT(h, m) is that day at h:m local time. */
const DAY0 = startOfLocalDay(new Date(2026, 9, 5, 12, 0, 0, 0).getTime());
const AT = (h, m = 0) => DAY0 + h * H + m * M;
const DAY = localDay(AT(12));

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

/**
 * No heart chunk at all: the midday slot (planned heart) falls back to
 * mobility, which the morning already took, and lands on core — a day planned
 * mobility, core, lower.
 */
function heartlessLibrary() {
  return [
    chunk({ id: "mob-1", areas: ["mobility"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "core-1", areas: ["core"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
  ];
}

/** The day's cards as the routes would draw them. */
function cardsFor(db, now = AT(9), lib = library()) {
  return dayCards(db, { now, library: lib });
}

/** Every emit call, so a write that must never leave the box can be seen. */
function collector() {
  const calls = [];
  const emit = async (table, op, row) => { calls.push({ table, op, row }); };
  return { calls, emit };
}

/** Every wallet row and setting, so "wrote nothing" is checkable. */
async function snapshot(db) {
  const wallet = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet ORDER BY kind, key", args: [],
  });
  const settings = await db.execute({
    sql: "SELECT key, value FROM ramble_settings ORDER BY key", args: [],
  });
  return {
    wallet: wallet.rows.map((r) => [String(r.kind), String(r.key), Number(r.delta)]),
    settings: settings.rows.map((r) => [String(r.key), String(r.value)]),
  };
}

async function readSetting(db, key) {
  const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
  return rows[0]?.value ?? null;
}

/** Rows of one wallet kind, so an assertion says how many were written. */
async function keysOf(db, kind) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? ORDER BY key", args: [kind],
  });
  return rows.map((row) => String(row.key));
}

/** The cards still open on the day, as the panel would draw them. */
async function openCards(db, now = AT(12)) {
  const cards = await cardsFor(db, now);
  return cards.slots.filter((item) => item.done !== true && item.empty !== true);
}

/** A hatched bird in the pet slot, so the real portrait read has something to draw. */
async function plantBird(db) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at)
          VALUES ('b1', 'hatched', 100, 'crow', 4242, 1, 2) ON CONFLICT(egg_id) DO NOTHING`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'b1')
          ON CONFLICT(owner) DO UPDATE SET active_egg_id = excluded.active_egg_id`,
    args: [],
  });
}

/** Open a session at 09:00 and finish it `minutes` later. */
async function walked(db, minutes, { cards = null, start = AT(9), emit } = {}) {
  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: start });
  return finishOutdoor(db, { day: DAY, now: start + minutes * M, emit, cards });
}

/* ------------------------------------------------------------------- fixture */

test("the fixed day is a Monday, so its three-card plan is mobility, heart, lower", async () => {
  assert.equal(DAY, "2026-10-05");
  const db = await freshDb();
  const cards = await cardsFor(db);
  assert.equal(cards.need, 3);
  assert.deepEqual(cards.slots.map((item) => item.area), ["mobility", "heart", "lower"]);
});

/* ----------------------------------------------------------------------- pay */

test("outdoorPoints is the chunk rate with no chunk ceiling, and junk pays nothing", () => {
  assert.equal(outdoorPoints(9), 11);
  assert.equal(outdoorPoints(10), 12);
  assert.equal(outdoorPoints(11), 13);
  assert.equal(outdoorPoints(30), 36);
  assert.equal(outdoorPoints(60), 72, "an hour is worth far more than one chunk's 20");
  assert.equal(outdoorPoints(0), 0);
  assert.equal(outdoorPoints(-5), 0);
  assert.equal(outdoorPoints("30"), 0);
  assert.equal(outdoorPoints(Number.NaN), 0);
  assert.equal(outdoorPoints(), 0);
});

test("pay: the minutes through the outdoor budget, and nothing capped per session", async () => {
  for (const [minutes, paid] of [[11, 13], [9, 11], [10, 12], [30, 36]]) {
    const db = await freshDb();
    // eslint-disable-next-line no-await-in-loop
    const out = await walked(db, minutes);
    assert.equal(out.minutes, minutes, `minutes: ${minutes}`);
    assert.equal(out.paid, paid, `paid for ${minutes} minutes`);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY), paid, "the day's budget row holds what was paid");
  }
});

test("a 90-minute session is capped at 60 minutes, and the day's 40 is the only cap", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9) });
  const out = await finishOutdoor(db, { day: DAY, now: AT(10, 30), cards });

  assert.equal(out.minutes, 60, "an hour is as long as a session counts");
  assert.equal(out.paid, OUTDOOR_DAILY_CAP, "round(1.2 x 60) is 72, cut to the day's 40");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY), OUTDOOR_DAILY_CAP);
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY), 60);
  assert.deepEqual(out.filled, ["midday", "morning"], "the heart card, then another");
  assert.equal(out.needsBalance, true, "the last card is left for a balancing chunk");
  assert.equal(out.walkedNew, true);
  assert.equal(await isDayComplete(db, DAY, { need: cards.need }), false);
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:midday`, `${DAY}:morning`]);
});

test("a repeated finish of the same session pays nothing and writes nothing", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const first = await walked(db, 11, { cards });
  assert.equal(first.paid, 13);
  assert.deepEqual(first.filled, ["midday"]);

  const before = await snapshot(db);
  const again = await finishOutdoor(db, { day: DAY, now: AT(9, 40), cards });
  assert.deepEqual(again, {
    minutes: 11,
    filled: first.filled,
    paid: 0,
    needsBalance: first.needsBalance,
    walkedNew: false,
  });
  assert.deepEqual(await snapshot(db), before, "a second finish writes nothing at all");
});

test("a second session of the day draws from what the budget has left", async () => {
  const db = await freshDb();
  const first = await walked(db, 30);
  assert.equal(first.paid, 36);
  const session = await outdoorState(db);
  assert.equal(session.finished, true);
  assert.equal(session.startedAt, AT(9));

  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9, 30) });
  const second = await finishOutdoor(db, { day: DAY, now: AT(10) });
  assert.equal(second.minutes, 30);
  assert.equal(second.paid, 4, "36 of the 40 are spent");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY), OUTDOOR_DAILY_CAP);
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY), 60);
});

/* -------------------------------------------------------------- what it marks */

test("nine minutes pays and counts the minutes, and marks nothing else", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const out = await walked(db, 9, { cards });

  assert.equal(out.paid, 11);
  assert.deepEqual(out.filled, []);
  assert.equal(out.walkedNew, false);
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY), 9);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), null, "no heart area under ten minutes");
  assert.equal(await rowDelta(db, WALKED_KIND, DAY), null, "no walked fact under ten minutes");
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);
  assert.equal(await hasRealMovement(db, DAY), true, "the outdoor budget row it paid is a movement fact");
});

test("ten minutes marks the heart area, the walked fact and the first card", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const out = await walked(db, 10, { cards });

  assert.equal(out.paid, 12);
  assert.equal(out.walkedNew, true);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), 1);
  assert.equal(await rowDelta(db, WALKED_KIND, DAY), 1);
  assert.deepEqual(out.filled, ["midday"], "the heart card");
  assert.equal(await rowDelta(db, MOVE_SLOT_KIND, `${DAY}:midday`), 1);
  assert.equal(await rowDelta(db, MOVE_STAND_KIND, `${DAY}:midday`), 1, "the stand-in row marks a walk");
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null, "an outdoor stand-in never balances the day");
  assert.equal(out.needsBalance, false, "two cards are still open for a balancing chunk");
});

test("nineteen minutes counts as one card", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const out = await walked(db, 19, { cards });
  assert.equal(out.filled.length, 1);
  assert.deepEqual(out.filled, ["midday"]);
});

/* --------------------------------------------------------------- card filling */

test("a 30-minute walk fills the heart card and one more, and leaves a balancing card open", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const out = await walked(db, 30, { cards });

  assert.equal(out.paid, 36);
  assert.equal(out.filled.length, 2);
  assert.equal(out.filled[0], "midday", "the heart card goes first");
  assert.equal(out.needsBalance, true);

  const open = await openCards(db);
  assert.equal(open.length, 1);
  assert.ok(BALANCE_AREAS.includes(open[0].area), "the card left open is one a balancing chunk fits: " + open[0].area);
  assert.equal(open[0].slot, "evening");
});

test("a filled card's stand-in row is written before the card's slot row", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const { calls, emit } = collector();
  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9) });
  const out = await finishOutdoor(db, { day: DAY, now: AT(9, 30), emit, cards });
  assert.deepEqual(out.filled, ["midday", "morning"]);

  const at = (kind, key) => calls.findIndex((call) => call.table === "ramble_wallet"
    && call.row?.kind === kind && call.row?.key === key);
  for (const slot of out.filled) {
    const stand = at(MOVE_STAND_KIND, `${DAY}:${slot}`);
    const filled = at(MOVE_SLOT_KIND, `${DAY}:${slot}`);
    assert.ok(stand >= 0, "the stand-in row is written: " + slot);
    assert.ok(filled >= 0, "the slot row is written: " + slot);
    assert.ok(stand < filled,
      "the stand-in mark lands first, so the day's stand-in count already holds the card: " + slot);
  }
});

test("on a day planned mobility, core and lower a 30-minute walk fills two of them", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db, AT(9), heartlessLibrary());
  assert.equal(cards.need, 3);
  assert.deepEqual(cards.slots.map((item) => item.area), ["mobility", "core", "lower"]);

  const out = await walked(db, 30, { cards });
  assert.equal(out.filled.length, 2);
  assert.deepEqual(out.filled, ["morning", "midday"], "no heart card, so the rest in slot order");
  const open = await openCards(db);
  assert.equal(open.length, 1);
  assert.equal(open[0].area, "lower");
  assert.equal(out.needsBalance, true);
});

test("a one-card day fills no card whatever the walk length", async () => {
  const db = await freshDb();
  await writePrefs(db, { cards: 1 });
  const cards = await cardsFor(db);
  assert.equal(cards.need, 1);

  const out = await walked(db, 60, { cards });
  assert.deepEqual(out.filled, []);
  assert.equal(out.needsBalance, true, "the day's one card is left for a balancing chunk");
  assert.equal(await rowDelta(db, MOVE_SLOT_KIND, `${DAY}:midday`), null);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), 1, "the heart area is still marked");
});

test("a two-card day fills one card at most, and the card left open is balancing", async () => {
  const db = await freshDb();
  await writePrefs(db, { cards: 2 });
  const cards = await cardsFor(db);
  assert.equal(cards.need, 2);

  const out = await walked(db, 60, { cards });
  assert.equal(out.filled.length, 1);
  assert.equal(out.needsBalance, true);
  const open = await openCards(db);
  assert.equal(open.length, 1);
  assert.ok(BALANCE_AREAS.includes(open[0].area), "left open: " + open[0].area);
});

test("a stand-in the day already used counts against the same need - 1", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  assert.equal(cards.need, 3);
  await insertOnce(db, MOVE_STAND_KIND, `${DAY}:evening`, 1, AT(8));

  const out = await walked(db, 30, { cards });
  assert.deepEqual(out.filled, ["midday"], "one card, because one stand-in was already used");
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:midday`]);
  assert.equal(out.needsBalance, true);
});

test("two walks of one day together fill at most need - 1 cards", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const first = await walked(db, 30, { cards });
  assert.equal(first.filled.length, 2);

  const second = await walkAgain(db, 30);
  assert.deepEqual(second.filled, []);
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 2, "need - 1 cards, no more");
  assert.equal(await isDayComplete(db, DAY, { need: cards.need }), false);
});

/** A second session of the same day, opened and finished 30 minutes later. */
async function walkAgain(db, minutes) {
  const start = AT(11);
  const cards = await cardsFor(db, start);
  await startOutdoor(db, { day: DAY, entryId: "walk-2", now: start });
  return finishOutdoor(db, { day: DAY, now: start + minutes * M, cards });
}

test("three cards all filled by walks is impossible: a walk, a stand-in and another walk", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const first = await walked(db, 60, { cards });
  assert.equal(first.filled.length, 2);
  // The last card's stand-in, recorded as a step goal would be.
  await insertOnce(db, MOVE_STAND_KIND, `${DAY}:evening`, 1, AT(10));

  // The same cards object on purpose: the wallet, not the flags, says what is done.
  const second = await walkAgain(db, 30);
  assert.deepEqual(second.filled, []);
  assert.equal((await keysOf(db, MOVE_SLOT_KIND)).length, 2);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), null);
  assert.equal(await isDayComplete(db, DAY, { need: cards.need }), false, "a balancing chunk is still owed");
});

test("a walk of need - 1 cards, then a player's own chunk on the open card, completes the day", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const out = await walked(db, 30, { cards });
  assert.equal(out.filled.length, 2);
  assert.equal(out.needsBalance, true);

  const open = await openCards(db);
  assert.equal(open.length, 1);
  const done = await recordSlotDone(db, {
    day: DAY,
    slot: open[0].slot,
    entry: { kind: "routine", areas: ["mobility"] },
    via: "player",
    now: AT(9, 40),
    need: cards.need,
  });
  assert.equal(done.all, true);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, DAY), 1, "the player's own chunk balances the day");
  assert.equal(await isDayComplete(db, DAY, { need: cards.need }), true);
});

test("without the day's cards the session still pays, counts, marks and badges", async () => {
  const db = await freshDb();
  await cardsFor(db);
  const out = await walked(db, 30);
  assert.deepEqual(out.filled, []);
  assert.equal(out.needsBalance, false);
  assert.equal(out.paid, 36);
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY), 30);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), 1);
  assert.equal(await rowDelta(db, WALKED_KIND, DAY), 1);
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), []);

  // Cards drawn for another day tell this one nothing.
  const other = await freshDb();
  const yesterday = await cardsFor(other, AT(-12));
  assert.notEqual(yesterday.day, DAY);
  const stale = await walked(other, 30, { cards: yesterday });
  assert.deepEqual(stale.filled, []);
  assert.equal(await rowDelta(other, MOVE_OUTDOOR_KIND, DAY), 36);
});

/** A local clock time on the day after DAY0, built from local fields so DST cannot shift it. */
const NEXT_AT = (h, m = 0) => new Date(2026, 9, 6, h, m, 0, 0).getTime();

test("a session finished after midnight pays its own day and fills none of the new day's cards", async () => {
  const db = await freshDb();
  const start = new Date(2026, 9, 5, 23, 50, 0, 0).getTime();
  const finish = NEXT_AT(0, 10);
  const nextDay = localDay(finish);
  assert.equal(localDay(start), DAY, "the session started on the fixed day");
  assert.notEqual(nextDay, DAY);

  // What the route reads at 00:10 and hands in: the NEW day's cards.
  const tomorrows = await cardsFor(db, finish);
  assert.equal(tomorrows.day, nextDay);
  assert.equal(tomorrows.need, 3);

  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: start });
  const out = await finishOutdoor(db, { day: nextDay, now: finish, cards: tomorrows });

  assert.deepEqual(out.filled, [], "another day's cards are never written under this one");
  assert.equal(out.paid, outdoorPoints(20), "the session still pays");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY), outdoorPoints(20), "on the day it started");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, nextDay), null);
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY), 20);
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${DAY}:heart`), 1, "the heart area is the session's day");
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${nextDay}:heart`), null);
  assert.equal(await rowDelta(db, WALKED_KIND, DAY), 1);
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [], "no slot row on either day");
  assert.deepEqual(await keysOf(db, MOVE_STAND_KIND), [], "no stand-in row on either day");

  // A same-day finish still fills the pay day's own cards.
  const daysOwn = await cardsFor(db, AT(9));
  assert.equal(daysOwn.day, DAY);
  await startOutdoor(db, { day: DAY, entryId: "walk-2", now: AT(9) });
  const sameDay = await finishOutdoor(db, { day: DAY, now: AT(9) + 20 * M, cards: daysOwn });
  assert.deepEqual(sameDay.filled, ["midday", "morning"], "the pay day's own cards are still filled");
  assert.deepEqual(await keysOf(db, MOVE_SLOT_KIND), [`${DAY}:midday`, `${DAY}:morning`]);
});

/* --------------------------------------------------- movement fact and badge */

test("a ten-minute walk is a movement fact and badges the profile picture", async () => {
  const db = await freshDb();
  await plantBird(db);
  const cards = await cardsFor(db);
  const out = await walked(db, 10, { cards });
  assert.equal(out.walkedNew, true);

  assert.equal(await rowDelta(db, WALKED_KIND, DAY), 1, "the walked fact the portrait reads");
  assert.equal(await hasRealMovement(db, DAY), true);

  // The real read the profile picture is drawn from, driven the way
  // tests/profile-avatar-bird.test.js drives it.
  const portrait = await readPortrait(db, { now: AT(12) });
  assert.equal(portrait.walked, true);
  assert.notEqual(renderBirdAvatar(portrait), renderBirdAvatar({ ...portrait, walked: false }),
    "the badge is drawn into the picture");
});

/* ------------------------------------------------------------- the session row */

test("startOutdoor keeps an open session's anchor, and outdoorState reads it back", async () => {
  const db = await freshDb();
  assert.equal(await outdoorState(db), null, "no session before one is started");

  const first = await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9) });
  assert.equal(first.startedAt, AT(9));
  assert.equal(first.sessionKey, `${DAY}:o:${Math.floor(AT(9) / 1000)}`);

  const again = await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9, 20) });
  assert.deepEqual(again, first, "a retried or reloaded start keeps the original anchor");

  const state = await outdoorState(db);
  assert.deepEqual(state, {
    day: DAY,
    startedAt: AT(9),
    entryId: "walk-1",
    sessionKey: first.sessionKey,
    finished: false,
  });
  assert.deepEqual(await outdoorState(db), state, "a second read answers the stored row");

  const stored = JSON.parse(await readSetting(db, OUTDOOR_SESSION_KEY));
  assert.equal(stored.day, DAY);
  assert.equal(stored.finished, false);
  assert.equal(stored.startedAt, AT(9));

  // A finished session is replaced: the next walk of the day is a new session.
  await finishOutdoor(db, { day: DAY, now: AT(9, 15) });
  assert.equal((await outdoorState(db)).finished, true);
  const next = await startOutdoor(db, { day: DAY, entryId: "walk-2", now: AT(9, 20) });
  assert.notEqual(next.sessionKey, first.sessionKey);
  const replaced = await outdoorState(db);
  assert.equal(replaced.finished, false);
  assert.equal(replaced.entryId, "walk-2");
  assert.equal(replaced.startedAt, AT(9, 20));
});

test("an unfinished session of another day is replaced, not resumed", async () => {
  const db = await freshDb();
  const first = await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9) });
  const retried = await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9, 20) });
  assert.deepEqual(retried, first, "a retried start the same day keeps the original anchor");

  // The next day's start: the forgotten Done must not make this one long.
  const tomorrow = NEXT_AT(9);
  const tomorrowDay = localDay(tomorrow);
  const next = await startOutdoor(db, { day: tomorrowDay, entryId: "walk-2", now: tomorrow });
  assert.equal(next.startedAt, tomorrow, "the new day's start is anchored at its own clock");
  assert.notEqual(next.sessionKey, first.sessionKey, "and it is a new session");

  const state = await outdoorState(db);
  assert.deepEqual(state, {
    day: tomorrowDay,
    startedAt: tomorrow,
    entryId: "walk-2",
    sessionKey: next.sessionKey,
    finished: false,
  });

  const out = await finishOutdoor(db, { day: tomorrowDay, now: tomorrow + 11 * M });
  assert.equal(out.minutes, 11, "the walk is measured from the new start, not from yesterday's");
  assert.equal(out.paid, outdoorPoints(11));
});

test("nothing about the session row is ever emitted", async () => {
  const db = await freshDb();
  const cards = await cardsFor(db);
  const { calls, emit } = collector();

  await startOutdoor(db, { day: DAY, entryId: "walk-1", now: AT(9) });
  await finishOutdoor(db, { day: DAY, now: AT(9, 30), emit, cards });

  assert.ok(calls.length > 0, "the wallet rows were emitted");
  assert.ok(!calls.some((call) => call.table === "ramble_settings"),
    "a local session row is this instance's own and never leaves the box");
  assert.ok(!calls.some((call) => String(call.row?.key ?? "").startsWith("local.")),
    "no local. key is emitted");
  assert.ok(!calls.some((call) => String(call.row?.value ?? "").includes(OUTDOOR_SESSION_KEY)));
  assert.ok(await readSetting(db, OUTDOOR_SESSION_KEY), "and the row is stored locally");
});

/* ------------------------------------------------------------------- refusals */

test("finishing with no session, or starting with no entry, is refused", async () => {
  const db = await freshDb();
  await assert.rejects(finishOutdoor(db, { day: DAY, now: AT(9) }), { name: "MovesInputError" });
  await assert.rejects(finishOutdoor(db, { now: AT(9) }), { name: "MovesInputError" });
  await assert.rejects(startOutdoor(db, { day: DAY, now: AT(9) }), { name: "MovesInputError" });
  await assert.rejects(startOutdoor(db, { day: DAY, entryId: "", now: AT(9) }), { name: "MovesInputError" });
  await assert.rejects(startOutdoor(db, { day: DAY, entryId: 42, now: AT(9) }), { name: "MovesInputError" });
  assert.equal(await outdoorState(db), null, "a refusal writes no session");
});