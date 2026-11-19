// 0032-reports-runs: Crow Recurring Reports' two run tables on both rails — init-db.js's "reports runs
// tables" block and this numbered migration, both built from REPORTS_RUNS_DDL
// (servers/shared/reports-schema.js). DDL only; additive, no SCHEMA_GENERATION bump. Both tables are
// local-only: a run row names the sources a report read and carries one attempt's redacted error, and
// never replicates to a paired instance. 0031's REPORTS_DDL is untouched (0031 already shipped it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0032-reports-runs.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { REPORTS_RUNS_DDL, REPORTS_RUNS_TABLES } from "../servers/shared/reports-schema.js";

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
    initDir = tmp("reports-runs-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

/** Every sqlite_master object that belongs to the two run tables (the tables and their indexes). */
function runObjects(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const marks = REPORTS_RUNS_TABLES.map(() => "?").join(", ");
    return d.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE tbl_name IN (${marks})
       ORDER BY type, name`,
    ).all(...REPORTS_RUNS_TABLES);
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
    const marks = REPORTS_RUNS_TABLES.map(() => "?").join(", ");
    return d.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${marks}) ORDER BY name`,
    ).all(...REPORTS_RUNS_TABLES).map((r) => r.name);
  } finally {
    d.close();
  }
}

test("the module id matches its filename", () => {
  assert.equal(id, "0032-reports-runs");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations"))
    .some((p) => p.endsWith("/0032-reports-runs.mjs")));
  assert.equal(mod.rollbackSafe, true);
});

test("the shape matches what init-db produces", () => {
  const master = join(initDbDir(), "crow.db");
  assert.deepEqual(tableNames(master), [...REPORTS_RUNS_TABLES].sort(),
    "init-db created the two run tables");

  const dbPath = freshDb("reports-runs-fresh-");
  assert.equal(run({ dbPath, log: () => {} }).applied, true);

  assert.deepEqual(runObjects(dbPath), runObjects(master),
    "the same sqlite_master rows, byte for byte");
  for (const table of REPORTS_RUNS_TABLES) {
    assert.deepEqual(tableInfo(dbPath, table), tableInfo(master, table),
      `${table} has the same columns on both rails`);
  }
});

test("the indexes the run engine reads exist, and the scheduled window is unique per report", () => {
  const master = join(initDbDir(), "crow.db");
  const byName = new Map(runObjects(master).map((o) => [o.name, o]));
  assert.ok(byName.has("idx_report_runs_report"));
  assert.ok(byName.has("idx_report_runs_status"));
  assert.ok(byName.has("idx_report_run_requests_claimed"));
  const window = byName.get("idx_report_runs_schedule_window");
  assert.ok(window, "the scheduled-window index");
  assert.match(window.sql, /UNIQUE INDEX/);
  assert.match(window.sql, /report_id, scheduled_for/);
  assert.match(window.sql, /WHERE "trigger" = 'schedule'/,
    "it covers scheduled runs only, so manual runs may share a null window");

  // The index is what the schema says it is: the same window twice refuses, another window is fine, and
  // a run with no window at all is not covered by it.
  const db = new Database(master);
  try {
    const insert = db.prepare(`INSERT INTO report_runs (id, report_id, "trigger", requested_by,
      scheduled_for, status, created_at) VALUES (?, 'rpt-0011223344556677', ?, 'schedule', ?, 'queued', 1)`);
    insert.run("rrn-0000000000000001", "schedule", 1000);
    assert.throws(() => insert.run("rrn-0000000000000002", "schedule", 1000), /UNIQUE/);
    insert.run("rrn-0000000000000003", "schedule", 2000);
    insert.run("rrn-0000000000000004", "manual", 1000);
    insert.run("rrn-0000000000000005", "manual", 1000);
    insert.run("rrn-0000000000000006", "manual", null);
    insert.run("rrn-0000000000000007", "manual", null);
  } finally {
    db.close();
  }
});

test("the columns and defaults are the ones the run engine reads back", () => {
  const master = join(initDbDir(), "crow.db");
  const runs = columns(master, "report_runs");
  const trigger = runs["trigger"];
  assert.equal(trigger.notnull, 1, "the quoted trigger column is there");
  assert.equal(runs.status.dflt_value, "'queued'");
  assert.equal(runs.late.dflt_value, "0");
  assert.equal(runs.late.notnull, 1);
  assert.equal(runs.report_id.notnull, 1);
  assert.equal(runs.requested_by.notnull, 1);
  assert.equal(runs.created_at.notnull, 1);
  assert.equal(runs.id.pk, 1);
  for (const nullable of ["scheduled_for", "started_at", "ended_at", "recipe_rev",
    "artifact_version", "block_log_json", "error_text", "gateway_run_id"]) {
    assert.equal(runs[nullable].notnull, 0, `${nullable} starts NULL`);
  }
  assert.deepEqual(Object.values(runs).filter((c) => c.pk > 0).map((c) => c.name), ["id"]);

  const requests = columns(master, "report_run_requests");
  assert.deepEqual(Object.values(requests).filter((c) => c.pk > 0).map((c) => c.name), ["id"]);
  for (const required of ["report_id", "kind", "requested_by", "created_at"]) {
    assert.equal(requests[required].notnull, 1, `${required} is required`);
  }
  assert.equal(requests.claimed_at.notnull, 0, "claimed_at starts NULL");

  const d = new Database(master, { readonly: true });
  try {
    assert.match(d.prepare("SELECT sql FROM sqlite_master WHERE name = 'report_run_requests'").get().sql,
      /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  } finally {
    d.close();
  }
});

test("init-db runs the same DDL through initTable, right after the reports block", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.match(init,
    /import \{[^}]*\bREPORTS_RUNS_DDL\b[^}]*\} from "\.\.\/servers\/shared\/reports-schema\.js";/);
  assert.ok(init.includes('await initTable("reports runs tables", REPORTS_RUNS_DDL);'));
  assert.ok(init.indexOf('await initTable("reports runs tables", REPORTS_RUNS_DDL);')
    > init.indexOf('await initTable("reports tables", REPORTS_DDL);'),
  "the runs block follows the reports block");
});

test("there is no CHECK and no foreign key (validated in the run engine)", () => {
  assert.doesNotMatch(REPORTS_RUNS_DDL, /CHECK/i);
  assert.doesNotMatch(REPORTS_RUNS_DDL, /REFERENCES/i);
  assert.equal((REPORTS_RUNS_DDL.match(/CREATE TABLE/g) ?? []).length, 2);
  assert.equal((REPORTS_RUNS_DDL.match(/IF NOT EXISTS/g) ?? []).length,
    (REPORTS_RUNS_DDL.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)/g) ?? []).length,
    "every object is created IF NOT EXISTS");
});

test("0031's DDL is left exactly as it was", () => {
  // 0031 has shipped, so the constants it executes must not move: the runs half is its own constant.
  const schema = readFileSync(new URL("../servers/shared/reports-schema.js", import.meta.url), "utf8");
  assert.match(schema, /export const REPORTS_DDL = `[\s\S]*?`;/);
  const core = schema.slice(schema.indexOf("export const REPORTS_DDL"), schema.indexOf("export const REPORTS_TABLES"));
  assert.doesNotMatch(core, /report_runs|report_run_requests/);
  const migration = readFileSync(
    new URL("../scripts/migrations/0031-reports-core.mjs", import.meta.url), "utf8");
  assert.match(migration, /import \{ REPORTS_DDL, REPORTS_TABLES \}/);
});

test("the migration neither drops nor deletes", () => {
  const src = readFileSync(
    new URL("../scripts/migrations/0032-reports-runs.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  assert.doesNotMatch(REPORTS_RUNS_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(REPORTS_RUNS_DDL, /\bDELETE\s+FROM\b/i);
});

test("run is idempotent and keeps a row", () => {
  const dbPath = freshDb("reports-runs-idem-");
  const first = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO report_runs (id, report_id, "trigger", requested_by, status, created_at)
              VALUES ('rrn-0011223344556677', 'rpt-0011223344556677', 'manual', 'owner', 'ok', 1)`).run();
  db.prepare(`INSERT INTO report_run_requests (report_id, kind, requested_by, created_at)
              VALUES ('rpt-0011223344556677', 'preview', 'owner', 1)`).run();
  db.close();
  const before = runObjects(dbPath);
  const second = run({ dbPath, log: () => {} });
  const after2 = runObjects(dbPath);
  const check = new Database(dbPath, { readonly: true });
  const kept = {
    runs: check.prepare("SELECT count(*) AS n FROM report_runs").get().n,
    requests: check.prepare("SELECT count(*) AS n FROM report_run_requests").get().n,
    run: check.prepare('SELECT status, "trigger", late FROM report_runs').get(),
  };
  check.close();
  assert.equal(first.applied, true);
  assert.equal(second.applied, true);
  assert.deepEqual(kept, {
    runs: 1,
    requests: 1,
    run: { status: "ok", trigger: "manual", late: 0 },
  });
  assert.deepEqual(after2, before, "a second run changes nothing");
});

test("both run tables are local-only and neither is synced", () => {
  for (const t of REPORTS_RUNS_TABLES) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
    assert.equal(SYNC.shouldSyncRowForTest(t, { id: "rrn-0011223344556677" }), false);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["report_runs"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
});