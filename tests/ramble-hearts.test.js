/**
 * Spec 2026-09-08 §2.3 and §6.4 — heart container placement.
 *
 * Placement is a hash of the cell, like nestFor and seedFor: identical on
 * every device, nothing stored, and not re-rollable by walking out and back.
 *
 * ⚠ FIXTURES, NOT LUCKY HASHES. Phase 1's sparse seed broke tests that were
 * written against cells which happened to hash right. Every behavioural test
 * below sets rate 1 so EVERY cell holds a heart and the fixture is whatever we
 * name. The rate itself is covered by one statistical test and one pinned
 * vector, which are the only two places a specific hash value matters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { decodeGeohash, encodeGeohash } from "../bundles/ramble/server/anchors.js";
import {
  HEART_KIND, HEART_SALT, HEART_WILD_SALT,
  HEART_RATE_DEFAULT, HEART_WILD_DAYS_DEFAULT, HEART_WILD_RATE_DEFAULT,
  ENERGY_MAX_BASE_DEFAULT, ENERGY_MAX_PER_HEART_DEFAULT, ENERGY_MAX_CAP_DEFAULT,
  wildWindow, heartFor, wildHeartFor, heartCandidates, readHeartSettings,
} from "../bundles/ramble/server/hearts.js";

const CELL = "9vk79ed";
const ALL = { rate: 1, wildRate: 1 };   // rate 1: every cell holds one

function inside(cell, spot) {
  const c = decodeGeohash(cell);
  return spot.lat >= c.lat - c.latErr && spot.lat <= c.lat + c.latErr
      && spot.lon >= c.lon - c.lonErr && spot.lon <= c.lon + c.lonErr;
}

test("the defaults are the spec's numbers, plus the two recorded deviations", () => {
  assert.equal(HEART_KIND, "heart");
  assert.equal(HEART_RATE_DEFAULT, 3);
  assert.equal(HEART_WILD_DAYS_DEFAULT, 30);
  assert.equal(HEART_WILD_RATE_DEFAULT, 40);
  assert.equal(ENERGY_MAX_BASE_DEFAULT, 100);
  assert.equal(ENERGY_MAX_PER_HEART_DEFAULT, 10);
  assert.equal(ENERGY_MAX_CAP_DEFAULT, 300);
  assert.notEqual(HEART_SALT, HEART_WILD_SALT, "the two sources must not share a salt");
});

test("heartFor: at rate 1 every valid cell holds one, at a point INSIDE the cell", () => {
  const spot = heartFor(CELL, ALL);
  assert.ok(spot, "rate 1 always hits");
  assert.equal(spot.cell, CELL);
  assert.equal(spot.source, "first");
  assert.equal(spot.key, CELL, "a first heart is keyed by the bare cell");
  assert.ok(inside(CELL, spot), "the pip sits inside its own cell");
  // Not the centre: a row of hearts along a street must not line up.
  const c = decodeGeohash(CELL);
  assert.ok(spot.lat !== c.lat || spot.lon !== c.lon, "hash-placed, not centred");
});

test("heartFor: deterministic, and junk is refused rather than thrown", () => {
  assert.deepEqual(heartFor(CELL, ALL), heartFor(CELL, ALL));
  assert.equal(heartFor("not-a-cell", ALL), null);
  assert.equal(heartFor("", ALL), null);
  assert.equal(heartFor(null, ALL), null);
  // deepEqual, NOT equal: at the default rate both sides may be objects, and
  // `equal` would then compare identity and fail for a reason that has nothing
  // to do with the fallback. This is the file's own lucky-hash warning applied
  // to itself.
  assert.deepEqual(heartFor(CELL, { rate: 0 }), heartFor(CELL, {}), "a junk rate falls back to the default");
});

test("heartFor at the default rate hits roughly one cell in three", () => {
  let hits = 0;
  const total = 3000;
  let n = 0;
  for (let i = 0; i < total; i++) {
    // A spread of real coordinates, not sequential strings: geohash prefixes
    // are not uniform over arbitrary text.
    const lat = -60 + ((i * 7919) % 12000) / 100;
    const lon = -170 + ((i * 6271) % 34000) / 100;
    const cell = encodeGeohash(lat, lon, 7);
    n += 1;
    if (heartFor(cell, { rate: HEART_RATE_DEFAULT })) hits += 1;
  }
  const share = hits / n;
  assert.ok(share > 0.28 && share < 0.39, `expected ~1/3, got ${share}`);
});

test("wildHeartFor: window-scoped, and a DIFFERENT place from the first heart", () => {
  const w = 610;
  const wild = wildHeartFor(CELL, w, ALL);
  assert.ok(wild);
  assert.equal(wild.source, "wild");
  assert.equal(wild.key, CELL + ":" + w, "a wild heart is keyed by cell AND window");
  assert.ok(inside(CELL, wild));
  const first = heartFor(CELL, ALL);
  assert.ok(wild.lat !== first.lat || wild.lon !== first.lon,
    "independent salts: the two sources must not land on the same spot");
  assert.notDeepEqual(wildHeartFor(CELL, w + 1, ALL), wild, "a new window is a new roll");
  assert.equal(wildHeartFor(CELL, "nope", ALL), null);
  assert.equal(wildHeartFor("bad", w, ALL), null);
});

test("wildWindow buckets by whole days and falls back on junk", () => {
  const day = 24 * 3600 * 1000;
  assert.equal(wildWindow(0, 30), 0);
  assert.equal(wildWindow(30 * day - 1, 30), 0);
  assert.equal(wildWindow(30 * day, 30), 1);
  assert.equal(wildWindow(60 * day, 30), 2);
  assert.equal(wildWindow(60 * day, 0), wildWindow(60 * day, HEART_WILD_DAYS_DEFAULT));
  assert.equal(wildWindow(60 * day, "x"), wildWindow(60 * day, HEART_WILD_DAYS_DEFAULT));
});

test("heartCandidates lists BOTH sources, permanent first — it never hides the wild one", () => {
  // ⚠ This is the shape the plan review forced. An `a || b` candidate would
  // short-circuit forever once the permanent heart was taken, so at the default
  // rate one cell in three could never grow a wild heart again — while the code
  // comment promised the opposite.
  const both = heartCandidates(CELL, 610, ALL);
  assert.equal(both.length, 2, "both sources hit at rate 1, and both are offered");
  assert.equal(both[0].source, "first", "the once-ever heart is offered first");
  assert.equal(both[1].source, "wild", "but the regrowing one is still there behind it");
  assert.deepEqual(both[0], heartFor(CELL, ALL));
  assert.deepEqual(both[1], wildHeartFor(CELL, 610, ALL));

  // The huge rates are asserted to miss rather than assumed to, so a surprise
  // hit reads as a precondition failure instead of a confusing shape failure.
  assert.equal(heartFor(CELL, { rate: 999999 }), null, "precondition: no first heart at this rate");
  const onlyWild = heartCandidates(CELL, 610, { rate: 999999, wildRate: 1 });
  assert.deepEqual(onlyWild.map((c) => c.source), ["wild"]);

  assert.equal(wildHeartFor(CELL, 610, { wildRate: 999999 }), null, "precondition: no wild heart either");
  assert.deepEqual(heartCandidates(CELL, 610, { rate: 999999, wildRate: 999999 }), []);
  assert.deepEqual(heartCandidates("bad", 610, ALL), []);
});

test("readHeartSettings reads all six keys, and refuses junk", async () => {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const put = (k, v) => db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [k, v],
  });

  assert.deepEqual(await readHeartSettings(db), {
    rate: 3, wildDays: 30, wildRate: 40, energyBase: 100, perHeart: 10, cap: 300,
  }, "an untouched db reads the defaults");

  await put("heart.rate", "1");
  await put("heart.wild.days", "7");
  await put("heart.wild.rate", "2");
  await put("energy.max.base", "80");
  await put("energy.max.per.heart", "25");
  await put("energy.max.cap", "500");
  assert.deepEqual(await readHeartSettings(db), {
    rate: 1, wildDays: 7, wildRate: 2, energyBase: 80, perHeart: 25, cap: 500,
  });

  for (const k of ["heart.rate", "heart.wild.days", "heart.wild.rate", "energy.max.base", "energy.max.per.heart", "energy.max.cap"]) {
    await put(k, "banana");
  }
  assert.deepEqual(await readHeartSettings(db), {
    rate: 3, wildDays: 30, wildRate: 40, energyBase: 100, perHeart: 10, cap: 300,
  }, "junk everywhere falls all the way back");

  // A cap below the base would clamp a heartless bird's energy DOWN. Refuse it.
  await put("energy.max.base", "100");
  await put("energy.max.cap", "40");
  assert.equal((await readHeartSettings(db)).cap, 100, "the cap is never below the base");
});

test("pinned: the default-rate placement never moves", () => {
  // Generated once from the salts in hearts.js. If this fails, someone changed
  // a salt or the hash arithmetic, and every existing player's map moved
  // underneath them. Hits AND misses, positions AND presence: a pin of misses
  // alone passes against a heartFor() that returns null for everything.
  const FIRST_HITS = [
    ["0jr4et3", -60.000382, -169.999899],
    ["9e7tnt3", 19.189336, -107.290802],
    ["7h0m181", -21.620466, -44.580818],
  ];
  const FIRST_MISSES = ["u6hzs83", "r5wp4tc", "7g616em"];
  const WILD_HITS = [
    ["26y5dc1", -28.910171, -160.188970],
    ["u3s7bzb", 54.139269, 17.259736],
  ];
  const WILD_MISSES = ["0jr4et3", "9e7tnt3"];

  assert.ok(FIRST_HITS.length > 0 && WILD_HITS.length > 0, "a pin with no hits pins nothing");
  for (const [cell, lat, lon] of FIRST_HITS) {
    const spot = heartFor(cell, {});
    assert.ok(spot, cell + " must still hold its permanent heart");
    assert.equal(spot.lat.toFixed(6), lat.toFixed(6), cell + " heart moved in latitude");
    assert.equal(spot.lon.toFixed(6), lon.toFixed(6), cell + " heart moved in longitude");
  }
  for (const cell of FIRST_MISSES) assert.equal(heartFor(cell, {}), null, cell + " must still be empty");
  for (const [cell, lat, lon] of WILD_HITS) {
    const spot = wildHeartFor(cell, 610, {});
    assert.ok(spot, cell + " must still hold its wild heart in window 610");
    assert.equal(spot.lat.toFixed(6), lat.toFixed(6), cell + " wild heart moved in latitude");
    assert.equal(spot.lon.toFixed(6), lon.toFixed(6), cell + " wild heart moved in longitude");
  }
  for (const cell of WILD_MISSES) assert.equal(wildHeartFor(cell, 610, {}), null, cell + " must still be empty");
});
