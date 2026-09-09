/**
 * Spec 2026-09-08 §2.1: a cell unlocks from a REAL position fix and stays
 * unlocked forever. recordUnlock reports whether this was the first time, so
 * the route can fire the unlock animation exactly once per cell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { recordUnlock, unlockedCells, unlockedCellsNear } from "../bundles/ramble/server/cells.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

test("recordUnlock: first visit unlocks and EMITS, later visits do neither, and the timestamp never moves", async () => {
  const db = await freshDb();
  const emitted = [];
  const emit = async (table, op, row) => { emitted.push({ table, op, cell: row.cell }); };

  assert.deepEqual(await recordUnlock(db, "9vk79ed", { now: 1000, emit }), { unlocked: true, cell: "9vk79ed" });
  assert.deepEqual(emitted, [{ table: "ramble_cells", op: "insert", cell: "9vk79ed" }],
    "the outbound half exists — registering the table alone replicates NOTHING");

  assert.deepEqual(await recordUnlock(db, "9vk79ed", { now: 2000, emit }), { unlocked: false, cell: "9vk79ed" });
  assert.equal(emitted.length, 1, "a repeat visit emits nothing");

  const rows = (await db.execute("SELECT * FROM ramble_cells")).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].first_unlocked_at), 1000, "the first arrival is the one recorded");
});

test("recordUnlock: a zero timestamp is a timestamp, not a missing value", async () => {
  const db = await freshDb();
  await recordUnlock(db, "9vk79ed", { now: 0 });
  assert.equal(Number((await db.execute("SELECT first_unlocked_at FROM ramble_cells")).rows[0].first_unlocked_at), 0, "now: 0 must not be replaced by the wall clock");
});

test("recordUnlock: a vague fix does NOT unlock, because an unlock can never be undone", async () => {
  const db = await freshDb();
  const r = await recordUnlock(db, "9vk79ed", { now: 1, accuracyM: 2000 });
  assert.deepEqual(r, { unlocked: false, cell: null, reason: "inaccurate" });
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows[0].n, 0, "nothing written");

  assert.equal((await recordUnlock(db, "9vk79ed", { now: 1, accuracyM: 100 })).unlocked, true, "at the limit is fine");
  const db2 = await freshDb();
  assert.equal((await recordUnlock(db2, "9vk79ed", { now: 1 })).unlocked, true, "no accuracy reported: trusted, as today");
  const db3 = await freshDb();
  await db3.execute("INSERT INTO ramble_settings (key, value) VALUES ('unlock.max.accuracy.m', '20')");
  assert.equal((await recordUnlock(db3, "9vk79ed", { now: 1, accuracyM: 50 })).unlocked, false, "the bound is a live setting");
});

test("unlockedCellsNear: only cells that could matter for this viewport", async () => {
  const db = await freshDb();
  await recordUnlock(db, "9vk79ed", { now: 1 });
  const here = (await import("../bundles/ramble/server/anchors.js")).decodeGeohash("9vk79ed");
  const near = { south: here.lat - 0.002, west: here.lon - 0.002, north: here.lat + 0.002, east: here.lon + 0.002 };
  assert.deepEqual([...(await unlockedCellsNear(db, near, 3))], ["9vk79ed"]);
  const far = { south: 0, west: 0, north: 0.002, east: 0.002 };
  assert.deepEqual([...(await unlockedCellsNear(db, far, 3))], [], "a viewport on the other side of the world reads nothing");
});

test("recordUnlock: junk is refused without throwing and writes nothing", async () => {
  const db = await freshDb();
  for (const bad of ["nope", "", null, undefined, 7, "9vk79edX", "9vk79e"]) {
    assert.deepEqual(await recordUnlock(db, bad, { now: 1000 }), { unlocked: false, cell: null }, String(bad));
  }
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows[0].n, 0);
  assert.deepEqual(await recordUnlock(null, "9vk79ed", { now: 1 }), { unlocked: false, cell: null }, "no db, no throw");
  // A throwing emit must not lose the write: the row is local truth already.
  const boom = async () => { throw new Error("relay down"); };
  assert.equal((await recordUnlock(db, "9vk79ed", { now: 1, emit: boom })).unlocked, true, "a failed emit never fails the unlock");
});

test("unlockedCells: the whole set, as a Set, empty on a database with no ramble tables", async () => {
  const db = await freshDb();
  await recordUnlock(db, "9vk79ed", { now: 1 });
  await recordUnlock(db, "9vk79ee", { now: 2 });
  const set = await unlockedCells(db);
  assert.ok(set instanceof Set);
  assert.deepEqual([...set].sort(), ["9vk79ed", "9vk79ee"]);
  const bare = createClient({ url: "file::memory:" });
  assert.deepEqual([...(await unlockedCells(bare))], [], "no table, no throw, empty set");
});

// ------------------------------------------------------- FIX 2: the backfill

// Raw pre-creation of the four legacy tables backfillCellsOnce reads, so
// seeding happens BEFORE initRambleTables is ever called — otherwise the
// very first call already sets the flag on empty tables and there is
// nothing left to backfill. Schemas match init-tables.js verbatim so the
// later `CREATE TABLE IF NOT EXISTS` / trigger statements are no-ops.
async function seededLegacyDb() {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(`
    CREATE TABLE ramble_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE TABLE ramble_credits (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      credited_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );
    CREATE TABLE ramble_nest_claims (
      cell TEXT NOT NULL,
      week TEXT NOT NULL,
      egg_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY (cell, week)
    );
    CREATE TABLE ramble_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mark_id TEXT UNIQUE NOT NULL,
      author TEXT NOT NULL,
      author_level TEXT,
      kind TEXT NOT NULL,
      anchor_kind TEXT NOT NULL,
      geohash TEXT, lat REAL, lon REAL, accuracy_m REAL, anchor_ref TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      reveal TEXT NOT NULL DEFAULT 'open',
      content_text TEXT, content_kind TEXT DEFAULT 'none', content_ref TEXT,
      thumb_enc TEXT, locked_blob TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      nostr_event_id TEXT UNIQUE,
      publish_state TEXT NOT NULL DEFAULT 'pending',
      origin TEXT NOT NULL DEFAULT 'local',
      lamport_ts INTEGER DEFAULT 0
    );`);
  return db;
}

test("initRambleTables backfill: visit_place credits, nest claims and local marks seed ramble_cells exactly once", async () => {
  const db = await seededLegacyDb();
  await db.execute({
    sql: "INSERT INTO ramble_credits (kind, key, credited_at) VALUES ('visit_place', ?, ?)",
    args: ["9vk7934:2026-W37", 1000],
  });
  await db.execute({
    sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES (?, ?, ?, ?)",
    args: ["9vk79ed", "2026-W37", "egg-1", 1000],
  });
  await db.execute({
    sql: `INSERT INTO ramble_marks (mark_id, author, kind, anchor_kind, geohash, created_at, origin)
          VALUES ('mark-1', 'me', 'mark', 'gps', ?, ?, 'local')`,
    args: ["9vk79ee", 1000],
  });

  await initRambleTables(db);
  const afterFirst = (await db.execute("SELECT cell FROM ramble_cells ORDER BY cell")).rows.map((r) => r.cell);
  assert.deepEqual(afterFirst, ["9vk7934", "9vk79ed", "9vk79ee"], "all three sources feed the backfill");
  const flag = (await db.execute("SELECT value FROM ramble_settings WHERE key = 'cells.backfilled'")).rows;
  assert.equal(flag.length, 1, "the flag row is set");

  await initRambleTables(db);
  const afterSecond = (await db.execute("SELECT cell FROM ramble_cells ORDER BY cell")).rows.map((r) => r.cell);
  assert.deepEqual(afterSecond, afterFirst, "the second run adds nothing — no duplicate rows, count unchanged");
});

test("initRambleTables backfill: a junk credit key is skipped rather than inserted", async () => {
  const db = await seededLegacyDb();
  await db.execute({
    sql: "INSERT INTO ramble_credits (kind, key, credited_at) VALUES ('visit_place', ?, ?)",
    args: ["not-a-cell:2026-W37", 1000],
  });

  await initRambleTables(db);
  const rows = (await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows;
  assert.equal(Number(rows[0].n), 0, "a junk cell shaped credit key must not become a row");
});

test("initRambleTables backfill: a fresh database with no legacy rows sets the flag with zero cells", async () => {
  const db = await freshDb();
  const rows = (await db.execute("SELECT COUNT(*) AS n FROM ramble_cells")).rows;
  assert.equal(Number(rows[0].n), 0, "no legacy history, no cells");
  const flag = (await db.execute("SELECT value FROM ramble_settings WHERE key = 'cells.backfilled'")).rows;
  assert.equal(flag.length, 1, "the flag is still set, so a fresh install cannot repeat the backfill");
});
