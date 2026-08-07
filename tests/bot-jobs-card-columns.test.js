/**
 * bot_jobs card_id migration. The DDL is CREATE TABLE IF NOT EXISTS shared by
 * three entry points, so a new column reaches EXISTING installs only via an
 * idempotent ALTER applied on first use. These pin both halves: fresh tables
 * need no ALTER, pre-existing ones get exactly the missing columns, and
 * running the migration twice is a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BOT_JOBS_DDL, BOT_JOBS_ADDED_COLUMNS, missingBotJobsColumns,
} from "../scripts/pi-bots/bot-jobs-schema.mjs";

/** The pre-card_id table, exactly as it exists on installs today. */
const LEGACY_DDL = `
  CREATE TABLE bot_jobs (
    job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
    schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER,
    claimed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, ended_at TEXT
  );`;

function withDb(ddl, fn) {
  const dir = mkdtempSync(join(tmpdir(), "botjobs-cols-"));
  const db = new Database(join(dir, "crow.db"));
  try { db.exec(ddl); return fn(db); }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

const cols = (db) => db.prepare("PRAGMA table_info(bot_jobs)").all().map((r) => r.name);

test("a table built from the current DDL already has card_id and needs no ALTER", () => {
  withDb(BOT_JOBS_DDL, (db) => {
    assert.ok(cols(db).includes("card_id"), "current DDL must create card_id");
    assert.deepEqual(missingBotJobsColumns(cols(db)), [],
      "a fresh table must require no migration — otherwise every boot re-ALTERs");
  });
});

test("a legacy table is missing card_id and the helper names exactly that ALTER", () => {
  withDb(LEGACY_DDL, (db) => {
    assert.equal(cols(db).includes("card_id"), false);
    const stmts = missingBotJobsColumns(cols(db));
    assert.equal(stmts.length, BOT_JOBS_ADDED_COLUMNS.length);
    assert.match(stmts[0], /ALTER TABLE bot_jobs ADD COLUMN card_id INTEGER/);
  });
});

test("applying the migration to a legacy table is idempotent", () => {
  withDb(LEGACY_DDL, (db) => {
    for (const s of missingBotJobsColumns(cols(db))) db.exec(s);
    assert.ok(cols(db).includes("card_id"), "card_id must exist after migrating");

    // Second pass: nothing left to do. A non-empty list here would mean every
    // entry point re-runs ALTER on every connect and throws "duplicate column".
    assert.deepEqual(missingBotJobsColumns(cols(db)), []);
  });
});

test("card_id survives a round-trip and defaults to NULL for non-card jobs", () => {
  withDb(BOT_JOBS_DDL, (db) => {
    db.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, source) VALUES (?,?,?,?)")
      .run("job-a", "bot-1", "do a thing", "schedule");
    db.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, source, card_id) VALUES (?,?,?,?,?)")
      .run("job-b", "bot-1", "work card 120", "card", 120);

    assert.equal(db.prepare("SELECT card_id FROM bot_jobs WHERE job_id='job-a'").get().card_id, null);
    assert.equal(db.prepare("SELECT card_id FROM bot_jobs WHERE job_id='job-b'").get().card_id, 120);
  });
});

test("card_action is added alongside card_id and round-trips", () => {
  withDb(BOT_JOBS_DDL, (db) => {
    assert.ok(cols(db).includes("card_action"), "current DDL must create card_action");
    db.prepare("INSERT INTO bot_jobs (job_id,bot_id,goal,source,card_id,card_action) VALUES (?,?,?,?,?,?)")
      .run("job-p", "bot-1", "plan card 120", "card", 120, "plan");
    const r = db.prepare("SELECT card_id, card_action FROM bot_jobs WHERE job_id='job-p'").get();
    assert.deepEqual([r.card_id, r.card_action], [120, "plan"]);
  });
});

test("job_runner self-heals a legacy table on connect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botjobs-heal-"));
  const dbPath = join(dir, "crow.db");
  const seed = new Database(dbPath);
  seed.exec(LEGACY_DDL);
  seed.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal) VALUES ('j1','b1','g')").run();
  seed.close();

  process.env.CROW_DB_PATH = dbPath;
  const mod = await import("../scripts/pi-bots/job_runner.mjs");

  const c = new Database(dbPath);
  try {
    mod.ensureBotJobsSchema(c);
    const names = c.prepare("PRAGMA table_info(bot_jobs)").all().map((r) => r.name);
    assert.ok(names.includes("card_id"), "an existing install must gain card_id without init-db");

    // The pre-existing row must survive — ALTER ADD COLUMN, never a rebuild.
    assert.equal(c.prepare("SELECT COUNT(*) n FROM bot_jobs").get().n, 1);

    mod.ensureBotJobsSchema(c); // second call must not throw "duplicate column"
  } finally {
    c.close(); rmSync(dir, { recursive: true, force: true });
  }
});
