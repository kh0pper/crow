// 0016-crow-to-crow: project_members.accepted_at + the c2c tables; init-db carries the same DDL.
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
const TABLES = [
  "project_shared_items", "c2c_outbox", "c2c_outbox_seq", "c2c_inbound_seq", "c2c_visits", "c2c_invite_gen",
];

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
  // The columns of the tables the sequencing contract keys on (outbox.js S1/S2): the
  // stream key now carries the epoch on both sides, and a visit its invite generation.
  const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all()
    .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
  const outbox = cols("c2c_outbox");
  const inbound = cols("c2c_inbound_seq");
  const outboxSeq = cols("c2c_outbox_seq");
  const visits = cols("c2c_visits");
  const inviteGen = cols("c2c_invite_gen");
  const streamIdx = d.prepare("SELECT sql FROM sqlite_master WHERE name='idx_c2c_outbox_stream_seq'").get()?.sql;
  d.close();
  return { sql, idx, pm, outbox, inbound, outboxSeq, visits, inviteGen, streamIdx };
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
    // R2/S1: the sender's counter is per (contact, project, epoch, stream).
    assert.deepEqual(s.outboxSeq.map((c) => c.name), ["contact_id", "project_uuid", "epoch", "stream", "next_seq"]);
    assert.deepEqual(
      s.outboxSeq.filter((c) => c.pk).map((c) => c.name).sort(),
      ["contact_id", "epoch", "project_uuid", "stream"],
    );
    // S1: the mark is keyed by the epoch, and there is no stored-epoch field left.
    for (const col of ["epoch", "stream", "high_water"]) assert.ok(s.inbound.some((c) => c.name === col), col);
    assert.deepEqual(
      s.inbound.filter((c) => c.pk).map((c) => c.name).sort(),
      ["contact_id", "epoch", "project_uuid", "sender_instance_id", "stream"],
      "the mark is per (sender instance, project, epoch, stream)",
    );
    const epochCol = s.inbound.find((c) => c.name === "epoch");
    assert.equal(epochCol.notnull, 1, "the epoch is part of the key, not a nullable field");
    // S1: the outbox row carries its epoch, and its uniqueness is per full stream.
    const outboxEpoch = s.outbox.find((c) => c.name === "epoch");
    assert.equal(outboxEpoch.notnull, 1);
    assert.match(s.streamIdx, /contact_id, project_uuid, epoch, COALESCE\(to_instance_id, '\*'\), seq/);
    // S2: a visit remembers the invite generation it came from; the counter is local-only
    // and has no contact foreign key, so a contact delete cannot rewind it.
    const gen = s.visits.find((c) => c.name === "gen");
    assert.deepEqual({ type: gen.type, notnull: gen.notnull, dflt: gen.dflt }, { type: "INTEGER", notnull: 1, dflt: "0" });
    assert.deepEqual(s.inviteGen.map((c) => c.name), ["project_uuid", "next_gen"]);
    assert.deepEqual(s.inviteGen.filter((c) => c.pk).map((c) => c.name), ["project_uuid"]);
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
      assert.deepEqual(mig.outbox, initSchema.outbox, "c2c_outbox columns match");
      assert.deepEqual(mig.inbound, initSchema.inbound, "c2c_inbound_seq columns match");
      assert.deepEqual(mig.outboxSeq, initSchema.outboxSeq, "c2c_outbox_seq columns match");
      assert.deepEqual(mig.visits, initSchema.visits, "c2c_visits columns match");
      assert.deepEqual(mig.inviteGen, initSchema.inviteGen, "c2c_invite_gen columns match");
      assert.deepEqual(mig.streamIdx, initSchema.streamIdx, "the outbox stream index matches");
      assert.ok(initSchema.pm.includes("accepted_at") && mig.pm.includes("accepted_at"));
      // the column definition itself must match too
      const colOf = (p) => { const x = new Database(p); const c = x.prepare("PRAGMA table_info(project_members)").all().find((c) => c.name === "accepted_at"); x.close(); return { type: c.type, notnull: c.notnull, dflt: c.dflt_value }; };
      assert.deepEqual(colOf(dbPath), colOf(join(dir, "crow.db")));
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("c2c tables are local-only", () => {
  for (const t of ["c2c_outbox", "c2c_outbox_seq", "c2c_inbound_seq", "c2c_visits", "c2c_invite_gen"]) {
    assert.ok(LOCAL_ONLY_TABLES.includes(t), t);
  }
  assertLocalOnlyDisjoint(SYNCED_TABLES, LOCAL_ONLY_TABLES);
});

test("id matches the filename", () => assert.equal(id, "0016-crow-to-crow"));
