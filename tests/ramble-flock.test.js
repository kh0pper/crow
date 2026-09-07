import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";
import { isoWeek, ensureIncubatingEgg } from "../bundles/ramble/server/eggs.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";
import {
  readFlockSettings, listNests, claimNest,
  incubateEgg, activateBird, flockState,
  SHELF_CAP_DEFAULT, CLAIM_RANGE_M, CLAIMS_PER_DAY,
} from "../bundles/ramble/server/flock.js";
import { giftEgg, proposeSwap } from "../bundles/ramble/server/trades.js";

const T0 = Date.UTC(2026, 8, 7, 12); // 2026-09-07 12:00Z
const WEEK = isoWeek(T0);
const DAY = 86400e3;

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }

/** The first N nest cells walking north from (30.46, -98.08) for `week`. */
function nestCells(week, n) {
  const out = [];
  for (let i = 0; i < 5000 && out.length < n; i++) {
    const cell = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(cell, week)) out.push(cell);
  }
  if (out.length < n) throw new Error("not enough nests found");
  return out;
}

let db;
before(async () => { db = await freshDb(); });

test("settings: nest.rate and shelf.cap read with defaults and floors", async () => {
  assert.deepEqual(await readFlockSettings(db), { rate: 24, shelfCap: SHELF_CAP_DEFAULT });
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('nest.rate','3'), ('shelf.cap','0')");
  assert.deepEqual(await readFlockSettings(db), { rate: 3, shelfCap: 0 });
  await db.execute("UPDATE ramble_settings SET value='-2' WHERE key='nest.rate'");
  await db.execute("UPDATE ramble_settings SET value='lots' WHERE key='shelf.cap'");
  assert.deepEqual(await readFlockSettings(db), { rate: 24, shelfCap: SHELF_CAP_DEFAULT });
  await db.execute("DELETE FROM ramble_settings WHERE key IN ('nest.rate','shelf.cap')");
});

test("listNests: current week, claimed marks, distance sort, and null when too wide", async () => {
  const d = await freshDb();
  const [cell] = nestCells(WEEK, 1);
  const nest = nestFor(cell, WEEK);
  const box = { south: nest.lat - 0.01, west: nest.lon - 0.01, north: nest.lat + 0.01, east: nest.lon + 0.01 };
  const out = await listNests(d, box, { now: T0 });
  assert.equal(out.week, WEEK);
  const mine = out.nests.find((n) => n.cell === cell);
  assert.ok(mine, "the known nest must be listed");
  assert.deepEqual(Object.keys(mine).sort(), ["cell", "claimed", "lat", "lon", "seed", "week"]);
  assert.equal(mine.claimed, false);

  await d.execute({ sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES (?,?,?,?)", args: [cell, WEEK, "e-x", T0] });
  const after = await listNests(d, box, { now: T0, from: { lat: nest.lat, lon: nest.lon } });
  assert.equal(after.nests[0].cell, cell, "nearest first");
  assert.equal(after.nests[0].claimed, true);
  assert.equal(after.nests[0].distance_m, 0);
  for (let i = 1; i < after.nests.length; i++) assert.ok(after.nests[i].distance_m >= after.nests[i - 1].distance_m);

  assert.equal(await listNests(d, { south: 30, west: -99, north: 31, east: -98 }, { now: T0 }), null);
});

test("claimNest: in range -> one 'user' shelf egg; idempotent; stale week / no nest / too far refused", async () => {
  const d = await freshDb();
  const [cell] = nestCells(WEEK, 1);
  const nest = nestFor(cell, WEEK);
  const emitted = [];
  const emit = async (t, op, row) => emitted.push([t, op, row]);

  const r = await claimNest(d, { cell, week: WEEK, here: { lat: nest.lat, lon: nest.lon }, now: T0, emit });
  assert.equal(r.claimed, true); assert.equal(r.already, false);
  assert.equal(r.egg.status, "shelf"); assert.equal(r.egg.shelf_origin, "user");
  assert.equal(r.egg.found_cell, cell); assert.equal(r.egg.found_week, WEEK); assert.equal(r.egg.warmth, 0);
  assert.deepEqual(emitted.map(([t, op]) => [t, op]), [["ramble_eggs", "insert"]]);
  assert.equal(emitted[0][2].egg_id, r.egg.egg_id);

  // Same nest again, even from far away: the same egg, nothing new written.
  const again = await claimNest(d, { cell, week: WEEK, here: { lat: 0, lon: 0 }, now: T0 + 3600e3, emit });
  assert.equal(again.claimed, true); assert.equal(again.already, true); assert.equal(again.egg.egg_id, r.egg.egg_id);
  assert.equal(emitted.length, 1);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs")).rows[0].n, 1);

  const [, other] = nestCells(WEEK, 2);
  const o = nestFor(other, WEEK);
  assert.deepEqual(await claimNest(d, { cell: other, week: "2020-W01", here: o, now: T0 + DAY }), { claimed: false, reason: "stale-week" });
  const empty = encodeGeohash(30.46, -98.08, 7); // walk until a NON-nest cell
  let noNest = empty; for (let i = 0; nestFor(noNest, WEEK); i++) noNest = encodeGeohash(30.46 - i * CELL7_LAT_STEP, -98.08, 7);
  assert.deepEqual(await claimNest(d, { cell: noNest, week: WEEK, here: { lat: 30.46, lon: -98.08 }, now: T0 + DAY }), { claimed: false, reason: "no-nest" });
  assert.deepEqual(await claimNest(d, { cell: other, week: WEEK, here: { lat: o.lat + 0.01, lon: o.lon }, now: T0 + DAY }), { claimed: false, reason: "too-far" });
  assert.ok(CLAIM_RANGE_M === 75);
});

test("claimNest: one claim per local day, and the shelf cap refuses the sixth", async () => {
  const d = await freshDb();
  const cells = nestCells(WEEK, 8);
  const at = (c) => { const n = nestFor(c, WEEK); return { lat: n.lat, lon: n.lon }; };
  assert.equal((await claimNest(d, { cell: cells[0], week: WEEK, here: at(cells[0]), now: T0 })).claimed, true);
  assert.deepEqual(await claimNest(d, { cell: cells[1], week: WEEK, here: at(cells[1]), now: T0 + 3600e3 }), { claimed: false, reason: "daily-limit" });
  assert.equal(CLAIMS_PER_DAY, 1);
  // Days 1-4 fill the shelf to the cap. T0 is Monday 12:00Z, and T0 + 5 days
  // (Saturday 12:00Z) is still ISO week 37 in EVERY timezone (UTC+14 makes it
  // Sunday 02:00, same ISO week), so nothing below can go stale. Never use
  // T0 + 6 days here: at UTC+12 that is Monday of W38.
  for (let i = 1; i < SHELF_CAP_DEFAULT; i++) {
    assert.equal((await claimNest(d, { cell: cells[i], week: WEEK, here: at(cells[i]), now: T0 + i * DAY })).claimed, true, `claim ${i}`);
  }
  const day5 = T0 + 5 * DAY;
  assert.deepEqual(await claimNest(d, { cell: cells[5], week: WEEK, here: at(cells[5]), now: day5 }), { claimed: false, reason: "shelf-full" });
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='shelf' AND shelf_origin='user'")).rows[0].n, SHELF_CAP_DEFAULT);
  // The cap counts USER shelf eggs only: neither the incubating egg nor a
  // convergence loser that landed on the shelf is one of the user's spots.
  await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('loser','shelf','sync',0,1)");
  assert.deepEqual(await claimNest(d, { cell: cells[5], week: WEEK, here: at(cells[5]), now: day5 }), { claimed: false, reason: "shelf-full" });
  // A raised cap admits it (5 user eggs < 6) — and the refused attempts above
  // left no claim row, so day 5's one claim is still available.
  await d.execute("INSERT INTO ramble_settings (key, value) VALUES ('shelf.cap','6')");
  assert.equal((await claimNest(d, { cell: cells[5], week: WEEK, here: at(cells[5]), now: day5 })).claimed, true);
});

test("incubateEgg swaps the slot: old egg shelved as 'user', target incubating, emits shelved then incubating", async () => {
  const d = await freshDb();
  const first = await ensureIncubatingEgg(d, { now: T0 });
  await d.execute({ sql: "UPDATE ramble_eggs SET warmth = 40 WHERE egg_id = ?", args: [first.egg_id] });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, created_at) VALUES ('s1','shelf','user',10,'9v6m21h',5)");
  const emitted = [];
  const r = await incubateEgg(d, "s1", { now: T0, emit: async (t, op, row) => emitted.push([t, op, row.egg_id, row.status, row.shelf_origin]) });
  assert.equal(r.ok, true); assert.equal(r.already, false); assert.equal(r.hatched, null);
  assert.equal(r.egg.egg_id, "s1"); assert.equal(r.egg.status, "incubating"); assert.equal(r.egg.shelf_origin, null); assert.equal(r.egg.warmth, 10);
  assert.equal(r.shelved.egg_id, first.egg_id); assert.equal(r.shelved.status, "shelf"); assert.equal(r.shelved.shelf_origin, "user"); assert.equal(r.shelved.warmth, 40);
  assert.deepEqual(emitted, [["ramble_eggs", "update", first.egg_id, "shelf", "user"], ["ramble_eggs", "update", "s1", "incubating", null]]);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);

  assert.deepEqual(await incubateEgg(d, "s1", { now: T0 }).then((x) => [x.ok, x.already]), [true, true]);
  assert.deepEqual(await incubateEgg(d, "nope", { now: T0 }), { ok: false, reason: "not-found" });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('h1','hatched',100,'crow',1,1,2)");
  assert.deepEqual(await incubateEgg(d, "h1", { now: T0 }), { ok: false, reason: "not-an-egg" });
});

test("incubateEgg hatches a swapped-in egg that is already past the threshold", async () => {
  const d = await freshDb();
  await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('hot','shelf','user',100,5)");
  const r = await incubateEgg(d, "hot", { now: T0 });
  assert.ok(r.hatched && r.hatched.egg_id === "hot" && typeof r.hatched.species === "string");
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1, "a successor egg was minted");
});

test("activateBird points the pet at a hatched egg and refuses anything else", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1','hatched',100,'raven',9,1,2)");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1','incubating',0,3)");
  const emitted = [];
  const r = await activateBird(d, "b1", { emit: async (t, op, row) => emitted.push([t, op, row.owner, row.active_egg_id]) });
  assert.deepEqual(r, { ok: true, bird: { egg_id: "b1", species: "raven", seed: 9 } });
  assert.deepEqual(emitted, [["ramble_pet", "update", "self", "b1"]]);
  assert.deepEqual(await activateBird(d, "e1"), { ok: false, reason: "not-a-bird" });
  assert.deepEqual(await activateBird(d, "zz"), { ok: false, reason: "not-found" });
});

test("flockState: birds with the active one marked, eggs incubating-first, species count, shelf cap", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1','hatched',100,'raven',9,1,20), ('b2','hatched',100,'crow',3,2,10), ('b3','hatched',100,'raven',4,3,30)");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at) VALUES ('s1','shelf','user',50,'9v6m21h','2026-W37',100), ('s0','shelf','sync',5,NULL,NULL,50)");
  await activateBird(d, "b2");
  const s = await flockState(d, { now: T0 });
  assert.deepEqual(s.birds.map((b) => [b.egg_id, b.species, b.active]), [["b2", "crow", true], ["b1", "raven", false], ["b3", "raven", false]]);
  assert.equal(s.eggs[0].status, "incubating", "the incubating egg is ensured and listed first");
  assert.deepEqual(s.eggs.slice(1).map((e) => [e.egg_id, e.status, e.percent, e.shelf_origin]), [["s0", "shelf", 5, "sync"], ["s1", "shelf", 50, "user"]]);
  // shelf_count is the user's own eggs (s1); the sync loser s0 is listed but does not use a spot.
  assert.deepEqual([s.shelf_count, s.shelf_cap, s.species_found, s.species_total, s.species.length], [1, SHELF_CAP_DEFAULT, 2, 8, 8]);
  for (const e of s.eggs) assert.ok(!("lamport_ts" in e) && !("species" in e), "eggs never expose seed/species or sync metadata");
});

test("incubateEgg is all-or-nothing under a concurrent swap of the same egg", async () => {
  const d = await freshDb();
  const first = await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('s2','shelf','user',10,5)");
  const results = await Promise.all([incubateEgg(d, "s2", { now: T0 }), incubateEgg(d, "s2", { now: T0 })]);
  assert.ok(results.every((r) => r.ok === true), JSON.stringify(results));
  assert.equal(results.filter((r) => r.already === false).length, 1, "exactly one call performed the swap");
  const rows = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.equal(rows.rows.filter((r) => r.status === "incubating").length, 1, "never zero or two incubating eggs");
  assert.deepEqual(rows.rows.find((r) => r.egg_id === "s2"), { egg_id: "s2", status: "incubating", shelf_origin: null });
  assert.deepEqual(rows.rows.find((r) => r.egg_id === first.egg_id), { egg_id: first.egg_id, status: "shelf", shelf_origin: "user" });
  // And a target that is no longer an egg at write time changes nothing.
  await d.execute({
    sql: "UPDATE ramble_eggs SET status='hatched', species='crow', seed=1, hatched_at=9 WHERE egg_id=?",
    args: [first.egg_id],
  });
  assert.deepEqual(await incubateEgg(d, first.egg_id, { now: T0 }), { ok: false, reason: "not-an-egg" });
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
});

test("phase 3: incubateEgg admits a received egg (origin cleared), refuses a locked one and a gifted one; flockState lists received + locked", async () => {
  const d = await freshDb();
  const first = await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, from_crow_id, created_at) VALUES ('rx','received','user',35,'crow:friend',7)");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('sw','shelf','user',5,8), ('gone','gifted','user',5,9)");
  const p = await proposeSwap(d, { eggId: "sw", toCrowId: "crow:friend", now: T0 });
  assert.equal(p.ok, true);
  assert.deepEqual(await incubateEgg(d, "sw", { now: T0 }), { ok: false, reason: "in-trade" });
  assert.deepEqual(await incubateEgg(d, "gone", { now: T0 }), { ok: false, reason: "not-an-egg" });

  const s = await flockState(d, { now: T0 });
  const rx = s.eggs.find((e) => e.egg_id === "rx");
  assert.deepEqual([rx.status, rx.from_crow_id, rx.locked, rx.percent], ["received", "crow:friend", false, 35]);
  assert.equal(s.eggs.find((e) => e.egg_id === "sw").locked, true);
  assert.ok(!s.eggs.find((e) => e.egg_id === "gone"), "gifted eggs are not on the shelf");
  assert.equal(s.eggs[0].status, "incubating");
  assert.equal(s.shelf_count, 1, "received eggs do not use a claim spot");

  const r = await incubateEgg(d, "rx", { now: T0 });
  assert.equal(r.ok, true); assert.equal(r.egg.status, "incubating"); assert.equal(r.egg.shelf_origin, null);
  assert.equal(r.egg.from_crow_id, "crow:friend", "provenance survives incubation");
  assert.deepEqual([r.shelved.egg_id, r.shelved.status, r.shelved.shelf_origin], [first.egg_id, "shelf", "user"]);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
  // giftEgg from flock.js's neighbour still sees the same lock.
  assert.deepEqual(await giftEgg(d, { eggId: "sw", toCrowId: "crow:x", now: T0 }), { ok: false, reason: "in-trade" });
});
