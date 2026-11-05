/**
 * The boot guard's schema rule (audit N1c-3, Layer 1 — B1/R1/S8).
 *
 * Rolling code back onto a database the new commit already reshaped is the one
 * thing the guard must never do. Every case here is a pure call on a scratch
 * repository plus a real crow.db, so each refusal is attributable to exactly one
 * input.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { evaluateSchema, validateDbPath } from "../scripts/boot-guard/crow-boot-guard.mjs";

const _dirs = [];
after(() => { for (const d of _dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const GEN_MODULE = (n) => `// schema generation for the fixture\nexport const SCHEMA_GENERATION = ${n};\n`;
const MIGRATION = (id, rollbackSafe) => `// fixture migration ${id}\nexport const id = "${id}";\nexport const rollbackSafe = ${rollbackSafe};\nexport async function up() {}\n`;

/**
 * Two commits: P (the last healthy sha) and B (the crash-looping one).
 * `bFiles` are written only into B; `changeInitDb` rewrites scripts/init-db.js in B.
 */
function fixture({ bFiles = {}, pFiles = {}, changeInitDb = false, pGeneration = 9, pSchemaModule = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bg-schema-"));
  _dirs.push(root);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  g(work, "init", "-b", "main");
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  mkdirSync(join(work, "servers", "shared"), { recursive: true });
  writeFileSync(join(work, "servers", "shared", "schema-version.js"), pSchemaModule ?? GEN_MODULE(pGeneration));
  writeFileSync(join(work, "scripts", "init-db.js"), "// init-db as of P\n");
  writeFileSync(join(work, "a.txt"), "one\n");
  for (const [name, body] of Object.entries(pFiles)) writeFileSync(join(work, name), body);
  g(work, "add", "-A");
  g(work, "commit", "-m", "P");
  const prev = g(work, "rev-parse", "HEAD");

  for (const [name, body] of Object.entries(bFiles)) {
    mkdirSync(join(work, name, ".."), { recursive: true });
    writeFileSync(join(work, name), body);
  }
  if (changeInitDb) writeFileSync(join(work, "scripts", "init-db.js"), "// init-db as of B\n");
  writeFileSync(join(work, "b.txt"), "B\n");
  g(work, "add", "-A");
  g(work, "commit", "-m", "B");
  const bad = g(work, "rev-parse", "HEAD");
  return { root, work, prev, bad };
}

/** A crow.db in the shape the running gateway leaves behind. */
function makeDb({ userVersion = 9, ids = [], table = true, dir = null } = {}) {
  const base = dir ?? mkdtempSync(join(tmpdir(), "bg-db-"));
  if (!dir) _dirs.push(base);
  const dbPath = join(base, "crow.db");
  const db = new DatabaseSync(dbPath);
  if (table) {
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT, sha TEXT)");
    for (const id of ids) db.prepare("INSERT INTO schema_migrations (id, applied_at, sha) VALUES (?, 'now', NULL)").run(id);
  }
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return dbPath;
}

const check = (f, dbPath) => evaluateSchema({ root: f.work, previous: f.prev, pending: f.bad, dbPath });

/* ------------------------------------------------------------------ cases */

test("unchanged schema → rollback is allowed", () => {
  const f = fixture();
  const r = check(f, makeDb({ userVersion: 9 }));
  assert.equal(r.ok, true, `expected a rollback, got refusal ${r.reason}`);
  assert.equal(r.previousGeneration, 9);
});

test("a registry id whose file is byte-identical in P and B is fine", () => {
  // Rule (a): P already knew this migration, so its shape cannot be a surprise.
  // rollbackSafe = false on purpose — the byte-identical rule wins.
  const f = fixture({
    pFiles: { "scripts/migrations/0001-old.mjs": MIGRATION("0001-old", false) },
  });
  const r = check(f, makeDb({ ids: ["0001-old"] }));
  assert.equal(r.ok, true, `got ${r.reason}`);
});

test("a new registry id with rollbackSafe = true rolls back", () => {
  const f = fixture({ bFiles: { "scripts/migrations/0009-new.mjs": MIGRATION("0009-new", true) } });
  const r = check(f, makeDb({ ids: ["0009-new"] }));
  assert.equal(r.ok, true, `got ${r.reason}`);
});

test("a new registry id with rollbackSafe = false refuses", () => {
  const f = fixture({ bFiles: { "scripts/migrations/0009-new.mjs": MIGRATION("0009-new", false) } });
  const r = check(f, makeDb({ ids: ["0009-new"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "migration-not-rollback-safe");
  assert.equal(r.detail.id, "0009-new");
});

test("a new registry id with NO rollbackSafe export refuses", () => {
  const f = fixture({ bFiles: { "scripts/migrations/0009-new.mjs": 'export const id = "0009-new";\n' } });
  const r = check(f, makeDb({ ids: ["0009-new"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "migration-not-rollback-safe");
});

test("two rollbackSafe declarations refuse (exactly one is required)", () => {
  const f = fixture({
    bFiles: {
      "scripts/migrations/0009-new.mjs":
        'export const rollbackSafe = true;\nexport const rollbackSafe = false;\n',
    },
  });
  const r = check(f, makeDb({ ids: ["0009-new"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "migration-not-rollback-safe");
});

test("a registry id with no file in B refuses", () => {
  const f = fixture();
  const r = check(f, makeDb({ ids: ["0099-ghost"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "migration-unknown");
});

test("user_version above P's generation refuses", () => {
  const f = fixture({ pGeneration: 9 });
  const r = check(f, makeDb({ userVersion: 10 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "db-ahead");
  assert.equal(r.detail.userVersion, 10);
  assert.equal(r.detail.previousGeneration, 9);
});

test("an unparseable generation in P refuses", () => {
  const f = fixture({ pSchemaModule: "export const SOMETHING_ELSE = 3;\n" });
  const r = check(f, makeDb());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "generation-unreadable");
});

test("a changed scripts/init-db.js refuses (it rebuilds tables with no bump)", () => {
  const f = fixture({ changeInitDb: true });
  const r = check(f, makeDb());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "init-db-changed");
});

test("a missing schema_migrations table counts as an empty set", () => {
  const f = fixture();
  const r = check(f, makeDb({ table: false, userVersion: 9 }));
  assert.equal(r.ok, true, `got ${r.reason}`);
  assert.deepEqual(r.migrationIds, []);
});

test("an unreadable database refuses (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-baddb-"));
  _dirs.push(dir);
  const dbPath = join(dir, "crow.db");
  writeFileSync(dbPath, "this is not a sqlite database, not even close\n".repeat(64));
  const f = fixture();
  const r = check(f, dbPath);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "db-unreadable");
});

test("a symlinked db_path is rejected", () => {
  const f = fixture();
  const real = makeDb();
  const dir = mkdtempSync(join(tmpdir(), "bg-linkdb-"));
  _dirs.push(dir);
  const link = join(dir, "crow.db");
  symlinkSync(real, link);
  assert.equal(validateDbPath(link), "db-path-invalid");
  const r = check(f, link);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "db-path-invalid");
});

test("a db_path that is not named crow.db is rejected", () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), "bg-name-"));
  _dirs.push(dir);
  const other = join(dir, "tasks.db");
  writeFileSync(other, "");
  assert.equal(validateDbPath(other), "db-path-invalid");
  assert.equal(check(f, other).reason, "db-path-invalid");
});

test("a missing db_path refuses instead of guessing", () => {
  const f = fixture();
  assert.equal(check(f, null).reason, "db-unknown");
});

test("B's migration file is read as text and NEVER imported", () => {
  const f = fixture();
  const sentinel = join(f.root, "migration-imported");
  // Written into B AFTER the commits are made, then amended in, so the sentinel
  // path is absolute (the launcher must never evaluate this file).
  writeFileSync(
    join(f.work, "scripts", "migrations", "0009-boom.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "x");\n`
      + `export const id = "0009-boom";\nexport const rollbackSafe = true;\n`,
  );
  g(f.work, "add", "-A");
  g(f.work, "commit", "--amend", "-m", "B");
  const bad = g(f.work, "rev-parse", "HEAD");
  const r = evaluateSchema({ root: f.work, previous: f.prev, pending: bad, dbPath: makeDb({ ids: ["0009-boom"] }) });
  assert.equal(r.ok, true, `got ${r.reason}`);
  assert.equal(existsSync(sentinel), false, "the launcher imported a migration from the sha it is judging");
});