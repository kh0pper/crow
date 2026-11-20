// 0034-reports-send: Crow Recurring Reports' send half on both rails — init-db.js's "reports send
// tables" block and this numbered migration, both built from REPORTS_SEND_DDL
// (servers/shared/reports-schema.js): report_recipients (one row per report and address) and
// report_sends (the send log, one row per run, recipient and attempt). DDL only; additive, no
// SCHEMA_GENERATION bump. Both tables are local-only: a recipient is a person the owner writes to and a
// send names them, and a report never replicates to a paired instance. The earlier reports constants
// (REPORTS_DDL from 0031, REPORTS_RUNS_DDL from 0032, REPORTS_VERSIONS_DDL from 0033) are untouched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0034-reports-send.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { REPORTS_SEND_DDL, REPORTS_SEND_TABLES } from "../servers/shared/reports-schema.js";

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
    initDir = tmp("reports-send-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

/** Every sqlite_master object that belongs to the send tables (the tables and their indexes). */
function sendObjects(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE tbl_name IN (${REPORTS_SEND_TABLES.map(() => "?").join(", ")})
       ORDER BY type, name`,
    ).all(...REPORTS_SEND_TABLES);
  } finally {
    d.close();
  }
}

function tableInfo(dbPath, table) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all();
  } finally {
    d.close();
  }
}

function columns(dbPath, table) {
  return Object.fromEntries(tableInfo(dbPath, table).map((c) => [c.name, c]));
}

function tableNames(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN (${REPORTS_SEND_TABLES.map(() => "?").join(", ")})
       ORDER BY name`,
    ).all(...REPORTS_SEND_TABLES).map((r) => r.name);
  } finally {
    d.close();
  }
}

test("the module id matches its filename", () => {
  assert.equal(id, "0034-reports-send");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations"))
    .some((p) => p.endsWith("/0034-reports-send.mjs")));
  assert.equal(mod.rollbackSafe, true);
});

test("the shape matches what init-db produces", () => {
  const master = join(initDbDir(), "crow.db");
  assert.deepEqual(tableNames(master), [...REPORTS_SEND_TABLES].sort(),
    "init-db created both send tables");

  const dbPath = freshDb("reports-send-fresh-");
  assert.equal(run({ dbPath, log: () => {} }).applied, true);

  assert.deepEqual(sendObjects(dbPath), sendObjects(master), "the same sqlite_master rows, byte for byte");
  for (const table of REPORTS_SEND_TABLES) {
    assert.deepEqual(tableInfo(dbPath, table), tableInfo(master, table),
      `${table} has the same columns on both rails`);
  }
});

test("the columns and the unique keys are the ones the plan fixes", () => {
  const master = join(initDbDir(), "crow.db");

  const recipients = columns(master, "report_recipients");
  // SQLite does not make a TEXT PRIMARY KEY NOT NULL, so the id is checked as the key it is.
  assert.equal(recipients.id.pk, 1, "the row id is the primary key");
  for (const required of ["report_id", "address", "state", "proposed_by", "created_at"]) {
    assert.equal(recipients[required].notnull, 1, `${required} is required`);
  }
  for (const nullable of ["display_name", "comment_tier", "approval_nonce", "approval_seal", "approved_at"]) {
    assert.equal(recipients[nullable].notnull, 0, `${nullable} starts NULL`);
  }
  assert.equal(recipients.state.dflt_value, "'proposed'");

  const sends = columns(master, "report_sends");
  assert.equal(sends.id.pk, 1, "the row id is the primary key");
  for (const required of [
    "run_id", "report_id", "recipient_id", "attempt", "status", "created_at", "updated_at",
  ]) {
    assert.equal(sends[required].notnull, 1, `${required} is required`);
  }
  assert.equal(sends.attempt.dflt_value, "1");
  assert.equal(sends.status.dflt_value, "'pending'");
  for (const nullable of [
    "account_id", "claim_token", "message_id", "provider_message_id", "reason", "gateway_run_id",
  ]) {
    assert.equal(sends[nullable].notnull, 0, `${nullable} starts NULL`);
  }

  const objects = new Map(sendObjects(master).map((o) => [o.name, o]));
  assert.match(objects.get("idx_report_recipients_report_address").sql,
    /UNIQUE INDEX[\s\S]*report_recipients\(report_id, address\)/,
    "one row per person per report");
  assert.match(objects.get("idx_report_sends_run_recipient_attempt").sql,
    /UNIQUE INDEX[\s\S]*report_sends\(run_id, recipient_id, attempt\)/,
    "one row per run, recipient and attempt");
  assert.match(objects.get("idx_report_sends_report").sql, /report_sends\(report_id\)/);
  assert.match(objects.get("idx_report_sends_status").sql, /report_sends\(status\)/);
  assert.match(objects.get("idx_report_recipients_report").sql, /report_recipients\(report_id\)/);
});

test("the unique keys really refuse a second row", () => {
  const dbPath = freshDb("reports-send-unique-");
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  try {
    const insertRecipient = db.prepare(`INSERT INTO report_recipients
      (id, report_id, address, state, proposed_by, created_at)
      VALUES (?, ?, ?, 'proposed', 'owner', 1)`);
    insertRecipient.run("rrc-0011223344556677", "rpt-0011223344556677", "alex@example.com");
    assert.throws(
      () => insertRecipient.run("rrc-8899aabbccddeeff", "rpt-0011223344556677", "alex@example.com"),
      /UNIQUE/,
      "the same address in one report is one row",
    );
    insertRecipient.run("rrc-8899aabbccddeeff", "rpt-0011223344556677", "second@example.com");
    // A different report may hold the same address.
    insertRecipient.run("rrc-5555666677778888", "rpt-ffeeddccbbaa9988", "alex@example.com");

    const send = db.prepare(`INSERT INTO report_sends
      (id, run_id, report_id, recipient_id, attempt, status, created_at, updated_at)
      VALUES (?, 'rrn-0011223344556677', 'rpt-0011223344556677', 'rrc-0011223344556677', ?, 'pending', 1, 1)`);
    send.run("rsd-0011223344556677", 1);
    assert.throws(() => send.run("rsd-8899aabbccddeeff", 1), /UNIQUE/,
      "one row per run, recipient and attempt");
    send.run("rsd-8899aabbccddeeff", 2);
  } finally {
    db.close();
  }
});

test("init-db runs the same DDL through initTable, right after the versions block", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.match(init,
    /import \{[^}]*\bREPORTS_SEND_DDL\b[^}]*\} from "\.\.\/servers\/shared\/reports-schema\.js";/);
  assert.ok(init.includes('await initTable("reports send tables", REPORTS_SEND_DDL);'));
  assert.ok(init.indexOf('await initTable("reports send tables", REPORTS_SEND_DDL);')
    > init.indexOf('await initTable("reports versions tables", REPORTS_VERSIONS_DDL);'),
  "the send block follows the versions block");
});

test("there is no CHECK and no foreign key (validated in the stores)", () => {
  assert.doesNotMatch(REPORTS_SEND_DDL, /CHECK/i);
  assert.doesNotMatch(REPORTS_SEND_DDL, /REFERENCES/i);
  assert.equal((REPORTS_SEND_DDL.match(/CREATE TABLE/g) ?? []).length, 2);
  assert.equal((REPORTS_SEND_DDL.match(/IF NOT EXISTS/g) ?? []).length,
    (REPORTS_SEND_DDL.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)/g) ?? []).length,
    "every object is created IF NOT EXISTS");
  const migration = readFileSync(
    new URL("../scripts/migrations/0034-reports-send.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /\bDROP\b/);
  assert.doesNotMatch(migration, /\bDELETE\b/);
  assert.doesNotMatch(REPORTS_SEND_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(REPORTS_SEND_DDL, /\bDELETE\s+FROM\b/i);
});

test("the earlier reports DDL constants are left exactly as they were", () => {
  const schema = readFileSync(new URL("../servers/shared/reports-schema.js", import.meta.url), "utf8");
  for (const [from, to] of [
    ["export const REPORTS_DDL", "export const REPORTS_TABLES"],
    ["export const REPORTS_RUNS_DDL", "export const REPORTS_RUNS_TABLES"],
    ["export const REPORTS_VERSIONS_DDL", "export const REPORTS_VERSIONS_TABLES"],
  ]) {
    const block = schema.slice(schema.indexOf(from), schema.indexOf(to));
    assert.doesNotMatch(block, /report_recipients|report_sends/, `${from} is untouched`);
  }
  assert.match(readFileSync(
    new URL("../scripts/migrations/0033-reports-versions.mjs", import.meta.url), "utf8"),
  /import \{ REPORTS_VERSIONS_DDL, REPORTS_VERSIONS_TABLES \}/);
});

test("run is idempotent and keeps a row", () => {
  const dbPath = freshDb("reports-send-idem-");
  const first = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO report_recipients
    (id, report_id, address, display_name, comment_tier, state, proposed_by, created_at)
    VALUES ('rrc-0011223344556677', 'rpt-0011223344556677', 'alex@example.com', 'Alex', 'b',
            'approved', 'owner', 1)`).run();
  db.prepare(`INSERT INTO report_sends
    (id, run_id, report_id, recipient_id, attempt, account_id, status, created_at, updated_at)
    VALUES ('rsd-0011223344556677', 'rrn-0011223344556677', 'rpt-0011223344556677',
            'rrc-0011223344556677', 1, 'ma-0011223344556677', 'sent', 1, 1)`).run();
  db.close();
  const before = sendObjects(dbPath);
  const second = run({ dbPath, log: () => {} });
  const after2 = sendObjects(dbPath);
  const check = new Database(dbPath, { readonly: true });
  const kept = {
    recipients: check.prepare("SELECT count(*) AS n, max(state) AS state FROM report_recipients").get(),
    sends: check.prepare("SELECT count(*) AS n, max(status) AS status FROM report_sends").get(),
  };
  check.close();
  assert.equal(first.applied, true);
  assert.equal(second.applied, true);
  assert.deepEqual(kept, {
    recipients: { n: 1, state: "approved" },
    sends: { n: 1, status: "sent" },
  });
  assert.deepEqual(after2, before, "a second run changes nothing");
});

test("both send tables are local-only and never synced", () => {
  for (const t of REPORTS_SEND_TABLES) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
    assert.equal(SYNC.shouldSyncRowForTest(t, { report_id: "rpt-0011223344556677" }), false);
  }
  const master = join(initDbDir(), "crow.db");
  const names = tableNames(master);
  assert.deepEqual(names, [...REPORTS_SEND_TABLES].sort());
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["report_sends"], SYNC.LOCAL_ONLY_TABLES),
    /local-only/);
});