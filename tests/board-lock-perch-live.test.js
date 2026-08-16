// tests/board-lock-perch-live.test.js
//
// T3-9 (Track 3 board×Perch merge spec): the board card lock predicate must
// stop treating a 'waiting-user' bot_sessions row as a lock, and must never
// let a 'perch-live' row (the always-on interactive channel, not a per-card
// dispatch) lock a card at all — including when a perch-live row is the
// NEWEST row on a card and an older 'chat'/'active' row underneath it is the
// one that should actually hold the lock. The exclusion has to live in the
// SQL (kind != 'perch-live'), not as a post-hoc check on the newest row,
// or a perch-live row would shadow a real active session.
//
// Fix round 1 (full-suite finding): the exclusion must be NULL-safe. SQLite's
// three-valued logic makes a bare `kind != 'perch-live'` evaluate to NULL —
// not true — for a NULL-kind row, and WHERE drops NULL like false, so an
// active row with a legacy/absent kind would silently stop locking. The
// fix in board-lock.js is `COALESCE(kind,'') != 'perch-live'`; card 6 below
// covers that a NULL kind is not a perch-live claim and must still lock.
//
// Harness: scratch tasks.db + crow.db via env, better-sqlite3 seeding, then
// the gateway's async libsql-shaped client (servers/db.js createDbClient) —
// same idiom as tests/board-job-lock.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-lock-perch-live-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

// Seed BEFORE importing anything that reads the env at module load.
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare(
    "INSERT INTO tasks_items (id, title, project_id, assigned_bot, status) VALUES (?,?,1,'scout',?)"
  );
  ins.run(1, "newest row perch-live waiting-user only", "in_progress");
  ins.run(2, "newest row chat waiting-user (stale history)", "in_progress");
  ins.run(3, "newest row chat active", "in_progress");
  ins.run(4, "bot_jobs running", "in_progress");
  ins.run(5, "newest perch-live waiting-user shadowing an older active chat row", "in_progress");
  ins.run(6, "active row with NULL kind (legacy/fixture-drift shape) still locks", "in_progress");
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
      workspace_dir TEXT, storage_prefix TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.exec(BOT_JOBS_DDL);
  c.prepare("INSERT INTO project_spaces (id, name, slug) VALUES (1, 'proj', 'proj')").run();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('scout','Scout','{}',1,1)").run();

  const sess = c.prepare(
    "INSERT INTO bot_sessions (bot_id, card_id, kind, status) VALUES ('scout', ?, ?, ?)"
  );
  // card 1: only row is perch-live/waiting-user -> never locks.
  sess.run(1, "perch-live", "waiting-user");
  // card 2: only row is chat/waiting-user (stale history) -> the T3-9 change:
  // waiting-user no longer locks.
  sess.run(2, "chat", "waiting-user");
  // card 3: chat/active -> still locks, rail 'session'.
  sess.run(3, "chat", "active");
  // card 5: OLDER chat/active row first, then a NEWER perch-live/waiting-user
  // row. The newest-row perch-live exclusion must not shadow the active row
  // underneath it — the card must still read as locked.
  sess.run(5, "chat", "active");
  sess.run(5, "perch-live", "waiting-user");
  // card 6: active row with an EXPLICIT NULL kind (fixture-drift / legacy-row
  // shape) -> must still lock. A bare `kind != 'perch-live'` would silently
  // exclude this row under SQLite's NULL comparison semantics; the fix uses
  // COALESCE(kind,'') != 'perch-live' so only the literal string is excluded.
  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, kind, status) VALUES ('scout', 6, NULL, 'active')").run();

  // card 4: locked via the job rail instead, rail 'job'.
  c.prepare(
    "INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id, card_action, worker_pid) " +
      "VALUES ('job-running-4','scout','execute #4','running','card',4,'execute',null)"
  ).run();
  c.close();
}

after(() => rmSync(dir, { recursive: true, force: true }));

let createDbClient;
before(async () => {
  ({ createDbClient } = await import("../servers/db.js"));
});

test("waiting-user no longer locks; perch-live never locks (even as the newest row over an active one); active still locks", async () => {
  const { lockState, lockedCardIds, SESSION_LOCK_STATUSES } = await import("../servers/gateway/routes/board-lock.js");
  const db = createDbClient();
  try {
    assert.equal(SESSION_LOCK_STATUSES.has("waiting-user"), false, "waiting-user must be removed from the lock set (T3-9)");
    assert.equal(SESSION_LOCK_STATUSES.has("active"), true, "active must still lock");

    const s1 = await lockState(db, 1);
    assert.equal(s1.locked, false, "a perch-live-only row must never lock");

    const s2 = await lockState(db, 2);
    assert.equal(s2.locked, false, "waiting-user must no longer lock (T3-9 product change)");

    const s3 = await lockState(db, 3);
    assert.equal(s3.locked, true, "an active chat row must still lock");
    assert.equal(s3.rail, "session");

    const s4 = await lockState(db, 4);
    assert.equal(s4.locked, true);
    assert.equal(s4.rail, "job");

    const s5 = await lockState(db, 5);
    assert.equal(s5.locked, true, "an older active row must not be shadowed by a newer perch-live row");
    assert.equal(s5.rail, "session");

    const s6 = await lockState(db, 6);
    assert.equal(s6.locked, true, "an active row with a NULL kind must still lock (NULL is not a perch-live claim)");
    assert.equal(s6.rail, "session");

    const set = await lockedCardIds(db, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...set].sort((a, b) => a - b), [3, 4, 5, 6]);
  } finally {
    db.close();
  }
});
