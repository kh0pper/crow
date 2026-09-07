import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";
import { isoWeek, ensureIncubatingEgg } from "../bundles/ramble/server/eggs.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";
import {
  readFlockSettings, listNests, claimNest,
  SHELF_CAP_DEFAULT, CLAIM_RANGE_M, CLAIMS_PER_DAY,
} from "../bundles/ramble/server/flock.js";

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
