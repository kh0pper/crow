import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { feedAll } from "../bundles/ramble/server/feed.js";
import { petState } from "../bundles/ramble/server/pet.js";

let db; const T0 = Date.UTC(2026, 8, 7, 12);
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

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
