import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { feedAll } from "../bundles/ramble/server/feed.js";
import { petState } from "../bundles/ramble/server/pet.js";
import { mintIncubatingEgg } from "../bundles/ramble/server/eggs.js";

let db; const T0 = Date.UTC(2026, 8, 7, 12);
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  // Task 2 (spec 2026-09-08 §4.1): minting is deliberate now — these tests
  // are about warmth accrual and hatching, not egg supply, so give them an
  // explicit starter egg rather than weaken their assertions.
  await mintIncubatingEgg(db, { now: T0 });
});

test("one call credits warmth AND energy; a repeat keyed event credits neither", async () => {
  const e0 = (await petState(db, { now: T0 })).energy;
  const a = await feedAll(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 });
  assert.equal(a.credited, true); assert.equal(a.warmth, 20);
  assert.equal(a.pet.energy, Math.min(100, e0 + 15));
  const b = await feedAll(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 1000 });
  assert.equal(b.credited, false); assert.equal(b.pet.energy, a.pet.energy);
});

test("hatch fires onHatch once with the egg", async () => {
  let hatched = null;
  for (let i = 0; i < 10 && !hatched; i++) {
    await feedAll(db, { type: "meet_crow", persona: "q" + i }, { now: T0, onHatch: (egg) => { hatched = egg; } });
  }
  assert.ok(hatched && hatched.species && Number.isInteger(hatched.seed));
});

test("unknown type is a no-op that does not throw", async () => {
  const r = await feedAll(db, { type: "bogus" }, { now: T0 });
  assert.equal(r.credited, false); assert.equal(r.hatched, null);
});

test("concurrent feeds on a fresh instance never race the pet row into a UNIQUE throw", async () => {
  // ensurePetRow / ensureRow used to be SELECT-then-INSERT: two overlapping
  // feeds on a fresh db both saw "no row" and both INSERTed, so the loser threw
  // SQLITE_CONSTRAINT and POST /api/ramble/egg/checkin answered 500.
  const fresh = createClient({ url: "file::memory:" });
  await initRambleTables(fresh);
  await assert.doesNotReject(
    Promise.all([feedAll(fresh, { type: "checkin" }, { now: T0 }), feedAll(fresh, { type: "checkin" }, { now: T0 })]),
  );
  const { rows } = await fresh.execute("SELECT count(*) AS n FROM ramble_pet");
  assert.equal(rows[0].n, 1, "exactly one singleton pet row");
});

test("concurrent unkeyed feeds (both credited, both feed the pet) never race the pet row", async () => {
  // The sharper reproduction of the same defect: `mark_left` is unkeyed, so
  // BOTH calls reach pet.js's ensureRow on a db that has no pet row yet.
  const fresh = createClient({ url: "file::memory:" });
  await initRambleTables(fresh);
  await assert.doesNotReject(
    Promise.all([feedAll(fresh, { type: "mark_left" }, { now: T0 }), feedAll(fresh, { type: "mark_left" }, { now: T0 })]),
  );
  const { rows } = await fresh.execute("SELECT count(*) AS n FROM ramble_pet");
  assert.equal(rows[0].n, 1, "exactly one singleton pet row");
});

test("feedAll's pet shape is identical whether or not the event credited", async () => {
  // The not-credited branch used to return the RAW pet row (lamport_ts,
  // chores_json, owner as stored) while the credited branch returned the
  // shaped pet — same key in the response, two different objects.
  const fresh = createClient({ url: "file::memory:" });
  await initRambleTables(fresh);
  const first = await feedAll(fresh, { type: "visit_place", cell: "9v6m21h" }, { now: T0 });
  const repeat = await feedAll(fresh, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 1000 });
  assert.equal(first.credited, true);
  assert.equal(repeat.credited, false);
  assert.deepEqual(Object.keys(repeat.pet).sort(), Object.keys(first.pet).sort());
  for (const leaked of ["lamport_ts", "chores_json"]) {
    assert.ok(!(leaked in repeat.pet), `${leaked} must not leak out of feedAll`);
  }
});
