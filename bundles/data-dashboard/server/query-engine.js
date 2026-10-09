/**
 * Data Dashboard — query engine.
 *
 * A thin adapter over the app's shared dataset helper
 * (servers/shared/sqlite-datasets.js), which owns every rule:
 *   - which files a `sqlite` backend may open (the data dir's datasets/ or
 *     projects/<id>/databases/, never one of Crow's own databases, checked
 *     by realpath and inode);
 *   - read queries run in a short-lived child process with a time limit, on
 *     a read-only connection with `query_only`, one statement, SQLite's own
 *     read-only verdict, and row and byte caps enforced by stepping rows.
 *
 * There is no write path: crow_data_write is disabled while the Data
 * Dashboard is being retired. Import data with your own tools into the
 * datasets/ folder instead.
 *
 * Reached through the app root (never a repo-relative path) so the
 * installed copy under <CROW_HOME>/bundles/ resolves it too.
 */
import { appImport } from "./app-root.js";

const ds = await appImport("servers/shared/sqlite-datasets.js");

export const MAX_ROWS = ds.DEFAULT_MAX_ROWS;

/** Folder for the databases this bundle creates for a project. */
export function getProjectDbDir(projectId) {
  return ds.managedDatabasesDir(projectId);
}

/** True when `dbPath` may be opened as a dataset. */
export function isPathSafe(dbPath) {
  return ds.resolveDatasetPath(dbPath).ok;
}

/**
 * Run one read-only statement on a dataset.
 * @returns {Promise<{columns: string[], rows: object[], rowCount: number, truncated: boolean, executionMs: number}>}
 */
export async function executeReadQuery(dbPath, sql, limit = MAX_ROWS, opts = {}) {
  // In a child process with a wall-clock limit and row + byte caps
  // (opts: { timeoutMs, maxBytes }).
  return ds.runReadOnlyQueryAsync(dbPath, sql, { maxRows: limit, ...opts });
}

/** Tables, columns, row counts and indexes of a dataset. */
export async function getSchema(dbPath) {
  return ds.readDatasetSchema(dbPath);
}

/** Create an empty database in the project's managed folder; returns its path. */
export function createProjectDatabase(projectId, name) {
  return ds.createManagedDatabase(projectId, name);
}
