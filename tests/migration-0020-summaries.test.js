// 0020-session-summaries — the rail that adds bot_sessions.summary /
// .summary_at / .summary_flags (+ idx_bot_sessions_summary_at) and
// memories.project_uuid to an existing instance. Additive, no
// SCHEMA_GENERATION bump; init-db.js and init-pi-bots.mjs carry the same
// columns — one shape, three rails, asserted equal here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0020-session-summaries.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const SUMMARY_COLS = ["summary", "summary_at", "summary_flags", "briefing", "briefing_rank"];

/** The pre-0020 shape: bot_sessions as 0006 leaves it, memories with project_id. */
function legacyDb({ sessions = true, memories = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mig-0020-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  if (sessions) {
    db.exec(`CREATE TABLE bot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, pi_session_id TEXT, pi_session_dir TEXT,
      gateway_type TEXT, gateway_thread_id TEXT, project_id INTEGER, card_id INTEGER, plan_path TEXT,
      status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run', model TEXT, cwd TEXT,
      escalated INTEGER DEFAULT 0, kind TEXT NOT NULL DEFAULT 'chat', narrowed_tools TEXT, label TEXT,
      archived_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
    db.prepare("INSERT INTO bot_sessions (bot_id, gateway_thread_id, kind, status) VALUES ('b','perchlive-x','perch-live','done')").run();
  }
  if (memories) {
    db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general', source TEXT, project_id INTEGER DEFAULT NULL)`);
    db.prepare("INSERT INTO memories (content, project_id) VALUES ('old', 3)").run();
  }
  db.close();
  return { dir, dbPath };
}

/** {name: {type, notnull, dflt_value}} for the given columns. */
function shape(dbPath, table, names) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const out = {};
    for (const c of d.prepare(`PRAGMA table_info(${table})`).all()) {
      if (names.includes(c.name)) out[c.name] = { type: c.type, notnull: c.notnull, dflt_value: c.dflt_value };
    }
    return out;
  } finally { d.close(); }
}

function indexCols(dbPath, name) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const idx = d.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(name);
    if (!idx) return null;
    return { table: idx.tbl_name, cols: d.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name) };
  } finally { d.close(); }
}

const EXPECTED_SESSION_SHAPE = {
  summary: { type: "TEXT", notnull: 0, dflt_value: null },
  summary_at: { type: "TEXT", notnull: 0, dflt_value: null },
  summary_flags: { type: "TEXT", notnull: 0, dflt_value: null },
  briefing: { type: "TEXT", notnull: 0, dflt_value: null },
  briefing_rank: { type: "TEXT", notnull: 0, dflt_value: null },
};

test("0020 adds the columns on every rail, idempotent, deferred when tables are absent", () => {
  const { dir, dbPath } = legacyDb();
  try {
    const first = run({ dbPath, log: () => {} });
    assert.equal(first.applied, true);
    assert.deepEqual(first.results, ["added", "added", "added", "added", "added", "added"]);
    const second = run({ dbPath, log: () => {} });
    assert.equal(second.applied, true);
    assert.deepEqual(second.results, ["no-op", "no-op", "no-op", "no-op", "no-op", "no-op"], "a second run is a clean no-op");
    assert.deepEqual(shape(dbPath, "bot_sessions", SUMMARY_COLS), EXPECTED_SESSION_SHAPE);
    assert.deepEqual(shape(dbPath, "memories", ["project_uuid"]), { project_uuid: { type: "TEXT", notnull: 0, dflt_value: null } });
    assert.deepEqual(indexCols(dbPath, "idx_bot_sessions_summary_at"), { table: "bot_sessions", cols: ["summary_at"] });
    // Existing rows survive with NULLs: no summary yet, project_uuid unset, project_id untouched.
    const d = new Database(dbPath, { readonly: true });
    const s = d.prepare("SELECT bot_id, summary, summary_at, summary_flags FROM bot_sessions").get();
    const m = d.prepare("SELECT content, project_id, project_uuid FROM memories").get();
    d.close();
    assert.deepEqual({ ...s }, { bot_id: "b", summary: null, summary_at: null, summary_flags: null });
    assert.deepEqual({ ...m }, { content: "old", project_id: 3, project_uuid: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }

  for (const absent of [{ sessions: false }, { memories: false }, { sessions: false, memories: false }]) {
    const fx = legacyDb(absent);
    try {
      const r = run({ dbPath: fx.dbPath, log: () => {} });
      assert.equal(r.deferred, true, `deferred when ${JSON.stringify(absent)}`);
      assert.ok(r.results.includes("absent"));
      assert.equal(r.applied, undefined, "a deferral is not recorded as applied");
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  }
});

test("the id matches the filename, sorts last, and the body never DROPs or DELETEs", async () => {
  assert.equal(id, "0020-session-summaries");
  const { discoverMigrations } = await import("../scripts/migrations/runner.mjs");
  const names = discoverMigrations(new URL("../scripts/migrations", import.meta.url).pathname).map((p) => p.split("/").pop());
  assert.ok(names.includes("0020-session-summaries.mjs"));
  assert.ok(names.indexOf("0015-research-note-withdrawal.mjs") < names.indexOf("0020-session-summaries.mjs"));
  const src = readFileSync(new URL("../scripts/migrations/0020-session-summaries.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\bDROP\b|\bDELETE\b/i);
});

test("the runner records 0020 once the tables exist, and keeps retrying while they do not", async () => {
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  const migrationsDir = new URL("../scripts/migrations", import.meta.url).pathname;
  const fx = legacyDb({ sessions: false });
  try {
    const tasksDbPath = join(fx.dir, "tasks.db");
    const r1 = await runMigrations({ migrationsDir, dbPath: fx.dbPath, tasksDbPath });
    assert.ok(r1.deferred.includes("0020-session-summaries"));
    const d = new Database(fx.dbPath);
    d.exec("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL)");
    d.close();
    const r2 = await runMigrations({ migrationsDir, dbPath: fx.dbPath, tasksDbPath });
    assert.ok(r2.applied.includes("0020-session-summaries"), "applied on the boot after the table appears");
    assert.deepEqual(shape(fx.dbPath, "bot_sessions", SUMMARY_COLS), EXPECTED_SESSION_SHAPE);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("init-db, init-pi-bots and 0020 agree", () => {
  const fresh = mkdtempSync(join(tmpdir(), "mig-0020-initdb-"));
  const legacy = legacyDb();
  const mpa = mkdtempSync(join(tmpdir(), "mig-0020-pibots-"));
  try {
    // Rail 1: init-db on a fresh data dir (CREATE body + guarded ALTERs).
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: fresh, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
    const freshDb = join(fresh, "crow.db");
    // Rail 2: 0020 on a legacy store.
    run({ dbPath: legacy.dbPath, log: () => {} });
    // Rail 3: init-pi-bots on a scratch MPA-shaped store (its guard needs a bot_registry row).
    const mpaDb = join(mpa, "crow.db");
    const seed = new Database(mpaDb);
    seed.exec("CREATE TABLE bot_registry (id INTEGER PRIMARY KEY)");
    seed.prepare("INSERT INTO bot_registry DEFAULT VALUES").run();
    seed.close();
    execFileSync(process.execPath, ["scripts/init-pi-bots.mjs"], { env: { ...process.env, CROW_DB_PATH: mpaDb }, stdio: "pipe", cwd: REPO });
    // And a second init-pi-bots run is a clean no-op.
    execFileSync(process.execPath, ["scripts/init-pi-bots.mjs"], { env: { ...process.env, CROW_DB_PATH: mpaDb }, stdio: "pipe", cwd: REPO });

    for (const [label, p] of [["init-db", freshDb], ["0020", legacy.dbPath], ["init-pi-bots", mpaDb]]) {
      assert.deepEqual(shape(p, "bot_sessions", SUMMARY_COLS), EXPECTED_SESSION_SHAPE, `${label}: bot_sessions summary columns`);
      assert.deepEqual(indexCols(p, "idx_bot_sessions_summary_at"), { table: "bot_sessions", cols: ["summary_at"] }, `${label}: summary_at index`);
    }
    // The one-summary-per-session unique partial index: one shape on both rails.
    const idxSql = (p) => { const d = new Database(p, { readonly: true }); try { return d.prepare("SELECT sql FROM sqlite_master WHERE name='idx_memories_session_summary_source'").get()?.sql || null; } finally { d.close(); } };
    assert.equal(idxSql(freshDb), "CREATE UNIQUE INDEX idx_memories_session_summary_source ON memories(source) WHERE source LIKE 'session-summary:%'");
    assert.equal(idxSql(legacy.dbPath), idxSql(freshDb), "0020 and init-db create the same index");
    // memories is init-db's (init-pi-bots never owned it): init-db and 0020 agree.
    assert.deepEqual(shape(freshDb, "memories", ["project_uuid"]), shape(legacy.dbPath, "memories", ["project_uuid"]));
    assert.deepEqual(shape(freshDb, "memories", ["project_uuid"]), { project_uuid: { type: "TEXT", notnull: 0, dflt_value: null } });
    // init-db's CREATE body carries the bot_sessions columns (fresh installs).
    const d = new Database(freshDb, { readonly: true });
    const sql = d.prepare("SELECT sql FROM sqlite_master WHERE name='bot_sessions'").get().sql;
    d.close();
    for (const c of SUMMARY_COLS) assert.match(sql, new RegExp(`\\b${c}\\s+TEXT`), `CREATE body carries ${c}`);

    // init-db's guarded ALTERs converge a pre-0020 store too: wind a full
    // init-db store back to the pre-0020 shape (test-only), then re-run init-db.
    const wound = new Database(freshDb);
    wound.exec("DROP INDEX idx_bot_sessions_summary_at");
    for (const c of SUMMARY_COLS) wound.exec(`ALTER TABLE bot_sessions DROP COLUMN ${c}`);
    wound.exec("ALTER TABLE memories DROP COLUMN project_uuid");
    wound.exec("DROP INDEX idx_memories_session_summary_source");
    wound.close();
    assert.deepEqual(shape(freshDb, "bot_sessions", SUMMARY_COLS), {}, "test setup: wound back");
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: fresh, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
    assert.deepEqual(shape(freshDb, "bot_sessions", SUMMARY_COLS), EXPECTED_SESSION_SHAPE);
    assert.deepEqual(indexCols(freshDb, "idx_bot_sessions_summary_at"), { table: "bot_sessions", cols: ["summary_at"] });
    assert.deepEqual(shape(freshDb, "memories", ["project_uuid"]), { project_uuid: { type: "TEXT", notnull: 0, dflt_value: null } });
    assert.ok(idxSql(freshDb), "init-db re-creates the summary source index");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(legacy.dir, { recursive: true, force: true });
    rmSync(mpa, { recursive: true, force: true });
  }
});
