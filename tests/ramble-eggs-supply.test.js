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
  promoteFromShelf, nextPromotable, hatchIfReady,
} from "../bundles/ramble/server/eggs.js";
import { flockState } from "../bundles/ramble/server/flock.js";
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

async function shelveEgg(db, eggId, createdAt, { status = "shelf", origin = "user" } = {}) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES (?, ?, ?, 0, ?)`,
    args: [eggId, status, origin, createdAt],
  });
}

async function statusOf(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT status, shelf_origin FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}

test("promoteFromShelf takes the OLDEST shelf egg and clears shelf_origin", async () => {
  const db = await freshDb();
  await shelveEgg(db, "younger", T0 + 5000);
  await shelveEgg(db, "older", T0);

  const promoted = await promoteFromShelf(db, { now: T0 + 9000 });
  assert.equal(promoted.egg_id, "older", "oldest created_at wins");
  assert.equal((await statusOf(db, "older")).status, "incubating");
  assert.equal((await statusOf(db, "older")).shelf_origin, null,
    "a deliberate promote carries no shelf origin, same as the manual incubate path");
  assert.equal((await statusOf(db, "younger")).status, "shelf", "only one is drafted");
});

test("promoteFromShelf emits, because the user really did move to a new egg", async () => {
  const db = await freshDb();
  await shelveEgg(db, "next", T0);
  const emitted = [];
  await promoteFromShelf(db, { now: T0 + 1000, emit: (t, o, r) => emitted.push([t, o, r.egg_id]) });
  assert.deepEqual(emitted, [["ramble_eggs", "update", "next"]]);
  assert.equal((await statusOf(db, "next")).shelf_origin, null,
    "NULL, never 'sync': relabelling would widen the nest shelf cap (flock.js:126) and make the "
    + "sync layer's own re-promote draftable on an egg the user parked");
});

test("a READ never promotes — flockState and the egg route are pure", async () => {
  const db = await freshDb();
  await shelveEgg(db, "parked", T0);
  await flockState(db, { now: T0 + 1000 });
  assert.equal(await getIncubatingEgg(db), null,
    "a GET must not queue a sync op, and a read-path promote races applyRambleEgg's "
    + "isUserShelve carve-out (instance-sync.js:855)");
  assert.equal((await statusOf(db, "parked")).status, "shelf");
});

test("promoteFromShelf breaks a created_at tie by the lower egg_id, so two instances agree", async () => {
  const db = await freshDb();
  await shelveEgg(db, "bbb", T0);
  await shelveEgg(db, "aaa", T0);
  const promoted = await promoteFromShelf(db, { now: T0 });
  assert.equal(promoted.egg_id, "aaa");
});

test("promoteFromShelf takes a RECEIVED (gifted) egg too", async () => {
  const db = await freshDb();
  await shelveEgg(db, "gift", T0, { status: "received" });
  const promoted = await promoteFromShelf(db, { now: T0 });
  assert.equal(promoted.egg_id, "gift");
});

test("promoteFromShelf SKIPS an egg spoken for by an open swap", async () => {
  const db = await freshDb();
  await shelveEgg(db, "locked-one", T0);
  await shelveEgg(db, "free-one", T0 + 1000);
  // ⚠ 'proposed', not 'offered'. OPEN_SQL is "state IN ('proposed','accepted')",
  // so a made-up state would leave the egg UNLOCKED and this test would be
  // asserting nothing about locking. counterpart/role/expires_at are NOT NULL
  // with no defaults — omitting them fails on the constraint, not the feature.
  await db.execute({
    sql: `INSERT INTO ramble_trades
            (trade_id, counterpart, role, my_egg_id, state, created_at, updated_at, expires_at)
          VALUES ('t1', 'npub-them', 'proposer', 'locked-one', 'proposed', ?, ?, ?)`,
    args: [T0, T0, T0 + 7 * 86400000],
  });
  const promoted = await promoteFromShelf(db, { now: T0 + 2000 });
  assert.equal(promoted.egg_id, "free-one", "an egg promised to a contact is not drafted");
  assert.equal((await statusOf(db, "locked-one")).status, "shelf");
});

test("an EXPIRED but unswept trade still locks its egg — do not 'fix' the predicate", async () => {
  // expireTrades runs on the 15 s drain tick, so there is a window where a
  // lapsed offer is still 'proposed' and its egg stays locked. Once it
  // expires the egg is promotable again, but nothing auto-promotes it — the
  // panel offers it instead (Task 7's "one's waiting on your shelf"). Pinned
  // here so nobody widens OPEN_SQL to "fix" the window.
  const db = await freshDb();
  await shelveEgg(db, "only-one", T0);
  await db.execute({
    sql: `INSERT INTO ramble_trades
            (trade_id, counterpart, role, my_egg_id, state, created_at, updated_at, expires_at)
          VALUES ('t-expired', 'npub-them', 'proposer', 'only-one', 'proposed', ?, ?, ?)`,
    args: [T0, T0, T0 - 1000],           // already past expires_at, not yet swept
  });
  assert.equal(await promoteFromShelf(db, { now: T0 + 5000 }), null);
});

test("nextPromotable answers the same question the promote acts on, and writes nothing", async () => {
  const db = await freshDb();
  assert.equal(await nextPromotable(db), null);
  await shelveEgg(db, "younger", T0 + 5000);
  await shelveEgg(db, "older", T0);

  const peek = await nextPromotable(db);
  assert.equal(peek.egg_id, "older");
  assert.equal((await statusOf(db, "older")).status, "shelf", "a peek must not move it");

  const promoted = await promoteFromShelf(db, { now: T0 + 9000 });
  assert.equal(promoted.egg_id, peek.egg_id, "the card and the promote read ONE rule");
  assert.equal(await nextPromotable(db), null, "the slot is full now");
});

test("promoteFromShelf is a NO-OP when the slot is full, and when there is nothing to promote", async () => {
  const db = await freshDb();
  assert.equal(await promoteFromShelf(db, { now: T0 }), null, "empty shelf, empty slot");
  assert.equal(await eggCount(db), 0, "a no-op promote writes NOTHING — this is what makes it safe on a GET");

  const sitting = await mintIncubatingEgg(db, { now: T0 });
  await shelveEgg(db, "waiting", T0 - 5000);
  assert.equal(await promoteFromShelf(db, { now: T0 }), null, "the slot is occupied");
  assert.equal((await statusOf(db, "waiting")).status, "shelf");
  assert.equal((await getIncubatingEgg(db)).egg_id, sitting.egg_id);
});

test("hatching promotes from the shelf instead of minting a successor", async () => {
  const db = await freshDb();
  const egg = await mintIncubatingEgg(db, { now: T0 });
  await shelveEgg(db, "next-you", T0 + 100);
  await db.execute({ sql: "UPDATE ramble_eggs SET warmth = 100 WHERE egg_id = ?", args: [egg.egg_id] });

  const hatched = await hatchIfReady(db, { now: T0 + 1000 });
  assert.ok(hatched, "it hatched");
  assert.equal(await eggCount(db), 2, "NO successor was minted");
  assert.equal((await getIncubatingEgg(db)).egg_id, "next-you", "the shelf refilled the slot");
});

test("hatching with an EMPTY shelf leaves the slot empty — no free egg", async () => {
  const db = await freshDb();
  const egg = await mintIncubatingEgg(db, { now: T0 });
  await db.execute({ sql: "UPDATE ramble_eggs SET warmth = 100 WHERE egg_id = ?", args: [egg.egg_id] });

  const hatched = await hatchIfReady(db, { now: T0 + 1000 });
  assert.ok(hatched);
  assert.equal(await getIncubatingEgg(db), null, "this is the whole phase: no successor appears");
  assert.equal(await eggCount(db), 1);
});

test("two instances promote the SAME egg independently, with no round trip", async () => {
  const a = await freshDb();
  const b = await freshDb();
  for (const db of [a, b]) {
    await shelveEgg(db, "zzz", T0);
    await shelveEgg(db, "aaa", T0);          // same created_at: the tie-break decides
    await shelveEgg(db, "mmm", T0 + 1);
  }
  const pa = await promoteFromShelf(a, { now: T0 + 100 });
  const pb = await promoteFromShelf(b, { now: T0 + 100 });
  assert.equal(pa.egg_id, pb.egg_id, "the order is a pure function of replicated rows");
  assert.equal(pa.egg_id, "aaa");
});
