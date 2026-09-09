/**
 * Spec 2026-09-08 §4.4 — one starter egg, once ever, as a narrative gift.
 *
 * ⚠ The grant condition is "has any egg EVER existed", read from ramble_eggs
 * itself, NOT a flag. Kevin intends to reset his game state to a new game once
 * phases 3 and 4 land, specifically to play the prologue as a new player; a
 * flag that outlived the wipe would silently make that reset useless.
 *
 * ⚠ The spec's own race protection ("derive the id from the Crow identity")
 * cannot work: loadOrCreateIdentity generates a random per-INSTANCE seed, so
 * crowId differs between a user's own Crows and deriving from it would grant
 * TWO eggs. A random uuid plus the existing applyRambleEgg convergence rule
 * (older survives incubating, younger is shelved with its warmth) is the
 * graceful answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  grantStarterEgg, readPrologue, setPrologueSeen, getIncubatingEgg, mintIncubatingEgg,
} from "../bundles/ramble/server/eggs.js";

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

test("a fresh player is granted exactly one starter egg, into the slot", async () => {
  const db = await freshDb();
  assert.deepEqual(await readPrologue(db), { intro_seen: false, hatch_seen: false, granted: false });

  const egg = await grantStarterEgg(db, { now: T0 });
  assert.ok(egg, "granted");
  assert.equal(await eggCount(db), 1);
  assert.equal((await getIncubatingEgg(db)).egg_id, egg.egg_id);
  assert.equal(egg.warmth, 0);
  assert.equal((await readPrologue(db)).granted, true);
});

test("the grant is once EVER — a hatched bird still counts as an egg having existed", async () => {
  const db = await freshDb();
  await grantStarterEgg(db, { now: T0 });
  assert.equal(await grantStarterEgg(db, { now: T0 + 1000 }), null, "twice is a no-op");
  assert.equal(await eggCount(db), 1);

  await db.execute({ sql: "UPDATE ramble_eggs SET status = 'hatched', species = 'wren', seed = 7, hatched_at = ?", args: [T0] });
  assert.equal(await grantStarterEgg(db, { now: T0 + 2000 }), null,
    "having hatched and become eggless must NOT re-grant — that would restore the free egg");
  assert.equal(await eggCount(db), 1);
});

test("an existing player who already has an egg is never granted one", async () => {
  const db = await freshDb();
  await mintIncubatingEgg(db, { now: T0 });
  assert.equal(await grantStarterEgg(db, { now: T0 + 1000 }), null);
  assert.equal(await eggCount(db), 1);
});

test("wiping the eggs makes the prologue replayable — K1's reset", async () => {
  const db = await freshDb();
  await grantStarterEgg(db, { now: T0 });
  await setPrologueSeen(db, "intro");
  await setPrologueSeen(db, "hatch");
  assert.deepEqual(await readPrologue(db), { intro_seen: true, hatch_seen: true, granted: true });

  // A game reset clears both the eggs and the two flags.
  await db.execute({ sql: "DELETE FROM ramble_eggs", args: [] });
  await db.execute({ sql: "DELETE FROM ramble_settings WHERE key LIKE 'prologue.%'", args: [] });

  assert.deepEqual(await readPrologue(db), { intro_seen: false, hatch_seen: false, granted: false });
  assert.ok(await grantStarterEgg(db, { now: T0 + 5000 }), "the prologue genuinely replays");
});

test("the two flags are independent and survive as replicated settings", async () => {
  const db = await freshDb();
  await setPrologueSeen(db, "intro");
  assert.deepEqual(await readPrologue(db), { intro_seen: true, hatch_seen: false, granted: false });
  await setPrologueSeen(db, "hatch");
  assert.equal((await readPrologue(db)).hatch_seen, true);

  const { rows } = await db.execute({ sql: "SELECT key FROM ramble_settings WHERE key LIKE 'prologue.%' ORDER BY key", args: [] });
  assert.deepEqual(rows.map((r) => r.key), ["prologue.hatch.seen", "prologue.intro.seen"]);
});

test("setPrologueSeen refuses an unknown beat rather than writing junk", async () => {
  const db = await freshDb();
  await assert.rejects(() => setPrologueSeen(db, "nonsense"));
});
