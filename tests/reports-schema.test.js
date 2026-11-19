// 0031-reports-core: Crow Recurring Reports' five tables on both rails — init-db.js's "reports
// tables" block and this numbered migration, both built from REPORTS_DDL
// (servers/shared/reports-schema.js). DDL only; additive, no SCHEMA_GENERATION bump. Every table is
// local-only: a report names the owner's sources, recipients and credentials, and never replicates to
// a paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0031-reports-core.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { REPORTS_DDL, REPORTS_TABLES } from "../servers/shared/reports-schema.js";

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
    initDir = tmp("reports-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

/** Every sqlite_master object that belongs to the reports tables (the tables and their indexes). */
function reportObjects(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const marks = REPORTS_TABLES.map(() => "?").join(", ");
    return d.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE tbl_name IN (${marks})
       ORDER BY type, name`,
    ).all(...REPORTS_TABLES);
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

function reportTableNames(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const marks = REPORTS_TABLES.map(() => "?").join(", ");
    return d.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${marks}) ORDER BY name`,
    ).all(...REPORTS_TABLES).map((r) => r.name);
  } finally {
    d.close();
  }
}

function columnInfo(dbPath, table) {
  const info = tableInfo(dbPath, table);
  return Object.fromEntries(info.map((c) => [c.name, c]));
}

test("the module id matches its filename", () => {
  assert.equal(id, "0031-reports-core");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations"))
    .some((p) => p.endsWith("/0031-reports-core.mjs")));
  assert.equal(mod.rollbackSafe, true);
});

test("the shape matches what init-db produces", () => {
  const want = reportObjects(join(initDbDir(), "crow.db"));
  const wantTables = reportTableNames(join(initDbDir(), "crow.db"));
  assert.deepEqual(wantTables, [...REPORTS_TABLES].sort(), "init-db created the five reports tables");

  const dbPath = freshDb("reports-fresh-");
  assert.equal(run({ dbPath, log: () => {} }).applied, true);
  const got = reportObjects(dbPath);

  assert.deepEqual(got.map((o) => o.name), want.map((o) => o.name), "the same objects exist");
  assert.deepEqual(got, want, "the same sqlite_master rows, byte for byte");
  for (const table of REPORTS_TABLES) {
    assert.deepEqual(tableInfo(dbPath, table), tableInfo(join(initDbDir(), "crow.db"), table),
      `${table} has the same columns on both rails`);
  }
});

test("the indexes the stores read exist", () => {
  const names = reportObjects(join(initDbDir(), "crow.db")).map((o) => o.name);
  assert.ok(names.includes("idx_reports_project"), "the project list's index");
  assert.ok(names.includes("idx_report_approvals_audit_report"), "the audit trail's index");
});

test("the defaults are the ones the stores read back", () => {
  const reports = columnInfo(join(initDbDir(), "crow.db"), "reports");
  assert.equal(reports.status.dflt_value, "'draft'");
  assert.equal(reports.recipe_rev.dflt_value, "0");
  assert.equal(reports.delivery_mode.dflt_value, "'email_link'");
  assert.equal(reports.comment_tier_default.dflt_value, "'c'");
  assert.equal(reports.comment_visibility.dflt_value, "'own'");
  assert.equal(reports.ai_commentary.dflt_value, "0");
  assert.equal(reports.notify_every_run.dflt_value, "0");
  assert.equal(reports.pending_free_change.dflt_value, "0");
  assert.equal(reports.recipe_json.dflt_value, `'{"blocks":[]}'`);
  for (const nullable of ["live_rev", "live_seal", "live_nonce", "model_ref", "pause_reason",
    "approved_preview_run", "sender_account_id", "artifact_id", "schedule_id"]) {
    assert.equal(reports[nullable].notnull, 0, `${nullable} starts NULL`);
  }

  const audit = columnInfo(join(initDbDir(), "crow.db"), "report_approvals_audit");
  assert.equal(audit.id.pk, 1, "the audit trail has its own rowid");
  const auditSql = new Database(join(initDbDir(), "crow.db"), { readonly: true });
  try {
    assert.match(
      auditSql.prepare("SELECT sql FROM sqlite_master WHERE name = 'report_approvals_audit'").get().sql,
      /id INTEGER PRIMARY KEY AUTOINCREMENT/,
    );
  } finally {
    auditSql.close();
  }

  const revisions = columnInfo(join(initDbDir(), "crow.db"), "report_recipe_revisions");
  const revisionPk = Object.values(revisions).filter((c) => c.pk > 0).map((c) => c.name).sort();
  assert.deepEqual(revisionPk, ["report_id", "rev"], "a revision is keyed by report and number");

  const state = columnInfo(join(initDbDir(), "crow.db"), "report_state");
  assert.deepEqual(Object.values(state).filter((c) => c.pk > 0).map((c) => c.name).sort(),
    ["key", "report_id"]);

  const usage = columnInfo(join(initDbDir(), "crow.db"), "report_usage");
  assert.deepEqual(Object.values(usage).filter((c) => c.pk > 0).map((c) => c.name).sort(),
    ["day", "report_id"]);
  assert.equal(usage.emails.dflt_value, "0");
  assert.equal(usage.bot_ms.dflt_value, "0");
  assert.equal(usage.extra_step_runs.dflt_value, "0");
});

test("init-db runs the same DDL through initTable", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.match(init, /import \{[^}]*\bREPORTS_DDL\b[^}]*\} from "\.\.\/servers\/shared\/reports-schema\.js";/);
  assert.ok(init.includes('await initTable("reports tables", REPORTS_DDL);'));
  assert.ok(init.indexOf('await initTable("reports tables", REPORTS_DDL);')
    > init.indexOf('await initTable("mail draft tables", MAIL_DRAFTS_DDL);'),
  "the reports block follows the mail drafts block");
});

test("there is no CHECK and no foreign key (validated in the stores)", () => {
  assert.doesNotMatch(REPORTS_DDL, /CHECK/i);
  assert.doesNotMatch(REPORTS_DDL, /REFERENCES/i);
});

test("the migration neither drops nor deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0031-reports-core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  assert.doesNotMatch(REPORTS_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(REPORTS_DDL, /\bDELETE\s+FROM\b/i);
});

test("run is idempotent and keeps a row", () => {
  const dbPath = freshDb("reports-idem-");
  const r1 = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO reports (id, project_id, owner, title, created_at, updated_at)
              VALUES ('rpt-0011223344556677', 1, 'owner', 'Weekly listings', 1, 1)`).run();
  db.prepare(`INSERT INTO report_recipe_revisions
                (report_id, rev, recipe_json, recipe_hash, sources_hash, author_kind, created_at)
              VALUES ('rpt-0011223344556677', 1, '{"blocks":[]}', 'h', 's', 'owner', 1)`).run();
  db.close();
  const before = reportObjects(dbPath);
  const r2 = run({ dbPath, log: () => {} });
  const after2 = reportObjects(dbPath);
  const check = new Database(dbPath, { readonly: true });
  const kept = {
    reports: check.prepare("SELECT count(*) AS n FROM reports").get().n,
    revisions: check.prepare("SELECT count(*) AS n FROM report_recipe_revisions").get().n,
    status: check.prepare("SELECT status, recipe_rev, delivery_mode FROM reports").get(),
  };
  check.close();
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);
  assert.deepEqual(kept, {
    reports: 1,
    revisions: 1,
    status: { status: "draft", recipe_rev: 0, delivery_mode: "email_link" },
  });
  assert.deepEqual(after2, before, "a second run changes nothing");
});

test("every reports table is local-only and none is synced", () => {
  const tables = reportTableNames(join(initDbDir(), "crow.db"));
  assert.deepEqual(tables, [...REPORTS_TABLES].sort());
  for (const t of [...REPORTS_TABLES, ...tables]) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["reports"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("reports", { id: "rpt-0011223344556677" }), false);
});