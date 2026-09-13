// 0006-bot-sessions-archived — the rail that keeps a co-hosted instance's
// bot_sessions table current with the additive archived_at column (Perch
// session archive, audit item 14), which carries no SCHEMA_GENERATION bump.
// Same outage class as 0005: convergence restarts an instance onto code whose
// /roost SELECT names `archived_at`; without this rail that instance's DB lacks
// the column and every Perch hub surface 500s until init-db is run by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0006-bot-sessions-archived.mjs";

function scratchCrowDb(withTable = true) {
  const dir = mkdtempSync(join(tmpdir(), "bs-arch-mig-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  if (withTable) {
    // The post-0005 shape: label + cwd present, archived_at absent — exactly
    // what an instance that already ran the 0005 rail (or a fresh init-db from
    // the prior generation) carries before this change converges.
    db.exec(`CREATE TABLE bot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL, pi_session_id TEXT, pi_session_dir TEXT,
      gateway_type TEXT, gateway_thread_id TEXT, project_id INTEGER, card_id INTEGER,
      plan_path TEXT, status TEXT NOT NULL DEFAULT 'active',
      control TEXT NOT NULL DEFAULT 'run', model TEXT, cwd TEXT, escalated INTEGER DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'chat', narrowed_tools TEXT, label TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
    db.prepare("INSERT INTO bot_sessions (bot_id, gateway_thread_id, kind, status) VALUES ('b','perchlive-x','perch-live','waiting-user')").run();
  }
  db.close();
  return dbPath;
}

function cols(dbPath) {
  const d = new Database(dbPath);
  const names = d.prepare("PRAGMA table_info(bot_sessions)").all().map((c) => c.name);
  d.close();
  return names;
}

test("adds archived_at to a legacy bot_sessions table, idempotently", () => {
  const dbPath = scratchCrowDb();
  assert.ok(!cols(dbPath).includes("archived_at"), "fixture is the pre-archive shape");

  const first = run({ dbPath, log: () => {} });
  assert.deepEqual(first.results, ["added"]);
  assert.ok(cols(dbPath).includes("archived_at"));

  const second = run({ dbPath, log: () => {} });
  assert.deepEqual(second.results, ["no-op"], "a second run is a clean no-op");
  assert.equal(cols(dbPath).filter((c) => c === "archived_at").length, 1);
});

test("existing rows survive — archived_at is NULL (not archived), the row is intact", () => {
  const dbPath = scratchCrowDb();
  run({ dbPath, log: () => {} });
  const d = new Database(dbPath);
  const row = d.prepare("SELECT bot_id, gateway_thread_id, archived_at FROM bot_sessions").get();
  d.close();
  assert.equal(row.bot_id, "b");
  assert.equal(row.archived_at, null, "NULL reads as 'not archived' — the roster default");
});

test("the /roost SELECT that names archived_at runs after the migration", () => {
  const dbPath = scratchCrowDb();
  const d0 = new Database(dbPath);
  assert.throws(() =>
    d0.prepare("SELECT gateway_thread_id, archived_at FROM bot_sessions WHERE kind='perch-live' AND archived_at IS NOT NULL").all(),
    /no such column: archived_at/);
  d0.close();
  run({ dbPath, log: () => {} });
  const d = new Database(dbPath);
  const rows = d.prepare("SELECT gateway_thread_id, archived_at FROM bot_sessions WHERE kind='perch-live'").all();
  d.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gateway_thread_id, "perchlive-x");
});

test("tolerates a DB with no bot_sessions table at all, and records applied", () => {
  const dbPath = scratchCrowDb(false);
  const r = run({ dbPath, log: () => {} });
  assert.deepEqual(r.results, ["absent"]);
  assert.equal(r.applied, true,
    "core table absent = a store that predates bot tables; init-db's CREATE body carries archived_at, so there is nothing to retry");
});

test("the id matches the filename convention the runner discovers", async () => {
  assert.equal(id, "0006-bot-sessions-archived");
  const { discoverMigrations } = await import("../scripts/migrations/runner.mjs");
  const found = discoverMigrations(new URL("../scripts/migrations", import.meta.url).pathname);
  assert.ok(found.some((p) => p.endsWith("0006-bot-sessions-archived.mjs")),
    "the runner must discover the new migration by filename");
  // and it sorts AFTER 0005 (ordered application)
  const names = found.map((p) => p.split("/").pop());
  assert.ok(names.indexOf("0005-bot-sessions-label-cwd.mjs") < names.indexOf("0006-bot-sessions-archived.mjs"));
});
