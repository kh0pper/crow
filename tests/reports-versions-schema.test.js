// 0033-reports-versions: Crow Recurring Reports' run-to-version map on both rails — init-db.js's
// "reports versions tables" block and this numbered migration, both built from REPORTS_VERSIONS_DDL
// (servers/shared/reports-schema.js). DDL only; additive, no SCHEMA_GENERATION bump. The table is
// local-only: it names a report and its run, and never replicates to a paired instance. The earlier
// reports constants (REPORTS_DDL from 0031, REPORTS_RUNS_DDL from 0032) are untouched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0033-reports-versions.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";
import { REPORTS_VERSIONS_DDL, REPORTS_VERSIONS_TABLES } from "../servers/shared/reports-schema.js";

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
    initDir = tmp("reports-versions-init-");
    execFileSync(process.execPath, ["scripts/init-db.js"],
      { env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  }
  return initDir;
}

/** Every sqlite_master object that belongs to the versions table (the table and its index). */
function versionObjects(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE tbl_name IN (${REPORTS_VERSIONS_TABLES.map(() => "?").join(", ")})
       ORDER BY type, name`,
    ).all(...REPORTS_VERSIONS_TABLES);
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
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REPORTS_VERSIONS_TABLES.map(() => "?").join(", ")})
       ORDER BY name`,
    ).all(...REPORTS_VERSIONS_TABLES).map((r) => r.name);
  } finally {
    d.close();
  }
}

test("the module id matches its filename", () => {
  assert.equal(id, "0033-reports-versions");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations"))
    .some((p) => p.endsWith("/0033-reports-versions.mjs")));
  assert.equal(mod.rollbackSafe, true);
});

test("the shape matches what init-db produces", () => {
  const master = join(initDbDir(), "crow.db");
  assert.deepEqual(tableNames(master), [...REPORTS_VERSIONS_TABLES].sort(),
    "init-db created the versions table");

  const dbPath = freshDb("reports-versions-fresh-");
  assert.equal(run({ dbPath, log: () => {} }).applied, true);

  assert.deepEqual(versionObjects(dbPath), versionObjects(master),
    "the same sqlite_master rows, byte for byte");
  assert.deepEqual(tableInfo(dbPath, "report_versions"), tableInfo(master, "report_versions"),
    "the same columns on both rails");
});

test("the primary key is the version's own key, and the report index exists", () => {
  const master = join(initDbDir(), "crow.db");
  const objects = new Map(versionObjects(master).map((o) => [o.name, o]));
  const idx = objects.get("idx_report_versions_report");
  assert.ok(idx, "the report index");
  assert.match(idx.sql, /report_versions\(report_id\)/);

  const cols = columns(master, "report_versions");
  assert.deepEqual(Object.values(cols).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    ["artifact_id", "n"], "one row per artifact version");
  for (const required of ["artifact_id", "n", "report_id", "run_id", "trigger", "created_at"]) {
    assert.equal(cols[required].notnull, 1, `${required} is required`);
  }
  assert.equal(cols.allowed_links_json.notnull, 0, "allowed_links_json starts NULL");

  const db = new Database(master);
  try {
    const insert = db.prepare(`INSERT INTO report_versions
      (artifact_id, n, report_id, run_id, "trigger", allowed_links_json, created_at)
      VALUES (?, ?, 'rpt-0011223344556677', 'rrn-0011223344556677', ?, '[]', 1)`);
    insert.run("art_aaaaaaaaaaaaaaaa", 2, "manual");
    assert.throws(() => insert.run("art_aaaaaaaaaaaaaaaa", 2, "manual"), /UNIQUE/,
      "a version has at most one run");
    insert.run("art_aaaaaaaaaaaaaaaa", 3, "preview");
    insert.run("art_bbbbbbbbbbbbbbbb", 2, "schedule");
  } finally {
    db.close();
  }
});

test("init-db runs the same DDL through initTable, right after the runs block", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.match(init,
    /import \{[^}]*\bREPORTS_VERSIONS_DDL\b[^}]*\} from "\.\.\/servers\/shared\/reports-schema\.js";/);
  assert.ok(init.includes('await initTable("reports versions tables", REPORTS_VERSIONS_DDL);'));
  assert.ok(init.indexOf('await initTable("reports versions tables", REPORTS_VERSIONS_DDL);')
    > init.indexOf('await initTable("reports runs tables", REPORTS_RUNS_DDL);'),
  "the versions block follows the runs block");
});

test("there is no CHECK and no foreign key (validated in the run engine)", () => {
  assert.doesNotMatch(REPORTS_VERSIONS_DDL, /CHECK/i);
  assert.doesNotMatch(REPORTS_VERSIONS_DDL, /REFERENCES/i);
  assert.equal((REPORTS_VERSIONS_DDL.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.equal((REPORTS_VERSIONS_DDL.match(/IF NOT EXISTS/g) ?? []).length,
    (REPORTS_VERSIONS_DDL.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)/g) ?? []).length,
    "every object is created IF NOT EXISTS");
  const migration = readFileSync(
    new URL("../scripts/migrations/0033-reports-versions.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /\bDROP\b/);
  assert.doesNotMatch(migration, /\bDELETE\b/);
  assert.doesNotMatch(REPORTS_VERSIONS_DDL, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(REPORTS_VERSIONS_DDL, /\bDELETE\s+FROM\b/i);
});

test("the earlier reports DDL constants are left exactly as they were", () => {
  const schema = readFileSync(new URL("../servers/shared/reports-schema.js", import.meta.url), "utf8");
  const core = schema.slice(schema.indexOf("export const REPORTS_DDL"), schema.indexOf("export const REPORTS_TABLES"));
  assert.doesNotMatch(core, /report_versions/);
  const runs = schema.slice(schema.indexOf("export const REPORTS_RUNS_DDL"),
    schema.indexOf("export const REPORTS_RUNS_TABLES"));
  assert.doesNotMatch(runs, /report_versions/);
  const migration = readFileSync(
    new URL("../scripts/migrations/0031-reports-core.mjs", import.meta.url), "utf8");
  assert.match(migration, /import \{ REPORTS_DDL, REPORTS_TABLES \}/);
});

test("run is idempotent and keeps a row", () => {
  const dbPath = freshDb("reports-versions-idem-");
  const first = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO report_versions
    (artifact_id, n, report_id, run_id, "trigger", allowed_links_json, created_at)
    VALUES ('art_0011223344556677', 2, 'rpt-0011223344556677', 'rrn-0011223344556677', 'manual',
            '["https://a.example.com/x"]', 1)`).run();
  db.close();
  const before = versionObjects(dbPath);
  const second = run({ dbPath, log: () => {} });
  const after2 = versionObjects(dbPath);
  const check = new Database(dbPath, { readonly: true });
  const kept = check.prepare('SELECT count(*) AS n, max("trigger") AS trigger FROM report_versions').get();
  check.close();
  assert.equal(first.applied, true);
  assert.equal(second.applied, true);
  assert.deepEqual(kept, { n: 1, trigger: "manual" });
  assert.deepEqual(after2, before, "a second run changes nothing");
});

test("the versions table is local-only and never synced", () => {
  for (const t of REPORTS_VERSIONS_TABLES) {
    assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), `${t} is in LOCAL_ONLY_TABLES`);
    assert.ok(!SYNC.SYNCED_TABLES.includes(t), `${t} is not in SYNCED_TABLES`);
    assert.equal(SYNC.shouldSyncRowForTest(t, { artifact_id: "art_0011223344556677", n: 2 }), false);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["report_versions"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
});

test("artifact_version_holds is treated as local retention state, like the rest of the artifact family", () => {
  // The artifact tables live in crow.db but are not in SYNCED_TABLES at all: nothing about an artifact,
  // a version, a link or a hold replicates. A hold in particular must never travel, because it protects a
  // version on the instance whose mail carried the link.
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("artifact_version_holds"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("artifact_version_holds"));
  assert.equal(SYNC.shouldSyncRowForTest("artifact_version_holds",
    { artifact_id: "art_0011223344556677", n: 2, holder: "report-send:1" }), false);
  for (const table of ["artifacts", "artifact_versions", "artifact_links", "artifact_version_holds"]) {
    assert.ok(!SYNC.SYNCED_TABLES.includes(table), `${table} never replicates`);
  }
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
});