// Crow Messages' draft tables on both rails — init-db.js's "message draft tables" block and its own
// numbered migration, both built from MESSAGE_DRAFTS_DDL (servers/shared/message-drafts-schema.js).
// DDL only; additive, no SCHEMA_GENERATION bump. Both tables are local-only: a draft holds who a
// message is for and the words of it, so it never replicates to a paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0036-message-drafts.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { MESSAGE_DRAFTS_DDL, MESSAGE_DRAFT_TABLES } from "../servers/shared/message-drafts-schema.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";

const { run, id } = mod;
const REPO = new URL("..", import.meta.url).pathname;
const SYNC = await import("../servers/sharing/instance-sync.js");

const MIGRATIONS = discoverMigrations(join(REPO, "scripts", "migrations"));

const DIRS = [];
after(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  DIRS.push(dir);
  return dir;
}

function freshDb(prefix) {
  const dbPath = join(tmp(prefix), "crow.db");
  new Database(dbPath).close();
  return dbPath;
}

/** The DB scripts/init-db.js builds on its own rail, in a throwaway data dir. */
let initDir = null;
function initDbDir() {
  if (!initDir) {
    initDir = tmp("message-drafts-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

function tableNames(dbPath, like) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ORDER BY name")
      .all(like).map((r) => r.name);
  } finally {
    d.close();
  }
}

/** Every sqlite_master object in the database, as a comparable {type, name} list. */
function shapes(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all();
  } finally {
    d.close();
  }
}

/** Every sqlite_master object that belongs to one table: the table, its autoindex and its indexes. */
function tableObjects(dbPath, table) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name = ? OR tbl_name = ?
       ORDER BY type, name`,
    ).all(table, table);
  } finally {
    d.close();
  }
}

function tableInfo(dbPath, table) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all()
      .map((c) => ({
        name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
      }));
  } finally {
    d.close();
  }
}

function column(name, type, { notnull = 0, dflt_value = null, pk = 0 } = {}) {
  return { name, type, notnull, dflt_value, pk };
}

// The two tables' columns, in declaration order, from the schema constant.
const DRAFTS_COLUMNS = [
  column("id", "TEXT", { pk: 1 }),
  column("conversation_kind", "TEXT", { notnull: 1 }),
  column("conversation_id", "INTEGER", { notnull: 1 }),
  column("origin", "TEXT", { notnull: 1 }),
  column("bot_id", "TEXT"),
  column("bot_name", "TEXT"),
  column("project_id", "INTEGER"),
  column("state", "TEXT", { notnull: 1, dflt_value: "'open'" }),
  column("version", "INTEGER", { notnull: 1, dflt_value: "1" }),
  column("body", "TEXT", { notnull: 1, dflt_value: "''" }),
  column("body_hash", "TEXT", { notnull: 1 }),
  column("recipients_json", "TEXT", { notnull: 1, dflt_value: "'[]'" }),
  column("recipients_seal", "TEXT", { notnull: 1 }),
  column("sent_at", "INTEGER"),
  column("sent_message_id", "TEXT"),
  column("fail_reason", "TEXT"),
  column("created_at", "INTEGER", { notnull: 1 }),
  column("updated_at", "INTEGER", { notnull: 1 }),
];

const AUDIT_COLUMNS = [
  column("id", "INTEGER", { pk: 1 }),
  column("draft_id", "TEXT", { notnull: 1 }),
  column("action", "TEXT", { notnull: 1 }),
  column("actor", "TEXT", { notnull: 1 }),
  column("actor_id", "TEXT"),
  column("version", "INTEGER", { notnull: 1 }),
  column("body_hash", "TEXT", { notnull: 1 }),
  column("recipients_seal", "TEXT", { notnull: 1 }),
  column("at", "INTEGER", { notnull: 1 }),
];

const SEEDED = `
  INSERT INTO message_drafts
    (id, conversation_kind, conversation_id, origin, bot_id, state, version, body, body_hash,
     recipients_json, recipients_seal, created_at, updated_at)
  VALUES ('msgd-0123456789abcdef', 'contact', 7, 'bot', 'bird', 'open', 2, 'Hello there',
          'hash-of-the-body', '["crow:peer"]', 'seal', 1, 2);
`;

test("message draft tables exist after init-db", () => {
  const dbPath = join(initDbDir(), "crow.db");
  assert.deepEqual(tableNames(dbPath, "message_draft%"), [...MESSAGE_DRAFT_TABLES].sort(),
    "init-db creates exactly the two draft tables");

  assert.deepEqual(tableInfo(dbPath, "message_drafts"), DRAFTS_COLUMNS,
    "message_drafts is exactly the schema constant's columns: names, types, NOT NULLs, defaults, key");
  assert.deepEqual(tableInfo(dbPath, "message_draft_audit"), AUDIT_COLUMNS,
    "message_draft_audit is exactly the schema constant's columns");

  const objects = tableObjects(dbPath, "message_drafts");
  const names = objects.map((o) => o.name);
  for (const name of ["idx_message_drafts_open", "idx_message_drafts_conversation", "idx_message_drafts_state"]) {
    assert.ok(names.includes(name), `init-db created index ${name}`);
  }
  const openIndex = objects.find((o) => o.name === "idx_message_drafts_open");
  assert.match(openIndex.sql, /CREATE UNIQUE INDEX/i, "the open-draft index is unique");
  assert.match(openIndex.sql, /WHERE state = 'open'/, "and partial: only open drafts share a conversation");

  const auditObjects = tableObjects(dbPath, "message_draft_audit").map((o) => o.name);
  assert.ok(auditObjects.includes("idx_message_draft_audit_draft"), "the audit trail is indexed by draft");
});

test("at most one OPEN draft per conversation, enforced by the partial unique index", () => {
  const dbPath = freshDb("message-drafts-open-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    db.exec(SEEDED);
    // A second OPEN draft for the same conversation collides.
    assert.throws(() => db.exec(SEEDED.replace("msgd-0123456789abcdef", "msgd-fedcba9876543210")),
      /UNIQUE|constraint/i, "one open draft per conversation");
    // A different conversation is free.
    db.exec(SEEDED.replace("msgd-0123456789abcdef", "msgd-fedcba9876543210").replace("'contact', 7", "'contact', 8"));
    // The closed states do not collide: a discarded row keeps its history beside the open one.
    db.exec(SEEDED
      .replace("msgd-0123456789abcdef", "msgd-1111111111111111")
      .replace("'open', 2", "'discarded', 2"));
    db.exec(SEEDED
      .replace("msgd-0123456789abcdef", "msgd-2222222222222222")
      .replace("'open', 2", "'sent', 2"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM message_drafts WHERE state = 'open'").get().n, 2,
      "two conversations, two open drafts, plus the closed history");
  } finally {
    db.close();
  }
});

test("message draft tables are local-only and neither is synced", () => {
  for (const t of MESSAGE_DRAFT_TABLES) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
    assert.equal(SYNC.shouldSyncRowForTest(t, { id: "msgd-0123456789abcdef" }), false, `${t} never replicates`);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["message_drafts"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
});

test("the draft migration is additive and idempotent on a fresh DB", () => {
  const dbPath = freshDb("message-drafts-idem-");

  const r1 = run({ dbPath, log: () => {} });
  const after1 = tableObjects(dbPath, "message_drafts");
  const firstShape = shapes(dbPath);

  const db = new Database(dbPath);
  try {
    db.exec(SEEDED);
  } finally { db.close(); }

  const lines = [];
  const r2 = run({ dbPath, log: (m) => lines.push(m) });

  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true, "a second run is not an error");
  assert.equal(mod.rollbackSafe, true, "older code never reads these tables");
  assert.ok(lines.length > 0 && lines.every((l) => l.includes("ensured")),
    "the second run reports every table as ensured");

  const kept = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(shapes(dbPath), firstShape, "a second run creates nothing new: no table, index or trigger");
    assert.deepEqual(kept.prepare("SELECT id, state, version, body_hash FROM message_drafts").get(),
      { id: "msgd-0123456789abcdef", state: "open", version: 2, body_hash: "hash-of-the-body" },
      "the second run leaves the row alone");
  } finally { kept.close(); }
  assert.deepEqual(tableObjects(dbPath, "message_drafts"), after1, "the table and its indexes are unchanged");
});

test("an EXISTING DB without the tables gets them, and nothing else is touched", () => {
  // A live install upgrading from before this PR: crow.db has been initialized, has real rows, and
  // has neither draft table. The registry is what brings the tables to such an instance.
  const dbPath = freshDb("message-drafts-existing-");
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)");
    db.prepare("INSERT INTO memories (content) VALUES ('a memory worth keeping')").run();
  } finally { db.close(); }

  const lines = [];
  const out = run({ dbPath, log: (m) => lines.push(m) });
  assert.equal(out.applied, true);
  assert.deepEqual(tableNames(dbPath, "message_draft%"), [...MESSAGE_DRAFT_TABLES].sort(),
    "both tables were created on the existing store");

  const after = new Database(dbPath, { readonly: true });
  try {
    assert.equal(after.prepare("SELECT content FROM memories").get().content, "a memory worth keeping",
      "the migration touches no other table");
  } finally { after.close(); }
});

test("a table made before bot_name gets the column from the migration, and the row survives", () => {
  // An install that ran an earlier build of this branch: the two tables exist, message_drafts has no
  // bot_name, and there is a real draft in it. CREATE TABLE IF NOT EXISTS would leave the column out.
  const dbPath = freshDb("message-drafts-botname-");
  const db = new Database(dbPath);
  try {
    db.exec(MESSAGE_DRAFTS_DDL.replace(/^\s*bot_name TEXT,/m, ""));
    const info = db.prepare("PRAGMA table_info(message_drafts)").all().map((c) => c.name);
    assert.ok(!info.includes("bot_name"), "the fixture really is the older shape");
    db.exec(SEEDED);
  } finally { db.close(); }

  const out = run({ dbPath, log: () => {} });
  assert.equal(out.applied, true);
  assert.ok(out.results.some((r) => r.includes("bot_name")), "the run reports the column it ensured");

  const after = new Database(dbPath, { readonly: true });
  try {
    assert.ok(after.prepare("PRAGMA table_info(message_drafts)").all().some((c) => c.name === "bot_name"),
      "the column was added");
    const row = after.prepare("SELECT id, bot_name FROM message_drafts").get();
    assert.deepEqual(row, { id: "msgd-0123456789abcdef", bot_name: null }, "and the existing row is untouched");
  } finally { after.close(); }

  // Idempotent: a second run finds the column and adds nothing.
  const shape = shapes(dbPath);
  assert.doesNotThrow(() => run({ dbPath, log: () => {} }));
  assert.deepEqual(shapes(dbPath), shape);
});

test("no SCHEMA_GENERATION bump", () => {
  // Additive local-only DDL: init-db carries it too, so no boot gate is needed for it.
  assert.equal(SCHEMA_GENERATION, 9);
});

test("MESSAGE_DRAFTS_DDL has no CHECK, no FOREIGN KEY and no TEXT time column", () => {
  assert.doesNotMatch(MESSAGE_DRAFTS_DDL, /CHECK/i, "kinds and states are validated in the store");
  assert.doesNotMatch(MESSAGE_DRAFTS_DDL, /FOREIGN\s+KEY/i, "the store removes one draft's rows itself");
  assert.doesNotMatch(MESSAGE_DRAFTS_DDL, /\b\w*_at TEXT\b/i, "every time column is epoch-ms INTEGER");
  for (const t of MESSAGE_DRAFT_TABLES) {
    assert.match(MESSAGE_DRAFTS_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`),
      `${t} is created with IF NOT EXISTS`);
  }
  for (const name of ["idx_message_drafts_open", "idx_message_drafts_conversation", "idx_message_drafts_state",
    "idx_message_draft_audit_draft"]) {
    assert.match(MESSAGE_DRAFTS_DDL, new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`),
      `${name} is created with IF NOT EXISTS`);
  }
  assert.match(MESSAGE_DRAFTS_DDL, /CREATE UNIQUE INDEX IF NOT EXISTS idx_message_drafts_open\s+ON message_drafts\(conversation_kind, conversation_id\) WHERE state = 'open'/,
    "the one-open-draft rule is the index's own predicate");
});

test("the migration neither drops nor deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0036-message-drafts.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  assert.doesNotMatch(MESSAGE_DRAFTS_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(MESSAGE_DRAFTS_DDL, /\bDELETE\s+FROM\b/i);
});

test("the module id matches its filename and sorts after the reports migrations", () => {
  const files = MIGRATIONS.map((p) => p.split("/").pop());
  const reportsRuns = files.findIndex((n) => n.endsWith("-reports-runs.mjs"));
  const reportsVersions = files.findIndex((n) => n.endsWith("-reports-versions.mjs"));
  const drafts = files.findIndex((n) => n.endsWith("-message-drafts.mjs"));
  assert.ok(reportsRuns >= 0, "the registry discovers the reports-runs migration");
  assert.ok(reportsVersions >= 0, "the registry discovers the reports-versions migration (0033)");
  assert.ok(drafts >= 0, "the registry discovers the message-drafts migration");
  assert.equal(id, files[drafts].replace(/\.mjs$/, ""), "the module id matches its filename");
  assert.ok(reportsRuns < drafts, "the draft migration sorts after the one it follows");
  assert.ok(reportsVersions < drafts, "0033 belongs to reports-versions and sorts before the drafts migration");
  // 0034 and 0035 belong to the reports stack (Recurring Reports, in its own PRs), so the drafts
  // migration was renumbered past them. The runner applies by `id`, in file-name order, and never
  // needs contiguous numbers — 0012 is another gap — so nothing depends on 0034/0035 existing here.
  assert.equal(files[drafts], "0036-message-drafts.mjs",
    "the drafts migration is 0036: 0034 and 0035 are reports'");
  assert.deepEqual(files, [...files].sort(), "the registry is an ordered list");
});