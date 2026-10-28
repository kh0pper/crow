// 0014-perch-session-files-kind — the rail that adds perch_session_files.kind
// (TEXT NOT NULL DEFAULT 'file') and .turn_anchor (TEXT) to an existing
// instance, so a final browser screenshot can be told apart from a file a bot
// sent with a look-alike name. Additive, no SCHEMA_GENERATION bump; init-db
// carries the same two columns (CREATE body + guarded ALTER) — one shape, two
// rails. And a co-hosted instance that restarts onto the new code BEFORE it
// migrates must still serve chat history (no 500 on "no such column").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0014-perch-session-files-kind.mjs";

const REPO = new URL("..", import.meta.url).pathname;

/** The 0007 shape: the table as every instance has it before this change. */
function legacyDb() {
  const dir = mkdtempSync(join(tmpdir(), "psf-kind-mig-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE perch_session_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    name TEXT NOT NULL, stored TEXT, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0, caption TEXT NOT NULL DEFAULT '',
    servable INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, servable) VALUES ('b','t','x.png',1)").run();
  db.close();
  return { dir, dbPath };
}

const colsOf = (dbPath) => {
  const d = new Database(dbPath);
  const c = d.prepare("PRAGMA table_info(perch_session_files)").all();
  d.close();
  return c;
};

test("0014 adds both columns once (idempotent) and existing rows read kind 'file'", () => {
  const { dir, dbPath } = legacyDb();
  try {
    const first = run({ dbPath, log: () => {} });
    assert.equal(first.applied, true);
    assert.deepEqual(first.results, ["added", "added"]);
    const second = run({ dbPath, log: () => {} });
    assert.deepEqual(second.results, ["no-op", "no-op"], "a second run is a clean no-op");
    const cols = colsOf(dbPath);
    assert.equal(cols.filter((c) => c.name === "kind").length, 1);
    assert.equal(cols.filter((c) => c.name === "turn_anchor").length, 1);
    const kind = cols.find((c) => c.name === "kind");
    assert.equal(kind.notnull, 1);
    assert.equal(kind.dflt_value, "'file'");
    const d = new Database(dbPath);
    const row = d.prepare("SELECT name, kind, turn_anchor FROM perch_session_files").get();
    // the send path's INSERT (no kind column named) keeps working and reads 'file'
    d.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, stored, mime, size, caption, servable) VALUES (?,?,?,?,?,?,?,?)")
      .run("b", "t", "y.png", "y.png", "image/png", 1, "", 1);
    const sent = d.prepare("SELECT kind FROM perch_session_files WHERE name='y.png'").get();
    d.close();
    assert.equal(row.kind, "file");
    assert.equal(row.turn_anchor, null);
    assert.equal(sent.kind, "file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0014 on a store with no perch_session_files table defers (0007 / init-db create it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "psf-kind-mig-"));
  try {
    const dbPath = join(dir, "crow.db");
    new Database(dbPath).close();
    const r = run({ dbPath, log: () => {} });
    assert.equal(r.deferred, true);
    assert.deepEqual(r.results, ["absent", "absent"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the id matches the filename and sorts after 0011", async () => {
  assert.equal(id, "0014-perch-session-files-kind");
  const { discoverMigrations } = await import("../scripts/migrations/runner.mjs");
  const names = discoverMigrations(new URL("../scripts/migrations", import.meta.url).pathname).map((p) => p.split("/").pop());
  assert.ok(names.includes("0014-perch-session-files-kind.mjs"));
  assert.ok(names.indexOf("0011-card-offers.mjs") < names.indexOf("0014-perch-session-files-kind.mjs"));
});

test("the migration body never DROPs or DELETEs", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/migrations/0014-perch-session-files-kind.mjs", import.meta.url), "utf8")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\bDROP\b|\bDELETE\b/i);
});

test("init-db creates them on a fresh db, and re-running it on a legacy table adds them", () => {
  const dir = mkdtempSync(join(tmpdir(), "psf-kind-init-"));
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
    const dbPath = join(dir, "crow.db");
    const d = new Database(dbPath);
    const sql = d.prepare("SELECT sql FROM sqlite_master WHERE name='perch_session_files'").get().sql;
    d.close();
    assert.match(sql, /kind\s+TEXT NOT NULL DEFAULT 'file'/, "the CREATE body carries kind");
    assert.match(sql, /turn_anchor\s+TEXT/, "the CREATE body carries turn_anchor");
    const legacy = legacyDb();
    try {
      execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: legacy.dir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
      const names = colsOf(legacy.dbPath).map((c) => c.name);
      assert.ok(names.includes("kind") && names.includes("turn_anchor"), "init-db's guarded ALTER adds both");
    } finally { rmSync(legacy.dir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a reader on a db without the columns still returns history (co-hosted, pre-migration)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psf-kind-reader-"));
  const saved = { data: process.env.CROW_DATA_DIR, home: process.env.CROW_HOME, db: process.env.CROW_DB_PATH };
  let server;
  try {
    process.env.CROW_DATA_DIR = dir;
    process.env.CROW_HOME = join(dir, "home");
    delete process.env.CROW_DB_PATH;
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
    // Wind the table back to the pre-0014 shape (test-only), as a co-hosted
    // instance that restarted onto this code before migrating carries it.
    const c = new Database(join(dir, "crow.db"));
    c.exec("ALTER TABLE perch_session_files DROP COLUMN kind");
    c.exec("ALTER TABLE perch_session_files DROP COLUMN turn_anchor");
    c.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, stored, mime, size, caption, servable) VALUES (?,?,?,?,?,?,?,?)")
      .run("b1", "perchlive-old", "old.png", null, "image/png", 3, "", 0);
    c.close();

    const { default: express } = await import("express");
    const { default: router } = await import("../servers/gateway/routes/perch-interactive-api.js");
    const app = express();
    app.use(express.json());
    app.use(router((req, res, next) => next(), {
      engine: () => ({ async get(sid) { return { sessionId: sid, botId: "b1", threadId: sid, outputsDir: null }; } }),
      annotate: async (m) => m, providerModels: () => [], piProviders: () => null,
    }));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    const r = await fetch("http://127.0.0.1:" + server.address().port + "/dashboard/perch-api/interactive/perchlive-old/files/history");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.items.map((i) => i.name), ["old.png"]);
    assert.equal(body.items[0].kind, "file", "a pre-migration row is a sent file");
    assert.deepEqual(body.browserShots, []);
  } finally {
    if (server) { server.closeAllConnections(); server.close(); }
    for (const [k, v] of [["CROW_DATA_DIR", saved.data], ["CROW_HOME", saved.home], ["CROW_DB_PATH", saved.db]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
