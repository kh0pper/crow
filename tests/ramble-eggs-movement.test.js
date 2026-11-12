/**
 * P3 Task 3.1 — the explicit egg rule: a happy day counts only when the day
 * also carries a real-movement fact.
 *
 * The three facts are defined in three places (steps.js `WALKED_KIND`,
 * moves/ledger.js `MOVE_OUTDOOR_KIND`, and the `visit_place` kind `creditKey`
 * writes in eggs.js), and eggs.js imports none of them: those modules reach
 * eggs.js through the pet module, and `settleHappyDay` is called BY them. The
 * first test pins eggs.js's literals to the constants their owners export, and
 * pins the absence of the import that would close the cycle.
 *
 * Harness (`freshDb`, the fixed local day and `AT`) copied from
 * tests/ramble-laying.test.js and tests/ramble-steps.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  MOVEMENT_KINDS, creditKey, creditWarmth, hasRealMovement, recordHappyDay,
  settleHappyDay, localDay, startOfLocalDay,
} from "../bundles/ramble/server/eggs.js";
import {
  WALKED_KIND, recordStepReading, recordWalkCheckin, settleDay,
} from "../bundles/ramble/server/steps.js";
import { MOVE_OUTDOOR_KIND, recordChallengeDone, recordLog } from "../bundles/ramble/server/moves/ledger.js";
import { feed } from "../bundles/ramble/server/pet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const H = 3_600_000;
// A fixed local day; AT(h, m) is that day at h:m local time (a negative hour
// reaches into the previous local day).
const DAY0 = startOfLocalDay(Date.UTC(2026, 9, 5, 18));
const AT = (h, m = 0) => DAY0 + h * H + m * 60_000;
const DEV = "11111111-2222-3333-4444-555555555555";

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  return db;
}

/** The local day the tests work in (noon of it). */
const day = () => localDay(AT(12));

/** Put the bird at a feed: energy 100, mood happy, and no movement fact. */
async function feedToHappy(db, now) {
  return feed(db, { type: "move", amount: 60 }, { now });
}

async function countOf(db, sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return Number(rows[0]?.n ?? 0);
}
const laydays = (db) => countOf(db, "SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'layday'");
const walletCount = (db) => countOf(db, "SELECT count(*) AS n FROM ramble_wallet");
const creditCount = (db) => countOf(db, "SELECT count(*) AS n FROM ramble_credits");

test("the movement kinds eggs.js uses are the constants their owners export", async () => {
  assert.equal(MOVEMENT_KINDS.walked, WALKED_KIND);
  assert.equal(MOVEMENT_KINDS.outdoor, MOVE_OUTDOOR_KIND);
  assert.equal(creditKey({ type: "visit_place", cell: "9vk79ed" }, { now: AT(9) }).kind,
    MOVEMENT_KINDS.visitPlace);

  const src = readFileSync(resolve(HERE, "../bundles/ramble/server/eggs.js"), "utf8");
  const specifiers = [...src.matchAll(/^\s*import\s[^;\n]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, "the import scan found eggs.js's imports");
  for (const bad of ["steps.js", "indoor-cap", "ledger", "pet.js"]) {
    assert.ok(!specifiers.some((s) => s.includes(bad)),
      `eggs.js must not import ${bad}: those modules reach it through pet.js, and settleHappyDay is called by them`);
  }
});

test("happy at a feed with no movement fact is not a lay day", async () => {
  const db = await freshDb();
  const pet = await feedToHappy(db, AT(9));
  assert.equal(pet.mood, "happy");

  const out = await recordHappyDay(db, { now: AT(9), mood: "happy" });
  assert.deepEqual(out, { recorded: false, laid: false, reason: "no_movement" });
  assert.equal(await laydays(db), 0);
});

test("a walked row from the \"I walked today\" tap is a movement fact", async () => {
  const db = await freshDb();
  await feedToHappy(db, AT(9));
  const out = await recordWalkCheckin(db, { now: AT(10) });

  assert.equal(out.walkedNew, true);
  assert.equal(await hasRealMovement(db, day()), true);
  assert.equal(await laydays(db), 1, "settleDay settled the day once the walked row landed");
});

test("a walked row from steps reaching the badge threshold is a movement fact", async () => {
  const db = await freshDb();
  await feedToHappy(db, AT(9));
  await recordStepReading(db, { device_id: DEV, counter: 2_000, elapsed_ms: 2 * H, boot_count: 1 }, { now: AT(10) });
  const settled = await settleDay(db, { now: AT(10) });

  assert.equal(settled.walked, true, "2,000 steps is the default badge line");
  assert.equal(await hasRealMovement(db, day()), true);
  assert.equal(await laydays(db), 1);
});

test("a positive outdoor move row is a movement fact; a row of 0 is not", async () => {
  const db = await freshDb();
  await feedToHappy(db, AT(9));
  const logged = await recordLog(db, { activity: "walk", minutes: 10, effort: "easy", now: AT(10) });
  assert.ok(logged.paid > 0);
  assert.equal(await hasRealMovement(db, day()), true);
  assert.equal(await laydays(db), 1);

  const zero = await freshDb();
  await feedToHappy(zero, AT(9));
  await zero.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 0, ?)",
    args: [MOVE_OUTDOOR_KIND, day(), AT(10)],
  });
  assert.equal(await hasRealMovement(zero, day()), false);
  assert.equal((await recordHappyDay(zero, { now: AT(10), mood: "happy" })).reason, "no_movement");
  assert.equal(await laydays(zero), 0);
});

test("a visit_place credit inside the local day is a movement fact", async () => {
  const db = await freshDb();
  await feedToHappy(db, AT(9));
  await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: AT(10) });

  assert.equal(await hasRealMovement(db, day()), true);
  const out = await recordHappyDay(db, { now: AT(10), mood: "happy" });
  assert.equal(out.recorded, true);
  assert.equal(await laydays(db), 1);
});

test("a visit_place credit from the previous local day only is not, and neither is a bare cell", async () => {
  const db = await freshDb();
  await feedToHappy(db, AT(9));
  await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: AT(-1) });   // yesterday, 23:00

  assert.equal(await hasRealMovement(db, localDay(AT(-1))), true);
  assert.equal(await hasRealMovement(db, day()), false);
  assert.equal((await recordHappyDay(db, { now: AT(12), mood: "happy" })).reason, "no_movement");

  const cells = await freshDb();
  await cells.execute({
    sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?)",
    args: ["9vk79ed", AT(9)],
  });
  assert.equal(await hasRealMovement(cells, day()), false,
    "first_unlocked_at is stamped by a backfill and moved by sync, so a cell row is not a movement fact");
});

test("indoor budget rows and a check-in credit alone are not movement", async () => {
  const db = await freshDb();
  const logged = await recordLog(db, { activity: "yoga", minutes: 10, effort: "moderate", now: AT(9) });
  const done = await recordChallengeDone(db, {
    day: day(),
    entry: { id: "egg-rule-1", activity: "yoga", minutes: 10, indoor: true },
    now: AT(10),
  });
  const checkin = await creditWarmth(db, { type: "checkin" }, { now: AT(11) });
  assert.ok(logged.paid > 0 && done.paid > 0 && checkin.credited, "the day really was played indoors");

  const { rows } = await db.execute({ sql: "SELECT DISTINCT kind FROM ramble_wallet ORDER BY kind", args: [] });
  assert.deepEqual(rows.map((r) => r.kind), ["movedone", "moveindoor", "movelog"]);

  assert.equal(await hasRealMovement(db, day()), false);
  assert.equal((await recordHappyDay(db, { now: AT(11), mood: "happy" })).reason, "no_movement");
  assert.equal(await laydays(db), 0);
});

test("fed first and walked later the same day: settleHappyDay records it, once", async () => {
  const db = await freshDb();
  const pet = await feedToHappy(db, AT(9));
  assert.equal(pet.mood, "happy");
  assert.equal(await laydays(db), 0, "no movement fact at the feed");

  const walked = await recordWalkCheckin(db, { now: AT(15) });
  assert.equal(walked.walkedNew, true);
  assert.equal(await laydays(db), 1, "the walked row let settleDay's settleHappyDay record the day");

  const again = await settleHappyDay(db, { now: AT(16) });
  assert.equal(again.recorded, false);
  assert.equal(await laydays(db), 1, "one layday row per local day");
});

test("hasRealMovement with a junk day string is false and writes nothing", async () => {
  const db = await freshDb();
  await feedToHappy(db, AT(9));
  await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: AT(10) });
  const before = [await walletCount(db), await creditCount(db)];

  for (const junk of ["", "today", "2026-13-01", "2026-02-30", "06/10/2026", null, undefined, 42, "2026-10-5"]) {
    assert.equal(await hasRealMovement(db, junk), false, `junk day: ${String(junk)}`);
  }
  assert.deepEqual([await walletCount(db), await creditCount(db)], before);
});