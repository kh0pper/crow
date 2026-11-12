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
import { rowDelta } from "../bundles/ramble/server/steps.js";
import {
  MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_NEED_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND,
  completeDays, isDayComplete,
} from "../bundles/ramble/server/moves/day-complete.js";

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

