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
import { backupDirFor, evaluateSchema, refusalText, validateDbPath } from "../scripts/boot-guard/crow-boot-guard.mjs";

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

/* ------------------------------------------------------------ refusal text */

/** Every refusal reason the launcher can print (the switch's cases + default). */
const REFUSAL_REASONS = [
  "db-ahead", "init-db-changed", "migration-not-rollback-safe", "migration-unknown",
  "generation-unreadable", "init-db-unknown", "db-unreadable", "db-path-invalid", "db-unknown",
  "unproven-previous", "not-on-main", "previous-not-ancestor", "something-new",
];
/** Backups are only ever named for the change that took one (S2) — the
 *  directory the migration guard writes them to is re-derived here. */
test("the backup directory is the migration guard's own (<db dir>/backups/migrations)", () => {
  assert.equal(backupDirFor("/home/u/.crow/data/crow.db"), join("/home/u/.crow/data", "backups", "migrations"));
  // `resolve()` first, exactly as guardAnchor does: a relative or dotted DB path
  // must not produce a different directory than the one the guard writes to.
  assert.equal(backupDirFor("/home/u/./.crow/data/crow.db"), join("/home/u", ".crow", "data", "backups", "migrations"));
  assert.equal(backupDirFor("relative/crow.db"), join(process.cwd(), "relative", "backups", "migrations"));
  assert.equal(backupDirFor(null), null);
});

const textFor = (reason, dbPath) => refusalText(reason, {
  root: "/checkout",
  detail: { id: "0009-new", userVersion: 10, previousGeneration: 9 },
  failures: 3,
  pending: "b".repeat(40),
  previous: "a".repeat(40),
  dbPath,
});

/** A crow.db whose guard backup directory holds exactly `files`. */
function dbWithBackups({ withBackup = false, files = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bg-texts-"));
  _dirs.push(dir);
  const backupDir = join(dir, "backups", "migrations");
  mkdirSync(backupDir, { recursive: true });
  const names = files ?? (withBackup ? ["crow-pre-g9-to-g10-2026-01-02.db"] : []);
  for (const name of names) writeFileSync(join(backupDir, name), "not really a db\n");
  return join(dir, "crow.db");
}

test("an older backup from another migration is never named or recommended (S2)", () => {
  // init-db-changed, the registry reasons, an unreadable DB: NONE of them takes
  // a backup, so the only file in the directory belongs to an EARLIER migration.
  // Restoring it would silently lose every write since it was taken — the old
  // text recommended exactly that ("restore the newest pre-migration backup").
  const older = "crow-pre-g7-to-g8-2026-01-01-00-00-00-000Z.db";
  const dbPath = dbWithBackups({ files: [older] });
  const dir = backupDirFor(dbPath);
  for (const reason of REFUSAL_REASONS) {
    const text = textFor(reason, dbPath);
    assert.ok(!text.includes(older), `${reason} named an unrelated older backup: ${text}`);
    assert.match(text, /No backup was taken for this change/, `${reason} must say none was taken: ${text}`);
    assert.ok(!/restore the/i.test(text), `${reason} must give no restore step: ${text}`);
    assert.ok(text.includes(dir), `${reason} must still name the directory ${dir}`);
  }
});

test("a db-ahead refusal names the backup taken for THAT crossing (S2)", () => {
  const mine = "crow-pre-g9-to-g10-2026-02-03-04-05-06-000Z.db";
  const older = "crow-pre-g8-to-g9-2026-01-01-00-00-00-000Z.db";
  const dbPath = dbWithBackups({ files: [older, mine] });
  const full = join(backupDirFor(dbPath), mine);
  const text = textFor("db-ahead", dbPath);
  assert.ok(text.includes(full), `db-ahead must name the g9→g10 backup: ${text}`);
  assert.ok(!text.includes(older), `db-ahead must not name another crossing's backup: ${text}`);
  assert.ok(text.includes(`restore ${full}, `), `the restore step must name that file: ${text}`);
});

test("a db-ahead refusal whose own backup is missing names no file and no restore (S2)", () => {
  // The file name carries the pair of generations, so a directory full of older
  // backups is NOT evidence that this crossing took one.
  const dbPath = dbWithBackups({ files: ["crow-pre-g8-to-g9-2026-01-01-00-00-00-000Z.db"] });
  const text = textFor("db-ahead", dbPath);
  assert.match(text, /No backup was taken for this change/, text);
  assert.ok(!/restore the/i.test(text), `no matching file, so no restore step: ${text}`);
  assert.ok(text.includes(backupDirFor(dbPath)), "the directory is still named");
});

test("a registry migration refusal never sends the operator to a backup it never took (F3)", () => {
  // The live report: `migration-not-rollback-safe` told the operator to restore
  // "the pre-migration backup the migration guard took", and no such backup
  // existed for that change.
  for (const withBackup of [false, true]) {
    const dbPath = dbWithBackups({ withBackup });
    const text = textFor("migration-not-rollback-safe", dbPath);
    assert.ok(!/restore the/i.test(text), `the registry refusal must not promise a restore: ${text}`);
    assert.ok(!/To recover: stop the gateway, restore/.test(text),
      "a registry migration leaves nothing of its own to restore");
    assert.match(text, /reset --keep/, "the git recovery step is still there");
  }
});

test("a refusal names the real backup directory when a backup exists (F3)", () => {
  const dbPath = dbWithBackups({ withBackup: true });
  const dir = backupDirFor(dbPath);
  for (const reason of REFUSAL_REASONS) {
    const text = textFor(reason, dbPath);
    assert.ok(text.includes(dir), `${reason} must name ${dir}`);
  }
  // A generation crossing DOES take a backup, so its exact file is named and can
  // be restored (S2: name the file, never "the newest" in the directory).
  const backup = join(dir, "crow-pre-g9-to-g10-2026-01-02.db");
  assert.ok(textFor("db-ahead", dbPath).includes(`restore ${backup}, `));
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