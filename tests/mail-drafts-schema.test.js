// Crow Mail's four draft tables on both rails — init-db.js's "mail draft tables" block and its own
// numbered migration, both built from MAIL_DRAFTS_DDL (servers/shared/mail-schema.js). DDL only;
// additive, no SCHEMA_GENERATION bump. Every table is local-only: a draft never replicates to a
// paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0030-mail-drafts.mjs";
import * as store from "../scripts/migrations/0027-mail-store.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { MAIL_DDL, MAIL_TABLES, MAIL_DRAFTS_DDL, MAIL_DRAFT_TABLES } from "../servers/shared/mail-schema.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";

const { run, id } = mod;
const REPO = new URL("..", import.meta.url).pathname;
const SYNC = await import("../servers/sharing/instance-sync.js");

const MIGRATIONS = discoverMigrations(join(REPO, "scripts", "migrations"));

/** A migration file found by its suffix: the numbers are taken at PR time, so nothing here names one. */
function migrationFile(suffix) {
  const found = MIGRATIONS.filter((p) => p.endsWith(suffix));
  assert.equal(found.length, 1, `exactly one migration ends with ${suffix}`);
  return found[0];
}

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
    initDir = tmp("mail-drafts-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
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

/** One row of PRAGMA table_info, written from the plan's Task 1b Interfaces: the declared type, the
 *  NOT NULL flag, the default exactly as SQLite reports it, and the 1-based position in the primary
 *  key (0 for a column that is not part of one). */
function column(name, type, { notnull = 0, dflt_value = null, pk = 0 } = {}) {
  return { name, type, notnull, dflt_value, pk };
}

function tableInfo(dbPath, table) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all()
      .map((c) => column(c.name, c.type, { notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
  } finally {
    d.close();
  }
}

// The four tables' columns, in declaration order, from the plan's Task 1b Interfaces.
const DRAFTS_COLUMNS = [
  column("id", "TEXT", { pk: 1 }),
  column("account_id", "TEXT", { notnull: 1 }),
  column("mode", "TEXT", { notnull: 1 }),
  column("reply_to_mid", "TEXT"),
  column("thread_key", "TEXT"),
  column("project_id", "INTEGER"),
  column("bot_id", "TEXT"),
  column("chat_thread_id", "TEXT"),
  column("audience", "TEXT"),
  column("state", "TEXT", { notnull: 1 }),
  column("head_rev", "INTEGER", { notnull: 1 }),
  column("head_hash", "TEXT", { notnull: 1 }),
  column("due_at", "INTEGER"),
  column("hold_until", "INTEGER"),
  column("message_id", "TEXT"),
  column("claim_token", "TEXT"),
  column("claimed_at", "INTEGER"),
  column("attempt_at", "INTEGER"),
  column("tap_seal", "TEXT"),
  column("tap_id", "TEXT"),
  column("tap_action", "TEXT"),
  column("attach_digest", "TEXT"),
  column("reconcile_count", "INTEGER", { notnull: 1, dflt_value: "0" }),
  column("next_reconcile_at", "INTEGER"),
  column("sent_at", "INTEGER"),
  column("fail_reason", "TEXT"),
  column("notified_at", "INTEGER"),
  column("created_at", "INTEGER", { notnull: 1 }),
  column("updated_at", "INTEGER", { notnull: 1 }),
];

const REVISIONS_COLUMNS = [
  column("draft_id", "TEXT", { notnull: 1, pk: 1 }),
  column("rev", "INTEGER", { notnull: 1, pk: 2 }),
  column("author", "TEXT", { notnull: 1 }),
  column("to_json", "TEXT", { notnull: 1 }),
  column("cc_json", "TEXT", { notnull: 1 }),
  column("bcc_json", "TEXT", { notnull: 1 }),
  column("subject", "TEXT", { notnull: 1 }),
  column("body", "TEXT", { notnull: 1 }),
  column("in_reply_to", "TEXT"),
  column("references_json", "TEXT"),
  column("attachments_json", "TEXT", { notnull: 1 }),
  column("from_json", "TEXT", { notnull: 1 }),
  column("mode", "TEXT", { notnull: 1 }),
  column("content_hash", "TEXT", { notnull: 1 }),
  column("note", "TEXT"),
  column("created_at", "INTEGER", { notnull: 1 }),
];

const VOICE_COLUMNS = [
  column("draft_id", "TEXT", { notnull: 1, pk: 1 }),
  column("rev", "INTEGER", { notnull: 1, pk: 2 }),
  column("voice_json", "TEXT", { notnull: 1 }),
  column("created_at", "INTEGER", { notnull: 1 }),
];

const COMMENTS_COLUMNS = [
  column("id", "TEXT", { pk: 1 }),
  column("draft_id", "TEXT", { notnull: 1 }),
  column("rev", "INTEGER", { notnull: 1 }),
  column("line_index", "INTEGER"),
  column("quote", "TEXT"),
  column("text", "TEXT", { notnull: 1 }),
  column("state", "TEXT", { notnull: 1 }),
  column("created_at", "INTEGER", { notnull: 1 }),
];

const DRAFTS_INDEXES = [
  "idx_mail_drafts_state_due",
  "idx_mail_drafts_state_hold",
  "idx_mail_drafts_chat_thread",
];

test("mail draft tables exist after init-db", () => {
  const dbPath = join(initDbDir(), "crow.db");
  assert.deepEqual(tableNames(dbPath, "mail_draft%"), [...MAIL_DRAFT_TABLES].sort(),
    "init-db creates exactly the four draft tables");

  assert.deepEqual(tableInfo(dbPath, "mail_drafts"), DRAFTS_COLUMNS,
    "mail_drafts is exactly the plan's columns: names, types, NOT NULLs, defaults and primary key");
  assert.deepEqual(tableInfo(dbPath, "mail_draft_revisions"), REVISIONS_COLUMNS,
    "mail_draft_revisions is exactly the plan's columns and is keyed by (draft_id, rev)");
  assert.deepEqual(tableInfo(dbPath, "mail_draft_voice"), VOICE_COLUMNS,
    "mail_draft_voice is exactly the plan's columns and is keyed by (draft_id, rev)");
  assert.deepEqual(tableInfo(dbPath, "mail_draft_comments"), COMMENTS_COLUMNS,
    "mail_draft_comments is exactly the plan's columns");

  const objects = tableObjects(dbPath, "mail_drafts").map((o) => o.name);
  for (const name of DRAFTS_INDEXES) assert.ok(objects.includes(name), `init-db created index ${name}`);
});

test("mail draft tables are local-only and none is synced", () => {
  for (const t of MAIL_DRAFT_TABLES) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
    assert.equal(SYNC.shouldSyncRowForTest(t, { id: "md-0123456789abcdef" }), false, `${t} never replicates`);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["mail_drafts"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
});

test("the draft migration is additive and idempotent", () => {
  const dbPath = freshDb("mail-drafts-idem-");
  assert.equal(store.run({ dbPath, log: () => {} }).applied, true, "0027 comes first");

  const r1 = run({ dbPath, log: () => {} });
  const after1 = tableObjects(dbPath, "mail_drafts");
  const firstShape = shapes(dbPath);

  const db = new Database(dbPath);
  try {
    db.prepare(`INSERT INTO mail_drafts
      (id, account_id, mode, state, head_rev, head_hash, created_at, updated_at)
      VALUES ('md-0123456789abcdef', 'ma-0123456789abcdef', 'reply', 'draft', 1, 'hash-1', 1, 1)`).run();
    db.prepare(`INSERT INTO mail_draft_revisions
      (draft_id, rev, author, to_json, cc_json, bcc_json, subject, body, attachments_json, from_json,
       mode, content_hash, created_at)
      VALUES ('md-0123456789abcdef', 1, 'bot', '[]', '[]', '[]', 'Hi', 'Body', '[]',
              '{"address":"alex@example.com"}', 'reply', 'hash-1', 1)`).run();
  } finally { db.close(); }

  const lines = [];
  const r2 = run({ dbPath, log: (m) => lines.push(m) });

  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true, "a second run is not an error");
  assert.equal(mod.rollbackSafe, true, "older code never reads these tables");
  assert.ok(lines.length > 0 && lines.every((l) => l.includes("ensured")), "the second run reports every table as ensured");

  const kept = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(shapes(dbPath), firstShape, "a second run creates nothing new: no table, index or trigger");
    assert.deepEqual(kept.prepare("SELECT id, state, head_rev, reconcile_count FROM mail_drafts").get(),
      { id: "md-0123456789abcdef", state: "draft", head_rev: 1, reconcile_count: 0 },
      "the second run leaves the row alone");
    assert.equal(kept.prepare("SELECT count(*) AS n FROM mail_draft_revisions").get().n, 1);
  } finally { kept.close(); }
  assert.deepEqual(tableObjects(dbPath, "mail_drafts"), after1, "the draft table and its indexes are unchanged");
});

test("no SCHEMA_GENERATION bump", () => {
  // Additive local-only DDL: init-db carries it too, so no boot gate is needed for it.
  assert.equal(SCHEMA_GENERATION, 9);
});

test("MAIL_DRAFTS_DDL has no CHECK, no FOREIGN KEY and no TEXT time column", () => {
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /CHECK/i, "states and modes are validated in the store");
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /FOREIGN\s+KEY/i, "the store removes a draft's rows itself");
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /\b\w*_at TEXT\b/i, "every time column is epoch-ms INTEGER");
  for (const t of MAIL_DRAFT_TABLES) {
    assert.match(MAIL_DRAFTS_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), `${t} is created with IF NOT EXISTS`);
  }
  assert.match(MAIL_DRAFTS_DDL, /reconcile_count INTEGER NOT NULL DEFAULT 0/);
  for (const name of DRAFTS_INDEXES) {
    assert.match(MAIL_DRAFTS_DDL, new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b`), `${name} is created with IF NOT EXISTS`);
  }
});

test("MAIL_DDL is unchanged by this task", () => {
  assert.doesNotMatch(MAIL_DDL, /mail_draft/, "the draft tables are their own constant, not part of 0027's DDL");
  for (const t of MAIL_DRAFT_TABLES) assert.ok(!MAIL_TABLES.includes(t), `${t} is not in MAIL_TABLES`);

  const src0027 = readFileSync(new URL("../scripts/migrations/0027-mail-store.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src0027, /mail_draft/, "0027 still runs exactly the approved DDL");
  assert.match(src0027, /db\.exec\(MAIL_DDL\)/);

  const src = readFileSync(migrationFile("-mail-drafts.mjs"), "utf8");
  assert.match(src, /import \{[^}]*\bMAIL_DRAFTS_DDL\b[^}]*\} from "\.\.\/\.\.\/servers\/shared\/mail-schema\.js";/);
  assert.match(src, /db\.exec\(MAIL_DRAFTS_DDL\)/);
});

test("the migration neither drops nor deletes", () => {
  const src = readFileSync(migrationFile("-mail-drafts.mjs"), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /\bDELETE\s+FROM\b/i);
});

test("the module id matches its filename and sorts after the account columns migration", () => {
  const files = MIGRATIONS.map((p) => p.split("/").pop());
  const accountColumns = files.findIndex((n) => n.endsWith("-mail-account-send-columns.mjs"));
  const drafts = files.findIndex((n) => n.endsWith("-mail-drafts.mjs"));
  assert.ok(accountColumns >= 0, "the registry discovers the account columns migration");
  assert.ok(drafts >= 0, "the registry discovers the draft migration");
  assert.equal(id, files[drafts].replace(/\.mjs$/, ""), "the module id matches its filename");
  assert.ok(accountColumns < drafts, "the draft migration sorts after the one it follows");
  assert.deepEqual(files, [...files].sort(), "the registry is an ordered list");
});