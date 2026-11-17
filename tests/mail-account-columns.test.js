// 0029-mail-account-send-columns: Crow Mail's A3 account columns (display_name, aliases_json,
// sent_copy) on both rails — init-db.js's MAIL_ACCOUNT_SEND_COLUMNS loop and this numbered
// migration. ADD COLUMN only; 0027's MAIL_DDL is untouched; no SCHEMA_GENERATION bump.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0029-mail-account-send-columns.mjs";
import * as store from "../scripts/migrations/0027-mail-store.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS } from "../servers/shared/mail-schema.js";

const { run, id } = mod;
const REPO = new URL("..", import.meta.url).pathname;

const SEND_COLUMNS = ["display_name", "aliases_json", "sent_copy"];

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freshDb(prefix) {
  const dbPath = join(tmp(prefix), "crow.db");
  new Database(dbPath).close();
  return dbPath;
}

const INSERT_ACCOUNT = `INSERT INTO mail_accounts
  (id, address, label, imap_host, imap_port, smtp_host, smtp_port, created_at, updated_at)
  VALUES ('ma-0123456789abcdef','alex@example.com','Alex','mail.example.test',993,'mail.example.test',465,1,1)`;

/** mail_accounts' columns as SQLite reports them, without the cid (an ALTER's position is not a
 *  contract; the name, type, nullability and default are). */
function accountColumns(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("PRAGMA table_info(mail_accounts)").all()
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }));
  } finally {
    db.close();
  }
}

/** The stored CREATE TABLE text: SQLite appends each ADD COLUMN to it, so two rails that add the
 *  same columns in the same order store the same string. */
function accountTableSql(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mail_accounts'").get().sql;
  } finally {
    db.close();
  }
}

/** The DB scripts/init-db.js builds on its own rail, in a throwaway data dir. */
let initDir = null;
function initDbDir() {
  if (!initDir) {
    initDir = tmp("mail-account-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

test("the columns are added to a DB that has only 0027 applied and keep existing rows", () => {
  const dbPath = freshDb("mail-account-0027-");
  assert.equal(store.run({ dbPath, log: () => {} }).applied, true);

  const before = new Database(dbPath);
  try {
    before.prepare(INSERT_ACCOUNT).run();
  } finally { before.close(); }
  const names = accountColumns(dbPath).map((c) => c.name);
  for (const c of SEND_COLUMNS) assert.ok(!names.includes(c), `0027 alone has no ${c}`);

  assert.equal(run({ dbPath, log: () => {} }).applied, true);

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT address, display_name, aliases_json, sent_copy FROM mail_accounts").get();
    assert.deepEqual(row, {
      address: "alex@example.com", display_name: null, aliases_json: "[]", sent_copy: "provider",
    });
  } finally { db.close(); }

  const cols = accountColumns(dbPath);
  assert.deepEqual(
    cols.filter((c) => SEND_COLUMNS.includes(c.name)),
    [
      { name: "display_name", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "aliases_json", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "sent_copy", type: "TEXT", notnull: 1, dflt_value: "'provider'" },
    ],
    "the row gains exactly A3's three columns, in that order",
  );
});

test("the migration is idempotent and rollbackSafe", () => {
  const dbPath = freshDb("mail-account-idem-");
  store.run({ dbPath, log: () => {} });
  const first = new Database(dbPath);
  try { first.prepare(INSERT_ACCOUNT).run(); } finally { first.close(); }

  const r1 = run({ dbPath, log: () => {} });
  const shapeAfter1 = accountColumns(dbPath);
  const sqlAfter1 = accountTableSql(dbPath);

  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE mail_accounts SET display_name = 'Alex A', aliases_json = '[\"a@example.com\"]', sent_copy = 'append'").run();
  } finally { db.close(); }

  const lines = [];
  const r2 = run({ dbPath, log: (m) => lines.push(m) });

  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true, "a second run is not an error");
  assert.equal(mod.rollbackSafe, true);
  assert.deepEqual(accountColumns(dbPath), shapeAfter1, "a second run adds nothing");
  assert.equal(accountTableSql(dbPath), sqlAfter1, "a second run does not rewrite the table");
  assert.equal(lines.length, MAIL_ACCOUNT_SEND_COLUMNS.length,
    "the second run logs one line per column, so the no-op check below cannot pass on an empty list");
  assert.ok(lines.every((l) => l.includes("no-op")), "the second run reports every column as a no-op");

  const kept = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      kept.prepare("SELECT display_name, aliases_json, sent_copy FROM mail_accounts").get(),
      { display_name: "Alex A", aliases_json: "[\"a@example.com\"]", sent_copy: "append" },
      "the second run leaves the row alone",
    );
  } finally { kept.close(); }
});

test("the migration does not run on a DB without mail_accounts and says so", () => {
  const dbPath = freshDb("mail-account-absent-");
  const lines = [];
  const r = run({ dbPath, log: (m) => lines.push(m) });

  assert.equal(r.applied, true,
    "recording applied is correct: under the runner 0027 has already created the table, so only a direct call gets here");
  assert.ok(r.results.some((line) => line.includes("absent")), `the result says why nothing happened: ${r.results.join(", ")}`);
  assert.ok(lines.some((line) => line.includes("absent")), "the log says so too");

  const db = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [],
      "a no-op creates nothing");
  } finally { db.close(); }
});

test("init-db and the migration produce the same mail_accounts columns", () => {
  const want = accountColumns(join(initDbDir(), "crow.db"));
  const wantSql = accountTableSql(join(initDbDir(), "crow.db"));

  const dbPath = freshDb("mail-account-parity-");
  assert.equal(store.run({ dbPath, log: () => {} }).applied, true);
  assert.equal(run({ dbPath, log: () => {} }).applied, true);

  assert.deepEqual(accountColumns(dbPath), want);
  assert.equal(accountTableSql(dbPath), wantSql);
});

test("0027 and MAIL_DDL carry none of the A3 columns", () => {
  for (const column of SEND_COLUMNS) {
    assert.ok(!MAIL_DDL.includes(column), `MAIL_DDL does not carry ${column}: the columns are an ALTER`);
  }
  assert.match(MAIL_DDL, /last_sync_at INTEGER\n\s*\);/,
    "mail_accounts still ends where 0027 left it");

  const src = readFileSync(new URL("../scripts/migrations/0027-mail-store.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bALTER\s+TABLE\b/i, "0027 never alters a table");
  for (const column of SEND_COLUMNS) assert.ok(!src.includes(column), `0027 does not mention ${column}`);
  assert.match(src, /db\.exec\(MAIL_DDL\)/, "0027 still runs exactly the approved DDL");
});

test("no CHECK in MAIL_ACCOUNT_SEND_COLUMNS", () => {
  assert.deepEqual(
    MAIL_ACCOUNT_SEND_COLUMNS.map((c) => ({ table: c.table, column: c.column, definition: c.definition })),
    [
      { table: "mail_accounts", column: "display_name", definition: "TEXT" },
      { table: "mail_accounts", column: "aliases_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
      { table: "mail_accounts", column: "sent_copy", definition: "TEXT NOT NULL DEFAULT 'provider'" },
    ],
    "A3's three columns, exactly as the plan gives them",
  );
  for (const c of MAIL_ACCOUNT_SEND_COLUMNS) {
    assert.doesNotMatch(c.definition, /CHECK/i, `${c.column} is validated in the store, never by a CHECK`);
    assert.doesNotMatch(c.definition, /\b(DROP|DELETE)\b/i, `${c.column} is additive`);
  }
});

test("the module id matches its filename", () => {
  assert.equal(id, "0029-mail-account-send-columns");
  const found = discoverMigrations(join(REPO, "scripts", "migrations")).map((p) => p.split("/").pop());
  assert.ok(found.includes("0029-mail-account-send-columns.mjs"), "the registry discovers the file");
  assert.ok(found.indexOf("0027-mail-store.mjs") < found.indexOf("0029-mail-account-send-columns.mjs"),
    "it sorts after 0027, the migration that creates mail_accounts");
  assert.deepEqual(found, [...found].sort(), "the registry is an ordered list");
});
