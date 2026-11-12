// 0027-mail-store: the Crow Mail tables on both rails — init-db.js's "mail tables" block and this
// numbered migration, both built from MAIL_DDL (servers/shared/mail-schema.js). DDL only; additive,
// no SCHEMA_GENERATION bump. Every table is local-only: mail never replicates to a paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0027-mail-store.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { MAIL_DDL, MAIL_TABLES } from "../servers/shared/mail-schema.js";

const { run, id } = mod;
const REPO = new URL("..", import.meta.url).pathname;
const SYNC = await import("../servers/sharing/instance-sync.js");

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

/** The DB scripts/init-db.js builds on its own rail, in a throwaway data dir. */
let initDir = null;
function initDbDir() {
  if (!initDir) {
    initDir = tmp("mail-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

/** Every sqlite_master object that belongs to the mail tables: the tables themselves, the unique
 *  autoindexes, the declared indexes, the fts5 virtual table and its shadow tables/triggers. */
function mailObjects(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'mail_%' OR tbl_name LIKE 'mail_%'
       ORDER BY type, name`,
    ).all();
  } finally {
    d.close();
  }
}

function mailTableNames(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail_%' ORDER BY name",
    ).all().map((r) => r.name);
  } finally {
    d.close();
  }
}

/** fts5 keeps its own shadow tables; they are an implementation detail of mail_messages_fts. */
function isFtsShadow(name) {
  return name.startsWith("mail_messages_fts_");
}

const INSERT = `INSERT INTO mail_messages
  (account_id, folder_id, uid, subject, from_text, to_text, body_text, date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const ROW = {
  account_id: "ma-0123456789abcdef",
  folder_id: 1,
  uid: 7,
  subject: "subjecttoken",
  from_text: "alex@example.com",
  to_text: "sam@example.com",
  body_text: "bodytoken",
  date: 1_700_000_000_000,
};

/** Rowids the FTS index matches for `term` — the index's own answer, not the content table's. */
function find(db, term) {
  return db.prepare("SELECT rowid FROM mail_messages_fts WHERE mail_messages_fts MATCH ?").all(term)
    .map((r) => r.rowid);
}

/** The fts5 full check for an external-content index: it re-reads mail_messages and throws when the
 *  index disagrees with it (a stale entry, a missing row, a wrong column value). */
function assertFtsIntegrity(db) {
  assert.doesNotThrow(
    () => db.prepare("INSERT INTO mail_messages_fts(mail_messages_fts, rank) VALUES('integrity-check', 1)").run(),
    "the index agrees with the content table",
  );
}

function ftsIntegrityThrows(db) {
  assert.throws(
    () => db.prepare("INSERT INTO mail_messages_fts(mail_messages_fts, rank) VALUES('integrity-check', 1)").run(),
    "the index disagrees with the content table",
  );
}

test("the module id matches its filename", () => {
  assert.equal(id, "0027-mail-store");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations")).some((p) => p.endsWith("/0027-mail-store.mjs")));
});

test("the shape matches what init-db produces", () => {
  const want = mailObjects(join(initDbDir(), "crow.db"));

  const dbPath = freshDb("mail-fresh-");
  assert.equal(run({ dbPath, log: () => {} }).applied, true);
  const got = mailObjects(dbPath);

  const names = want.map((o) => o.name);
  for (const t of MAIL_TABLES) assert.ok(names.includes(t), `init-db created ${t}`);
  for (const i of ["idx_mail_messages_folder_date", "idx_mail_messages_account_date",
    "idx_mail_messages_thread", "idx_mail_messages_message_id", "idx_mail_messages_in_reply_to",
    "idx_mail_threads_account_last"]) {
    assert.ok(names.includes(i), `init-db created index ${i}`);
  }
  for (const t of ["mail_messages_ai", "mail_messages_ad", "mail_messages_au"]) {
    assert.ok(names.includes(t), `init-db created trigger ${t}`);
  }

  assert.deepEqual(got, want);
});

test("MAIL_TABLES names the tables, never the fts5 shadow tables", () => {
  for (const t of MAIL_TABLES) assert.equal(isFtsShadow(t), false, `${t} is not a shadow table`);
  assert.deepEqual([...MAIL_TABLES].sort(), [
    "mail_accounts", "mail_folders", "mail_image_allow", "mail_messages",
    "mail_messages_fts", "mail_sync_state", "mail_threads",
  ]);
});

test("init-db runs the same DDL through initTable", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.match(init, /import \{ MAIL_DDL \} from "\.\.\/servers\/shared\/mail-schema\.js";/);
  assert.ok(init.includes('await initTable("mail tables", MAIL_DDL);'));
});

test("there is no CHECK on a status or state column (validated in JS)", () => {
  assert.doesNotMatch(MAIL_DDL, /CHECK/i);
});

test("the migration neither drops nor deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0027-mail-store.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  // MAIL_DDL itself carries the fts5 delete trigger ("AFTER DELETE ON mail_messages"), so there the
  // check is against statements that remove rows or schema objects.
  assert.doesNotMatch(MAIL_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(MAIL_DDL, /\bDELETE\s+FROM\b/i);
});

test("run is idempotent and keeps a row", () => {
  const dbPath = freshDb("mail-idem-");
  const r1 = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO mail_accounts
    (id, address, label, imap_host, imap_port, smtp_host, smtp_port, created_at, updated_at)
    VALUES ('ma-0123456789abcdef','alex@example.com','Alex','mail.example.test',993,'mail.example.test',465,1,1)`).run();
  db.close();
  const before = mailObjects(dbPath);
  const r2 = run({ dbPath, log: () => {} });
  const after2 = mailObjects(dbPath);
  const d2 = new Database(dbPath, { readonly: true });
  const kept = d2.prepare("SELECT address, window_days, local_models_only, digest_opt_in, digest_time, status FROM mail_accounts").all();
  d2.close();
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);
  assert.equal(mod.rollbackSafe, true);
  assert.deepEqual(kept, [{
    address: "alex@example.com", window_days: 90, local_models_only: 0,
    digest_opt_in: 0, digest_time: "07:00", status: "active",
  }]);
  assert.deepEqual(after2, before, "a second run changes nothing");
});

test("every mail table is local-only and none is synced", () => {
  const tables = mailTableNames(join(initDbDir(), "crow.db")).filter((n) => !isFtsShadow(n));
  assert.deepEqual(tables, [...MAIL_TABLES].sort(), "sqlite_master's mail tables are exactly MAIL_TABLES");
  for (const t of [...new Set([...MAIL_TABLES, ...tables])]) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["mail_messages"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("mail_messages", { id: 1 }), false);
});

test("FTS finds a message by subject, sender, recipient and body, and forgets it on delete", () => {
  const dbPath = freshDb("mail-fts-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const info = db.prepare(INSERT).run(
      ROW.account_id, ROW.folder_id, ROW.uid, ROW.subject, ROW.from_text, ROW.to_text, ROW.body_text, ROW.date);
    const rowid = info.lastInsertRowid;
    for (const term of ["subjecttoken", "alex", "sam", "bodytoken"]) {
      assert.deepEqual(find(db, term), [rowid], `${term} is indexed`);
    }
    db.prepare("DELETE FROM mail_messages WHERE id = ?").run(rowid);
    for (const term of ["subjecttoken", "alex", "sam", "bodytoken"]) {
      assert.deepEqual(find(db, term), [], `${term} is gone from the index`);
    }
    assertFtsIntegrity(db);
  } finally { db.close(); }
});

test("an update of body_text or from_text re-indexes the row", () => {
  const dbPath = freshDb("mail-reindex-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const rowid = db.prepare(INSERT).run(
      ROW.account_id, ROW.folder_id, ROW.uid, ROW.subject, ROW.from_text, ROW.to_text, ROW.body_text, ROW.date,
    ).lastInsertRowid;

    db.prepare("UPDATE mail_messages SET body_text = ? WHERE id = ?").run("replacedbody", rowid);
    assert.deepEqual(find(db, "bodytoken"), [], "the old body term is gone");
    assert.deepEqual(find(db, "replacedbody"), [rowid], "the new body term is indexed");

    db.prepare("UPDATE mail_messages SET from_text = ? WHERE id = ?").run("kim@example.com", rowid);
    assert.deepEqual(find(db, "alex"), [], "the old sender term is gone");
    assert.deepEqual(find(db, "kim"), [rowid], "the new sender term is indexed");

    assert.deepEqual(find(db, "subjecttoken"), [rowid], "the untouched columns stay indexed");
    assertFtsIntegrity(db);
  } finally { db.close(); }
});

test("an is_read update does not touch the FTS index", () => {
  const dbPath = freshDb("mail-read-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const rowid = db.prepare(INSERT).run(
      ROW.account_id, ROW.folder_id, ROW.uid, ROW.subject, ROW.from_text, ROW.to_text, "sentinelterm", ROW.date,
    ).lastInsertRowid;
    assert.deepEqual(find(db, "sentinelterm"), [rowid], "the row starts indexed");

    // Take the row out of the index by hand, with the fts5 'delete' command (which needs the old
    // column values). From here the index has nothing for this rowid, so the only way the term can
    // come back is the update trigger firing.
    const row = db.prepare("SELECT subject, from_text, to_text, body_text FROM mail_messages WHERE id = ?").get(rowid);
    db.prepare(`INSERT INTO mail_messages_fts(mail_messages_fts, rowid, subject, from_text, to_text, body_text)
                VALUES ('delete', ?, ?, ?, ?, ?)`)
      .run(rowid, row.subject, row.from_text, row.to_text, row.body_text);
    assert.deepEqual(find(db, "sentinelterm"), [], "the index no longer holds the row");

    db.prepare("UPDATE mail_messages SET is_read = 1 WHERE id = ?").run(rowid);
    assert.equal(db.prepare("SELECT is_read FROM mail_messages WHERE id = ?").get(rowid).is_read, 1);
    assert.deepEqual(find(db, "sentinelterm"), [], "a read-state update must not reach the index");

    // Repair the probe's own doing — fts5 refuses a 'delete' of a row that is not in the index, so
    // the update trigger below needs a healthy index — then show that column write re-indexes.
    db.prepare("INSERT INTO mail_messages_fts(mail_messages_fts) VALUES('rebuild')").run();
    assert.deepEqual(find(db, "sentinelterm"), [rowid], "the rebuilt index holds the row again");
    db.prepare("UPDATE mail_messages SET body_text = ? WHERE id = ?").run("readdedterm", rowid);
    assert.deepEqual(find(db, "sentinelterm"), [], "the old body term is gone");
    assert.deepEqual(find(db, "readdedterm"), [rowid], "the new body term is indexed");
    assertFtsIntegrity(db);
  } finally { db.close(); }
});

test("ON CONFLICT upsert keeps the index consistent", () => {
  const dbPath = freshDb("mail-upsert-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const rowid = db.prepare(INSERT).run(
      ROW.account_id, ROW.folder_id, ROW.uid, ROW.subject, ROW.from_text, ROW.to_text, ROW.body_text, ROW.date,
    ).lastInsertRowid;
    assert.deepEqual(find(db, "bodytoken"), [rowid], "the first write is indexed");

    db.prepare(`INSERT INTO mail_messages
        (account_id, folder_id, uid, subject, from_text, to_text, body_text, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(folder_id, uid) DO UPDATE
          SET subject = excluded.subject, body_text = excluded.body_text`)
      .run(ROW.account_id, ROW.folder_id, ROW.uid, "upsertsubject", ROW.from_text, ROW.to_text,
        "upsertbody", ROW.date);

    assert.deepEqual(find(db, "bodytoken"), [], "the old body term is gone");
    assert.deepEqual(find(db, "subjecttoken"), [], "the old subject term is gone");
    assert.deepEqual(find(db, "upsertbody"), [rowid], "the new body term is indexed");
    assert.deepEqual(find(db, "upsertsubject"), [rowid], "the new subject term is indexed");
    assert.deepEqual(find(db, "alex"), [rowid], "an untouched column stays indexed");
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_messages").get().n, 1, "the upsert updated the row");
    assertFtsIntegrity(db);
  } finally { db.close(); }
});

// Why the store never writes mail_messages with INSERT OR REPLACE / REPLACE: with recursive_triggers
// off, REPLACE's implicit DELETE does not fire mail_messages_ad, so the old row's index entries
// survive while the content table has only the new rowid. The index is then corrupt.
test("INSERT OR REPLACE of the same (folder_id, uid) breaks the index", () => {
  const dbPath = freshDb("mail-replace-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const oldRowid = db.prepare(INSERT).run(
      ROW.account_id, ROW.folder_id, ROW.uid, ROW.subject, ROW.from_text, ROW.to_text, ROW.body_text, ROW.date,
    ).lastInsertRowid;
    assertFtsIntegrity(db);

    db.prepare(INSERT.replace("INSERT INTO", "INSERT OR REPLACE INTO")).run(
      ROW.account_id, ROW.folder_id, ROW.uid, "replacesubject", ROW.from_text, ROW.to_text, "replacebody", ROW.date,
    );
    assert.deepEqual(find(db, "replacebody").length, 1, "the replacement row is indexed");
    assert.equal(db.prepare("SELECT count(*) AS n FROM mail_messages").get().n, 1, "the row was replaced");
    assert.deepEqual(find(db, "bodytoken"), [oldRowid],
      "the replaced row's terms survive: REPLACE's implicit DELETE never fired the delete trigger");
    ftsIntegrityThrows(db);
  } finally { db.close(); }
});

test("mail_accounts and mail_image_allow treat addresses case-insensitively", () => {
  const dbPath = freshDb("mail-nocase-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const account = db.prepare(`INSERT INTO mail_accounts
      (id, address, label, imap_host, imap_port, smtp_host, smtp_port, created_at, updated_at)
      VALUES (?, ?, 'Alex', 'mail.example.test', 993, 'mail.example.test', 465, 1, 1)`);
    account.run("ma-0123456789abcdef", "alex@example.com");
    assert.throws(() => account.run("ma-fedcba9876543210", "Alex@Example.com"), /UNIQUE/,
      "a second account with the same address in another case is refused");

    const allow = db.prepare("INSERT INTO mail_image_allow (account_id, sender, created_at) VALUES (?, ?, 1)");
    allow.run("ma-0123456789abcdef", "alex@example.com");
    assert.throws(() => allow.run("ma-0123456789abcdef", "Alex@Example.com"), /UNIQUE/,
      "the allow entry is keyed case-insensitively too");
  } finally { db.close(); }
});
