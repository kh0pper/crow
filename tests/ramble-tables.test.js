import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await initRambleTables(db); // idempotent
});

test("all ramble tables + fts exist", async () => {
  const { rows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
  );
  const names = rows.map((r) => r.name);
  for (const t of ["ramble_marks", "ramble_pet", "ramble_settings", "ramble_groups", "ramble_blocks", "ramble_tombstones", "ramble_marks_fts"]) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
});

test("synced tables carry lamport_ts (outbox stamp requirement)", async () => {
  for (const t of ["ramble_marks", "ramble_settings", "ramble_blocks"]) {
    const { rows } = await db.execute(`PRAGMA table_info(${t})`);
    assert.ok(rows.some((r) => r.name === "lamport_ts"), `${t} missing lamport_ts`);
  }
});

test("fts indexes mark text on insert", async () => {
  await db.execute({
    sql: "INSERT INTO ramble_marks (mark_id, author, kind, anchor_kind, geohash, visibility, reveal, content_text, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    args: ["m1", "abc", "mark", "geo", "9v6", "public", "open", "coffee here", 1000],
  });
  const { rows } = await db.execute({ sql: "SELECT mark_id FROM ramble_marks_fts WHERE ramble_marks_fts MATCH ?", args: ["coffee"] });
  assert.equal(rows.length, 1);
});

test("flock tables + columns exist (phase 1)", async () => {
  const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const names = rows.map((r) => r.name);
  for (const t of ["ramble_eggs", "ramble_credits"]) assert.ok(names.includes(t), `missing ${t}`);
  const cols = async (t) => (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name);
  const pet = await cols("ramble_pet");
  for (const c of ["active_egg_id", "chores_json", "lamport_ts", "week_start"]) assert.ok(pet.includes(c), `ramble_pet.${c}`);
  const marks = await cols("ramble_marks");
  for (const c of ["bird_species", "bird_seed"]) assert.ok(marks.includes(c), `ramble_marks.${c}`);
  const eggs = await cols("ramble_eggs");
  for (const c of ["egg_id", "status", "warmth", "species", "seed", "found_cell", "found_week", "from_crow_id", "created_at", "hatched_at", "lamport_ts"]) assert.ok(eggs.includes(c), `ramble_eggs.${c}`);
});

test("credits primary key rejects a duplicate (kind,key)", async () => {
  await db.execute({ sql: "INSERT INTO ramble_credits (kind, key, credited_at) VALUES (?,?,?)", args: ["checkin", "2026-09-07", 1] });
  await assert.rejects(db.execute({ sql: "INSERT INTO ramble_credits (kind, key, credited_at) VALUES (?,?,?)", args: ["checkin", "2026-09-07", 2] }));
});

test("phase 2: ramble_eggs.shelf_origin exists and legacy NULL shelf rows backfill to 'sync'", async () => {
  const cols = (await db.execute("PRAGMA table_info(ramble_eggs)")).rows.map((r) => r.name);
  assert.ok(cols.includes("shelf_origin"), "ramble_eggs.shelf_origin");
  // A phase-1 convergence loser on disk has no origin. Re-running init (every
  // boot does) must mark it 'sync' so re-promotion can still pick it up, and
  // must leave a user-shelved egg alone.
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('legacy','shelf',5,1)", args: [] });
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at, shelf_origin) VALUES ('mine','shelf',5,2,'user')", args: [] });
  await initRambleTables(db);
  const got = await db.execute("SELECT egg_id, shelf_origin FROM ramble_eggs WHERE egg_id IN ('legacy','mine') ORDER BY egg_id");
  assert.deepEqual(got.rows.map((r) => [r.egg_id, r.shelf_origin]), [["legacy", "sync"], ["mine", "user"]]);
});

test("phase 2: ramble_nest_claims exists, is keyed on (cell, week) and is NOT a synced table", async () => {
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(!SYNCED_TABLES.includes("ramble_nest_claims"), "claims are per instance (spec §5)");
  const cols = (await db.execute("PRAGMA table_info(ramble_nest_claims)")).rows.map((r) => r.name);
  for (const c of ["cell", "week", "egg_id", "claimed_at"]) assert.ok(cols.includes(c), `ramble_nest_claims.${c}`);
  await db.execute({ sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES ('9v6m21h','2026-W37','e1',1)", args: [] });
  await assert.rejects(db.execute({ sql: "INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES ('9v6m21h','2026-W37','e2',2)", args: [] }));
});

test("phase 3: ramble_trades is a replicated natural-key table; ramble_outbox is local", async () => {
  const cols = async (t) => (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name);
  const trades = await cols("ramble_trades");
  for (const c of ["trade_id", "counterpart", "role", "my_egg_id", "their_egg_id", "offer_json", "state", "created_at", "updated_at", "expires_at", "lamport_ts"]) {
    assert.ok(trades.includes(c), `ramble_trades.${c}`);
  }
  const outbox = await cols("ramble_outbox");
  for (const c of ["id", "to_crow_id", "kind", "ref_id", "payload_json", "attempts", "created_at"]) assert.ok(outbox.includes(c), `ramble_outbox.${c}`);
  assert.ok(!outbox.includes("lamport_ts"), "ramble_outbox never replicates, so it carries no lamport");
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(SYNCED_TABLES.includes("ramble_trades"), "trades follow the user across their instances (spec §5)");
  assert.ok(!SYNCED_TABLES.includes("ramble_outbox"), "the delivery queue is one instance's outbound work");
  await db.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, state, created_at, updated_at, expires_at) VALUES ('t1','crow:x','proposer','proposed',1,1,2)", args: [] });
  await assert.rejects(db.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, state, created_at, updated_at, expires_at) VALUES ('t1','crow:y','acceptor','proposed',1,1,2)", args: [] }));
});
