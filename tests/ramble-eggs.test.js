import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { ensureIncubatingEgg, creditWarmth, hatchIfReady, checkin, eggState, activeBird, isoWeek, localDay, WARMTH_DEFAULTS } from "../bundles/ramble/server/eggs.js";

let db; const T0 = Date.UTC(2026, 8, 7, 12); // 2026-09-07 12:00Z
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

test("a fresh instance gets exactly one incubating egg", async () => {
  const a = await ensureIncubatingEgg(db, { now: T0 });
  const b = await ensureIncubatingEgg(db, { now: T0 });
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

test("hatch at the threshold: rolls a roster species + uint32 seed, activates, and starts the next egg", async () => {
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
  assert.deepEqual(rows.map((x) => [x.status, x.n]), [["hatched", 1], ["incubating", 1]]);
  assert.ok(emitted.some(([t, op]) => t === "ramble_eggs" && op === "update"));
  assert.ok(emitted.some(([t]) => t === "ramble_pet"));
  assert.equal(await hatchIfReady(db, { now: T0 }), null); // nothing else ready
});

test("eggState reports percent + checklist", async () => {
  const s = await eggState(db, { now: T0 });
  assert.ok(s.egg.egg_id); assert.equal(typeof s.egg.percent, "number");
  assert.equal(typeof s.checklist.new_places_week, "number");
  assert.equal(s.checklist.checked_in_today, true);
});

test("week and day keys", () => {
  assert.match(isoWeek(T0), /^\d{4}-W\d{2}$/);
  assert.match(localDay(T0), /^\d{4}-\d{2}-\d{2}$/);
});
