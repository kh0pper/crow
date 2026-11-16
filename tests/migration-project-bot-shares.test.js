// 0028-project-bot-shares: the project_bot_shares table on both rails — init-db.js's
// "project_bot_shares table" block and this numbered migration. DDL only; additive, no
// SCHEMA_GENERATION bump. The table is local-only: a share never replicates to a paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0028-project-bot-shares.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";

const { run, id, PROJECT_BOT_SHARES_DDL } = mod;
const REPO = new URL("..", import.meta.url).pathname;
const SYNC = await import("../servers/sharing/instance-sync.js");

const TABLE = "project_bot_shares";
const INDEXES = ["idx_project_bot_shares_bot", "idx_project_bot_shares_live"];

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freshDb(prefix) {
  const dbPath = join(tmp("pbs-" + prefix + "-"), "crow.db");
  new Database(dbPath).close();
  return dbPath;
}

/** Everything SQLite knows about this table: its columns, its indexes and its sqlite_master rows. */
function shape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return {
      cols: d.prepare(`PRAGMA table_info(${TABLE})`).all(),
      idx: d.prepare(`PRAGMA index_list(${TABLE})`).all().map(({ seq, ...rest }) => rest)
        .sort((a, b) => a.name.localeCompare(b.name)),
      idxCols: Object.fromEntries(INDEXES.map((n) => [n, d.prepare(`PRAGMA index_info(${n})`).all().map((c) => c.name)])),
      sql: d.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
                      WHERE tbl_name = ? OR name = ? ORDER BY type, name`).all(TABLE, TABLE),
    };
  } finally {
    d.close();
  }
}

/** init-db's OWN block for `label`, read straight out of the script. */
function initDbBlock(label) {
  const src = readFileSync(join(REPO, "scripts", "init-db.js"), "utf8");
  const marker = `initTable("${label}", \``;
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `init-db has no "${label}" block`);
  assert.equal(src.indexOf(marker, at + 1), -1, `init-db has more than one "${label}" block`);
  const from = at + marker.length;
  const to = src.indexOf("`);", from);
  assert.notEqual(to, -1, `init-db's "${label}" block is unterminated`);
  return src.slice(from, to);
}

function insertShare(db, { project = 1, bot = "bot-a", level = "read", revoked = null } = {}) {
  return db.prepare(`INSERT INTO ${TABLE} (project_id, bot_id, level, revoked_at) VALUES (?, ?, ?, ?)`)
    .run(project, bot, level, revoked);
}

/** The foreign key's target, with the projects the row tests share. */
function seedProjects(dbPath, ids = [1, 2, 3]) {
  const d = new Database(dbPath);
  try {
    d.exec("CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
    for (const n of ids) d.prepare("INSERT OR IGNORE INTO project_spaces (id, name) VALUES (?, ?)").run(n, `p${n}`);
  } finally { d.close(); }
}

test("the module id matches its filename", () => {
  assert.equal(id, "0028-project-bot-shares");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations"))
    .some((p) => p.endsWith("/0028-project-bot-shares.mjs")));
});

test("the migration creates the table and its indexes on an empty DB", () => {
  const dbPath = freshDb("empty");
  assert.equal(run({ dbPath, log: () => {} }).applied, true);

  const s = shape(dbPath);
  assert.deepEqual(s.cols.map((c) => c.name),
    ["id", "project_id", "bot_id", "level", "granted_by", "granted_at", "revoked_at"]);
  assert.deepEqual(s.cols.filter((c) => c.pk).map((c) => c.name), ["id"]);
  assert.equal(s.cols.find((c) => c.name === "id").type, "INTEGER");
  for (const name of ["project_id", "bot_id", "level", "granted_by", "granted_at"]) {
    assert.equal(s.cols.find((c) => c.name === name).notnull, 1, `${name} is NOT NULL`);
  }
  assert.equal(s.cols.find((c) => c.name === "revoked_at").notnull, 0, "revoked_at is nullable");
  assert.match(s.cols.find((c) => c.name === "granted_by").dflt_value, /owner/);
  assert.match(s.cols.find((c) => c.name === "granted_at").dflt_value, /datetime\('now'\)/);

  assert.deepEqual(s.idx.map((i) => i.name), INDEXES, "exactly the two declared indexes");
  const live = s.idx.find((i) => i.name === "idx_project_bot_shares_live");
  assert.equal(live.unique, 1, "the live index is UNIQUE");
  assert.equal(live.partial, 1, "the live index is partial");
  assert.deepEqual(s.idxCols.idx_project_bot_shares_live, ["project_id", "bot_id"]);
  assert.match(s.sql.find((o) => o.name === "idx_project_bot_shares_live").sql, /WHERE revoked_at IS NULL/);
  assert.equal(s.idx.find((i) => i.name === "idx_project_bot_shares_bot").unique, 0);
  assert.deepEqual(s.idxCols.idx_project_bot_shares_bot, ["bot_id"]);

  // The project is the only foreign key; bot_id is a text key onto pi_bot_defs with no FK, so a
  // deleted bot leaves a dead row that resolves to no access.
  const tableSql = s.sql.find((o) => o.name === TABLE).sql;
  assert.match(tableSql, /project_id\s+INTEGER NOT NULL REFERENCES project_spaces\(id\) ON DELETE CASCADE/);
  assert.equal((tableSql.match(/REFERENCES/g) || []).length, 1, "no foreign key on bot_id");
});

test("the migration is idempotent", () => {
  const dbPath = freshDb("idem");
  const first = run({ dbPath, log: () => {} });
  assert.equal(first.applied, true);

  seedProjects(dbPath, [1]);
  const db = new Database(dbPath);
  insertShare(db, { project: 1, bot: "bot-a" });
  db.close();
  const before = shape(dbPath);

  const second = run({ dbPath, log: () => {} });
  assert.equal(second.applied, true);
  assert.deepEqual(shape(dbPath), before, "a second run changes nothing");

  const d = new Database(dbPath, { readonly: true });
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n, 1, "the row survives");
  d.close();
});

test("the migration declares rollbackSafe and its DDL neither drops nor deletes rows", () => {
  assert.equal(mod.rollbackSafe, true);
  const src = readFileSync(join(REPO, "scripts", "migrations", "0028-project-bot-shares.mjs"), "utf8");
  // The DDL's own "ON DELETE CASCADE" is a backstop, not a statement this rail issues.
  assert.doesNotMatch(src, /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
  assert.doesNotMatch(src, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(src, /\bRENAME\s+TO\b/i);
});

test("init-db's block is byte-identical to PROJECT_BOT_SHARES_DDL", () => {
  assert.equal(initDbBlock("project_bot_shares table"), PROJECT_BOT_SHARES_DDL);
});

test("init-db and the migration build the same shape", () => {
  const dir = tmp("pbs-init");
  execFileSync(process.execPath, ["scripts/init-db.js"],
    { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  const want = shape(join(dir, "crow.db"));
  assert.ok(want.cols.length > 0, "init-db created the table");

  const dbPath = freshDb("rail");
  run({ dbPath, log: () => {} });
  assert.deepEqual(shape(dbPath), want);
});

test("level only accepts read and read_write", () => {
  const dbPath = freshDb("level");
  run({ dbPath, log: () => {} });
  seedProjects(dbPath);
  const db = new Database(dbPath);
  try {
    assert.doesNotThrow(() => insertShare(db, { project: 1, bot: "bot-a", level: "read" }));
    assert.doesNotThrow(() => insertShare(db, { project: 2, bot: "bot-a", level: "read_write" }));
    assert.throws(() => insertShare(db, { project: 3, bot: "bot-a", level: "write" }), /CHECK/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n, 2, "the refused row was not stored");
  } finally { db.close(); }
});

test("one live share per (project, bot); a revoked row plus a live one is fine", () => {
  const dbPath = freshDb("unique");
  run({ dbPath, log: () => {} });
  seedProjects(dbPath);
  const db = new Database(dbPath);
  try {
    insertShare(db, { project: 1, bot: "bot-a" });
    assert.throws(() => insertShare(db, { project: 1, bot: "bot-a" }), /UNIQUE/,
      "two live rows for the same pair are refused");

    // A revoked row leaves the pair free again.
    db.prepare(`UPDATE ${TABLE} SET revoked_at = datetime('now') WHERE project_id = 1 AND bot_id = 'bot-a'`).run();
    assert.doesNotThrow(() => insertShare(db, { project: 1, bot: "bot-a" }), "revoked + live is accepted");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n, 2);

    // The pair is what is unique, not the bot or the project alone.
    assert.doesNotThrow(() => insertShare(db, { project: 2, bot: "bot-a" }));
    assert.doesNotThrow(() => insertShare(db, { project: 1, bot: "bot-b" }));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n, 4);
  } finally { db.close(); }
});

test("the table is local-only and assertLocalOnlyDisjoint passes", () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(TABLE), `${TABLE} is in LOCAL_ONLY_TABLES`);
  assert.ok(!SYNC.SYNCED_TABLES.includes(TABLE), `${TABLE} is not in SYNCED_TABLES`);
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", TABLE], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest(TABLE, { id: 1 }), false);
});