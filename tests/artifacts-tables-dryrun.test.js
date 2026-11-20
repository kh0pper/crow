// The artifacts-tables schema rail (scripts/artifacts-tables-dryrun.mjs): run the bundle's own
// initArtifactsTables against a COPY of a database and report every change to a table the bundle
// creates (the artifact* family plus design_house_styles).
//
// The real script is spawned, so its exit code and its copy-only behaviour are what is exercised. The
// changed-SQL detection is tested through the exported `diffArtifactTables` against synthetic snapshots:
// the init never alters an existing table, so a real database cannot produce that case.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { diffArtifactTables, snapshotArtifactTables } from "../scripts/artifacts-tables-dryrun.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO, "scripts", "artifacts-tables-dryrun.mjs");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A scratch instance: a real init-db'd crow.db, and the data dir its live path resolves to. */
function scratchInstance(prefix) {
  const dir = tmp(prefix);
  execFileSync(process.execPath, ["scripts/init-db.js"],
    { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO });
  return { dir, dbPath: join(dir, "crow.db") };
}

function spawnDryRun(paths, { dataDir }) {
  return spawnSync(process.execPath, [SCRIPT, ...paths], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: "" },
  });
}

/** A copy of the database, sidecars included: a WAL-mode source keeps its newest pages in -wal. */
function copyDb(dbPath, destDir) {
  const dest = join(destDir, "copy.db");
  copyFileSync(dbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    try { copyFileSync(dbPath + suffix, dest + suffix); } catch { /* no sidecar */ }
  }
  return dest;
}

test("a copy of a freshly initialised database is unchanged (exit 0, the bundle tables are added)", () => {
  const instance = scratchInstance("artifacts-dryrun-fresh-");
  const copy = copyDb(instance.dbPath, tmp("artifacts-dryrun-copy-"));
  const out = spawnDryRun([copy], { dataDir: instance.dir });

  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /tables added: .*artifacts/);
  assert.match(out.stdout, /tables added: .*design_house_styles/,
    "the bundle's other table is in the snapshot, so the init's creation of it is reported");
  assert.match(out.stdout, /tables changed: none/);
  assert.match(out.stdout, /columns removed: none/);
  assert.match(out.stdout, /result: ok/);
  assert.match(out.stdout, /summary: 1 unchanged, 0 changed or refused/);
});

test("a copy that already has the artifact tables ends with no change at all (exit 0)", async () => {
  const instance = scratchInstance("artifacts-dryrun-ready-");
  const db = createDbClient(instance.dbPath);
  try {
    await initArtifactsTables(db);
    // Fold the WAL back into the main file, so the copy below is one complete database.
    await db.execute({ sql: "PRAGMA wal_checkpoint(TRUNCATE)", args: [] });
  } finally {
    db.close();
  }
  const copy = copyDb(instance.dbPath, tmp("artifacts-dryrun-copy2-"));
  const out = spawnDryRun([copy], { dataDir: instance.dir });

  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /tables added: none/);
  assert.match(out.stdout, /result: ok/);
});

test("the snapshot is every table the bundle creates: the artifact* family and design_house_styles", async () => {
  const dir = tmp("artifacts-dryrun-snap-");
  const db = createDbClient(join(dir, "crow.db"));
  try {
    await initArtifactsTables(db);
    const snap = await snapshotArtifactTables(db);
    const names = Object.keys(snap);
    assert.ok(names.length > 0);
    assert.ok(names.every((n) => n === "artifacts" || n.startsWith("artifact_") || n === "design_house_styles"),
      `only the bundle's tables: ${names.join(", ")}`);
    for (const expected of [
      "artifacts", "artifact_versions", "artifact_version_holds", "design_house_styles",
    ]) {
      assert.ok(names.includes(expected), `${expected} is snapshotted`);
    }
    assert.ok(!names.includes("reports"), "core tables are out of scope");
    // This database was created empty, so every table in it is one init-tables.js just
    // created: the snapshot must name exactly those. A table added to init-tables.js
    // without a matching line in the script fails here.
    const created = (await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table'", args: [] })).rows
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"));
    assert.deepEqual(names.slice().sort(), created.slice().sort(),
      `the snapshot is every table the bundle creates: ${created.join(", ")}`);
    assert.match(snap.artifacts.sql, /CREATE TABLE/);
    assert.deepEqual(snap.artifacts.columns.map((c) => c.name).slice(0, 2), ["id", "title"]);
    assert.deepEqual(snap.design_house_styles.columns.map((c) => c.name), ["project_uuid", "theme", "set_at"]);
  } finally {
    db.close();
  }
});

test("diffArtifactTables fails a changed table's SQL text, and passes an added table", () => {
  const before = {
    artifacts: {
      sql: "CREATE TABLE artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
      columns: [
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ],
    },
  };
  const unchanged = structuredClone(before);
  assert.deepEqual(diffArtifactTables(before, unchanged), {
    tablesAdded: [], tablesRemoved: [], tablesChanged: [], columnsRemoved: [], ok: true,
  });

  const added = structuredClone(before);
  added.artifact_version_holds = {
    sql: "CREATE TABLE artifact_version_holds (artifact_id TEXT NOT NULL, n INTEGER NOT NULL, holder TEXT NOT NULL, until TEXT, PRIMARY KEY (artifact_id, n, holder))",
    columns: [{ name: "artifact_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 }],
  };
  const addDiff = diffArtifactTables(before, added);
  assert.deepEqual(addDiff.tablesAdded, ["artifact_version_holds"]);
  assert.equal(addDiff.ok, true, "a new table is the one additive bundle schema change");

  const changed = structuredClone(before);
  changed.artifacts.sql = before.artifacts.sql.replace("title TEXT NOT NULL", "title TEXT");
  const changedDiff = diffArtifactTables(before, changed);
  assert.deepEqual(changedDiff.tablesChanged, ["artifacts"]);
  assert.equal(changedDiff.ok, false);
});

test("diffArtifactTables fails a removed column and a removed table", () => {
  const before = {
    artifacts: {
      sql: "CREATE TABLE artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
      columns: [
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ],
    },
    artifact_versions: { sql: "CREATE TABLE artifact_versions (artifact_id TEXT NOT NULL)", columns: [] },
  };

  const narrowed = structuredClone(before);
  narrowed.artifacts.columns = narrowed.artifacts.columns.filter((c) => c.name !== "title");
  const dropColumnDiff = diffArtifactTables(before, narrowed);
  assert.deepEqual(dropColumnDiff.columnsRemoved, [{ table: "artifacts", column: "title" }]);
  assert.equal(dropColumnDiff.ok, false);

  const dropped = structuredClone(before);
  delete dropped.artifact_versions;
  const dropTableDiff = diffArtifactTables(before, dropped);
  assert.deepEqual(dropTableDiff.tablesRemoved, ["artifact_versions"]);
  assert.equal(dropTableDiff.ok, false);
});

test("diffArtifactTables covers design_house_styles too", () => {
  const before = {
    design_house_styles: {
      sql: "CREATE TABLE design_house_styles (project_uuid TEXT PRIMARY KEY, theme TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (datetime('now')))",
      columns: [
        { name: "project_uuid", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "theme", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ],
    },
  };
  assert.equal(diffArtifactTables(before, structuredClone(before)).ok, true);

  const narrowed = structuredClone(before);
  narrowed.design_house_styles.columns = narrowed.design_house_styles.columns.filter((c) => c.name !== "theme");
  const narrowDiff = diffArtifactTables(before, narrowed);
  assert.deepEqual(narrowDiff.columnsRemoved, [{ table: "design_house_styles", column: "theme" }]);
  assert.equal(narrowDiff.ok, false);

  const changed = structuredClone(before);
  changed.design_house_styles.sql = before.design_house_styles.sql.replace("theme TEXT NOT NULL", "theme TEXT");
  const changedDiff = diffArtifactTables(before, changed);
  assert.deepEqual(changedDiff.tablesChanged, ["design_house_styles"]);
  assert.equal(changedDiff.ok, false);
});

test("the script refuses a path that is not a .db file, a missing file, and this instance's live crow.db", () => {
  const instance = scratchInstance("artifacts-dryrun-refuse-");
  const notDb = join(tmp("artifacts-dryrun-notdb-"), "crow.sqlite");
  copyFileSync(instance.dbPath, notDb);

  const wrongName = spawnDryRun([notDb], { dataDir: instance.dir });
  assert.equal(wrongName.status, 1);
  assert.match(wrongName.stderr, /refused \(not a \.db file\)/);

  const missing = spawnDryRun([join(instance.dir, "no-such.db")], { dataDir: instance.dir });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /refused \(no such file\)/);

  const live = spawnDryRun([instance.dbPath], { dataDir: instance.dir });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /refused \(that is this instance's live crow\.db; pass a copy\)/);

  assert.match(live.stdout, /summary: 0 unchanged, 1 changed or refused/);
});

test("no path at all is a usage error", () => {
  const out = spawnDryRun([], { dataDir: tmp("artifacts-dryrun-usage-") });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage: node scripts\/artifacts-tables-dryrun\.mjs/);
});