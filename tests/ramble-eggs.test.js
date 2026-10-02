import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { mintIncubatingEgg, creditWarmth, hatchIfReady, checkin, eggState, activeBird, isoWeek, localDay, WARMTH_DEFAULTS, MEET_CROW_DAILY_CAP } from "../bundles/ramble/server/eggs.js";

let db; const T0 = Date.UTC(2026, 8, 7, 12); // 2026-09-07 12:00Z
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

test("a fresh instance gets exactly one incubating egg", async () => {
  const a = await mintIncubatingEgg(db, { now: T0 });
  const b = await mintIncubatingEgg(db, { now: T0 });
  assert.equal(a.egg_id, b.egg_id);
  const { rows } = await db.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'");
  assert.equal(rows[0].n, 1);
});

test("credits are idempotent per key and use the weights", async () => {
  const first = await creditWarmth(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 });
  assert.equal(first.credited, true); assert.equal(first.warmth, WARMTH_DEFAULTS.visit_place);
  const again = await creditWarmth(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 3600e3 });
  assert.equal(again.credited, false); assert.equal(again.warmth, WARMTH_DEFAULTS.visit_place);
  const nextWeek = await creditWarmth(db, { type: "visit_place", cell: "9v6m21h" }, { now: T0 + 8 * 86400e3 });
  assert.equal(nextWeek.credited, true);
  const c1 = await checkin(db, { now: T0 }); const c2 = await checkin(db, { now: T0 + 60e3 });
  assert.equal(c1.credited, true); assert.equal(c2.credited, false);
  assert.equal((await creditWarmth(db, { type: "mark_left" }, { now: T0 })).credited, true);
  assert.equal((await creditWarmth(db, { type: "mark_left" }, { now: T0 })).credited, true); // never keyed
});

test("weights come from settings when set", async () => {
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('warmth.unlock_mark', '3')", args: [] });
  const r = await creditWarmth(db, { type: "unlock_mark" }, { now: T0 });
  assert.equal(r.credited, true);
  const { rows } = await db.execute("SELECT warmth FROM ramble_eggs WHERE status='incubating'");
  assert.ok(rows[0].warmth >= 3);
});

test("hatch at the threshold: rolls a roster species + uint32 seed, activates, and mints no successor", async () => {
  const emitted = [];
  const emit = async (t, op, row) => emitted.push([t, op, row.egg_id || row.owner]);
  let r;
  for (let i = 0; i < 10 && !(r && r.hatched); i++) r = await creditWarmth(db, { type: "meet_crow", persona: "p" + i }, { now: T0, emit });
  assert.ok(r.hatched, "should have hatched");
  assert.ok(["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"].includes(r.hatched.species));
  assert.ok(Number.isInteger(r.hatched.seed) && r.hatched.seed >= 0 && r.hatched.seed < 2 ** 32);
  const bird = await activeBird(db);
  assert.equal(bird.egg_id, r.hatched.egg_id);
  const { rows } = await db.execute("SELECT status, count(*) AS n FROM ramble_eggs GROUP BY status ORDER BY status");
  assert.deepEqual(rows.map((x) => [x.status, x.n]), [["hatched", 1]], "no successor was minted, and the shelf is empty");
  assert.ok(emitted.some(([t, op]) => t === "ramble_eggs" && op === "update"));
  assert.ok(emitted.some(([t]) => t === "ramble_pet"));
  assert.equal(await hatchIfReady(db, { now: T0 }), null); // nothing else ready
});

test("eggState reports egg: null right after a hatch, then percent + checklist once the shelf promotes", async () => {
  const empty = await eggState(db, { now: T0 });
  assert.equal(empty.egg, null, "no successor was minted");
  assert.equal(typeof empty.checklist.new_places_week, "number");
  assert.equal(empty.checklist.checked_in_today, true);

  // Nothing else exercises a non-zero percent any more, now that nothing
  // auto-mints: shelve an egg, mint+hatch a throwaway incubating egg so the
  // hatch's own promoteFromShelf draws the shelved one in, then credit it.
  await db.execute({
    sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES (?, 'shelf', 'user', 0, ?)",
    args: ["waiting-on-shelf", T0],
  });
  const throwaway = await mintIncubatingEgg(db, { now: T0 });
  await db.execute({ sql: "UPDATE ramble_eggs SET warmth = ? WHERE egg_id = ?", args: [WARMTH_DEFAULTS.hatch_at, throwaway.egg_id] });
  assert.ok(await hatchIfReady(db, { now: T0 }), "the throwaway egg hatched");

  await creditWarmth(db, { type: "mark_left" }, { now: T0 });
  const s = await eggState(db, { now: T0 });
  assert.equal(s.egg.egg_id, "waiting-on-shelf", "the shelf refilled the slot");
  assert.ok(s.egg.percent > 0, "the shelved egg now carries warmth");
});

test("week and day keys", () => {
  assert.match(isoWeek(T0), /^\d{4}-W\d{2}$/);
  assert.match(localDay(T0), /^\d{4}-\d{2}-\d{2}$/);
});

test("visit_place without cell never credits (not treated as always-credited)", async () => {
  const before = await eggState(db, { now: T0 });
  const beforeWarmth = before.egg ? before.egg.warmth : 0; // Phase 3: a hatch can leave egg: null
  for (let i = 0; i < 3; i++) {
    const r = await creditWarmth(db, { type: "visit_place" }, { now: T0 });
    assert.equal(r.credited, false);
    assert.equal(r.warmth, beforeWarmth);
  }
  const after = await eggState(db, { now: T0 });
  assert.equal(after.egg ? after.egg.warmth : 0, beforeWarmth);
});

test("meet_crow without persona never credits (not treated as always-credited)", async () => {
  const before = await eggState(db, { now: T0 });
  const beforeWarmth = before.egg ? before.egg.warmth : 0; // Phase 3: a hatch can leave egg: null
  for (let i = 0; i < 3; i++) {
    const r = await creditWarmth(db, { type: "meet_crow" }, { now: T0 });
    assert.equal(r.credited, false);
    assert.equal(r.warmth, beforeWarmth);
  }
  const after = await eggState(db, { now: T0 });
  assert.equal(after.egg ? after.egg.warmth : 0, beforeWarmth);
});

test("chore on a fresh db is a pure read: no egg created, nothing emitted", async () => {
  const freshDb = createClient({ url: "file::memory:" });
  await initRambleTables(freshDb);
  const emitted = [];
  const r = await creditWarmth(freshDb, { type: "chore" }, { now: T0, emit: async (...args) => emitted.push(args) });
  assert.equal(r.credited, false);
  assert.equal(r.warmth, 0);
  assert.equal(r.hatched, null);
  const { rows } = await freshDb.execute("SELECT count(*) AS n FROM ramble_eggs");
  assert.equal(rows[0].n, 0);
  assert.equal(emitted.length, 0);
});

test("meet_crow warmth is capped per local day (a spoofed-persona flood cannot force a hatch)", async () => {
  const fresh = createClient({ url: "file::memory:" });
  await initRambleTables(fresh);
  // A high hatch threshold keeps every credit on ONE egg, so "warmth unchanged"
  // is readable — a hatch would reset it to a fresh zero-warmth egg.
  await fresh.execute("INSERT INTO ramble_settings (key, value) VALUES ('warmth.hatch_at', '1000')");
  assert.equal(MEET_CROW_DAILY_CAP, 5);

  const results = [];
  for (let i = 0; i <= MEET_CROW_DAILY_CAP; i++) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await creditWarmth(fresh, { type: "meet_crow", persona: "spoof" + i }, { now: T0 }));
  }
  assert.deepEqual(results.map((r) => r.credited), [true, true, true, true, true, false]);

  const overCap = results[MEET_CROW_DAILY_CAP];
  assert.equal(overCap.warmth, results[MEET_CROW_DAILY_CAP - 1].warmth, "the 6th persona must not add warmth");
  assert.equal(overCap.hatched, null);
  const ledger = await fresh.execute("SELECT count(*) AS n FROM ramble_credits WHERE kind='meet_crow'");
  assert.equal(ledger.rows[0].n, MEET_CROW_DAILY_CAP, "an over-cap meeting must not leave a ledger row either");

  // The allowance is per LOCAL DAY, not per week: tomorrow credits again.
  const tomorrow = await creditWarmth(fresh, { type: "meet_crow", persona: "spoof-next" }, { now: T0 + 86400e3 });
  assert.equal(tomorrow.credited, true);
});

test("activeBird ignores a pet pointer at an egg that has not hatched", async () => {
  const fresh = createClient({ url: "file::memory:" });
  await initRambleTables(fresh);
  const egg = await mintIncubatingEgg(fresh, { now: T0 });
  await fresh.execute({ sql: "INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', ?)", args: [egg.egg_id] });
  assert.equal(await activeBird(fresh), null, "an incubating egg is not a bird");

  await fresh.execute({
    sql: "UPDATE ramble_eggs SET status='hatched', species='crow', seed=3, hatched_at=? WHERE egg_id=?",
    args: [T0, egg.egg_id],
  });
  const bird = await activeBird(fresh);
  assert.equal(bird.species, "crow");
  assert.equal(bird.seed, 3);
});
