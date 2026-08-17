// tests/init-pi-bots.test.js
//
// M5 (final review): scripts/init-pi-bots.mjs is the MPA-only maintenance
// script — a SEPARATE substrate-migration path from scripts/init-db.js,
// retained per the F3 note at its own header for the prod-bot guard + the
// JSON->column project_id backfill. Its bot_sessions CREATE TABLE body still
// used the pre-Track-3 narrow control CHECK ('run','stop' only), re-planting
// the pre-migration shape on ANY fresh install this script runs on (its
// `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, but a truly
// FRESH table gets whatever this file's own DDL says). init-db.js's guarded
// rebuild migration self-heals a pre-existing narrow-CHECK table on its NEXT
// run, but that's an exact-substring detection on the OLD CHECK text — this
// test proves the CREATE body itself now matches, so a fresh MPA install
// never needs that self-heal in the first place.
//
// Harness: this script REFUSES to run unless bot_registry has >= 1 row (its
// own "is this really the live MPA db?" guard) and reads CROW_DB_PATH
// directly (never CROW_DATA_DIR) via better-sqlite3, NOT createDbClient() —
// so the RED LINE here is a scratch file passed via CROW_DB_PATH, with a
// minimal bot_registry seeded first, never the real MPA db.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "init-pi-bots-"));
const dbFile = join(dir, "crow.db");

{
  const seed = new Database(dbFile);
  // The script's own guard reads `SELECT count(*) c FROM bot_registry` —
  // minimal shape, ANY column, just needs to exist with >= 1 row.
  seed.exec("CREATE TABLE bot_registry (id INTEGER PRIMARY KEY)");
  seed.prepare("INSERT INTO bot_registry DEFAULT VALUES").run();
  seed.close();
}

execFileSync(process.execPath, ["scripts/init-pi-bots.mjs"], {
  env: { ...process.env, CROW_DB_PATH: dbFile },
  stdio: "pipe",
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("M5: a fresh bot_sessions table (via init-pi-bots.mjs) already accepts control='interrupted'", () => {
  const db = new Database(dbFile, { readonly: true });
  try {
    const sql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_sessions'"
    ).get().sql;
    assert.match(sql, /CHECK \(control IN \('run','stop','interrupted'\)\)/,
      "the fresh CREATE body must already include 'interrupted' — no self-heal migration should be needed");
  } finally {
    db.close();
  }
});

test("M5: a fresh bot_sessions row actually accepts control='interrupted' without a CHECK violation", () => {
  const db = new Database(dbFile);
  try {
    const info = db.prepare(
      "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control) VALUES (?,?,?,?,?)"
    ).run("test-bot", "perch", "thread-interrupted-m5", "waiting-user", "interrupted");
    assert.ok(info.lastInsertRowid > 0);
    const row = db.prepare("SELECT control FROM bot_sessions WHERE id=?").get(info.lastInsertRowid);
    assert.equal(row.control, "interrupted");
  } finally {
    db.close();
  }
});
