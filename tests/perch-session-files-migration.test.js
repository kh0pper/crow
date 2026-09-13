// 0007-perch-session-files — the rail that creates the sent-file card history
// table on a co-hosted instance that converges without re-running init-db
// (Perch PR-E, audit item 12). Same outage class as 0005/0006: the table
// carries no SCHEMA_GENERATION bump, so an instance whose boot guard skips
// init-db would meet "no such table: perch_session_files" on the first
// crow-file: relay of its life — inside the engine's notify branch, where a
// throw is swallowed and the card silently stops persisting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0007-perch-session-files.mjs";

function scratchDb({ withTable = false, withIndex = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "psf-mig-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  if (withTable) {
    db.exec(`CREATE TABLE perch_session_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, name TEXT NOT NULL,
      stored TEXT, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0, caption TEXT NOT NULL DEFAULT '',
      servable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, servable) VALUES ('b','t','x.png',1)").run();
  }
  if (withIndex) {
    db.exec("CREATE INDEX idx_perch_session_files_thread ON perch_session_files (bot_id, thread_id)");
  }
  db.close();
  return { dir, dbPath };
}

function shape(dbPath) {
  const d = new Database(dbPath);
  const out = {
    table: !!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='perch_session_files'").get(),
    index: !!d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_perch_session_files_thread'").get(),
    cols: d.prepare("PRAGMA table_info(perch_session_files)").all().map((c) => c.name),
  };
  d.close();
  return out;
}

test("creates the table and its thread index on an instance that never ran init-db's new block", () => {
  const { dir, dbPath } = scratchDb();
  try {
    const r = run({ dbPath, log: () => {} });
    assert.equal(r.applied, true);
    const s = shape(dbPath);
    assert.ok(s.table && s.index);
    assert.deepEqual(s.cols, ["id", "bot_id", "thread_id", "name", "stored", "mime", "size", "caption", "servable", "created_at"],
      "byte-identical column shape to init-db.js's CREATE body");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a second run is a clean no-op — no duplicate table, no lost rows", () => {
  const { dir, dbPath } = scratchDb({ withTable: true, withIndex: true });
  try {
    const first = run({ dbPath, log: () => {} });
    const second = run({ dbPath, log: () => {} });
    assert.equal(first.applied, true);
    assert.equal(second.applied, true);
    const d = new Database(dbPath);
    const rows = d.prepare("SELECT COUNT(*) AS n FROM perch_session_files").get().n;
    d.close();
    assert.equal(rows, 1, "CREATE IF NOT EXISTS never touched existing history");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the module id matches its filename, as the runner's registry expects", () => {
  assert.equal(id, "0007-perch-session-files");
});
