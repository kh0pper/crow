// 0015-research-note-withdrawal: research_notes gains who wrote a note (created_by) and whether
// it was withdrawn here (withdrawn_at, withdrawn_by, withdrawn_reason), on both rails (init-db's
// block right after the provenance one, and this numbered migration). ADD COLUMN only, no
// SCHEMA_GENERATION bump, no back-fill, and the same deferral as 0013 (tables absent, or the old
// research_projects FK shape still waiting on init-db's rebuild).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { id, run } from "../scripts/migrations/0015-research-note-withdrawal.mjs";
import { run as run0013, researchTablesDeferral } from "../scripts/migrations/0013-research-provenance.mjs";
import { NOTE_WITHDRAWAL_COLUMNS, PROVENANCE_COLUMNS } from "../servers/research/provenance-schema.js";
import { ensureWithdrawalSchema, ensureProvenanceSchema } from "../servers/research/ensure-schema.js";
import { makePre0013Db, makeOldFkDb, openFixtureDb } from "./helpers/research-fixtures.js";

const REPO = new URL("..", import.meta.url).pathname;
const COLS = ["created_by", "withdrawn_at", "withdrawn_by", "withdrawn_reason"];

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

function noteCols(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    const out = {};
    for (const c of d.prepare("PRAGMA table_info(research_notes)").all()) {
      if (COLS.includes(c.name)) out[c.name] = { type: c.type, notnull: c.notnull, dflt_value: c.dflt_value };
    }
    return out;
  } finally {
    d.close();
  }
}

/** A 0013-applied fixture (the shape every instance carries after PR #592, before this one). */
function make0013Db(prefix) {
  const dbPath = makePre0013Db(join(tmp(prefix), "crow.db"));
  const r = run0013({ dbPath, log: () => {} });
  assert.equal(r.applied, true);
  return dbPath;
}

test("module id matches filename", () => {
  assert.equal(id, "0015-research-note-withdrawal");
});

test("the column specs are the agreed shape", () => {
  assert.deepEqual(NOTE_WITHDRAWAL_COLUMNS.map((c) => [c.table, c.column, c.ddl, c.backfill]), [
    ["research_notes", "created_by", "TEXT", null],
    ["research_notes", "withdrawn_at", "TEXT", null],
    ["research_notes", "withdrawn_by", "TEXT", null],
    ["research_notes", "withdrawn_reason", "TEXT", null],
  ]);
});

test("0015 and init-db produce the same columns", () => {
  const dir = tmp("wd-init-");
  initDb(dir);
  const want = noteCols(join(dir, "crow.db"));
  assert.deepEqual(Object.keys(want).sort(), [...COLS].sort());
  for (const c of COLS) assert.equal(want[c].type, "TEXT", c);

  const fixture = make0013Db("wd-mig-");
  const r = run({ dbPath: fixture, log: () => {} });
  assert.equal(r.applied, true);
  assert.deepEqual(noteCols(fixture), want);
});

test("init-db adds the columns to a pre-0013 database too", () => {
  const dir = tmp("wd-initup-");
  makePre0013Db(join(dir, "crow.db"));
  initDb(dir);
  assert.deepEqual(Object.keys(noteCols(join(dir, "crow.db"))).sort(), [...COLS].sort());
});

test("it defers when the research tables are absent, or on an old-FK-shape database", () => {
  const absent = join(tmp("wd-absent-"), "crow.db");
  new Database(absent).close();
  assert.deepEqual(run({ dbPath: absent, log: () => {} }), { deferred: true });
  const a = new Database(absent, { readonly: true });
  try { assert.equal(typeof researchTablesDeferral(a), "string"); } finally { a.close(); }

  const old = makeOldFkDb(join(tmp("wd-oldfk-"), "crow.db"));
  assert.deepEqual(run({ dbPath: old, log: () => {} }), { deferred: true });
  assert.deepEqual(noteCols(old), {}, "nothing added");

  const ok = new Database(make0013Db("wd-nodefer-"), { readonly: true });
  try { assert.equal(researchTablesDeferral(ok), null); } finally { ok.close(); }
});

test("a re-run is a no-op", () => {
  const dbPath = make0013Db("wd-rerun-");
  const r1 = run({ dbPath, log: () => {} });
  assert.deepEqual(r1.results, COLS.map((c) => `research_notes.${c}: added`));
  const d = openFixtureDb(dbPath);
  d.prepare("UPDATE research_notes SET created_by = 'owner', withdrawn_at = '2026-10-28T00:00:00Z', withdrawn_by = 'owner', withdrawn_reason = 'misquote' WHERE id = 1").run();
  d.close();
  const r2 = run({ dbPath, log: () => {} });
  assert.equal(r2.applied, true);
  assert.deepEqual(r2.results, COLS.map((c) => `research_notes.${c}: no-op`));
  const v = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      v.prepare("SELECT created_by, withdrawn_at, withdrawn_by, withdrawn_reason FROM research_notes WHERE id = 1").get(),
      { created_by: "owner", withdrawn_at: "2026-10-28T00:00:00Z", withdrawn_by: "owner", withdrawn_reason: "misquote" },
    );
  } finally { v.close(); }
});

test("it never drops or deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0015-research-note-withdrawal.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
});

test("ensureWithdrawalSchema readies a DB that has 0013 but not 0015, and leaves provenance readiness alone", () => {
  const dbPath = make0013Db("wd-ens-ok-");
  assert.deepEqual(noteCols(dbPath), {}, "fixture is 0013-only");
  assert.deepEqual(ensureWithdrawalSchema(dbPath), { ready: true, state: "ready" });
  assert.deepEqual(Object.keys(noteCols(dbPath)).sort(), [...COLS].sort());
  assert.deepEqual(ensureWithdrawalSchema(dbPath), { ready: true, state: "ready" }, "idempotent");
  assert.deepEqual(ensureProvenanceSchema(dbPath), { ready: true, state: "ready" });

  const old = makeOldFkDb(join(tmp("wd-ens-old-"), "crow.db"));
  const r = ensureWithdrawalSchema(old);
  assert.equal(r.ready, false);
  assert.equal(r.state, "deferred");
  assert.equal(typeof r.reason, "string");
  assert.deepEqual(noteCols(old), {});
  const p = ensureProvenanceSchema(old);
  assert.equal(p.ready, false);
  assert.equal(p.state, "deferred", "provenance keeps its own result");
  const d = new Database(old, { readonly: true });
  try {
    for (const { table, column } of PROVENANCE_COLUMNS) {
      assert.ok(!d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column), `${table}.${column}`);
    }
  } finally { d.close(); }

  // Never throws, even on a path that is not a database.
  const bad = join(tmp("wd-ens-bad-"), "missing", "crow.db");
  let res;
  assert.doesNotThrow(() => { res = ensureWithdrawalSchema(bad); });
  assert.equal(res.ready, false);
  assert.equal(res.state, "error");
});
