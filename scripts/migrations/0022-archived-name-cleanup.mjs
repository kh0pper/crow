// scripts/migrations/0022-archived-name-cleanup.mjs
//
// Old archive code renamed a project "<name> — archived" (space, em dash, space, "archived"). Archive
// no longer touches the name, so those leftovers are noise: strip exactly that trailing suffix from
// projects that are ARCHIVED (status 'archived') and NOT deleted (archived_at IS NULL).
//
// DATA ONLY, no DDL, no SCHEMA_GENERATION bump. It never writes archived_at (that column means
// "deleted", the hidden tombstone from permanent Delete), never touches a deleted row or an active
// one, and never touches any other column. Idempotent: once the suffix is gone nothing matches.
// init-db.js runs the same statement (ARCHIVED_NAME_CLEANUP_SQL) as a guarded step, so a fresh or
// old install converges on its own restart as well as through this rail.
import Database from "better-sqlite3";

export const id = "0022-archived-name-cleanup";

export const ARCHIVED_NAME_SUFFIX = " — archived";

// The suffix is 11 characters (SQLite LENGTH/SUBSTR count characters, not bytes). The length guard
// keeps a name that IS only the suffix from becoming empty.
export const ARCHIVED_NAME_CLEANUP_SQL = `
  UPDATE project_spaces
     SET name = SUBSTR(name, 1, LENGTH(name) - LENGTH('${ARCHIVED_NAME_SUFFIX}'))
   WHERE status = 'archived' AND archived_at IS NULL
     AND LENGTH(name) > LENGTH('${ARCHIVED_NAME_SUFFIX}')
     AND SUBSTR(name, -LENGTH('${ARCHIVED_NAME_SUFFIX}')) = '${ARCHIVED_NAME_SUFFIX}'`;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    const cols = db.prepare("PRAGMA table_info(project_spaces)").all().map((c) => c.name);
    if (!["name", "status", "archived_at"].every((c) => cols.includes(c))) {
      // init-db has not built the table yet: try again next boot, do not record as applied.
      log("  archived-name cleanup: project_spaces not ready, deferred");
      return { deferred: true };
    }
    const n = db.transaction(() => db.prepare(ARCHIVED_NAME_CLEANUP_SQL).run().changes).immediate();
    log(`  archived-name cleanup: ${n} renamed`);
    return { applied: true, results: [`archived-name cleanup: ${n} renamed`] };
  } finally {
    db.close();
  }
}
