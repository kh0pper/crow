/**
 * Moves — derived day completion (private engineering notes).
 *
 * What is pinned here:
 *   - a day is complete from its wallet rows alone: the `moveneed` count, that
 *     many `moveslot` rows for real slot names, and a `movebal` row,
 *   - reading a day writes nothing, and `moveall` — a cache a write path may
 *     keep — is never what makes a day complete,
 *   - a `moveneed` row that states no usable count leaves the day incomplete,
 *     and a slot row for another day (or another slot name) counts for nothing,
 *   - `opts.need` caps the requirement at the day's picks-capped need, and any
 *     value that is not a whole number from 1 up is no cap,
 *   - `completeDays` answers exactly the complete days of a range in three
 *     queries, and a bad range answers nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { insertOnce, rowDelta } from "../bundles/ramble/server/steps.js";
import {
  MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_NEED_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND,
  completeDays, isDayComplete,
} from "../bundles/ramble/server/moves/day-complete.js";
import { MOVE_AREA_KIND } from "../bundles/ramble/server/moves/week.js";
import { HEART_KIND } from "../bundles/ramble/server/hearts.js";
import { MOVE_DONE_KIND } from "../bundles/ramble/server/moves/ledger.js";
import { VIA, recordSlotDone, settleDay } from "../bundles/ramble/server/moves/day.js";

const DAY = "2026-11-12";
const YESTERDAY = "2026-11-11";
const SLOTS = ["morning", "midday", "evening"];

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

async function fact(db, kind, key, delta = 1) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [kind, key, delta, 0],
  });
}

/** One `moveslot` row per named slot of `day`. */
async function slotRows(db, day, slots = SLOTS) {
  for (const slot of slots) await fact(db, MOVE_SLOT_KIND, `${day}:${slot}`);
}

/** A finished day: its need, its slot rows and its balance. */
async function finishedDay(db, day, { need = 3, slots = SLOTS } = {}) {
  await fact(db, MOVE_NEED_KIND, day, need);
  await slotRows(db, day, slots);
  await fact(db, MOVE_BAL_KIND, day);
}

/** How many rows the wallet holds per kind. */
async function walletCounts(db) {
  const { rows } = await db.execute({
    sql: "SELECT kind, count(*) AS n FROM ramble_wallet GROUP BY kind",
    args: [],
  });
  const out = {};
  for (const row of rows) out[String(row.kind)] = Number(row.n);
  return out;
}

test("three finished slots, a need and a balance complete the day, and reading it writes nothing", async () => {
  const db = await freshDb();
  await finishedDay(db, DAY);
  const before = await walletCounts(db);

  assert.equal(await isDayComplete(db, DAY), true);
  assert.deepEqual(await walletCounts(db), before, "a read is a read");
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, DAY), null, "no cache row was written");

  assert.equal(await isDayComplete(db, DAY), true, "the cache row is not what makes it complete");
});

test("a day is complete only from the slots it asked for and its balance", async () => {
  const short = await freshDb();
  await fact(short, MOVE_NEED_KIND, DAY, 3);
  await slotRows(short, DAY, ["morning", "midday"]);
  await fact(short, MOVE_BAL_KIND, DAY);
  assert.equal(await isDayComplete(short, DAY), false, "two of three is not the day");

  const unbalanced = await freshDb();
  await fact(unbalanced, MOVE_NEED_KIND, DAY, 3);
  await slotRows(unbalanced, DAY);
  assert.equal(await isDayComplete(unbalanced, DAY), false, "no balance, no complete day");

  const pair = await freshDb();
  await fact(pair, MOVE_NEED_KIND, DAY, 2);
  await slotRows(pair, DAY, ["morning", "evening"]);
  await fact(pair, MOVE_BAL_KIND, DAY);
  assert.equal(await isDayComplete(pair, DAY), true, "two slots named, two done");

  const unasked = await freshDb();
  await slotRows(unasked, DAY);
  await fact(unasked, MOVE_BAL_KIND, DAY);
  assert.equal(await isDayComplete(unasked, DAY), false, "a day that asked for nothing");
  assert.equal(await isDayComplete(unasked, "yesterday"), false, "a day string that is not one");

  for (const delta of [5, 0, -1, 2.5]) {
    const odd = await freshDb();
    await fact(odd, MOVE_NEED_KIND, DAY, delta);
    await slotRows(odd, DAY);
    await fact(odd, MOVE_BAL_KIND, DAY);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await isDayComplete(odd, DAY), false, `a need of ${delta} is no demand`);
  }
});

test("opts.need caps the requirement at the day's picks-capped need, and never more", async () => {
  const db = await freshDb();
  await fact(db, MOVE_NEED_KIND, DAY, 3);
  await slotRows(db, DAY, ["morning", "midday"]);
  await fact(db, MOVE_BAL_KIND, DAY);

  assert.equal(await isDayComplete(db, DAY), false);
  assert.equal(await isDayComplete(db, DAY, { need: 2 }), true, "the day could only fill two");
  assert.equal(await isDayComplete(db, DAY, { need: 3 }), false, "the cap never fills a slot");
  assert.equal(await isDayComplete(db, DAY, { need: 1 }), true);
  assert.equal(await isDayComplete(db, DAY, { need: 0 }), false, "zero is no cap");
  assert.equal(await isDayComplete(db, DAY, { need: "x" }), false, "junk is no cap");
  assert.equal(await isDayComplete(db, DAY, { need: 2.5 }), false, "a fraction is no cap");
});

test("a slot row of another day, another name, or a cache row alone never completes a day", async () => {
  const otherDay = await freshDb();
  await fact(otherDay, MOVE_NEED_KIND, DAY, 3);
  await slotRows(otherDay, YESTERDAY);
  await fact(otherDay, MOVE_BAL_KIND, DAY);
  assert.equal(await isDayComplete(otherDay, DAY), false);

  const otherName = await freshDb();
  await fact(otherName, MOVE_NEED_KIND, DAY, 1);
  await fact(otherName, MOVE_SLOT_KIND, `${DAY}:noon`);
  await fact(otherName, MOVE_STAND_KIND, `${DAY}:midday`);
  await fact(otherName, MOVE_BAL_KIND, DAY);
  assert.equal(await isDayComplete(otherName, DAY), false, "a stand-in is not a slot row");

  const cached = await freshDb();
  await fact(cached, MOVE_NEED_KIND, DAY, 3);
  await fact(cached, MOVE_BAL_KIND, DAY);
  await fact(cached, MOVE_ALL_KIND, DAY);
  assert.equal(await isDayComplete(cached, DAY), false, "the cache is not the answer");
});

test("completeDays answers exactly the complete days of a range, in three queries", async () => {
  const db = await freshDb();
  const first = "2026-11-10";
  const second = "2026-11-11";
  const third = "2026-11-12";
  // A two-card day, a day whose balance never came, a three-card day, and one
  // day outside the range (which must not leak in).
  await finishedDay(db, first, { need: 2, slots: ["morning", "evening"] });
  await fact(db, MOVE_NEED_KIND, second, 3);
  await slotRows(db, second);
  await finishedDay(db, third);
  await finishedDay(db, "2026-11-13");

  const counted = { calls: 0 };
  const spy = {
    execute: (query) => {
      counted.calls += 1;
      return db.execute(query);
    },
  };
  const done = await completeDays(spy, { from: first, to: third });
  assert.deepEqual([...done].sort(), [first, third]);
  assert.equal(counted.calls, 3);

  assert.deepEqual([...(await completeDays(db, { from: first, to: second }))], [first]);
  assert.deepEqual([...(await completeDays(db, { from: first, to: "2026-11-09" }))], []);
  assert.deepEqual([...(await completeDays(db, { from: "not-a-day", to: third }))], []);
  assert.deepEqual([...(await completeDays(db, { from: third, to: first }))], [], "a range that runs backwards");
  assert.deepEqual([...(await completeDays(db, {}))], []);
});

// --- Writing a day: recordSlotDone and settleDay ---------------------------

/** Local noon, so day arithmetic is timezone-independent. */
function base(offset) {
  return new Date(2026, 9, 20 + offset, 12, 0, 0).getTime();
}

/** Just after local midnight of that day. */
function midnight(offset) {
  return new Date(2026, 9, 20 + offset, 0, 5, 0).getTime();
}

const dayOf = (offset) => localDay(base(offset));

/** A player-run chunk: `kind` (a routine by default) training `areas`. */
function chunk(areas, kind = "routine") {
  return { id: `chunk-${kind}-${areas.join("-")}`, kind, areas, activity: "bodyweight", minutes: 10 };
}

/** A walk, which never balances a day whatever it works. */
function walk(id, areas) {
  return { id, kind: "walk", areas, activity: "walk", minutes: 10 };
}

/** Rows of one kind, so an assertion says how many were written. */
async function rowsOfKind(db, kind) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? ORDER BY key",
    args: [kind],
  });
  return rows.map((row) => String(row.key));
}

test("three finished slots complete the day; two of three do not", async () => {
  const db = await freshDb();
  const day = dayOf(0);
  await insertOnce(db, MOVE_NEED_KIND, day, 3, base(0));

  const morning = await recordSlotDone(db, {
    day, slot: "morning", entry: chunk(["heart"]), via: "player", now: base(0),
  });
  assert.deepEqual(morning, { fresh: true, all: false });

  const midday = await recordSlotDone(db, {
    day, slot: "midday", entry: chunk(["mobility"]), via: "player", now: base(0),
  });
  assert.equal(midday.all, false, "two of three is not the day");
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, day), null, "no cache row before the last card");

  const evening = await recordSlotDone(db, {
    day, slot: "evening", entry: chunk(["core"]), via: "player", now: base(0),
  });
  assert.equal(evening.fresh, true);
  assert.equal(evening.all, true);
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, day), 1);
});

test("settleDay is the only writer of the cache and the heart, once each", async () => {
  const db = await freshDb();
  const day = dayOf(0);
  // A seven-day run ending today, so the settlement has a heart to award.
  for (let i = -6; i <= 0; i += 1) await fact(db, MOVE_DONE_KIND, dayOf(i), 1);
  await fact(db, MOVE_NEED_KIND, day, 3);
  await slotRows(db, day);
  await fact(db, MOVE_BAL_KIND, day);

  const before = await walletCounts(db);
  assert.equal(await isDayComplete(db, day), true);
  assert.deepEqual(await walletCounts(db), before, "a read is a read");
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, day), null, "completion writes nothing on its own");

  const first = await settleDay(db, { day, now: base(0) });
  assert.deepEqual(first, { complete: true, fresh: true });
  const settled = await walletCounts(db);
  assert.equal(settled[MOVE_ALL_KIND], 1, "one cache row");
  assert.equal(settled[HEART_KIND], 1, "one heart");
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, day), 1);
  assert.equal(await rowDelta(db, HEART_KIND, "streak:" + day), 1);

  const second = await settleDay(db, { day, now: base(0) });
  assert.deepEqual(second, { complete: true, fresh: false });
  assert.deepEqual(await walletCounts(db), settled, "a second settle writes nothing");
  assert.deepEqual(await rowsOfKind(db, HEART_KIND), ["streak:" + day]);
});

test("a day at its slot count without a balance is not complete", async () => {
  const day = dayOf(0);

  const walks = await freshDb();
  await insertOnce(walks, MOVE_NEED_KIND, day, 3, base(0));
  for (const slot of SLOTS) {
    const got = await recordSlotDone(walks, {
      day, slot, entry: walk("walk-" + slot, ["heart"]), via: "player", now: base(0),
    });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(got.all, false);
  }
  assert.equal(await rowDelta(walks, MOVE_BAL_KIND, day), null, "a walk is not a balance");
  assert.equal(await isDayComplete(walks, day), false);

  const outdoor = await freshDb();
  await insertOnce(outdoor, MOVE_NEED_KIND, day, 3, base(0));
  for (const slot of SLOTS) {
    await recordSlotDone(outdoor, {
      day, slot, entry: chunk(["core"]), via: "outdoor", now: base(0),
    });
  }
  assert.equal(await rowDelta(outdoor, MOVE_BAL_KIND, day), null, "an outdoor chunk is no balance");
  assert.equal(await isDayComplete(outdoor, day), false, "three of three, still no balance");
});

test("recording the same slot twice writes its row once", async () => {
  const db = await freshDb();
  const day = dayOf(0);

  const first = await recordSlotDone(db, {
    day, slot: "morning", entry: chunk(["core"]), via: "player", now: base(0),
  });
  assert.equal(first.fresh, true);
  assert.deepEqual(await rowsOfKind(db, MOVE_SLOT_KIND), [`${day}:morning`]);
  const before = await walletCounts(db);

  const second = await recordSlotDone(db, {
    day, slot: "morning", entry: chunk(["core"]), via: "player", now: base(0),
  });
  assert.equal(second.fresh, false, "the row was already there");
  assert.deepEqual(await walletCounts(db), before, "a repeat writes nothing new");
  assert.deepEqual(await rowsOfKind(db, MOVE_SLOT_KIND), [`${day}:morning`]);
});

test("a chunk beyond the day's cards closes no slot, and can finish the day", async () => {
  const db = await freshDb();
  const day = dayOf(0);
  const emitted = [];
  const emit = async (table, op, row) => {
    if (table === "ramble_wallet") emitted.push(`${row.kind} ${row.key}`);
  };

  const extra = await recordSlotDone(db, {
    day, entry: chunk(["core"]), via: "player", now: base(0), emit,
  });
  assert.equal(extra.fresh, true, "its area and balance rows were new");
  assert.deepEqual(await rowsOfKind(db, MOVE_SLOT_KIND), [], "an extra closes no slot");
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${day}:core`), 1);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, day), 1);
  assert.deepEqual(emitted, [`${MOVE_AREA_KIND} ${day}:core`, `${MOVE_BAL_KIND} ${day}`]);

  const again = await recordSlotDone(db, {
    day, entry: chunk(["core"]), via: "player", now: base(0),
  });
  assert.equal(again.fresh, false, "nothing was new the second time");

  // Every card already done and no balance: the extra is what finishes the day.
  const late = await freshDb();
  await fact(late, MOVE_NEED_KIND, day, 3);
  await slotRows(late, day);
  assert.equal(await isDayComplete(late, day), false, "the day still lacks its balance");

  const finishing = await recordSlotDone(late, {
    day, entry: chunk(["core"]), via: "player", now: base(0),
  });
  assert.equal(finishing.all, true);
  assert.equal(await rowDelta(late, MOVE_SLOT_KIND, `${day}:morning`), 1, "the day's card rows stay");
});

test("a balance is the player's own chunk or a class, never a walk and never a stand-in", async () => {
  const day = dayOf(0);
  const balanceAfter = async (entry, via) => {
    const db = await freshDb();
    await recordSlotDone(db, { day, slot: "morning", entry, via, now: base(0) });
    return rowDelta(db, MOVE_BAL_KIND, day);
  };

  assert.equal(await balanceAfter(chunk(["heart"]), "player"), null,
    "a heart routine leaves the balance alone");
  assert.equal(await balanceAfter(chunk(["lower", "heart"]), "player"), 1,
    "a routine that works the legs balances the day");
  assert.equal(await balanceAfter(chunk(["lower", "heart"], "landmark"), "player"), 1,
    "a landmark routine counts: it is the player's own and it works the legs");
  assert.equal(await balanceAfter(walk("walk-heart", ["heart"]), "player"), null);
  assert.equal(await balanceAfter(walk("walk-lower", ["lower"]), "player"), null,
    "a walk is no balance, even working the legs");
  assert.equal(await balanceAfter(chunk(["core"]), "class"), 1, "a class balances like the player");
  for (const via of ["outdoor", "standin-log", "standin-steps"]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await balanceAfter(chunk(["lower"]), via), null, `via ${via} writes no balance`);
  }
});

test("a chunk done just after midnight is filed under the day it was picked for", async () => {
  const db = await freshDb();
  const today = dayOf(0);
  const yesterday = dayOf(-1);
  const now = midnight(0);

  const got = await recordSlotDone(db, {
    day: yesterday, slot: "evening", entry: chunk(["core"]), via: "player", now,
  });
  assert.equal(got.fresh, true);
  assert.deepEqual(await rowsOfKind(db, MOVE_SLOT_KIND), [`${yesterday}:evening`]);
  assert.equal(await rowDelta(db, MOVE_SLOT_KIND, `${today}:evening`), null, "today's cards stay open");
  assert.equal(await rowDelta(db, MOVE_AREA_KIND, `${yesterday}:core`), 1);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, yesterday), 1);
  assert.equal(await rowDelta(db, MOVE_BAL_KIND, today), null);

  // A day older than yesterday is too old to write to: today's date is used.
  const old = await freshDb();
  await recordSlotDone(old, {
    day: dayOf(-2), slot: "evening", entry: chunk(["core"]), via: "player", now: base(0),
  });
  assert.deepEqual(await rowsOfKind(old, MOVE_SLOT_KIND), [`${today}:evening`]);
});

test("the picks-capped need finishes a day its slot count alone would not", async () => {
  const db = await freshDb();
  const day = dayOf(0);
  await insertOnce(db, MOVE_NEED_KIND, day, 3, base(0));
  await recordSlotDone(db, {
    day, slot: "morning", entry: chunk(["core"]), via: "player", now: base(0),
  });
  await recordSlotDone(db, {
    day, slot: "midday", entry: chunk(["mobility"]), via: "player", now: base(0),
  });

  assert.equal((await settleDay(db, { day, now: base(0) })).complete, false, "two of three is not the day");
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, day), null, "an incomplete settle writes nothing");
  assert.equal((await settleDay(db, { day, now: base(0), need: 2 })).complete, true,
    "the day could only fill two cards");

  const capped = await recordSlotDone(db, {
    day, slot: "midday", entry: chunk(["mobility"]), via: "player", now: base(0), need: 2,
  });
  assert.equal(capped.all, true);
});

test("a chunk naming an unknown via, slot or entry is refused before anything is written", async () => {
  const db = await freshDb();
  const day = dayOf(0);
  const entry = chunk(["core"]);
  const refused = { name: "MovesInputError" };

  await assert.rejects(recordSlotDone(db, { day, slot: "morning", entry, via: "buddy", now: base(0) }), refused);
  await assert.rejects(recordSlotDone(db, { day, slot: "morning", entry, via: undefined, now: base(0) }), refused);
  await assert.rejects(recordSlotDone(db, { day, slot: "noon", entry, via: "player", now: base(0) }), refused);
  await assert.rejects(recordSlotDone(db, { day, slot: "", entry, via: "player", now: base(0) }), refused);
  await assert.rejects(recordSlotDone(db, { day, slot: "morning", via: "player", now: base(0) }), refused);
  await assert.rejects(recordSlotDone(db, {
    day, slot: "morning", entry: { areas: ["core"] }, via: "player", now: base(0),
  }), refused);
  await assert.rejects(recordSlotDone(db, {
    day, slot: "morning", entry: { kind: "routine", areas: [1] }, via: "player", now: base(0),
  }), refused);
  assert.deepEqual(VIA, ["player", "class", "outdoor", "standin-log", "standin-steps"]);
  assert.equal(Object.isFrozen(VIA), true);

  const ok = await recordSlotDone(db, { day, entry, via: "player", now: base(0) });
  assert.equal(ok.fresh, true, "a chunk with no slot is an extra, not junk");
});
