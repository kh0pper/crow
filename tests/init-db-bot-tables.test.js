import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "f3-initdb-"));

// Run the real init-db.js against a throwaway data dir.
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const db = new Database(join(dir, "crow.db"), { readonly: true });
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test("pi_bot_defs exists with project_id column", () => {
  assert.ok(cols("pi_bot_defs").includes("project_id"));
});

test("bot_sessions exists with model + escalated columns", () => {
  const c = cols("bot_sessions");
  assert.ok(c.includes("model"));
  assert.ok(c.includes("escalated"));
});

test("bot_skill_events exists with action column", () => {
  assert.ok(cols("bot_skill_events").includes("action"));
});

// C4 acceptance fix (2026-07-22): bridge.mjs upsertSession() writes/reads
// bot_sessions.kind on EVERY bot turn (default "chat"), but init-db.js never
// created or migrated that column — a truly fresh install crashed on its
// first bot turn with "table bot_sessions has no column named kind". Prod
// only worked via an uncaptured manual ALTER TABLE. See the fix comment
// above the bot_sessions initTable() call in scripts/init-db.js.
test("bot_sessions (fresh install) has a kind column, NOT NULL DEFAULT 'chat'", () => {
  const info = db.prepare("PRAGMA table_info(bot_sessions)").all();
  const kind = info.find((c) => c.name === "kind");
  assert.ok(kind, "bot_sessions.kind must exist on a freshly init-db'd DB");
  assert.equal(kind.notnull, 1, "kind must be NOT NULL, matching prod's manual ALTER");
  assert.equal(kind.dflt_value, "'chat'", "kind must default to 'chat', matching bridge.mjs's null-default");
});

test("bot_sessions accepts the exact INSERT bridge.mjs's upsertSession() issues (fresh install)", () => {
  // Mirrors scripts/pi-bots/bridge.mjs upsertSession()'s INSERT verbatim —
  // this is the literal statement that crashed a fresh install pre-fix.
  const rw = new Database(join(dir, "crow.db"));
  try {
    const info = rw
      .prepare(
        "INSERT INTO bot_sessions (bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,project_id,card_id,plan_path,status,control,model,escalated,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run("test-bot", null, null, "gmail", "thread-1", null, null, null, "active", "run", null, 0, "chat");
    assert.ok(info.lastInsertRowid > 0);
    const row = rw.prepare("SELECT kind FROM bot_sessions WHERE id=?").get(info.lastInsertRowid);
    assert.equal(row.kind, "chat");
    // Clean up so this test doesn't leak state into the read-only assertions above.
    rw.prepare("DELETE FROM bot_sessions WHERE id=?").run(info.lastInsertRowid);
  } finally {
    rw.close();
  }
});

// Migration path: an existing DB that already has bot_sessions WITHOUT `kind`
// (any host that ran init-db.js between F3 and this fix) must converge via
// addColumnIfMissing on the NEXT init-db.js run — no SCHEMA_GENERATION bump,
// same idiom as every other post-hoc column in this file.
test("bot_sessions pre-existing WITHOUT kind: re-running init-db.js adds it", () => {
  const migDir = mkdtempSync(join(tmpdir(), "f3-initdb-mig-"));
  try {
    // First pass: build the full current shape (so every OTHER table/column
    // this migration depends on already exists), then drop back to the
    // pre-fix bot_sessions shape by rebuilding the table without `kind`.
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });
    const pre = new Database(join(migDir, "crow.db"));
    try {
      pre.exec(`
        CREATE TABLE bot_sessions_old (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id            TEXT NOT NULL,
          pi_session_id     TEXT,
          pi_session_dir    TEXT,
          gateway_type      TEXT,
          gateway_thread_id TEXT,
          project_id        INTEGER,
          card_id           INTEGER,
          plan_path         TEXT,
          status            TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','waiting-user','stopped','done','error')),
          control           TEXT NOT NULL DEFAULT 'run'
                              CHECK (control IN ('run','stop')),
          model             TEXT,
          escalated         INTEGER DEFAULT 0,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO bot_sessions_old
          (id,bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,
           project_id,card_id,plan_path,status,control,model,escalated,created_at,updated_at)
          SELECT id,bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,
                 project_id,card_id,plan_path,status,control,model,escalated,created_at,updated_at
          FROM bot_sessions;
        DROP TABLE bot_sessions;
        ALTER TABLE bot_sessions_old RENAME TO bot_sessions;
      `);
      const preCols = pre.prepare("PRAGMA table_info(bot_sessions)").all().map((c) => c.name);
      assert.ok(!preCols.includes("kind"), "test setup sanity: pre-fix shape must not have kind");
    } finally {
      pre.close();
    }

    // Re-run init-db.js against the same data dir — the guarded ALTER path
    // (addColumnIfMissing) must add `kind` without a SCHEMA_GENERATION bump
    // and without touching any other column.
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });
    const post = new Database(join(migDir, "crow.db"), { readonly: true });
    try {
      const postCols = post.prepare("PRAGMA table_info(bot_sessions)").all().map((c) => c.name);
      assert.ok(postCols.includes("kind"), "kind must be added by a second init-db.js run");
      assert.ok(postCols.includes("model") && postCols.includes("escalated"),
        "pre-existing columns must survive the migration");
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});
