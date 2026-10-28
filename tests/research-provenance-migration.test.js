// 0013-research-provenance: fetch and provenance columns on research_sources / research_notes, on
// both rails (init-db's late block and this numbered migration). ADD COLUMN only, no
// SCHEMA_GENERATION bump; the one-time back-fill rides the ADD that creates the column, and the
// migration defers while the old research_projects FK shape remains (init-db's rebuild first).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { id, run } from "../scripts/migrations/0013-research-provenance.mjs";
import { PROVENANCE_COLUMNS, PROVENANCE_INDEX_SQL } from "../servers/research/provenance-schema.js";
import { ensureProvenanceSchema } from "../servers/research/ensure-schema.js";
import { makePre0013Db, makeOldFkDb, openFixtureDb } from "./helpers/research-fixtures.js";

const REPO = new URL("..", import.meta.url).pathname;
const INDEX = "idx_sources_project_final_url";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function initDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    stdio: "pipe",
    cwd: REPO,
  });
}

function provenanceShape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const cols = {};
    for (const { table, column } of PROVENANCE_COLUMNS) {
      const row = d.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === column);
      cols[`${table}.${column}`] = row ? { name: row.name, type: row.type, notnull: row.notnull, dflt_value: row.dflt_value } : null;
    }
    const idx = d.prepare("PRAGMA index_list(research_sources)").all().find((i) => i.name === INDEX);
    const idxCols = d.prepare(`PRAGMA index_info(${INDEX})`).all().map((c) => c.name);
    return { cols, idx: idx ? { name: idx.name, unique: idx.unique, partial: idx.partial } : null, idxCols };
  } finally {
    d.close();
  }
}

function hasColumn(dbPath, table, column) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } finally {
    d.close();
  }
}

function assertBackfilled(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const rows = d.prepare("SELECT id, fetch_status, verification_method FROM research_sources WHERE id <= 3 ORDER BY id").all();
    assert.deepEqual(rows, [
      { id: 1, fetch_status: "legacy", verification_method: "legacy_flag" },
      { id: 2, fetch_status: "legacy", verification_method: "legacy_flag" },
      { id: 3, fetch_status: "legacy", verification_method: null },
    ]);
  } finally {
    d.close();
  }
}

function insertLaterSource(dbPath) {
  const d = openFixtureDb(dbPath);
  try {
    return Number(d.prepare(`INSERT INTO research_sources (title, source_type, citation_apa, verified)
                             VALUES ('Later', 'web_article', 'Later. (2026).', 1)`).run().lastInsertRowid);
  } finally {
    d.close();
  }
}

function rowOf(dbPath, sid) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return d.prepare("SELECT fetch_status, verification_method FROM research_sources WHERE id = ?").get(sid);
  } finally {
    d.close();
  }
}

test("module id matches filename", () => {
  assert.equal(id, "0013-research-provenance");
});

test("the column specs and index are the agreed shape", () => {
  assert.equal(PROVENANCE_COLUMNS.length, 12);
  assert.equal(PROVENANCE_INDEX_SQL,
    "CREATE INDEX IF NOT EXISTS idx_sources_project_final_url ON research_sources(project_id, final_url)");
  const withBackfill = PROVENANCE_COLUMNS.filter((c) => c.backfill).map((c) => `${c.table}.${c.column}`);
  assert.deepEqual(withBackfill, ["research_sources.fetch_status", "research_sources.verification_method"]);
});

test("0013 and init-db produce the same columns", () => {
  const dir = tmp("prov-init-");
  initDb(dir);
  const want = provenanceShape(join(dir, "crow.db"));
  const fixture = makePre0013Db(join(tmp("prov-mig-"), "crow.db"));
  run({ dbPath: fixture, log: () => {} });
  const got = provenanceShape(fixture);
  for (const [k, v] of Object.entries(want.cols)) assert.ok(v, `init-db created ${k}`);
  assert.ok(want.idx, "init-db created the index");
  assert.deepEqual(want.idxCols, ["project_id", "final_url"]);
  assert.deepEqual(got, want);
});

test("0013 back-fills once, only when it adds the column", () => {
  const dbPath = makePre0013Db(join(tmp("prov-once-"), "crow.db"));
  const r1 = run({ dbPath, log: () => {} });
  assert.equal(r1.applied, true);
  assert.ok(r1.results.every((r) => r.endsWith(": added")), JSON.stringify(r1.results));
  assertBackfilled(dbPath);
  const later = insertLaterSource(dbPath);
  const r2 = run({ dbPath, log: () => {} });
  assert.equal(r2.applied, true);
  assert.ok(r2.results.length === PROVENANCE_COLUMNS.length);
  assert.ok(r2.results.every((r) => r.endsWith(": no-op")), JSON.stringify(r2.results));
  assert.deepEqual(rowOf(dbPath, later), { fetch_status: null, verification_method: null });
});

test("init-db back-fills a pre-0013 database once", () => {
  const dir = tmp("prov-initbf-");
  const dbPath = makePre0013Db(join(dir, "crow.db"));
  initDb(dir);
  assertBackfilled(dbPath);
  const later = insertLaterSource(dbPath);
  initDb(dir);
  assert.deepEqual(rowOf(dbPath, later), { fetch_status: null, verification_method: null });
  assertBackfilled(dbPath);
});

test("init-db upgrades an old-FK-shape database (FK → research_projects) without the rebuild aborting", () => {
  const dir = tmp("prov-oldfk-");
  const dbPath = makeOldFkDb(join(dir, "crow.db"));
  initDb(dir); // throws on a non-zero exit
  const d = new Database(dbPath, { readonly: true });
  try {
    for (const t of ["research_sources", "research_notes"]) {
      const fks = d.prepare(`PRAGMA foreign_key_list(${t})`).all().filter((r) => r.from === "project_id");
      assert.deepEqual(fks.map((r) => r.table), ["project_spaces"], `${t} FK re-pointed`);
    }
  } finally {
    d.close();
  }
  for (const { table, column } of PROVENANCE_COLUMNS) assert.ok(hasColumn(dbPath, table, column), `${table}.${column}`);
  assertBackfilled(dbPath);
});

test("0013 defers on an old-FK-shape database", () => {
  const dbPath = makeOldFkDb(join(tmp("prov-defer-"), "crow.db"));
  assert.deepEqual(run({ dbPath, log: () => {} }), { deferred: true });
  assert.equal(hasColumn(dbPath, "research_sources", "fetch_status"), false);
  assert.equal(hasColumn(dbPath, "research_notes", "provenance"), false);
});

test("0013 defers when the research tables are absent", () => {
  const dbPath = join(tmp("prov-absent-"), "crow.db");
  new Database(dbPath).close();
  assert.deepEqual(run({ dbPath, log: () => {} }), { deferred: true });
});

test("CHECK constraints reject unknown values", () => {
  const dbPath = makePre0013Db(join(tmp("prov-check-"), "crow.db"));
  run({ dbPath, log: () => {} });
  const d = new Database(dbPath);
  try {
    assert.throws(() => d.prepare("UPDATE research_sources SET fetch_status = 'maybe' WHERE id = 1").run(), /CHECK constraint failed/);
    assert.throws(() => d.prepare("UPDATE research_sources SET verification_method = 'vibes' WHERE id = 1").run(), /CHECK constraint failed/);
    assert.throws(() => d.prepare("UPDATE research_notes SET provenance = 'guess' WHERE id = 1").run(), /CHECK constraint failed/);
    assert.throws(() => d.prepare("UPDATE research_notes SET quote_found = 2 WHERE id = 1").run(), /CHECK constraint failed/);
    d.prepare("UPDATE research_sources SET fetch_status = 'fetched', verification_method = 'quotes_checked' WHERE id = 1").run();
    d.prepare("UPDATE research_notes SET provenance = 'snippet', quote_found = 0 WHERE id = 1").run();
  } finally {
    d.close();
  }
});

test("it never drops or deletes, and declares no migration-guard expectation", () => {
  const src = readFileSync(new URL("../scripts/migrations/0013-research-provenance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
  const schema = readFileSync(new URL("../servers/research/provenance-schema.js", import.meta.url), "utf8");
  assert.doesNotMatch(schema, /\bDROP\b|\bDELETE\b/);
  assert.doesNotMatch(schema, /^\s*import\b/m, "provenance-schema.js stays import-free");
});

test("ensureProvenanceSchema readies a pre-0013 DB and reports deferred on an old-FK DB", async () => {
  const ready = makePre0013Db(join(tmp("prov-ens-ok-"), "crow.db"));
  assert.deepEqual(ensureProvenanceSchema(ready), { ready: true, state: "ready" });
  for (const { table, column } of PROVENANCE_COLUMNS) assert.ok(hasColumn(ready, table, column), `${table}.${column}`);
  assert.deepEqual(ensureProvenanceSchema(ready), { ready: true, state: "ready" }, "idempotent");

  const old = makeOldFkDb(join(tmp("prov-ens-old-"), "crow.db"));
  const r = ensureProvenanceSchema(old);
  assert.equal(r.ready, false);
  assert.equal(r.state, "deferred");
  assert.equal(hasColumn(old, "research_sources", "fetch_status"), false);

  // Locked: another PROCESS holds the write lock past run()'s 10 s busy_timeout.
  const locked = makePre0013Db(join(tmp("prov-ens-lock-"), "crow.db"));
  const w = new Database(locked);
  w.pragma("journal_mode = WAL");
  w.close();
  const holder = spawn(process.execPath, ["-e", `
    const Database = require(${JSON.stringify(join(REPO, "node_modules", "better-sqlite3"))});
    const d = new Database(${JSON.stringify(locked)});
    d.exec("BEGIN IMMEDIATE"); d.exec("UPDATE research_sources SET tags = 'held' WHERE id = 3");
    process.stdout.write("locked\\n");
    setTimeout(() => { d.exec("ROLLBACK"); d.close(); process.exit(0); }, 12000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((r2) => holder.once("exit", r2));
  await new Promise((resolve, reject) => {
    holder.stdout.on("data", (b) => { if (String(b).includes("locked")) resolve(); });
    holder.on("exit", (c) => reject(new Error("holder exited early: " + c)));
  });
  let res;
  assert.doesNotThrow(() => { res = ensureProvenanceSchema(locked); });
  assert.equal(res.ready, false);
  assert.equal(res.state, "error");
  assert.equal(typeof res.reason, "string");
  await exited;
  for (const { table, column } of PROVENANCE_COLUMNS) assert.equal(hasColumn(locked, table, column), false, `${table}.${column}`);
});

test("sources_fts is unchanged", () => {
  const dir = tmp("prov-fts-");
  initDb(dir);
  const fixture = makePre0013Db(join(tmp("prov-fts-mig-"), "crow.db"));
  run({ dbPath: fixture, log: () => {} });
  for (const dbPath of [join(dir, "crow.db"), fixture]) {
    const d = new Database(dbPath, { readonly: true });
    try {
      for (const name of ["sources_fts", "sources_ai", "sources_ad", "sources_au"]) {
        const row = d.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
        assert.ok(row, `${name} exists`);
        assert.doesNotMatch(row.sql, /fetched_text/, `${name} never indexes fetched_text`);
      }
    } finally {
      d.close();
    }
  }
});
