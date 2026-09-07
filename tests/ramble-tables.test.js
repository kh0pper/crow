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
