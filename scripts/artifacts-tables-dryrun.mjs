/**
 * The artifacts bundle's schema rail: run the bundle's own `initArtifactsTables` against COPIES of live
 * databases and report every change it makes to a table that module creates.
 *
 * WHY: `scripts/schema-migration-dryrun.sh` runs `init-db.js` only. The artifacts tables are created by
 * the bundle (a `CREATE TABLE IF NOT EXISTS` block in `bundles/artifacts/server/init-tables.js`), so a
 * change there is invisible to that harness and, on every live database, reaches only tables that do not
 * exist yet: SQLite cannot alter a CHECK in place and no bundle table is rebuilt. This harness is what
 * proves it: it records `sqlite_master.sql` and `PRAGMA table_info` for every table that module creates —
 * the `artifact*` family plus `design_house_styles`, the one consumer-neutral table it also owns — before
 * and after the init, and fails on any existing table whose SQL text changed or any column that went
 * away. TABLES ADDED are expected and are reported, not failed.
 *
 * The table set is spelled out rather than "every table the init touched": a table the init ever STOPPED
 * creating is still in the before snapshot and would otherwise be reported as removed on every copy.
 *
 * COPY ONLY: a path must end in `.db`, must not be this instance's live crow.db, and is copied to a
 * temporary file first; the init runs against that copy. Nothing here writes to the path you name.
 *
 * Usage: node scripts/artifacts-tables-dryrun.mjs <db-copy-path>...
 * Exit code: 0 when every copy ends unchanged (a table may be added), 1 when a table changed, a column
 * was removed, a table was removed, or a path was refused.
 */
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDbClient, resolveDbPath } from "../servers/db.js";

/** The installed bundle's table module (the same one the gateway mount calls). */
const INIT_TABLES_URL = new URL("../bundles/artifacts/server/init-tables.js", import.meta.url);

/** Every table `init-tables.js` creates: the artifacts family, plus the design-kit house style
 *  (`design_house_styles`, bundle-owned here and read by `servers/shared/design-kit.js`). */
const BUNDLE_TABLE = /^(artifacts|artifact_[a-z_]+|design_house_styles)$/;

function line(label, values) {
  return `  ${label}: ${values.length ? values.join(", ") : "none"}`;
}

/**
 * Every one of the bundle's tables' stored SQL text and its columns, as a plain object keyed by table
 * name: the `artifact*` family plus `design_house_styles` (see BUNDLE_TABLE).
 *
 * `PRAGMA table_info` rows are copied field by field (name, type, notnull, default, pk), so two snapshots
 * can be compared by value.
 *
 * @param {object} db a libsql-shaped client
 * @returns {Promise<Record<string, {sql: string, columns: object[]}>>}
 */
export async function snapshotArtifactTables(db) {
  const { rows } = await db.execute({
    sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
    args: [],
  });
  const out = {};
  for (const row of rows) {
    if (!BUNDLE_TABLE.test(row.name)) continue;
    const info = (await db.execute({ sql: `PRAGMA table_info(${row.name})`, args: [] })).rows;
    out[row.name] = {
      sql: row.sql,
      columns: info.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: Number(c.notnull),
        dflt_value: c.dflt_value ?? null,
        pk: Number(c.pk),
      })),
    };
  }
  return out;
}

/**
 * What the second snapshot did to the first. Pure, so a test can hand it two synthetic snapshots.
 *
 * `ok` is true only when no existing table's SQL text moved, no column was removed and no table was
 * removed. An added table is not a failure: that is how the one additive bundle schema change (a new
 * table) reaches a live database.
 *
 * @param {Record<string, {sql: string, columns: object[]}>} before
 * @param {Record<string, {sql: string, columns: object[]}>} after
 * @returns {{tablesAdded: string[], tablesRemoved: string[], tablesChanged: string[],
 *   columnsRemoved: {table: string, column: string}[], ok: boolean}}
 */
export function diffArtifactTables(before, after) {
  const b = before || {};
  const a = after || {};
  const tablesAdded = [];
  const tablesRemoved = [];
  const tablesChanged = [];
  const columnsRemoved = [];
  for (const name of Object.keys(a)) if (!Object.hasOwn(b, name)) tablesAdded.push(name);
  for (const name of Object.keys(b)) {
    if (!Object.hasOwn(a, name)) {
      tablesRemoved.push(name);
      continue;
    }
    if (b[name].sql !== a[name].sql) tablesChanged.push(name);
    const remaining = new Set((a[name].columns || []).map((c) => c.name));
    for (const column of b[name].columns || []) {
      if (!remaining.has(column.name)) columnsRemoved.push({ table: name, column: column.name });
    }
  }
  return {
    tablesAdded,
    tablesRemoved,
    tablesChanged,
    columnsRemoved,
    ok: tablesChanged.length === 0 && columnsRemoved.length === 0 && tablesRemoved.length === 0,
  };
}

/** This instance's live crow.db, resolved, so it can be refused even when named by another spelling. */
function liveDbPath() {
  try {
    return resolveDbPath();
  } catch {
    return null;
  }
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Why a named path may not be used, or null when it may. */
function refusal(input) {
  if (!input || typeof input !== "string") return "no path";
  if (!input.endsWith(".db")) return "not a .db file";
  if (!existsSync(input)) return "no such file";
  if (!realOrNull(input)) return "cannot read the file";
  const live = liveDbPath();
  if (live && realOrNull(live) === realOrNull(input)) {
    return "that is this instance's live crow.db; pass a copy";
  }
  return null;
}

/**
 * Run the init against ONE copy and print its diff.
 *
 * @param {string} input the copy the caller names
 * @param {{log: Function, error: Function}} out
 * @returns {Promise<boolean>} whether the copy ended unchanged
 */
export async function dryRunOne(input, out = { log: console.log, error: console.error }) {
  const refused = refusal(input);
  if (refused) {
    out.error(`${input}: refused (${refused})`);
    return false;
  }
  out.log(`${input}`);
  const workDir = mkdtempSync(join(tmpdir(), "artifacts-tables-dryrun-"));
  let db = null;
  try {
    const copyPath = join(workDir, "copy.db");
    copyFileSync(input, copyPath);
    // A copy taken while its source was open in WAL mode can carry its -wal beside it: without that
    // file the copy would silently miss the newest pages (and report tables as absent that are there).
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(input + suffix)) copyFileSync(input + suffix, copyPath + suffix);
    }
    db = createDbClient(copyPath);
    const before = await snapshotArtifactTables(db);
    const { initArtifactsTables } = await import(INIT_TABLES_URL.href);
    await initArtifactsTables(db);
    const after = await snapshotArtifactTables(db);
    const diff = diffArtifactTables(before, after);
    out.log(line("tables added", diff.tablesAdded));
    out.log(line("tables removed", diff.tablesRemoved));
    out.log(line("tables changed", diff.tablesChanged));
    out.log(line("columns removed", diff.columnsRemoved.map((c) => `${c.table}.${c.column}`)));
    out.log(`  result: ${diff.ok ? "ok" : "CHANGED"}`);
    return diff.ok;
  } catch (err) {
    out.error(`  failed: ${err && err.message ? err.message : String(err)}`);
    return false;
  } finally {
    try {
      db?.close?.();
    } catch {
      // closing a client that already failed is not worth a line of its own
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (!argv.length) {
    console.error("usage: node scripts/artifacts-tables-dryrun.mjs <db-copy-path>...");
    return 2;
  }
  let failures = 0;
  for (const input of argv) {
    if (!(await dryRunOne(input))) failures += 1;
  }
  console.log(`summary: ${argv.length - failures} unchanged, ${failures} changed or refused`);
  return failures ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`artifacts-tables-dryrun failed: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
}