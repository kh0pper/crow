// 0030-mail-drafts: Crow Mail's four draft tables on both rails — init-db.js's "mail draft tables"
// block and this numbered migration, both built from MAIL_DRAFTS_DDL (servers/shared/mail-schema.js).
// DDL only; additive, no SCHEMA_GENERATION bump. Every table is local-only: a draft never replicates
// to a paired instance.
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

function columnsOf(dbPath, table) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all()
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }));
  } finally {
    d.close();
  }
}

const DRAFTS_INDEXES = [
  "idx_mail_drafts_state_due",
  "idx_mail_drafts_state_hold",
  "idx_mail_drafts_chat_thread",
];

test("mail draft tables exist after init-db", () => {
  const dbPath = join(initDbDir(), "crow.db");
  assert.deepEqual(tableNames(dbPath, "mail_draft%"), [...MAIL_DRAFT_TABLES].sort(),
    "init-db creates exactly the four draft tables");

  const draft = columnsOf(dbPath, "mail_drafts");
  const names = draft.map((c) => c.name);
  for (const c of [
    "id", "account_id", "mode", "reply_to_mid", "thread_key", "project_id", "bot_id",
    "chat_thread_id", "audience", "state", "head_rev", "head_hash", "due_at", "hold_until",
    "message_id", "claim_token", "claimed_at", "attempt_at", "tap_seal", "tap_id", "tap_action",
    "attach_digest", "reconcile_count", "next_reconcile_at", "sent_at", "fail_reason",
    "notified_at", "created_at", "updated_at",
  ]) assert.ok(names.includes(c), `mail_drafts carries ${c}`);
  assert.deepEqual(draft.find((c) => c.name === "reconcile_count"),
    { name: "reconcile_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
    "reconcile_count starts at 0");

  const revisionNames = columnsOf(dbPath, "mail_draft_revisions").map((c) => c.name);
  for (const c of ["draft_id", "rev", "author", "to_json", "cc_json", "bcc_json", "subject", "body",
    "in_reply_to", "references_json", "attachments_json", "from_json", "mode", "content_hash",
    "note", "created_at"]) assert.ok(revisionNames.includes(c), `mail_draft_revisions carries ${c}`);

  const commentNames = columnsOf(dbPath, "mail_draft_comments").map((c) => c.name);
  for (const c of ["id", "draft_id", "rev", "line_index", "quote", "text", "state", "created_at"]) {
    assert.ok(commentNames.includes(c), `mail_draft_comments carries ${c}`);
  }

  const voiceNames = columnsOf(dbPath, "mail_draft_voice").map((c) => c.name);
  for (const c of ["draft_id", "rev", "voice_json", "created_at"]) {
    assert.ok(voiceNames.includes(c), `mail_draft_voice carries ${c}`);
  }

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
  const before = new Database(dbPath, { readonly: true });
  const firstShape = before.prepare("SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name").all();
  before.close();

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
    assert.deepEqual(kept.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
      firstShape.filter((o) => o.type === "table").map((o) => ({ name: o.name })),
      "a second run creates nothing new");
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

  const src = readFileSync(new URL("../scripts/migrations/0030-mail-drafts.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\bMAIL_DRAFTS_DDL\b[^}]*\} from "\.\.\/\.\.\/servers\/shared\/mail-schema\.js";/);
  assert.match(src, /db\.exec\(MAIL_DRAFTS_DDL\)/);
});

test("the migration neither drops nor deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0030-mail-drafts.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(MAIL_DRAFTS_DDL, /\bDELETE\s+FROM\b/i);
});

test("the module id matches its filename and sorts after 0029", () => {
  assert.equal(id, "0030-mail-drafts");
  const found = discoverMigrations(join(REPO, "scripts", "migrations")).map((p) => p.split("/").pop());
  assert.ok(found.includes("0030-mail-drafts.mjs"), "the registry discovers the file");
  assert.ok(found.indexOf("0029-mail-account-send-columns.mjs") < found.indexOf("0030-mail-drafts.mjs"),
    "it sorts after the migration it follows");
  assert.deepEqual(found, [...found].sort(), "the registry is an ordered list");
});