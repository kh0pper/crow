// 0016-crow-to-crow: project_members.accepted_at + the four c2c tables; init-db carries the same DDL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0016-crow-to-crow.mjs";
import { LOCAL_ONLY_TABLES, SYNCED_TABLES, assertLocalOnlyDisjoint } from "../servers/sharing/instance-sync.js";

const REPO = new URL("..", import.meta.url).pathname;
const TABLES = ["project_shared_items", "c2c_outbox", "c2c_inbound_seq", "c2c_visits"];

/** The pre-0016 shape of the three tables the migration depends on. */
function legacyDb({ rows = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "c2c-mig-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE project_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES project_spaces(id),
      contact_id INTEGER REFERENCES contacts(id), role TEXT NOT NULL, mode TEXT,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT);`);
  if (rows) {
    db.exec("INSERT INTO project_spaces (name) VALUES ('p'); INSERT INTO contacts (name) VALUES ('c');");
    db.exec("INSERT INTO project_members (project_id, contact_id, role, mode) VALUES (1, 1, 'viewer', 'static')");
  }
  db.close();
  return { dir, dbPath };
}

const schemaOf = (dbPath) => {
  const d = new Database(dbPath);
  const sql = Object.fromEntries(TABLES.map((t) => [t, d.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(t)?.sql]));
  const idx = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='project_shared_items' AND sql IS NOT NULL ORDER BY name").all();
  const pm = d.prepare("PRAGMA table_info(project_members)").all().map((c) => c.name).sort();
  d.close();
  return { sql, idx, pm };
};

test("0016 creates every table and column on a fresh DB", () => {
  const { dir, dbPath } = legacyDb();
  try {
    const r = run({ dbPath, log: () => {} });
    assert.equal(r.applied, true);
    const s = schemaOf(dbPath);
    for (const t of TABLES) assert.ok(s.sql[t], `${t} exists`);
    assert.ok(s.pm.includes("accepted_at"));
    assert.equal(s.idx.length, 1);
    assert.match(s.idx[0].sql, /WHERE removed_at IS NULL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0016 is idempotent", () => {
  const { dir, dbPath } = legacyDb();
  try {
    run({ dbPath, log: () => {} });
    const first = schemaOf(dbPath);
    const second = run({ dbPath, log: () => {} });
    assert.equal(second.applied, true);
    assert.deepEqual(second.results, ["no-op"]);
    assert.deepEqual(schemaOf(dbPath), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0016 keeps existing project_members rows and adds accepted_at NULL", () => {
  const { dir, dbPath } = legacyDb({ rows: true });
  try {
    run({ dbPath, log: () => {} });
    const d = new Database(dbPath);
    const row = d.prepare("SELECT role, mode, accepted_at FROM project_members").get();
    d.close();
    assert.deepEqual({ ...row }, { role: "viewer", mode: "static", accepted_at: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0016 defers when its prerequisite tables are absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2c-mig-"));
  try {
    const dbPath = join(dir, "crow.db");
    new Database(dbPath).close();
    assert.equal(run({ dbPath, log: () => {} }).deferred, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init-db and 0016 produce identical schemas", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2c-init-"));
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
    const initSchema = schemaOf(join(dir, "crow.db"));
    // Rebuild via the migration rail: drop the c2c tables and the column's effect by running 0016 on a legacy DB
    const { dir: d2, dbPath } = legacyDb();
    try {
      run({ dbPath, log: () => {} });
      const mig = schemaOf(dbPath);
      assert.deepEqual(mig.sql, initSchema.sql);
      assert.deepEqual(mig.idx, initSchema.idx);
      assert.ok(initSchema.pm.includes("accepted_at") && mig.pm.includes("accepted_at"));
      // the column definition itself must match too
      const colOf = (p) => { const x = new Database(p); const c = x.prepare("PRAGMA table_info(project_members)").all().find((c) => c.name === "accepted_at"); x.close(); return { type: c.type, notnull: c.notnull, dflt: c.dflt_value }; };
      assert.deepEqual(colOf(dbPath), colOf(join(dir, "crow.db")));
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("c2c tables are local-only", () => {
  for (const t of ["c2c_outbox", "c2c_inbound_seq", "c2c_visits"]) assert.ok(LOCAL_ONLY_TABLES.includes(t), t);
  assertLocalOnlyDisjoint(SYNCED_TABLES, LOCAL_ONLY_TABLES);
});

test("id matches the filename", () => assert.equal(id, "0016-crow-to-crow"));
