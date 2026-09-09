/**
 * Spec 2026-09-08 §4.1 — the auto-minted egg is gone, and NOTHING recreates
 * it by being looked at.
 *
 * ⚠ The test that matters most here is "walking still feeds you with no egg".
 * feedAll gates the PET feed on creditWarmth's `credited`, so making
 * creditWarmth report not-credited when there is no egg would stop energy
 * arriving exactly while the player is eggless — and laying (Task 5) needs
 * happy days while eggless. That is a death spiral, not a rough edge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  mintIncubatingEgg, getIncubatingEgg, eggState, creditWarmth,
} from "../bundles/ramble/server/eggs.js";
import { feedAll } from "../bundles/ramble/server/feed.js";

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  return db;
}

async function eggCount(db) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_eggs", args: [] });
  return Number(rows[0].n);
}

test("eggState on a fresh db creates NO egg and reports egg: null", async () => {
  const db = await freshDb();
  const state = await eggState(db, { now: T0 });
  assert.equal(state.egg, null, "no egg exists, so none is reported");
  assert.equal(await eggCount(db), 0, "a pure read must not mint");
  assert.ok(state.checklist, "the checklist still renders with no egg");
});

test("eggState is still a pure read when an egg DOES exist", async () => {
  const db = await freshDb();
  await mintIncubatingEgg(db, { now: T0 });
  const state = await eggState(db, { now: T0 });
  assert.ok(state.egg, "the egg is reported");
  assert.equal(state.egg.warmth, 0);
  assert.equal(state.egg.percent, 0);
  assert.equal(await eggCount(db), 1, "reading twice must not mint a second");
  await eggState(db, { now: T0 });
  assert.equal(await eggCount(db), 1);
});

test("creditWarmth with no egg: the ledger row is written, warmth vanishes (D3)", async () => {
  const db = await freshDb();
  const out = await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 });
  assert.equal(out.credited, true, "credited means THE KEY WAS NEW, not that an egg received it");
  assert.equal(out.warmth, 0);
  assert.equal(out.hatched, null);
  assert.equal(await eggCount(db), 0, "crediting warmth must never mint an egg");

  const { rows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_credits WHERE kind = 'visit_place'", args: [],
  });
  assert.equal(Number(rows[0].n), 1, "the key is burned: D3 says the warmth is wasted, not banked");

  // Same place again in the same week is still a no-op.
  const again = await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 });
  assert.equal(again.credited, false);
});

test("REGRESSION: walking, meeting a crow and checking in ALL still feed energy with no egg", async () => {
  const db = await freshDb();
  // ⚠ EXACT VALUES, NOT `> 0` OR `>=`. `ramble_pet.energy` DEFAULTS TO 60
  // (init-tables.js:105), so `energy > 0` is true whether or not anything was
  // fed, and `>=` is true when the feed was SKIPPED and the value did not
  // move. An earlier draft of this very test asserted exactly that and would
  // have passed against the death spiral it exists to prevent — phase 2's
  // vacuous-fixture lesson, on the one test that most needed to be sharp.
  // Deltas (pet.js FEED_DELTAS): checkin +5, visit_place +15, meet_crow +20,
  // against the base ceiling of 100.
  const before = await feedAll(db, { type: "checkin" }, { now: T0 });
  assert.equal(await eggCount(db), 0, "feeding must not mint an egg");
  assert.equal(before.pet.energy, 65, "60 + 5: the check-in fed the bird with no egg");

  const place = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 + 1000 });
  assert.equal(place.pet.energy, 80, "65 + 15: a new place fed the bird");

  const crow = await feedAll(db, { type: "meet_crow", persona: "abc123" }, { now: T0 + 2000 });
  assert.equal(crow.pet.energy, 100, "80 + 20: meeting a crow fed the bird");
  assert.equal(await eggCount(db), 0);
});

test("NEGATIVE CONTROL: a repeat visit_place does not feed, so the test above can fail", async () => {
  // Without this, an implementation that fed unconditionally would also pass
  // the test above. `shouldFeedPet` must still honour the dedup key.
  const db = await freshDb();
  const first = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 });
  assert.equal(first.pet.energy, 75, "60 + 15");
  const repeat = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 + 1000 });
  assert.equal(repeat.credited, false, "same cell, same ISO week");
  assert.equal(repeat.pet.energy, 75, "a not-credited keyed event must NOT feed");
});

test("an unknown or pet-only event is still a pure read with no egg", async () => {
  const db = await freshDb();
  await creditWarmth(db, { type: "chore" }, { now: T0 });
  await creditWarmth(db, { type: "nonsense" }, { now: T0 });
  assert.equal(await eggCount(db), 0);
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_credits", args: [] });
  assert.equal(Number(rows[0].n), 0, "chore/unknown never touch the ledger");
});

test("getIncubatingEgg is a plain read that returns null rather than throwing", async () => {
  const db = await freshDb();
  assert.equal(await getIncubatingEgg(db), null);
  const egg = await mintIncubatingEgg(db, { now: T0 });
  const read = await getIncubatingEgg(db);
  assert.equal(read.egg_id, egg.egg_id);
});
