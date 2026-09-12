// 0005-bot-sessions-label-cwd — the rail that keeps a co-hosted instance's
// bot_sessions table current with additive columns that carry no
// SCHEMA_GENERATION bump. Written from the measured 2026-09-12 R4 outage:
// convergence restarted R4 onto post-#360 code whose /roost SELECT names
// `label` and whose writeRow stamps `cwd`; R4's DB had neither, so every
// Perch hub surface on that instance 500'd until init-db was run by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0005-bot-sessions-label-cwd.mjs";

function scratchCrowDb(withTable = true) {
  const dir = mkdtempSync(join(tmpdir(), "bs-mig-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  if (withTable) {
    // The pre-label/cwd shape: an R4-as-found table (kind/narrowed_tools
    // present from 0001-era rails, label/cwd absent).
    db.exec(`CREATE TABLE bot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL, pi_session_id TEXT, pi_session_dir TEXT,
      gateway_type TEXT, gateway_thread_id TEXT, project_id INTEGER, card_id INTEGER,
      plan_path TEXT, status TEXT NOT NULL DEFAULT 'active',
      control TEXT NOT NULL DEFAULT 'run', model TEXT, escalated INTEGER DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'chat', narrowed_tools TEXT,
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

test("adds label and cwd to a legacy bot_sessions table, idempotently", () => {
  const dbPath = scratchCrowDb();
  const before = cols(dbPath);
  assert.ok(!before.includes("label") && !before.includes("cwd"), "fixture is the legacy shape");

  const first = run({ dbPath, log: () => {} });
  assert.deepEqual(first.results, ["added", "added"]);
  const after = cols(dbPath);
  assert.ok(after.includes("label"));
  assert.ok(after.includes("cwd"));

  const second = run({ dbPath, log: () => {} });
  assert.deepEqual(second.results, ["no-op", "no-op"], "a second run is a clean no-op");
  assert.equal(cols(dbPath).filter((c) => c === "cwd").length, 1);
});

test("existing rows survive — the column is NULL, the row is intact", () => {
  const dbPath = scratchCrowDb();
  run({ dbPath, log: () => {} });
  const d = new Database(dbPath);
  const row = d.prepare("SELECT bot_id, gateway_thread_id, label, cwd FROM bot_sessions").get();
  d.close();
  assert.equal(row.bot_id, "b");
  assert.equal(row.label, null, "NULL reads as 'no name' — the rename feature's own default");
  assert.equal(row.cwd, null, "NULL reads as 'the bot's default directory' — the open-anywhere default");
});

test("the /roost query that 500'd on R4 runs after the migration", () => {
  const dbPath = scratchCrowDb();
  // Before: this exact SELECT is what broke (routes/perch.js ~:507).
  const d0 = new Database(dbPath);
  assert.throws(() =>
    d0.prepare("SELECT gateway_thread_id, card_id, control, label FROM bot_sessions WHERE kind='perch-live' AND status != 'stopped'").all(),
    /no such column: label/);
  d0.close();
  run({ dbPath, log: () => {} });
  const d = new Database(dbPath);
  const rows = d.prepare("SELECT gateway_thread_id, card_id, control, label, cwd FROM bot_sessions WHERE kind='perch-live' AND status != 'stopped'").all();
  d.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gateway_thread_id, "perchlive-x");
});

test("tolerates a DB with no bot_sessions table at all, and records applied", () => {
  const dbPath = scratchCrowDb(false);
  const r = run({ dbPath, log: () => {} });
  assert.deepEqual(r.results, ["absent", "absent"]);
  assert.equal(r.applied, true,
    "core table absent = a store that predates bot tables; init-db's CREATE body carries both columns, so there is nothing to retry");
});

test("the id matches the filename convention the runner discovers", async () => {
  assert.equal(id, "0005-bot-sessions-label-cwd");
  const { discoverMigrations } = await import("../scripts/migrations/runner.mjs");
  const found = discoverMigrations(new URL("../scripts/migrations", import.meta.url).pathname);
  assert.ok(found.some((p) => p.endsWith("0005-bot-sessions-label-cwd.mjs")),
    "the runner must discover the new migration by filename");
});
