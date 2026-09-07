/**
 * Task 14 — Ramble pet (geo activity -> crow mood).
 *
 * feed(db, event) applies FEED_DELTAS to energy (clamped 0..100), bumps the
 * matching weekly counter for the three positive events, sets last_fed_at for
 * positive events, and does a weekly rollover BEFORE applying the event.
 * petState(db) additionally applies passive decay (the phase-1 stand-in for
 * a quiet_tick radio feed) and persists it once.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { feed, petState, moodFor, FEED_DELTAS, doChore } from "../bundles/ramble/server/pet.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
});

async function freshDb() {
  const d = createClient({ url: "file::memory:" });
  await initRambleTables(d);
  return d;
}

test("moodFor thresholds", () => {
  assert.equal(moodFor(100), "happy");
  assert.equal(moodFor(60), "happy");
  assert.equal(moodFor(59), "tired");
  assert.equal(moodFor(30), "tired");
  assert.equal(moodFor(29), "alarmed");
  assert.equal(moodFor(0), "alarmed");
});

test("feeding visit_place/unlock_mark/meet_crow raises energy and sets happy; counters increment", async () => {
  const db2 = createClient({ url: "file::memory:" });
  await initRambleTables(db2);
  const now = 1_000_000;

  // Starting energy is 60 (default) -> already happy, but the deltas +
  // counters must still be exercised for each type.
  const afterVisit = await feed(db2, { type: "visit_place" }, { now });
  assert.equal(afterVisit.energy, 75); // 60 + 15, clamped
  assert.equal(afterVisit.mood, "happy");
  assert.equal(afterVisit.places_week, 1);
  assert.equal(afterVisit.last_fed_at, now);

  const afterUnlock = await feed(db2, { type: "unlock_mark" }, { now: now + 1 });
  assert.equal(afterUnlock.energy, 85); // 75 + 10
  assert.equal(afterUnlock.mood, "happy");
  assert.equal(afterUnlock.unlocks_week, 1);
  assert.equal(afterUnlock.last_fed_at, now + 1);

  const afterCrow = await feed(db2, { type: "meet_crow" }, { now: now + 2 });
  assert.equal(afterCrow.energy, 100); // 85 + 20 clamps at 100
  assert.equal(afterCrow.mood, "happy");
  assert.equal(afterCrow.crows_week, 1);
  assert.equal(afterCrow.last_fed_at, now + 2);
});

test("repeated quiet_tick lowers energy to tired then alarmed; quiet_tick does not bump counters or last_fed_at", async () => {
  const db3 = createClient({ url: "file::memory:" });
  await initRambleTables(db3);
  const now = 2_000_000;

  // 60 -> 50 (tired)
  const r1 = await feed(db3, { type: "quiet_tick" }, { now });
  assert.equal(r1.energy, 50);
  assert.equal(r1.mood, "tired");
  assert.equal(r1.last_fed_at, null);
  assert.equal(r1.places_week, 0);
  assert.equal(r1.unlocks_week, 0);
  assert.equal(r1.crows_week, 0);

  // 50 -> 40 (still tired)
  const r2 = await feed(db3, { type: "quiet_tick" }, { now: now + 1 });
  assert.equal(r2.energy, 40);
  assert.equal(r2.mood, "tired");

  // 40 -> 30 (still tired, boundary)
  const r3 = await feed(db3, { type: "quiet_tick" }, { now: now + 2 });
  assert.equal(r3.energy, 30);
  assert.equal(r3.mood, "tired");

  // 30 -> 20 (alarmed)
  const r4 = await feed(db3, { type: "quiet_tick" }, { now: now + 3 });
  assert.equal(r4.energy, 20);
  assert.equal(r4.mood, "alarmed");
});

test("energy clamps at 100 on the high end", async () => {
  const db4 = createClient({ url: "file::memory:" });
  await initRambleTables(db4);
  const now = 3_000_000;
  await feed(db4, { type: "meet_crow" }, { now });
  await feed(db4, { type: "meet_crow" }, { now: now + 1 });
  const r = await feed(db4, { type: "meet_crow" }, { now: now + 2 });
  assert.equal(r.energy, 100);
  assert.equal(r.mood, "happy");
});

test("energy clamps at 0 on the low end", async () => {
  const db5 = createClient({ url: "file::memory:" });
  await initRambleTables(db5);
  const now = 4_000_000;
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await feed(db5, { type: "quiet_tick" }, { now: now + i });
  }
  const r = await feed(db5, { type: "quiet_tick" }, { now: now + 10 });
  assert.equal(r.energy, 0);
  assert.equal(r.mood, "alarmed");
});

test("weekly rollover resets counters after 7 days but not at 6 days 23 hours", async () => {
  const db6 = createClient({ url: "file::memory:" });
  await initRambleTables(db6);
  const t0 = 10_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  const first = await feed(db6, { type: "visit_place" }, { now: t0 });
  assert.equal(first.places_week, 1);

  // 6 days 23 hours later: no rollover, counter keeps accumulating.
  const almostWeek = t0 + 6 * DAY + 23 * 60 * 60 * 1000;
  const stillAccruing = await feed(db6, { type: "visit_place" }, { now: almostWeek });
  assert.equal(stillAccruing.places_week, 2);

  // Exactly 7 days after t0: rollover resets counters BEFORE applying the
  // event, so this visit lands as places_week === 1, not 3.
  const afterWeek = t0 + 7 * DAY;
  const rolled = await feed(db6, { type: "visit_place" }, { now: afterWeek });
  assert.equal(rolled.places_week, 1);
});

test("unknown event type throws", async () => {
  const db7 = createClient({ url: "file::memory:" });
  await initRambleTables(db7);
  await assert.rejects(() => feed(db7, { type: "nonsense" }, { now: Date.now() }));
});

test("petState decay subtracts 10 energy per full 6 hours elapsed since last_fed_at", async () => {
  const db8 = createClient({ url: "file::memory:" });
  await initRambleTables(db8);
  const t0 = 20_000_000;
  const HOUR = 60 * 60 * 1000;

  // Feed once so last_fed_at is set and energy is at a known value.
  const fed = await feed(db8, { type: "meet_crow" }, { now: t0 }); // 60 + 20 = 80
  assert.equal(fed.energy, 80);

  // 13 hours later: 2 full 6h intervals elapsed -> -20.
  const state = await petState(db8, { now: t0 + 13 * HOUR });
  assert.equal(state.energy, 60);
  assert.equal(state.mood, "happy");
});

test("petState decay persists once: a second immediate petState call at the same instant does not decay again", async () => {
  const db9 = createClient({ url: "file::memory:" });
  await initRambleTables(db9);
  const t0 = 30_000_000;
  const HOUR = 60 * 60 * 1000;

  await feed(db9, { type: "meet_crow" }, { now: t0 }); // energy 80

  const decayed = await petState(db9, { now: t0 + 13 * HOUR });
  assert.equal(decayed.energy, 60);

  // Same "now" again: last_fed_at was rewritten to t0+13h during the call
  // above, so elapsed is 0 and no further decay should apply.
  const again = await petState(db9, { now: t0 + 13 * HOUR });
  assert.equal(again.energy, 60);
});

test("petState does not decay a fresh row with last_fed_at null", async () => {
  const db10 = createClient({ url: "file::memory:" });
  await initRambleTables(db10);
  const state = await petState(db10, { now: 999_999_999_999 });
  assert.equal(state.energy, 60);
  assert.equal(state.mood, "happy");
  assert.equal(state.last_fed_at, null);
});

test("FEED_DELTAS matches the spec's mapping", () => {
  assert.deepEqual(FEED_DELTAS, {
    visit_place: 15,
    unlock_mark: 10,
    meet_crow: 20,
    quiet_tick: -10,
    checkin: 5,
    chore: 8,
    mark_left: 0,
  });
});

test("chores: once per day each, +8 energy, day rollover resets", async () => {
  const db = await freshDb(); // ADD this helper at the top of the file: async function freshDb() { const d = createClient({ url: "file::memory:" }); await initRambleTables(d); return d; }
  const T0 = Date.UTC(2026, 8, 7, 12);
  const a = await doChore(db, "feed", { now: T0 });
  assert.equal(a.done, true); assert.equal(a.chores.feed, true); assert.equal(a.chores.preen, false);
  const before = a.pet.energy;
  const b = await doChore(db, "feed", { now: T0 + 60e3 });
  assert.equal(b.done, false); assert.equal(b.pet.energy, before);
  const c = await doChore(db, "preen", { now: T0 });
  assert.equal(c.pet.energy, Math.min(100, before + 8));
  const d = await doChore(db, "feed", { now: T0 + 86400e3 });
  assert.equal(d.done, true); assert.equal(d.chores.preen, false); // new day
  await assert.rejects(doChore(db, "nap", { now: T0 }));
  const s = await petState(db, { now: T0 + 86400e3 });
  assert.deepEqual(Object.keys(s.chores).sort(), ["day","feed","play","preen"]);
});

test("pet writes emit when a hook is given", async () => {
  const db = await freshDb(); const seen = []; // same helper
  await feed(db, { type: "visit_place" }, { emit: async (t, op, row) => seen.push([t, op, row.owner]) });
  assert.deepEqual(seen[0], ["ramble_pet", "update", "self"]);
});
