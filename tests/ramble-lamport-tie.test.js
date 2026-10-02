/**
 * Fix round 2, I-2: equal-Lamport writes of one Ramble row must converge.
 *
 * Before: every ramble apply handler skipped only a STRICTLY older op
 * (`lamportTs < localTs`), so on a tie each Crow took the OTHER's write and
 * the two swapped values for good. Shared-identity gifts made that routine
 * (one Crow writes the gift `incubating`, another `received`, at whatever
 * Lamport their counters happen to share).
 *
 * After: each LWW ramble row records the instance that wrote its current
 * Lamport (`lamport_origin`, stamped locally and taken from the sync entry's
 * `instance_id` on apply). On a tie the GREATER origin id wins; a NULL origin
 * (a row written before this column existed) loses to a non-null one; two
 * NULLs keep the old behaviour (the incoming op applies).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRemoteOp } from "../servers/sharing/instance-sync.js";
import { stampSql, ensureLamportOriginColumn } from "../servers/shared/sync-stamp.js";

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002"; // ID_B > ID_A

async function fresh() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }

const egg = (status, origin) => ({
  egg_id: "g", status, shelf_origin: origin, warmth: 5, from_crow_id: "crow:friend", created_at: 1000,
});
/** A local write as emitChange makes it: the row, then the production stamp with this Crow's id. */
async function localWrite(db, row, ts, instanceId) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, from_crow_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(egg_id) DO UPDATE SET status = excluded.status, shelf_origin = excluded.shelf_origin`,
    args: [row.egg_id, row.status, row.shelf_origin, row.warmth, row.from_crow_id, row.created_at],
  });
  await db.execute(stampSql("ramble_eggs", row, ts, instanceId));
}
async function read(db) {
  return (await db.execute("SELECT status, lamport_ts, lamport_origin FROM ramble_eggs WHERE egg_id = 'g'")).rows[0];
}

for (const deliverFirst of ["A", "B"]) {
  test(`MUTUAL tie (delivered ${deliverFirst} first): both Crows write one egg at the SAME Lamport and converge on the greater origin`, async () => {
    const a = await fresh();
    const b = await fresh();
    const rowA = egg("incubating", null);
    const rowB = egg("received", "user");
    await localWrite(a, rowA, 14, ID_A);
    await localWrite(b, rowB, 14, ID_B);
    const steps = [
      () => applyRemoteOp(b, "ramble_eggs", "update", rowA, 14, ID_A),
      () => applyRemoteOp(a, "ramble_eggs", "update", rowB, 14, ID_B),
    ];
    if (deliverFirst === "B") steps.reverse();
    for (const s of steps) await s(); // eslint-disable-line no-await-in-loop

    const ra = await read(a);
    const rb = await read(b);
    assert.equal(ra.status, rb.status, `diverged: A=${ra.status} B=${rb.status}`);
    assert.equal(ra.status, "received", "ID_B is the greater origin, so B's write wins on both");
    assert.equal(ra.lamport_origin, ID_B);
    assert.equal(rb.lamport_origin, ID_B);
  });
}

test("a NULL-origin legacy row loses a tie to a stamped write, on either side", async () => {
  // A row replicated before lamport_origin existed (crow holds grackle's 17
  // birds this way) has lamport_origin NULL. At an equal Lamport, a write
  // that carries an origin replaces it ...
  const legacy = await fresh();
  await legacy.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, from_crow_id, created_at, lamport_ts) VALUES ('g','received',5,'crow:friend',1000,14)");
  assert.equal((await read(legacy)).lamport_origin, null, "the ALTER leaves existing rows untouched");
  await applyRemoteOp(legacy, "ramble_eggs", "update", egg("incubating", null), 14, ID_A);
  assert.equal((await read(legacy)).status, "incubating");
  assert.equal((await read(legacy)).lamport_origin, ID_A);

  // ... and a stamped local row is NOT replaced by an origin-less op at a tie.
  const stamped = await fresh();
  await localWrite(stamped, egg("incubating", null), 14, ID_A);
  await applyRemoteOp(stamped, "ramble_eggs", "update", egg("received", "user"), 14, null);
  assert.equal((await read(stamped)).status, "incubating");
});

test("two NULL origins keep the old behaviour: on a tie the incoming op applies", async () => {
  const db = await fresh();
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, from_crow_id, created_at, lamport_ts) VALUES ('g','received',5,'crow:friend',1000,14)");
  await applyRemoteOp(db, "ramble_eggs", "update", egg("incubating", null), 14);
  assert.equal((await read(db)).status, "incubating");
  assert.equal((await read(db)).lamport_origin, null);
});

test("strictly newer and strictly older still decide by Lamport alone, whatever the origins", async () => {
  const db = await fresh();
  await localWrite(db, egg("received", "user"), 14, ID_B);
  await applyRemoteOp(db, "ramble_eggs", "update", egg("incubating", null), 13, ID_A > ID_B ? ID_A : "zzzz");
  assert.equal((await read(db)).status, "received", "an older op never wins, even from a greater origin");
  await applyRemoteOp(db, "ramble_eggs", "update", egg("incubating", null), 15, ID_A);
  assert.equal((await read(db)).status, "incubating", "a newer op always wins, even from a lesser origin");
  assert.equal((await read(db)).lamport_origin, ID_A);
});

test("legacy replicated state (NULL origins on both Crows) is untouched and converges on its next write", async () => {
  // The shape crow holds today: rows that arrived before this column, same
  // values and Lamports on both of the user's Crows, origin NULL on both.
  const a = await fresh();
  const b = await fresh();
  for (const db of [a, b]) {
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, lamport_ts) VALUES ('g','incubating',40,1000,30)");
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, species, seed, warmth, created_at, hatched_at, lamport_ts) VALUES ('bird','hatched','crow',7,100,500,600,20)");
  }
  // Re-running the guarded ALTER (every boot does) changes nothing.
  await initRambleTables(a);
  await ensureLamportOriginColumn(a, "ramble_eggs");
  const before = (await a.execute("SELECT egg_id, status, warmth, lamport_ts, lamport_origin FROM ramble_eggs ORDER BY egg_id")).rows;
  assert.deepEqual(before.map((r) => [r.egg_id, r.status, r.warmth, r.lamport_ts, r.lamport_origin]),
    [["bird", "hatched", 100, 20, null], ["g", "incubating", 40, 30, null]]);

  // The next write (warmth on A) is stamped with A's origin and lands on B.
  await a.execute("UPDATE ramble_eggs SET warmth = 60 WHERE egg_id = 'g'");
  await a.execute(stampSql("ramble_eggs", { egg_id: "g" }, 31, ID_A));
  await applyRemoteOp(b, "ramble_eggs", "update", { egg_id: "g", status: "incubating", warmth: 60, created_at: 1000 }, 31, ID_A);
  const snap = async (db) => (await db.execute("SELECT egg_id, status, warmth, lamport_ts, lamport_origin FROM ramble_eggs ORDER BY egg_id")).rows
    .map((r) => [r.egg_id, r.status, r.warmth, r.lamport_ts, r.lamport_origin]);
  assert.deepEqual(await snap(b), await snap(a));
  assert.deepEqual((await snap(a))[1], ["g", "incubating", 60, 31, ID_A]);
});

test("the tie rule covers every LWW ramble table, not just eggs", async () => {
  const cases = [
    ["ramble_settings", { key: "k", value: "from-A" }, { key: "k", value: "from-B" }, "SELECT value AS v FROM ramble_settings WHERE key='k'"],
    ["ramble_blocks", { persona: "p", reason: "from-A", created_at: 1 }, { persona: "p", reason: "from-B", created_at: 1 }, "SELECT reason AS v FROM ramble_blocks WHERE persona='p'"],
    ["ramble_pet", { owner: "self", mood: "from-A" }, { owner: "self", mood: "from-B" }, "SELECT mood AS v FROM ramble_pet WHERE owner='self'"],
    ["ramble_trades", { trade_id: "t", counterpart: "c", role: "proposer", state: "from-A", created_at: 1, updated_at: 1, expires_at: 9 },
      { trade_id: "t", counterpart: "c", role: "proposer", state: "from-B", created_at: 1, updated_at: 1, expires_at: 9 }, "SELECT state AS v FROM ramble_trades WHERE trade_id='t'"],
    ["ramble_marks", { mark_id: "m", author: "x", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "from-A", created_at: 1 },
      { mark_id: "m", author: "x", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "from-B", created_at: 1 }, "SELECT content_text AS v FROM ramble_marks WHERE mark_id='m'"],
  ];
  for (const [table, rowA, rowB, q] of cases) {
    const a = await fresh(); // eslint-disable-line no-await-in-loop
    const b = await fresh(); // eslint-disable-line no-await-in-loop
    // Each side holds its own write at Lamport 14 (applied as from itself), then they exchange.
    await applyRemoteOp(a, table, "insert", rowA, 14, ID_A); // eslint-disable-line no-await-in-loop
    await applyRemoteOp(b, table, "insert", rowB, 14, ID_B); // eslint-disable-line no-await-in-loop
    await applyRemoteOp(a, table, "update", rowB, 14, ID_B); // eslint-disable-line no-await-in-loop
    await applyRemoteOp(b, table, "update", rowA, 14, ID_A); // eslint-disable-line no-await-in-loop
    const va = (await a.execute(q)).rows[0].v; // eslint-disable-line no-await-in-loop
    const vb = (await b.execute(q)).rows[0].v; // eslint-disable-line no-await-in-loop
    assert.equal(va, vb, `${table} diverged`);
    assert.equal(va, "from-B", `${table}: the greater origin wins`);
  }
});

test("stampSql writes the origin only when given one (the cap-drop NULL stamp leaves it alone)", () => {
  const withOrigin = stampSql("ramble_eggs", { egg_id: "g" }, 5, ID_A);
  assert.match(withOrigin.sql, /lamport_origin = \?/);
  assert.deepEqual(withOrigin.args, [5, ID_A, "g"]);
  const without = stampSql("ramble_eggs", { egg_id: "g" }, null);
  assert.doesNotMatch(without.sql, /lamport_origin/);
  assert.equal(stampSql("ramble_cells", { cell: "x" }, 5, ID_A).sql.includes("lamport_origin"), false,
    "cells merge by MIN/MAX, not LWW — no origin needed");
});
