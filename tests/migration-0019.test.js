// 0019-project-services: service_connections, crow_keychain.connection_uuid (+ its service index),
// chat_conversations.project_id and bot_jobs.principal, on both rails (init-db and the numbered
// migration) plus the two lazy ensures (keychain, bot_jobs). Additive, no SCHEMA_GENERATION bump.
// Scratch DBs only; never touches ~/.crow.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "m0019-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const mod = await import("../scripts/migrations/0019-project-services.mjs");
const { discoverMigrations, runMigrations } = await import("../scripts/migrations/runner.mjs");
const S = await import("../servers/shared/project-services-schema.js");
const SYNC = await import("../servers/sharing/instance-sync.js");
const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const BJ = await import("../scripts/pi-bots/bot-jobs-schema.mjs");
const { SCHEMA_GENERATION } = await import("../servers/shared/schema-version.js");

const REPO = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(REPO, "scripts", "migrations");
const dirs = [process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SC_COLS = ["id", "uuid", "project_id", "owner_contact_id", "service_id", "bundle_id", "method",
  "account_label", "label_slug", "config", "status", "source_connection_id", "last_tested_at",
  "last_error", "created_at", "updated_at"];
const SC_INDEXES = ["idx_service_connections_bundle", "idx_service_connections_project", "idx_service_connections_slug"];

const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const objects = (d, tbl) => d.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name=? ORDER BY name").all(tbl);

// The gen-9 shapes, before 0019.
const OLD_PROJECT_SPACES = "CREATE TABLE project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT)";
const OLD_CHAT = `CREATE TABLE chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
    profile_id TEXT DEFAULT NULL, system_prompt TEXT, total_tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`;
const OLD_KEYCHAIN = `
  CREATE TABLE IF NOT EXISTS crow_keychain (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL,
    label            TEXT NOT NULL,
    bundle_id        TEXT,
    env_key          TEXT,
    username         TEXT,
    url              TEXT,
    secret_sealed    TEXT NOT NULL,
    key_id           TEXT NOT NULL,
    origin           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',
    first_view_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_keychain_ext
    ON crow_keychain (bundle_id, env_key) WHERE kind = 'extension';
`;
const OLD_BOT_JOBS = `CREATE TABLE bot_jobs (
    job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
    schedule_id INTEGER, card_id INTEGER, card_action TEXT, escalate INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER,
    claimed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, ended_at TEXT)`;
const KC_ROW = `INSERT INTO crow_keychain (kind, label, bundle_id, env_key, secret_sealed, key_id, origin)
                VALUES ('extension', 'Gitea token', 'gitea', 'GITEA_TOKEN', 'sealed-x', 'k1', 'typed')`;

function oldShapeDb() {
  const dbPath = join(tmp("m0019-old-"), "crow.db");
  const d = new Database(dbPath);
  d.exec(OLD_PROJECT_SPACES);
  d.exec(OLD_CHAT);
  d.exec(OLD_KEYCHAIN);
  d.exec(OLD_BOT_JOBS);
  d.prepare("INSERT INTO project_spaces (slug, name) VALUES ('p1', 'One')").run();
  d.exec(KC_ROW);
  d.prepare("INSERT INTO chat_conversations (title, provider, model) VALUES ('t', 'p', 'm')").run();
  d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal) VALUES ('j1', 'b1', 'g')").run();
  d.close();
  return dbPath;
}

function initDb() {
  const dir = tmp("m0019-init-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  return join(dir, "crow.db");
}

test("the module id matches its filename, and the generation stays 9", () => {
  assert.equal(mod.id, "0019-project-services");
  assert.ok(discoverMigrations(MIGRATIONS).some((p) => p.endsWith("/0019-project-services.mjs")));
  assert.equal(SCHEMA_GENERATION, 9);
});

test("fresh init-db has the shape", () => {
  const p = initDb();
  const d = new Database(p, { readonly: true });
  try {
    assert.deepEqual(cols(d, "service_connections"), SC_COLS);
    assert.ok(cols(d, "chat_conversations").includes("project_id"));
    assert.ok(cols(d, "crow_keychain").includes("connection_uuid"));
    assert.ok(cols(d, "bot_jobs").includes("principal"));
    const idx = d.prepare("PRAGMA index_list(service_connections)").all();
    for (const n of SC_INDEXES) assert.ok(idx.some((i) => i.name === n), n);
    const slug = idx.find((i) => i.name === "idx_service_connections_slug");
    assert.equal(slug.unique, 1);
    assert.equal(slug.partial, 1);
    const kc = d.prepare("PRAGMA index_list(crow_keychain)").all().find((i) => i.name === "idx_crow_keychain_service");
    assert.ok(kc && kc.unique === 1 && kc.partial === 1, "the keychain service index is unique and partial");
    const fk = d.prepare("PRAGMA foreign_key_list(service_connections)").all();
    assert.deepEqual(fk.map((f) => [f.table, f.from, f.to, f.on_delete]), [["project_spaces", "project_id", "id", "CASCADE"]]);
  } finally {
    d.close();
  }
});

test("init-db is a no-op when run a second time", () => {
  const dir = tmp("m0019-init2-");
  const env = { ...process.env, CROW_DATA_DIR: dir };
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, stdio: "pipe", cwd: REPO });
  const snap = () => { const d = new Database(join(dir, "crow.db"), { readonly: true }); const o = d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('service_connections','crow_keychain','chat_conversations','bot_jobs') ORDER BY name").all(); d.close(); return o; };
  const first = snap();
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, stdio: "pipe", cwd: REPO });
  assert.deepEqual(snap(), first);
});

test("the migration's tables and indexes match what init-db produces", () => {
  const want = new Database(initDb(), { readonly: true });
  const p = oldShapeDb();
  assert.equal(mod.run({ dbPath: p }).applied, true);
  const got = new Database(p, { readonly: true });
  try {
    assert.deepEqual(objects(got, "service_connections"), objects(want, "service_connections"));
    const kcIdx = (d) => d.prepare("SELECT sql FROM sqlite_master WHERE name='idx_crow_keychain_service'").get();
    assert.deepEqual(kcIdx(got), kcIdx(want));
    for (const [t, c] of [["chat_conversations", "project_id"], ["crow_keychain", "connection_uuid"], ["bot_jobs", "principal"]]) {
      const info = (d) => d.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === c);
      const { cid: _a, ...g } = info(got);
      const { cid: _b, ...w } = info(want);
      assert.deepEqual(g, w, `${t}.${c}`);
    }
  } finally {
    got.close();
    want.close();
  }
});

test("migration on an old shape: columns added, rows intact, a second run changes nothing", () => {
  const p = oldShapeDb();
  const r1 = mod.run({ dbPath: p });
  assert.equal(r1.applied, true);
  assert.deepEqual(r1.results, [
    "service_connections: ensured",
    "chat_conversations.project_id: added",
    "crow_keychain.connection_uuid: added",
    "bot_jobs.principal: added",
    "idx_crow_keychain_service: ensured",
  ]);
  const snap = () => {
    const d = new Database(p, { readonly: true });
    const o = {
      schema: d.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      kc: d.prepare("SELECT * FROM crow_keychain").all(),
      chat: d.prepare("SELECT * FROM chat_conversations").all(),
      jobs: d.prepare("SELECT * FROM bot_jobs").all(),
    };
    d.close();
    return o;
  };
  const s1 = snap();
  assert.equal(s1.kc.length, 1);
  assert.equal(s1.kc[0].label, "Gitea token");
  assert.equal(s1.kc[0].secret_sealed, "sealed-x");
  assert.equal(s1.kc[0].connection_uuid, null);
  assert.equal(s1.chat[0].project_id, null, "no backfill");
  assert.equal(s1.jobs[0].principal, null, "old jobs fail closed");
  const r2 = mod.run({ dbPath: p });
  assert.equal(r2.applied, true);
  assert.deepEqual(r2.results.filter((r) => r.includes(".")), [
    "chat_conversations.project_id: no-op",
    "crow_keychain.connection_uuid: no-op",
    "bot_jobs.principal: no-op",
  ]);
  assert.deepEqual(snap(), s1);
});

test("absent keychain and bot_jobs tables are left absent", () => {
  const p = join(tmp("m0019-abs-"), "crow.db");
  const d = new Database(p);
  d.exec(OLD_PROJECT_SPACES);
  d.close();
  const r = mod.run({ dbPath: p });
  assert.equal(r.applied, true);
  assert.ok(r.results.includes("crow_keychain.connection_uuid: absent"));
  assert.ok(r.results.includes("bot_jobs.principal: absent"));
  assert.ok(r.results.includes("chat_conversations.project_id: absent"));
  const d2 = new Database(p, { readonly: true });
  const names = d2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x) => x.name);
  d2.close();
  assert.deepEqual(names, ["project_spaces", "service_connections"]);
});

test("defers without projects", async () => {
  const p = join(tmp("m0019-def-"), "crow.db");
  new Database(p).close();
  assert.deepEqual(mod.run({ dbPath: p }), { deferred: true });
  const out = await runMigrations({ migrationsDir: MIGRATIONS, dbPath: p, tasksDbPath: join(tmp("m0019-tasks-"), "tasks.db") });
  assert.ok(out.deferred.includes("0019-project-services"));
  const d = new Database(p, { readonly: true });
  try {
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='0019-project-services'").get().n, 0);
    assert.equal(d.prepare("SELECT 1 FROM sqlite_master WHERE name='service_connections'").get(), undefined);
  } finally {
    d.close();
  }
});

function insertConn(d, { uuid, owner = null, slug = "work", status = "active", project = 1, service = "github" }) {
  d.prepare(`INSERT INTO service_connections (uuid, project_id, owner_contact_id, service_id, method, account_label, label_slug, status)
             VALUES (?, ?, ?, ?, 'token', 'Work', ?, ?)`).run(uuid, project, owner, service, slug, status);
}

test("null owner unique: two project-wide rows with one slug collide", () => {
  const d = new Database(oldShapeDb());
  try {
    mod.run({ dbPath: d.name });
    insertConn(d, { uuid: "u1" });
    assert.throws(() => insertConn(d, { uuid: "u2" }), /UNIQUE/);
    // A named owner is a separate namespace from project-wide (NULL) rows.
    insertConn(d, { uuid: "u3", owner: 7 });
    assert.throws(() => insertConn(d, { uuid: "u4", owner: 7 }), /UNIQUE/);
  } finally {
    d.close();
  }
});

test("slug unique: a disconnected row frees its slug", () => {
  const d = new Database(oldShapeDb());
  try {
    mod.run({ dbPath: d.name });
    insertConn(d, { uuid: "u1", status: "disconnected" });
    insertConn(d, { uuid: "u2" });
    assert.throws(() => insertConn(d, { uuid: "u3" }), /UNIQUE/);
    insertConn(d, { uuid: "u4", slug: "personal" });
    insertConn(d, { uuid: "u5", service: "gitea" });
    assert.throws(() => insertConn(d, { uuid: "u2", slug: "other" }), /UNIQUE/, "uuid is unique");
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM service_connections").get().n, 4);
  } finally {
    d.close();
  }
});

test("a deleted project cascades its connections away (foreign keys on)", () => {
  const d = new Database(initDb());
  try {
    d.pragma("foreign_keys = ON");
    const pid = d.prepare("INSERT INTO project_spaces (slug, name, type, workspace_dir, storage_prefix) VALUES ('svc-x', 'X', 'project', '/tmp/x', 'x/')").run().lastInsertRowid;
    insertConn(d, { uuid: "c1", project: pid });
    d.prepare("DELETE FROM project_spaces WHERE id = ?").run(pid);
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM service_connections").get().n, 0);
  } finally {
    d.close();
  }
});

test("local only", () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("service_connections"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("service_connections"));
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", "service_connections"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
});

test("keychain ensure on an old table adds connection_uuid and the service index", async () => {
  const p = join(tmp("m0019-kc-"), "crow.db");
  const d = new Database(p);
  d.exec(OLD_KEYCHAIN);
  d.exec(KC_ROW);
  d.close();
  const db = createDbClient(p);
  try {
    await K.ensureKeychainTable(db);
    const c = (await db.execute("PRAGMA table_info(crow_keychain)")).rows.map((r) => r.name);
    assert.ok(c.includes("connection_uuid"));
    assert.ok((await db.execute("SELECT 1 FROM sqlite_master WHERE name='idx_crow_keychain_service'")).rows.length);
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM crow_keychain")).rows[0].n), 1);
    // The index holds: one secret per (connection, env_key) for kind 'service'.
    const ins = `INSERT INTO crow_keychain (kind, label, env_key, secret_sealed, key_id, origin, connection_uuid)
                 VALUES ('service', 'gh', 'GITHUB_TOKEN', 's', 'k1', 'typed', 'conn-1')`;
    await db.execute(ins);
    await assert.rejects(db.execute(ins), /UNIQUE/);
  } finally {
    db.close();
  }
  // A fresh libsql DB: the column comes from KEYCHAIN_DDL, and a second ensure on a new client is a no-op.
  const p2 = join(tmp("m0019-kc2-"), "crow.db");
  for (let i = 0; i < 2; i++) {
    const db2 = createDbClient(p2);
    try {
      await K.ensureKeychainTable(db2);
      const c = (await db2.execute("PRAGMA table_info(crow_keychain)")).rows.map((r) => r.name);
      assert.equal(c.filter((n) => n === "connection_uuid").length, 1);
      assert.equal(c.at(-1), "connection_uuid", "last column, same as an ALTERed table");
    } finally {
      db2.close();
    }
  }
});

test("bot_jobs ensure on an old table adds principal", () => {
  const p = join(tmp("m0019-bj-"), "crow.db");
  const d = new Database(p);
  try {
    d.exec(OLD_BOT_JOBS);
    const stmts = BJ.missingBotJobsColumns(cols(d, "bot_jobs"));
    assert.deepEqual(stmts, [S.BOT_JOBS_PRINCIPAL_COLUMN.ddl]);
    for (const s of stmts) d.exec(s);
    d.exec(BJ.BOT_JOBS_DDL);
    assert.ok(cols(d, "bot_jobs").includes("principal"));
    assert.deepEqual(BJ.missingBotJobsColumns(cols(d, "bot_jobs")), []);
  } finally {
    d.close();
  }
  const f = new Database(":memory:");
  f.exec(BJ.BOT_JOBS_DDL);
  assert.equal(cols(f, "bot_jobs").at(-1), "principal", "fresh DDL carries it, last");
  assert.deepEqual(BJ.missingBotJobsColumns(cols(f, "bot_jobs")), []);
  f.close();
});

test("both rails build from the one module, and the migration never drops or deletes", () => {
  const init = readFileSync(join(REPO, "scripts/init-db.js"), "utf8");
  assert.match(init, /await initTable\("service_connections table", SERVICE_CONNECTIONS_DDL\);/);
  assert.match(init, /await ensureSchemaColumn\(CHAT_PROJECT_COLUMN\);/);
  assert.match(init, /await ensureSchemaColumn\(KEYCHAIN_CONNECTION_COLUMN\);/);
  assert.match(init, /await initTable\("crow_keychain service index", KEYCHAIN_SERVICE_INDEX_DDL\);/);
  const src = readFileSync(join(REPO, "scripts/migrations/0019-project-services.mjs"), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  assert.doesNotMatch(S.SERVICE_CONNECTIONS_DDL, /CHECK/);
  assert.doesNotMatch(S.SERVICE_CONNECTIONS_DDL, /REFERENCES contacts/);
});
