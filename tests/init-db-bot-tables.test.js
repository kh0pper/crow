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

// Track 3 Task 7: stopAll() parks a mid-turn-interrupted session with
// control='interrupted' (perch-interactive.js), but the ORIGINAL CHECK
// (control IN ('run','stop')) predates that value — a fresh install already
// gets the widened CHECK from the CREATE TABLE body (asserted directly
// below), and a PRE-EXISTING install (the old narrow CHECK, some rows already
// present) must converge via the guarded rebuild migration on the NEXT
// init-db.js run, preserving every row and every other column exactly — see
// the fix comment above the migration block in scripts/init-db.js.
test("bot_sessions (fresh install) control CHECK allows 'interrupted'", () => {
  const rw = new Database(join(dir, "crow.db"));
  try {
    const info = rw
      .prepare(
        "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,kind) VALUES (?,?,?,?,?,?)"
      )
      .run("test-bot-interrupted", "perch", "thread-interrupted", "waiting-user", "interrupted", "perch-live");
    assert.ok(info.lastInsertRowid > 0);
    const row = rw.prepare("SELECT control FROM bot_sessions WHERE id=?").get(info.lastInsertRowid);
    assert.equal(row.control, "interrupted");
    rw.prepare("DELETE FROM bot_sessions WHERE id=?").run(info.lastInsertRowid);
  } finally {
    rw.close();
  }
});

test("bot_sessions pre-existing WITH the old control CHECK ('run','stop' only): re-running init-db.js widens it, preserving every row", () => {
  const migDir = mkdtempSync(join(tmpdir(), "f3-initdb-controlmig-"));
  try {
    // First pass: build the full current shape, then rebuild bot_sessions
    // back to the OLD narrow control CHECK (every other column/CHECK/DEFAULT
    // untouched) so the guarded migration has something real to detect.
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });
    const pre = new Database(join(migDir, "crow.db"));
    let seededId;
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
          kind              TEXT NOT NULL DEFAULT 'chat',
          narrowed_tools    TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO bot_sessions_old
          (id,bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,
           project_id,card_id,plan_path,status,control,model,escalated,kind,
           narrowed_tools,created_at,updated_at)
          SELECT id,bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,
                 project_id,card_id,plan_path,status,control,model,escalated,kind,
                 narrowed_tools,created_at,updated_at
          FROM bot_sessions;
        DROP TABLE bot_sessions;
        ALTER TABLE bot_sessions_old RENAME TO bot_sessions;
      `);
      const preSql = pre.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_sessions'").get().sql;
      assert.ok(preSql.includes("CHECK (control IN ('run','stop'))"), "test setup sanity: pre-fix CHECK must be the narrow one");
      // A real pre-existing row, to prove the rebuild preserves it verbatim.
      const info = pre
        .prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,kind) VALUES (?,?,?,?,?,?)")
        .run("carried-bot", "perch", "carried-thread", "active", "run", "perch-live");
      seededId = info.lastInsertRowid;
    } finally {
      pre.close();
    }

    // Re-run init-db.js against the same data dir — the guarded rebuild must
    // widen the CHECK, preserve the seeded row exactly, and reject nothing.
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });
    const post = new Database(join(migDir, "crow.db"));
    try {
      const postSql = post.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_sessions'").get().sql;
      assert.ok(postSql.includes("'interrupted'"), "the CHECK must be widened by a second init-db.js run");
      const seeded = post.prepare("SELECT bot_id, gateway_thread_id, status, control, kind FROM bot_sessions WHERE id=?").get(seededId);
      assert.deepEqual(seeded, {
        bot_id: "carried-bot", gateway_thread_id: "carried-thread", status: "active", control: "run", kind: "perch-live",
      }, "the pre-existing row must survive the rebuild byte-identical");
      // And the new value now actually inserts without a CHECK violation.
      const inserted = post
        .prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,kind) VALUES (?,?,?,?,?,?)")
        .run("post-mig-bot", "perch", "post-mig-thread", "waiting-user", "interrupted", "perch-live");
      assert.ok(inserted.lastInsertRowid > 0);
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});

// --- Final fix wave (2026-08-16): C3 / I11 / I12 / I13 ---
//
// Builds a data dir whose bot_sessions is back on the OLD narrow control
// CHECK (so the guarded rebuild in scripts/init-db.js fires on the next
// run), matching the setup used by the test above. Callers get the migDir
// path and are responsible for cleanup (rmSync) and further mutation before
// re-running init-db.js.
function buildOldCheckMigDir(prefix) {
  const migDir = mkdtempSync(join(tmpdir(), prefix));
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
        kind              TEXT NOT NULL DEFAULT 'chat',
        narrowed_tools    TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO bot_sessions_old
        (id,bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,
         project_id,card_id,plan_path,status,control,model,escalated,kind,
         narrowed_tools,created_at,updated_at)
        SELECT id,bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,
               project_id,card_id,plan_path,status,control,model,escalated,kind,
               narrowed_tools,created_at,updated_at
        FROM bot_sessions;
      DROP TABLE bot_sessions;
      ALTER TABLE bot_sessions_old RENAME TO bot_sessions;
    `);
    const preSql = pre.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_sessions'"
    ).get().sql;
    assert.ok(
      preSql.includes("CHECK (control IN ('run','stop'))"),
      "test setup sanity: pre-fix CHECK must be the narrow one"
    );
  } finally {
    pre.close();
  }
  return migDir;
}

// C3: a leftover bot_sessions_new (e.g. from a crashed prior run — the
// migration's CREATE TABLE has no IF NOT EXISTS) must make init-db.js FAIL
// LOUDLY — non-zero exit, no silent "Schema generation set to N" — instead of
// the old behavior (catch logs "non-fatal, continuing" with the transaction
// left OPEN, and the script still exits 0 having stamped user_version).
test("C3: leftover bot_sessions_new makes init-db.js fail loudly and NOT stamp user_version", () => {
  const migDir = buildOldCheckMigDir("f3-initdb-c3-");
  try {
    const pre = new Database(join(migDir, "crow.db"));
    let versionBefore;
    try {
      // Simulate a crashed prior run: a leftover bot_sessions_new table.
      pre.exec("CREATE TABLE bot_sessions_new (id INTEGER PRIMARY KEY)");
      // Reset user_version so we can tell whether the failing run re-stamps it.
      pre.pragma("user_version = 0");
      versionBefore = pre.pragma("user_version", { simple: true });
      assert.equal(versionBefore, 0, "test setup sanity");
    } finally {
      pre.close();
    }

    assert.throws(
      () => {
        execFileSync(process.execPath, ["scripts/init-db.js"], {
          env: { ...process.env, CROW_DATA_DIR: migDir },
          stdio: "pipe",
        });
      },
      /Command failed|non-zero/i,
      "init-db.js must exit non-zero when bot_sessions_new already exists"
    );

    const post = new Database(join(migDir, "crow.db"), { readonly: true });
    try {
      const versionAfter = post.pragma("user_version", { simple: true });
      assert.equal(
        versionAfter, 0,
        "a failed migration must NOT stamp PRAGMA user_version — the next run must retry it"
      );
      // The transaction must have been rolled back, not left open: the
      // original (old-CHECK) bot_sessions table must still be intact and
      // queryable, and the leftover bot_sessions_new must still be there
      // untouched (proof nothing partially committed).
      const stillOldCheck = post.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_sessions'"
      ).get().sql;
      assert.ok(stillOldCheck.includes("CHECK (control IN ('run','stop'))"));
      const leftover = post.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_sessions_new'"
      ).get();
      assert.ok(leftover, "leftover bot_sessions_new must survive the rollback");
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});

// C3 (companion): a clean successful rebuild run must still stamp
// user_version to SCHEMA_GENERATION and preserve every row — proves the
// rethrow-on-failure fix didn't turn the happy path into a failure too.
test("C3: a successful bot_sessions rebuild still stamps user_version and preserves rows", () => {
  const migDir = buildOldCheckMigDir("f3-initdb-c3-happy-");
  try {
    const pre = new Database(join(migDir, "crow.db"));
    let seededId;
    try {
      pre.pragma("user_version = 0");
      const info = pre
        .prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,kind) VALUES (?,?,?,?,?,?)")
        .run("happy-path-bot", "perch", "happy-path-thread", "active", "run", "perch-live");
      seededId = info.lastInsertRowid;
    } finally {
      pre.close();
    }

    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });

    const post = new Database(join(migDir, "crow.db"), { readonly: true });
    try {
      const versionAfter = post.pragma("user_version", { simple: true });
      assert.ok(versionAfter > 0, "a successful migration must stamp PRAGMA user_version");
      const row = post.prepare(
        "SELECT bot_id, control FROM bot_sessions WHERE id=?"
      ).get(seededId);
      assert.deepEqual(row, { bot_id: "happy-path-bot", control: "run" });
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});

// I11: index (and trigger) DDL on bot_sessions must be snapshotted from
// sqlite_master and replayed after the rebuild, not hand-listed — a
// hand-listed pair would silently drop any OTHER index/trigger a future
// change adds to this table.
test("I11: a custom index on bot_sessions survives the control-CHECK rebuild", () => {
  const migDir = buildOldCheckMigDir("f3-initdb-i11-");
  try {
    const pre = new Database(join(migDir, "crow.db"));
    try {
      pre.exec("CREATE INDEX idx_bot_sessions_custom_test ON bot_sessions (model)");
    } finally {
      pre.close();
    }

    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });

    const post = new Database(join(migDir, "crow.db"), { readonly: true });
    try {
      const idx = post.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_bot_sessions_custom_test'"
      ).get();
      assert.ok(idx, "a pre-existing custom index on bot_sessions must survive the rebuild");
      // The two standing indexes must also survive.
      const standing = post.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bot_sessions'"
      ).all().map((r) => r.name);
      assert.ok(standing.includes("idx_bot_sessions_bot_thread"));
      assert.ok(standing.includes("idx_bot_sessions_status"));
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});

// I12: the AUTOINCREMENT high-water mark (sqlite_sequence) must survive the
// rebuild. delete-bot.js deletes bot_sessions rows in production; without
// this fix the rebuild resets the sequence to max(id) present, so a stale
// drawer/board reference to a deleted session id can rebind to a brand-new
// unrelated session.
test("I12: sqlite_sequence for bot_sessions survives the control-CHECK rebuild (id reuse prevented)", () => {
  const migDir = buildOldCheckMigDir("f3-initdb-i12-");
  try {
    const pre = new Database(join(migDir, "crow.db"));
    let seqBefore;
    try {
      const ins = pre.prepare(
        "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,kind) VALUES (?,?,?,?,?,?)"
      );
      const ids = [];
      for (let i = 0; i < 5; i++) {
        ids.push(ins.run(`seq-bot-${i}`, "perch", `seq-thread-${i}`, "active", "run", "perch-live").lastInsertRowid);
      }
      // Delete the last 3 — creates a gap between max(id) and the real
      // high-water mark, exactly the delete-bot.js scenario.
      const del = pre.prepare("DELETE FROM bot_sessions WHERE id=?");
      for (const id of ids.slice(2)) del.run(id);

      seqBefore = pre.prepare("SELECT seq FROM sqlite_sequence WHERE name='bot_sessions'").get().seq;
      const maxIdBefore = pre.prepare("SELECT MAX(id) AS m FROM bot_sessions").get().m;
      assert.ok(seqBefore > maxIdBefore, "test setup sanity: sequence must be ahead of max(id)");
    } finally {
      pre.close();
    }

    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: migDir },
      stdio: "pipe",
    });

    const post = new Database(join(migDir, "crow.db"), { readonly: true });
    try {
      const seqAfter = post.prepare("SELECT seq FROM sqlite_sequence WHERE name='bot_sessions'").get().seq;
      assert.ok(
        seqAfter >= seqBefore,
        `sqlite_sequence for bot_sessions must not regress across the rebuild (before=${seqBefore}, after=${seqAfter})`
      );
      // And a freshly inserted row must get an id PAST the old high-water
      // mark, not a reused deleted id.
      const rw = new Database(join(migDir, "crow.db"));
      try {
        const newId = rw.prepare(
          "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,kind) VALUES (?,?,?,?,?,?)"
        ).run("post-mig-seq-bot", "perch", "post-mig-seq-thread", "active", "run", "perch-live").lastInsertRowid;
        assert.ok(newId > seqBefore - 1, "a new row after the rebuild must not reuse a deleted session id");
      } finally {
        rw.close();
      }
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});

// I13: an unrecognized (or missing) column on the live bot_sessions relative
// to the canonical 17-column list must abort the rebuild BEFORE any DDL,
// instead of a fixed column list silently dropping the extra column's data.
test("I13: an unknown column on bot_sessions aborts the rebuild before any DDL", () => {
  const migDir = buildOldCheckMigDir("f3-initdb-i13-");
  try {
    const pre = new Database(join(migDir, "crow.db"));
    try {
      // A host-local column the canonical rebuild list doesn't know about.
      pre.exec("ALTER TABLE bot_sessions ADD COLUMN quirky_host_local_extra TEXT");
      pre.pragma("user_version = 0");
    } finally {
      pre.close();
    }

    assert.throws(
      () => {
        execFileSync(process.execPath, ["scripts/init-db.js"], {
          env: { ...process.env, CROW_DATA_DIR: migDir },
          stdio: "pipe",
        });
      },
      /Command failed|non-zero/i,
      "init-db.js must exit non-zero on an unrecognized bot_sessions column"
    );

    const post = new Database(join(migDir, "crow.db"), { readonly: true });
    try {
      // Aborted BEFORE any DDL: the old (narrow-CHECK) table is untouched,
      // and the unknown column is still there — nothing was silently dropped.
      const cols = post.prepare("PRAGMA table_info(bot_sessions)").all().map((c) => c.name);
      assert.ok(cols.includes("quirky_host_local_extra"), "the unknown column must survive — no DDL ran");
      const sql = post.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_sessions'"
      ).get().sql;
      assert.ok(sql.includes("CHECK (control IN ('run','stop'))"), "the old CHECK must still be in place — the rebuild never ran");
      assert.equal(post.pragma("user_version", { simple: true }), 0, "user_version must not be stamped");
    } finally {
      post.close();
    }
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});
