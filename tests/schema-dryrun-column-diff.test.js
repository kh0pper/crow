/**
 * Finding 1 (Item 2a-FU): scripts/schema-migration-dryrun.sh was BLIND to
 * ALTER TABLE ADD COLUMN — it diffed sqlite_master object names + per-table
 * COUNT(*), so it proved nothing was LOST but could not prove a migration
 * HAPPENED (and a table silently rebuilt WITHOUT a column passed the gate).
 *
 * The gate must now snapshot per-table columns (PRAGMA table_info) pre/post
 * and diff them: ADDED columns are reported (informational — an additive
 * migration is EXPECTED to add its column), REMOVED columns are a STOP.
 *
 * Exercises the real script against a fixture DB, with DRYRUN_INIT_SCRIPT
 * pointing at fixture "migrations" instead of scripts/init-db.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const gateScript = join(repoRoot, "scripts", "schema-migration-dryrun.sh");
const bsqlite = join(repoRoot, "node_modules", "better-sqlite3", "lib", "index.js");

const dir = mkdtempSync(join(tmpdir(), "dryrun-coldiff-"));
const fixtureDb = join(dir, "fixture.db");

// Fixture "migrations" — each acts on the COPY the gate hands it via CROW_DB_PATH.
const addColumnScript = join(dir, "migrate-add-column.mjs");
const noopScript = join(dir, "migrate-noop.mjs");
const dropColumnScript = join(dir, "migrate-drop-column.mjs");

let fixtureHash;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runGate(initScript) {
  return spawnSync("bash", [gateScript, "fixture", fixtureDb], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DRYRUN_INIT_SCRIPT: initScript },
  });
}

before(() => {
  const db = new Database(fixtureDb);
  db.exec(`
    CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO widgets (name) VALUES ('alpha'), ('beta'), ('gamma');
  `);
  db.pragma("user_version = 1");
  db.close();
  fixtureHash = sha256(fixtureDb);

  writeFileSync(addColumnScript, `
    import Database from ${JSON.stringify(bsqlite)};
    const db = new Database(process.env.CROW_DB_PATH);
    db.exec("ALTER TABLE widgets ADD COLUMN color TEXT");
    db.pragma("user_version = 2");
    db.close();
  `);

  writeFileSync(noopScript, `
    import Database from ${JSON.stringify(bsqlite)};
    const db = new Database(process.env.CROW_DB_PATH);
    db.close();
  `);

  // A rebuild-narrower migration: same table name, same row count — only the
  // column set shrinks. This is exactly what the old gate could not see.
  writeFileSync(dropColumnScript, `
    import Database from ${JSON.stringify(bsqlite)};
    const db = new Database(process.env.CROW_DB_PATH);
    db.exec(\`
      CREATE TABLE widgets_new (id INTEGER PRIMARY KEY);
      INSERT INTO widgets_new (id) SELECT id FROM widgets;
      DROP TABLE widgets;
      ALTER TABLE widgets_new RENAME TO widgets;
    \`);
    db.pragma("user_version = 2");
    db.close();
  `);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("ADD COLUMN migration: added column is reported, gate still passes", () => {
  const r = runGate(addColumnScript);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /COLUMNS added\/removed per table/,
    "output must have a per-table column diff section");
  assert.match(r.stdout, /\+ widgets\.color/,
    "the added column must be named in the column diff section");
  assert.match(r.stdout, /DRY-RUN GATE PASSED/);
  assert.doesNotMatch(r.stdout, /STOP/, "an additive migration is not a failure");
  assert.equal(sha256(fixtureDb), fixtureHash, "gate must never mutate the source DB");
});

test("no-op migration: column section reports clean, gate passes", () => {
  const r = runGate(noopScript);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /COLUMNS added\/removed per table/);
  assert.doesNotMatch(r.stdout, /widgets\.color/);
  assert.doesNotMatch(r.stdout, /STOP/);
  assert.match(r.stdout, /DRY-RUN GATE PASSED/);
  assert.equal(sha256(fixtureDb), fixtureHash, "gate must never mutate the source DB");
});

test("REMOVED column (table rebuilt narrower): STOP line and exit 1", () => {
  const r = runGate(dropColumnScript);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /- widgets\.name/,
    "the removed column must be named in the column diff section");
  assert.match(r.stdout, /STOP/, "a removed column must print a STOP line");
  assert.match(r.stdout, /DRY-RUN GATE FAILED/);
  assert.equal(sha256(fixtureDb), fixtureHash, "gate must never mutate the source DB");
});

// ── Item 2b follow-on: the OBJECT diff section (pipefail inversion bug) ───────
//
// Under `set -o pipefail`, `if diff | grep -q` took diff's exit 1 whenever
// differences existed, so "schema objects added/removed" printed "(none)" for
// EVERY real delta — found live by 2b's own gate run (the new table showed in
// the column diff but not here). Indexes/triggers/views are covered ONLY by
// that section, so a removed one must be a STOP, not just display.

const addTableScript = join(dir, "migrate-add-table.mjs");
const dropIndexScript = join(dir, "migrate-drop-index.mjs");
const indexedDb = join(dir, "indexed-fixture.db");

test("ADDED object (new table) is DISPLAYED in the object-diff section", () => {
  writeFileSync(addTableScript, `
    import Database from ${JSON.stringify(bsqlite)};
    const db = new Database(process.env.CROW_DB_PATH);
    db.exec("CREATE TABLE gadgets (id INTEGER PRIMARY KEY)");
    db.pragma("user_version = 2");
    db.close();
  `);
  const r = runGate(addTableScript);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /> table gadgets/,
    "the new table must appear in the object-diff section (pipefail regression)");
  assert.match(r.stdout, /DRY-RUN GATE PASSED/);
  assert.equal(sha256(fixtureDb), fixtureHash, "gate must never mutate the source DB");
});

test("REMOVED index: named in the object diff, STOP line, exit 1", () => {
  const db = new Database(indexedDb);
  db.exec(`
    CREATE TABLE parts (id INTEGER PRIMARY KEY, sku TEXT);
    CREATE INDEX idx_parts_sku ON parts(sku);
    INSERT INTO parts (sku) VALUES ('a'), ('b');
  `);
  db.pragma("user_version = 1");
  db.close();
  const indexedHash = sha256(indexedDb);
  writeFileSync(dropIndexScript, `
    import Database from ${JSON.stringify(bsqlite)};
    const db = new Database(process.env.CROW_DB_PATH);
    db.exec("DROP INDEX idx_parts_sku");
    db.pragma("user_version = 2");
    db.close();
  `);
  const r = spawnSync("bash", [gateScript, "indexed", indexedDb], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DRYRUN_INIT_SCRIPT: dropIndexScript },
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /< index idx_parts_sku/,
    "the removed index must be named in the object-diff section");
  assert.match(r.stdout, /STOP — schema object\(s\) REMOVED/,
    "a removed index is invisible to counts/columns — the object section must FAIL the gate");
  assert.match(r.stdout, /DRY-RUN GATE FAILED/);
  assert.equal(sha256(indexedDb), indexedHash, "gate must never mutate the source DB");
});
