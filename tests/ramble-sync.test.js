/**
 * Ramble Task 8 — same-user sync: allowlist + exclusions, the outbox door
 * (emitOrQueue with no live manager), and the natural-key apply handlers.
 *
 * Two real doors, not allowlist membership:
 *   (a) outbox door — an MCP-process write (no InstanceSyncManager) must
 *       row-stamp + queue into sync_outbox in one atomic batch;
 *   (b) apply door — captured wire ops applied to a second db through
 *       applyRemoteOp assert insert / LWW / delete semantics and the
 *       origin='sync' stamp (C2: the peer's drain must never re-publish).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { SYNCED_TABLES, EXCLUDED_COLUMNS, applyRemoteOp, shouldSyncRow } from "../servers/sharing/instance-sync.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, blockPersona } from "../bundles/ramble/server/marks.js";
import { ensureIncubatingEgg, isoWeek } from "../bundles/ramble/server/eggs.js";
import { feed } from "../bundles/ramble/server/pet.js";
import { claimNest } from "../bundles/ramble/server/flock.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";

// getOrCreateLocalInstanceId() (called internally by emitOrQueue) reads
// process.env.CROW_DATA_DIR directly — point it at a scratch dir for the
// whole file so it never touches the real ~/.crow instance-id file.
const instanceIdDir = mkdtempSync(join(tmpdir(), "crow-ramble-sync-instanceid-"));
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = instanceIdDir;

let a, b; // instance A (author) and B (peer)
before(async () => {
  a = createClient({ url: "file::memory:" }); await initRambleTables(a);
  b = createClient({ url: "file::memory:" }); await initRambleTables(b);
  // The suite env sets CROW_DISABLE_INSTANCE_SYNC=1 — without this override the
  // queue path silently drops and the outbox assertion below goes vacuous.
  _setEligibilityForTest(() => true);
});

after(() => {
  _setEligibilityForTest(null);
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(instanceIdDir, { recursive: true, force: true });
});

test("allowlist + exclusions", () => {
  for (const t of ["ramble_marks", "ramble_settings", "ramble_blocks"]) assert.ok(SYNCED_TABLES.includes(t), t);
  assert.ok(!SYNCED_TABLES.includes("ramble_groups"));
  for (const c of ["id", "publish_state", "origin", "lamport_ts"]) assert.ok(EXCLUDED_COLUMNS.ramble_marks.includes(c), c);
});

test("outbox door: an MCP-process write (no manager) lands in sync_outbox", async () => {
  const row = await createMark(a, {
    author: "a".repeat(64), author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 }, content: { content_text: "queued" },
  });
  const res = await emitOrQueue(null, a, "ramble_marks", "insert", row);
  assert.ok(res && res.queued, "emitOrQueue returned null — the stamp batch failed (missing lamport_ts?)");
  // Scoped to this table so the count can't be coupled to what later tests queue.
  const { rows } = await a.execute("SELECT table_name, op FROM sync_outbox WHERE table_name = 'ramble_marks'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table_name, "ramble_marks");
});

test("apply door: insert lands on B as origin=sync, LWW by lamport, delete by mark_id", async () => {
  const row = { mark_id: "m9", author: "pk1", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "hi", created_at: 1000 };
  await applyRemoteOp(b, "ramble_marks", "insert", row, 5);
  let got = await b.execute({ sql: "SELECT content_text, origin, publish_state, lamport_ts FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "hi");
  assert.equal(got.rows[0].origin, "sync");       // C2: the peer's drain must never publish this
  assert.equal(got.rows[0].publish_state, "synced");
  assert.equal(got.rows[0].lamport_ts, 5);
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, content_text: "stale" }, 3); // older → ignored
  // Assert the skip HERE: without it, "stale" would land and then be masked by
  // the "newer" write below, leaving the final assertion green either way.
  got = await b.execute({ sql: "SELECT content_text FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "hi", "an older mark op overwrote a newer local row");
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, content_text: "newer" }, 7);
  got = await b.execute({ sql: "SELECT content_text FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "newer");
  await applyRemoteOp(b, "ramble_marks", "delete", { mark_id: "m9" }, 8);
  got = await b.execute({ sql: "SELECT 1 FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows.length, 0);
});

test("settings + blocks apply by natural key (idempotent, no UNIQUE throw)", async () => {
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "pseudonym" }, 1);
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "real" }, 2);
  const got = await b.execute({ sql: "SELECT value FROM ramble_settings WHERE key=?", args: ["public_identity_level"] });
  assert.equal(got.rows[0].value, "real");
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: "b".repeat(64), reason: "x", created_at: 1 }, 1);
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: "b".repeat(64), reason: "x", created_at: 1 }, 1);
  await applyRemoteOp(b, "ramble_blocks", "delete", { persona: "b".repeat(64) }, 2);
  assert.equal((await b.execute("SELECT 1 FROM ramble_blocks")).rows.length, 0);

  // LWW skip must hold for these two tables too, not just for marks: an op
  // older than the local row's lamport is dropped, it does not overwrite.
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "pseudonym" }, 1);
  const afterStale = await b.execute({ sql: "SELECT value FROM ramble_settings WHERE key=?", args: ["public_identity_level"] });
  assert.equal(afterStale.rows[0].value, "real", "an older settings op overwrote a newer local value");

  const p = "d".repeat(64);
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: p, reason: "a", created_at: 1 }, 5);
  await applyRemoteOp(b, "ramble_blocks", "update", { persona: p, reason: "b", created_at: 1 }, 3); // older → ignored
  const block = await b.execute({ sql: "SELECT reason, lamport_ts FROM ramble_blocks WHERE persona=?", args: [p] });
  assert.equal(block.rows[0].reason, "a", "an older block op overwrote a newer local row");
  assert.equal(Number(block.rows[0].lamport_ts), 5);
});

test("R9: an id-less natural-key table is lamport-stamped locally on emit", async () => {
  // ramble_blocks has no `id` column — without stampSql's by-persona branch the
  // outbox row would carry the lamport while the source row kept 0, making the
  // apply side's LWW one-sided (a remote op would always beat a newer local edit).
  const persona = "c".repeat(64);
  await blockPersona(a, persona, "x", { emit: (t, op, r) => emitOrQueue(null, a, t, op, r) });

  const local = await a.execute({
    sql: "SELECT lamport_ts FROM ramble_blocks WHERE persona = ?", args: [persona],
  });
  assert.ok(Number(local.rows[0].lamport_ts) > 0, "local ramble_blocks row was never stamped");

  const queued = await a.execute({
    sql: "SELECT lamport_ts FROM sync_outbox WHERE table_name = ?", args: ["ramble_blocks"],
  });
  assert.equal(queued.rows.length, 1);
  // Same atomic batch → the row and its outbox entry must agree.
  assert.equal(Number(queued.rows[0].lamport_ts), Number(local.rows[0].lamport_ts));
});

test("shouldSyncRow gates: local.* settings and keyless rows never sync", async () => {
  // Ruling R3 — per-instance settings stay on the device that wrote them.
  assert.equal(shouldSyncRow("ramble_settings", { key: "local.active_area", value: "[]" }), false);
  assert.equal(shouldSyncRow("ramble_settings", { key: "local.session_id" }), false);
  assert.equal(shouldSyncRow("ramble_settings", { key: "public_identity_level", value: "real" }), true);

  // A row without its natural key can be neither stamped, applied nor deleted
  // on a peer — rejected for all three tables, on emit AND on apply (this
  // function is the shared choke point for both).
  assert.equal(shouldSyncRow("ramble_marks", { author: "x" }), false);
  assert.equal(shouldSyncRow("ramble_blocks", { reason: "x" }), false);
  assert.equal(shouldSyncRow("ramble_settings", { value: "x" }), false);

  // The emit side actually honours it: emitOrQueue's syncability-parity check
  // must drop a local.* setting rather than queue it for the drain.
  // (Runs after the outbox-door test, which is what creates sync_outbox on `a`.)
  const res = await emitOrQueue(null, a, "ramble_settings", "update", { key: "local.active_area", value: "[]" });
  assert.equal(res, null, "a local.* setting was queued instead of being dropped");
  const { rows } = await a.execute("SELECT 1 FROM sync_outbox WHERE table_name = 'ramble_settings'");
  assert.equal(rows.length, 0);
});

/* ------------------------------------------------ Task 6: eggs + pet replicate */

test("allowlist + exclusions for eggs/pet", () => {
  for (const t of ["ramble_eggs", "ramble_pet"]) assert.ok(SYNCED_TABLES.includes(t), t);
  assert.ok(EXCLUDED_COLUMNS.ramble_eggs.includes("lamport_ts"));
  assert.ok(EXCLUDED_COLUMNS.ramble_pet.includes("lamport_ts"));
  assert.equal(shouldSyncRow("ramble_eggs", { warmth: 1 }), false);
  assert.equal(shouldSyncRow("ramble_eggs", { egg_id: "x" }), true);
  assert.equal(shouldSyncRow("ramble_pet", { owner: "other" }), false);
  assert.equal(shouldSyncRow("ramble_pet", { owner: "self" }), true);
});

test("outbox door: an egg write with no manager queues and is stamped", async () => {
  const egg = await ensureIncubatingEgg(a, { now: 1000 });
  const res = await emitOrQueue(null, a, "ramble_eggs", "insert", egg);
  assert.ok(res && res.queued, "emitOrQueue returned null — missing stampSql branch or lamport_ts?");
  const { rows } = await a.execute({ sql: "SELECT lamport_ts FROM ramble_eggs WHERE egg_id=?", args: [egg.egg_id] });
  assert.ok(rows[0].lamport_ts > 0);
  await feed(a, { type: "unlock_mark" }, { now: 1000 }); // creates the pet row
  const pet = await a.execute("SELECT * FROM ramble_pet WHERE owner='self'");
  const res2 = await emitOrQueue(null, a, "ramble_pet", "update", pet.rows[0]);
  assert.ok(res2 && res2.queued);
  const stamped = await a.execute("SELECT lamport_ts FROM ramble_pet WHERE owner='self'");
  assert.ok(stamped.rows[0].lamport_ts > 0, "ramble_pet row was never stamped — missing stampSql branch?");
});

test("apply door: egg insert, LWW, hatch survives a stale update, delete", async () => {
  const row = { egg_id: "e1", status: "incubating", warmth: 40, created_at: 1 };
  await applyRemoteOp(b, "ramble_eggs", "insert", row, 5);
  await applyRemoteOp(b, "ramble_eggs", "update", { ...row, warmth: 10 }, 3); // stale
  let got = await b.execute({ sql: "SELECT warmth FROM ramble_eggs WHERE egg_id='e1'", args: [] });
  assert.equal(got.rows[0].warmth, 40);
  await applyRemoteOp(b, "ramble_eggs", "update", { ...row, status: "hatched", species: "crow", seed: 77, hatched_at: 9 }, 7);
  await applyRemoteOp(b, "ramble_eggs", "update", { ...row, species: null, seed: null }, 8); // never un-hatch
  got = await b.execute({ sql: "SELECT status, species, seed, hatched_at FROM ramble_eggs WHERE egg_id='e1'", args: [] });
  assert.equal(got.rows[0].status, "hatched"); // the stale row said 'incubating' — hatch is one-way
  assert.equal(got.rows[0].species, "crow"); assert.equal(got.rows[0].seed, 77); assert.equal(got.rows[0].hatched_at, 9);
  await applyRemoteOp(b, "ramble_eggs", "delete", { egg_id: "e1" }, 9);
  assert.equal((await b.execute("SELECT 1 FROM ramble_eggs WHERE egg_id='e1'")).rows.length, 0);
});

test("two instances' incubating eggs converge deterministically (older wins, loser shelved)", async () => {
  await b.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('local-z','incubating',30,2000)", args: [] });
  await applyRemoteOp(b, "ramble_eggs", "insert", { egg_id: "peer-a", status: "incubating", warmth: 10, created_at: 1000 }, 4); // older peer egg wins
  let got = await b.execute("SELECT egg_id, status, warmth FROM ramble_eggs WHERE egg_id IN ('local-z','peer-a') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.warmth]), [["local-z", "shelf", 30], ["peer-a", "incubating", 10]]);
  await applyRemoteOp(b, "ramble_eggs", "insert", { egg_id: "peer-b", status: "incubating", warmth: 5, created_at: 5000 }, 5); // newer peer egg loses
  got = await b.execute("SELECT egg_id, status FROM ramble_eggs WHERE egg_id IN ('peer-a','peer-b') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["peer-a", "incubating"], ["peer-b", "shelf"]]);
  assert.equal((await b.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
  // Tie on created_at → the lexically lower egg_id wins ("aaa-tie" < "peer-a"),
  // so the tiebreak is a total order and both sides reach the same answer.
  await applyRemoteOp(b, "ramble_eggs", "insert", { egg_id: "aaa-tie", status: "incubating", warmth: 1, created_at: 1000 }, 6);
  got = await b.execute("SELECT egg_id, status FROM ramble_eggs WHERE egg_id IN ('aaa-tie','peer-a') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["aaa-tie", "incubating"], ["peer-a", "shelf"]]);
  assert.equal((await b.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
});

test("a synced mark keeps its bird", async () => {
  await applyRemoteOp(b, "ramble_marks", "insert", { mark_id: "mb", author: "pk", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "x", created_at: 1, bird_species: "raven", bird_seed: 9 }, 1);
  const got = await b.execute({ sql: "SELECT bird_species, bird_seed FROM ramble_marks WHERE mark_id='mb'", args: [] });
  assert.equal(got.rows[0].bird_species, "raven"); assert.equal(got.rows[0].bird_seed, 9);
});

test("apply door: pet upserts by owner and ignores deletes", async () => {
  await applyRemoteOp(b, "ramble_pet", "update", { owner: "self", mood: "tired", energy: 31, active_egg_id: "e1", chores_json: "{}" }, 2);
  let got = await b.execute("SELECT energy, active_egg_id FROM ramble_pet WHERE owner='self'");
  assert.equal(got.rows[0].energy, 31); assert.equal(got.rows[0].active_egg_id, "e1");
  await applyRemoteOp(b, "ramble_pet", "delete", { owner: "self" }, 3);
  assert.equal((await b.execute("SELECT 1 FROM ramble_pet WHERE owner='self'")).rows.length, 1);
});

test("a locally hatched egg never competes for the incubating slot", async () => {
  // A hatches e1 and mints successor e2. Offline B credits warmth to the egg it
  // still believes is incubating (e1) and emits it at a higher lamport. Gating
  // convergence on the INCOMING status alone would shelve e2 (e1's created_at is
  // older) while the hatch-one-way CASE keeps e1 hatched — leaving A with ZERO
  // incubating eggs, every cycle, silently discarding the warmth.
  const c = createClient({ url: "file::memory:" }); await initRambleTables(c);
  await c.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at, lamport_ts) VALUES ('e1','hatched',100,'crow',7,1000,1500,4)", args: [] });
  await c.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e2','incubating',20,2000)", args: [] });

  await applyRemoteOp(c, "ramble_eggs", "update", { egg_id: "e1", status: "incubating", warmth: 50, created_at: 1000 }, 9);

  const got = await c.execute("SELECT egg_id, status FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["e1", "hatched"], ["e2", "incubating"]]);
  assert.equal((await c.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
});

// -------------------------------------------- C1: deterministic hatch tiebreak

/** A fresh, isolated ramble db (each convergence case needs its own instance). */
async function freshDb() {
  const c = createClient({ url: "file::memory:" });
  await initRambleTables(c);
  return c;
}

/** The (species, seed, hatched_at) triple this instance ended up with. */
async function birdTriple(db, eggId) {
  const { rows } = await db.execute({
    sql: "SELECT species, seed, hatched_at FROM ramble_eggs WHERE egg_id = ?", args: [eggId],
  });
  return [rows[0].species, Number(rows[0].seed), Number(rows[0].hatched_at)];
}

test("a hatch race on one egg converges to ONE bird on every instance, in any order", async () => {
  // Two partitioned instances each hatch the same egg_id and roll a different
  // bird. First-writer-wins-per-instance (COALESCE(local, excluded)) would let
  // each keep its own roll forever; the joint tiebreak must pick the same
  // triple as a unit no matter which row an instance saw first.
  const A = { egg_id: "race-1", status: "hatched", warmth: 100, species: "raven", seed: 11, created_at: 1000, hatched_at: 1500 };
  const B = { egg_id: "race-1", status: "hatched", warmth: 100, species: "magpie", seed: 22, created_at: 1000, hatched_at: 1600 };
  const EARLIER = ["raven", 11, 1500];

  // Each side hatched locally, then receives the other's row.
  const da = await freshDb(); const dbb = await freshDb();
  for (const [d, own] of [[da, A], [dbb, B]]) {
    await d.execute({
      sql: `INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at, lamport_ts)
            VALUES (?, 'hatched', 100, ?, ?, ?, ?, 3)`,
      args: [own.egg_id, own.species, own.seed, own.created_at, own.hatched_at],
    });
  }
  await applyRemoteOp(da, "ramble_eggs", "update", B, 9);
  await applyRemoteOp(dbb, "ramble_eggs", "update", A, 9);
  assert.deepEqual(await birdTriple(da, "race-1"), EARLIER, "instance A drifted off the joint winner");
  assert.deepEqual(await birdTriple(dbb, "race-1"), EARLIER, "instance B drifted off the joint winner");

  // A third instance receiving both rows, in either arrival order.
  const c1 = await freshDb();
  await applyRemoteOp(c1, "ramble_eggs", "update", B, 9);
  await applyRemoteOp(c1, "ramble_eggs", "update", A, 10);
  const c2 = await freshDb();
  await applyRemoteOp(c2, "ramble_eggs", "update", A, 9);
  await applyRemoteOp(c2, "ramble_eggs", "update", B, 10);
  assert.deepEqual(await birdTriple(c1, "race-1"), EARLIER, "B-then-A arrival order diverged");
  assert.deepEqual(await birdTriple(c2, "race-1"), EARLIER, "A-then-B arrival order diverged");
});

test("equal hatched_at breaks to the lower seed, and a hatched side always beats an unhatched one", async () => {
  const E1 = { egg_id: "race-2", status: "hatched", warmth: 100, species: "grackle", seed: 5, created_at: 1000, hatched_at: 2000 };
  const E2 = { egg_id: "race-2", status: "hatched", warmth: 100, species: "penguin", seed: 6, created_at: 1000, hatched_at: 2000 };
  const LOWER_SEED = ["grackle", 5, 2000];

  const d1 = await freshDb();
  await applyRemoteOp(d1, "ramble_eggs", "update", E1, 9);
  await applyRemoteOp(d1, "ramble_eggs", "update", E2, 10);
  const d2 = await freshDb();
  await applyRemoteOp(d2, "ramble_eggs", "update", E2, 9);
  await applyRemoteOp(d2, "ramble_eggs", "update", E1, 10);
  assert.deepEqual(await birdTriple(d1, "race-2"), LOWER_SEED);
  assert.deepEqual(await birdTriple(d2, "race-2"), LOWER_SEED);

  // An explicitly-unhatched row (all three fields null on the wire) at a HIGHER
  // lamport must not un-roll the bird: hatch stays one-way.
  await applyRemoteOp(d1, "ramble_eggs", "update",
    { egg_id: "race-2", status: "incubating", warmth: 40, created_at: 1000, species: null, seed: null, hatched_at: null }, 11);
  assert.deepEqual(await birdTriple(d1, "race-2"), LOWER_SEED);
  const st = await d1.execute("SELECT status FROM ramble_eggs WHERE egg_id='race-2'");
  assert.equal(st.rows[0].status, "hatched");
});

// ------------------------- I3: the incubating slot never stays empty after a batch

test("a shelved convergence loser is re-promoted when the incubating slot empties", async () => {
  const d = await freshDb();
  // Local EA is incubating and older; the peer's successor EC arrives and loses.
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('ea','incubating',60,1000)");
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "ec", status: "incubating", warmth: 5, created_at: 3000 }, 4);
  assert.equal((await d.execute("SELECT status FROM ramble_eggs WHERE egg_id='ec'")).rows[0].status, "shelf");
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);

  // Now EA's own hatched row arrives. Without re-promotion this instance is
  // left with ZERO incubating eggs and nothing that would ever refill the slot.
  await applyRemoteOp(d, "ramble_eggs", "update",
    { egg_id: "ea", status: "hatched", warmth: 100, species: "crow", seed: 7, created_at: 1000, hatched_at: 1500 }, 6);

  const got = await d.execute("SELECT egg_id, status FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["ea", "hatched"], ["ec", "incubating"]]);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
});

// ------------------------------------------ Phase 2 Task 1: shelf origin marker

test("shelf_origin rides the wire and a convergence loser is marked 'sync' on both sides", async () => {
  const d = await freshDb();
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "u1", status: "shelf", shelf_origin: "user", warmth: 0, created_at: 100 }, 1);
  assert.equal((await d.execute("SELECT shelf_origin FROM ramble_eggs WHERE egg_id='u1'")).rows[0].shelf_origin, "user");

  // Local incubating egg loses to an older peer egg -> it is shelved AND marked 'sync'.
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('local-z','incubating',30,2000)");
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "peer-a", status: "incubating", warmth: 10, created_at: 1000 }, 4);
  let got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs WHERE egg_id IN ('local-z','peer-a') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["local-z", "shelf", "sync"], ["peer-a", "incubating", null]]);

  // An incoming newer egg loses -> stored as shelf + 'sync' even though the wire row said incubating.
  await applyRemoteOp(d, "ramble_eggs", "insert", { egg_id: "peer-b", status: "incubating", warmth: 5, created_at: 5000 }, 5);
  got = await d.execute("SELECT status, shelf_origin FROM ramble_eggs WHERE egg_id='peer-b'");
  assert.deepEqual([got.rows[0].status, got.rows[0].shelf_origin], ["shelf", "sync"]);
});

test("re-promotion picks only a 'sync' egg and KEEPS its mark; a user-shelved egg never moves", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('user-old','shelf',9,500,'user')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('loser','shelf',3,700,'sync')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('x','incubating',60,1000)");
  // x hatches on a peer: the slot empties. The OLDEST shelf egg is the user's
  // (500) — it must be skipped; the convergence loser (700) is promoted.
  await applyRemoteOp(d, "ramble_eggs", "update",
    { egg_id: "x", status: "hatched", warmth: 100, species: "crow", seed: 7, created_at: 1000, hatched_at: 1500 }, 6);
  const got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  // The promoted egg KEEPS its 'sync' mark: the sync layer put it in the slot,
  // and that class ranks below any NULL-origin egg in the convergence rule.
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]),
    [["loser", "incubating", "sync"], ["user-old", "shelf", "user"], ["x", "hatched", null]]);
});

test("class rule: a NULL-origin incubating egg beats a sync-promoted one regardless of age, on both sides", async () => {
  // Round-1 C1 scenario. A and B share X (incubating) and an ancient loser L.
  // X hatches on A; A mints successor N. B applies X-hatched -> promotes L.
  // N then arrives at B: without the class rule L (older) would win and the
  // fleet would diverge; with it N wins on B. Symmetrically, when B's
  // promoted L reaches A, A keeps N. Same for a user's later incubate choice Y.
  const A = await freshDb(); const B = await freshDb();
  for (const d of [A, B]) {
    await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('L','shelf',3,100,'sync')");
    await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('X','incubating',90,1000)");
  }
  const xHatched = { egg_id: "X", status: "hatched", warmth: 100, species: "crow", seed: 7, created_at: 1000, hatched_at: 1500 };
  const nRow = { egg_id: "N", status: "incubating", warmth: 0, created_at: 1500, shelf_origin: null };
  // A hatched locally (stand-in) and minted N.
  await A.execute("UPDATE ramble_eggs SET status='hatched', species='crow', seed=7, hatched_at=1500 WHERE egg_id='X'");
  await A.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('N','incubating',0,1500)");
  // B applies the hatch: L is promoted and marked 'sync'.
  await applyRemoteOp(B, "ramble_eggs", "update", xHatched, 5);
  let b = await B.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs WHERE status='incubating'");
  assert.deepEqual(b.rows.map((r) => [r.egg_id, r.shelf_origin]), [["L", "sync"]]);
  // N arrives at B: NULL beats 'sync' even though L is older.
  await applyRemoteOp(B, "ramble_eggs", "insert", nRow, 6);
  b = await B.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(b.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["L", "shelf", "sync"], ["N", "incubating", null], ["X", "hatched", null]]);
  // B's promoted L (from before N arrived) reaches A: A keeps N.
  await applyRemoteOp(A, "ramble_eggs", "update", { egg_id: "L", status: "incubating", warmth: 3, created_at: 100, shelf_origin: "sync" }, 6);
  const a = await A.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(a.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["L", "shelf", "sync"], ["N", "incubating", null], ["X", "hatched", null]]);
  // A PHASE-1 peer (rolling restart) emits L incubating with NO shelf_origin
  // key at all: the class rule must fall back to the 'sync' this instance
  // already holds for L, so N still wins (round 2, N1).
  await applyRemoteOp(A, "ramble_eggs", "update", { egg_id: "L", status: "incubating", warmth: 4, created_at: 100 }, 7);
  assert.deepEqual((await A.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows.map((r) => r.egg_id), ["N"]);
  // ...and a phase-1 peer's shelf row with no key lands as 'sync' (re-promotable), never NULL.
  await applyRemoteOp(A, "ramble_eggs", "insert", { egg_id: "P1", status: "shelf", warmth: 1, created_at: 50 }, 8);
  assert.equal((await A.execute("SELECT shelf_origin FROM ramble_eggs WHERE egg_id='P1'")).rows[0].shelf_origin, "sync");
  // Two NULL-origin eggs still settle by the phase-1 order (older wins).
  await applyRemoteOp(A, "ramble_eggs", "insert", { egg_id: "Z", status: "incubating", warmth: 0, created_at: 3000, shelf_origin: null }, 7);
  assert.deepEqual((await A.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows.map((r) => r.egg_id), ["N"]);
  // ...and two 'sync' eggs too.
  const C = await freshDb();
  await C.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('s-new','incubating',0,2000,'sync')");
  await applyRemoteOp(C, "ramble_eggs", "insert", { egg_id: "s-old", status: "incubating", warmth: 0, created_at: 1000, shelf_origin: "sync" }, 1);
  assert.deepEqual((await C.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows.map((r) => r.egg_id), ["s-old"]);
});

test("with no 'sync' egg on the shelf the slot simply stays empty (a user egg is not drafted)", async () => {
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('mine','shelf',9,500,'user')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('x','incubating',60,1000)");
  await applyRemoteOp(d, "ramble_eggs", "delete", { egg_id: "x" }, 6);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 0);
  assert.equal((await d.execute("SELECT status FROM ramble_eggs WHERE egg_id='mine'")).rows[0].status, "shelf");
});

test("a peer's user-shelve does not trigger re-promotion (the user's replacement egg is on its way)", async () => {
  // A's user incubates X and thereby shelves Y ('user'). B still has Y
  // incubating and an ancient convergence loser L on its shelf. If Y's shelve
  // re-promoted L, L (older than X) would then beat X on B AND, once L's next
  // warmth emit reached A, on A too — overriding the user's explicit choice.
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('L','shelf',3,100,'sync')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('Y','incubating',40,1000)");
  await applyRemoteOp(d, "ramble_eggs", "update", { egg_id: "Y", status: "shelf", shelf_origin: "user", warmth: 40, created_at: 1000 }, 7);
  let got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["L", "shelf", "sync"], ["Y", "shelf", "user"]]);
  // Then X arrives with no rival and takes the slot.
  await applyRemoteOp(d, "ramble_eggs", "update", { egg_id: "X", status: "incubating", shelf_origin: null, warmth: 0, created_at: 3000, found_cell: "9v6m21h" }, 8);
  got = await d.execute("SELECT egg_id, status FROM ramble_eggs WHERE status='incubating'");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status]), [["X", "incubating"]]);
});

test("an explicit null origin on the wire means plain, even if this instance once marked the egg 'sync'", async () => {
  // B demoted Y earlier (shelf/'sync'); B then minted Z (NULL). The user on A
  // now incubates Y and A emits it with shelf_origin: null explicitly. On B,
  // Y must rank as a plain egg: NULL vs NULL, older wins -> Y incubates.
  const d = await freshDb();
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('Y','shelf',20,1000,'sync')");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('Z','incubating',0,3000)");
  await applyRemoteOp(d, "ramble_eggs", "update", { egg_id: "Y", status: "incubating", warmth: 20, created_at: 1000, shelf_origin: null }, 9);
  let got = await d.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["Y", "incubating", null], ["Z", "shelf", "sync"]]);
  // Whereas a MISSING key (phase-1 peer) still falls back to the local mark:
  // reset and replay without the key -> Y reads as 'sync' and loses to Z.
  const e = await freshDb();
  await e.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('Y','shelf',20,1000,'sync')");
  await e.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('Z','incubating',0,3000)");
  await applyRemoteOp(e, "ramble_eggs", "update", { egg_id: "Y", status: "incubating", warmth: 20, created_at: 1000 }, 9);
  got = await e.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.status, r.shelf_origin]), [["Y", "shelf", "sync"], ["Z", "incubating", null]]);
});

test("outbox door: a claimed egg (no manager) is queued and stamped with its 'user' origin on the wire", async () => {
  const week = isoWeek(1_800_000_000_000);
  let cell = null;
  for (let i = 0; i < 5000 && !cell; i++) {
    const c = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(c, week)) cell = c;
  }
  const nest = nestFor(cell, week);
  const r = await claimNest(a, { cell, week, here: { lat: nest.lat, lon: nest.lon }, now: 1_800_000_000_000,
    emit: (t, op, row) => emitOrQueue(null, a, t, op, row) });
  assert.equal(r.claimed, true);
  const local = await a.execute({ sql: "SELECT lamport_ts FROM ramble_eggs WHERE egg_id=?", args: [r.egg.egg_id] });
  assert.ok(Number(local.rows[0].lamport_ts) > 0, "claimed egg row was never stamped");
  const queued = await a.execute({ sql: "SELECT row_json, lamport_ts FROM sync_outbox WHERE table_name='ramble_eggs' ORDER BY id DESC LIMIT 1", args: [] });
  const wire = JSON.parse(queued.rows[0].row_json);
  assert.equal(wire.egg_id, r.egg.egg_id);
  assert.equal(wire.shelf_origin, "user", "the origin must travel so a peer never auto-promotes it");
  assert.equal(Number(queued.rows[0].lamport_ts), Number(local.rows[0].lamport_ts));
});

test("phase 3: allowlist + exclusions + gate for ramble_trades", () => {
  assert.ok(SYNCED_TABLES.includes("ramble_trades"));
  assert.deepEqual(EXCLUDED_COLUMNS.ramble_trades, ["lamport_ts"]);
  assert.equal(shouldSyncRow("ramble_trades", null), false);
  assert.equal(shouldSyncRow("ramble_trades", { counterpart: "crow:x" }), false, "keyless rows never sync");
  assert.equal(shouldSyncRow("ramble_trades", { trade_id: "t1" }), true);
});

test("phase 3 outbox door: a trade write with no manager queues and is stamped by trade_id", async () => {
  await a.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, state, created_at, updated_at, expires_at) VALUES ('t-out','crow:peer','proposer','egg-1','proposed',10,10,999)", args: [] });
  const { rows } = await a.execute("SELECT * FROM ramble_trades WHERE trade_id='t-out'");
  const res = await emitOrQueue(null, a, "ramble_trades", "insert", rows[0]);
  assert.ok(res && res.queued, "emitOrQueue returned null — missing stampSql branch or lamport_ts?");
  const stamped = await a.execute("SELECT lamport_ts FROM ramble_trades WHERE trade_id='t-out'");
  assert.ok(Number(stamped.rows[0].lamport_ts) > 0, "trade row was never stamped — missing stampSql branch?");
  const queued = await a.execute("SELECT row_json, lamport_ts FROM sync_outbox WHERE table_name='ramble_trades' ORDER BY id DESC LIMIT 1");
  const wire = JSON.parse(queued.rows[0].row_json);
  assert.equal(wire.trade_id, "t-out");
  assert.equal(wire.role, "proposer");
  assert.equal(wire.state, "proposed");
  // row_json may carry the raw row's lamport_ts; the outbox drain re-enters emitChange, which strips EXCLUDED_COLUMNS before any peer sees it.
  assert.equal(Number(queued.rows[0].lamport_ts), Number(stamped.rows[0].lamport_ts));
});

test("phase 3 apply door: trade insert, LWW by envelope lamport, update, delete by trade_id", async () => {
  const row = { trade_id: "t-in", counterpart: "crow:peer", role: "acceptor", my_egg_id: null, their_egg_id: "egg-9", offer_json: '{"warmth":40}', state: "proposed", created_at: 5, updated_at: 5, expires_at: 99 };
  await applyRemoteOp(b, "ramble_trades", "insert", row, 5);
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, state: "declined" }, 3); // stale
  let got = await b.execute("SELECT state, role, their_egg_id FROM ramble_trades WHERE trade_id='t-in'");
  assert.deepEqual([got.rows[0].state, got.rows[0].role, got.rows[0].their_egg_id], ["proposed", "acceptor", "egg-9"]);
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, state: "accepted", my_egg_id: "egg-2", updated_at: 7 }, 7);
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, state: "accepted", my_egg_id: "egg-2", updated_at: 7 }, 7); // idempotent re-delivery
  got = await b.execute("SELECT state, my_egg_id, lamport_ts FROM ramble_trades WHERE trade_id='t-in'");
  assert.deepEqual([got.rows[0].state, got.rows[0].my_egg_id, Number(got.rows[0].lamport_ts)], ["accepted", "egg-2", 7]);
  // created_at is immutable on conflict
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, created_at: 1, state: "completed" }, 8);
  got = await b.execute("SELECT created_at, state FROM ramble_trades WHERE trade_id='t-in'");
  assert.deepEqual([got.rows[0].created_at, got.rows[0].state], [5, "completed"]);
  await applyRemoteOp(b, "ramble_trades", "delete", { trade_id: "t-in" }, 9);
  assert.equal((await b.execute("SELECT 1 FROM ramble_trades WHERE trade_id='t-in'")).rows.length, 0);
  await assert.doesNotReject(applyRemoteOp(b, "ramble_trades", "update", { counterpart: "x" }, 10), "a keyless row is ignored, never thrown on");
});

test("author_name rides the apply door (wire column) and is updatable by LWW", async () => {
  const row = { mark_id: "named-9", author: "c".repeat(64), author_level: "pseudonym", kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, visibility: "public", reveal: "open", content_text: "n", content_kind: "none", created_at: 1, expires_at: null, nostr_event_id: "ev-n9", author_name: "Kevin" };
  await applyRemoteOp(b, "ramble_marks", "insert", row, 11);
  let got = (await b.execute({ sql: "SELECT author_name, origin FROM ramble_marks WHERE mark_id = 'named-9'", args: [] })).rows[0];
  assert.deepEqual([got.author_name, got.origin], ["Kevin", "sync"]);
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, author_name: "Kev" }, 12);
  got = (await b.execute({ sql: "SELECT author_name FROM ramble_marks WHERE mark_id = 'named-9'", args: [] })).rows[0];
  assert.equal(got.author_name, "Kev");
});
