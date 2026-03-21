/**
 * Data Dashboard — Safe SQL Query Engine
 *
 * Executes SQL on user-owned secondary databases (never crow.db).
 * Read-only queries validated by first-token inspection.
 * Write queries go through a separate path with explicit safety checks.
 */

import { createClient } from "@libsql/client";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

const READ_TOKENS = new Set(["SELECT", "EXPLAIN", "PRAGMA", "WITH"]);
const WRITE_TOKENS = new Set(["INSERT", "CREATE", "UPDATE", "DELETE", "ALTER", "DROP"]);
const MAX_ROWS = 5000;
const QUERY_TIMEOUT_MS = 10_000;

/**
 * Resolve the directory for project-scoped databases.
 */
export function getProjectDbDir(projectId) {
  const base = resolve(homedir(), ".crow", "data", "projects", String(projectId), "databases");
  mkdirSync(base, { recursive: true });
  return base;
}

/**
 * Open a connection to a user-owned SQLite database.
 * @param {string} dbPath - Absolute path to the .db file
 * @returns {import("@libsql/client").Client}
 */
export function openUserDb(dbPath) {
  return createClient({ url: `file:${dbPath}` });
}

/**
 * Validate that a SQL string is a read-only query.
 * Uses first-token validation (not a full parser, but catches common cases).
 */
export function isReadOnlySQL(sql) {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  // Strip leading comments
  const noComments = trimmed.replace(/^(--.*)$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const firstToken = noComments.split(/\s+/)[0]?.toUpperCase();

  return READ_TOKENS.has(firstToken);
}

/**
 * Validate that a SQL string is a write operation.
 */
export function isWriteSQL(sql) {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  const noComments = trimmed.replace(/^(--.*)$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const firstToken = noComments.split(/\s+/)[0]?.toUpperCase();

  return WRITE_TOKENS.has(firstToken);
}

/**
 * Ensure a database path is within the project databases directory.
 * Prevents path traversal attacks.
 */
export function isPathSafe(dbPath) {
  const crowData = resolve(homedir(), ".crow", "data");
  const resolved = resolve(dbPath);
  return resolved.startsWith(crowData) && !resolved.includes("..");
}

/**
 * Execute a read-only SQL query on a user database.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {string} sql - SQL query (must be SELECT/EXPLAIN/PRAGMA/WITH)
 * @param {number} [limit] - Max rows to return (default: MAX_ROWS)
 * @returns {Promise<{columns: string[], rows: object[], rowCount: number, executionMs: number}>}
 */
export async function executeReadQuery(dbPath, sql, limit = MAX_ROWS) {
  if (!isReadOnlySQL(sql)) {
    throw new Error("Only SELECT, EXPLAIN, PRAGMA, and WITH queries are allowed. Use crow_data_write for mutations.");
  }

  if (!isPathSafe(dbPath)) {
    throw new Error("Database path is outside the allowed data directory.");
  }

  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const userDb = openUserDb(dbPath);
  const start = Date.now();

  try {
    // Add LIMIT if not already present
    let safeSql = sql.trim();
    if (!safeSql.toUpperCase().includes("LIMIT")) {
      safeSql = `${safeSql} LIMIT ${limit}`;
    }

    const result = await Promise.race([
      userDb.execute(safeSql),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Query timed out (${QUERY_TIMEOUT_MS / 1000}s)`)), QUERY_TIMEOUT_MS)
      ),
    ]);

    const executionMs = Date.now() - start;
    const columns = result.columns || [];
    const rows = result.rows || [];

    return { columns, rows, rowCount: rows.length, executionMs };
  } finally {
    userDb.close();
  }
}

/**
 * Execute a write SQL statement on a user database.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {string} sql - SQL statement (INSERT/CREATE/UPDATE/DELETE/ALTER/DROP)
 * @returns {Promise<{rowsAffected: number, executionMs: number}>}
 */
export async function executeWriteQuery(dbPath, sql) {
  if (!isWriteSQL(sql)) {
    throw new Error("Only INSERT, CREATE, UPDATE, DELETE, ALTER, and DROP statements are allowed.");
  }

  if (!isPathSafe(dbPath)) {
    throw new Error("Database path is outside the allowed data directory.");
  }

  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const userDb = openUserDb(dbPath);
  const start = Date.now();

  try {
    const result = await Promise.race([
      userDb.execute(sql),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Query timed out (${QUERY_TIMEOUT_MS / 1000}s)`)), QUERY_TIMEOUT_MS)
      ),
    ]);

    const executionMs = Date.now() - start;
    return { rowsAffected: result.rowsAffected || 0, executionMs };
  } finally {
    userDb.close();
  }
}

/**
 * Get schema information for a user database.
 * @param {string} dbPath - Path to the SQLite database file
 * @returns {Promise<{tables: Array<{name, columns, rowCount, indexes}>}>}
 */
export async function getSchema(dbPath) {
  if (!isPathSafe(dbPath)) {
    throw new Error("Database path is outside the allowed data directory.");
  }

  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const userDb = openUserDb(dbPath);

  try {
    // Get all tables
    const { rows: tableRows } = await userDb.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    const tables = [];
    for (const { name } of tableRows) {
      // Get columns
      const { rows: colRows } = await userDb.execute(`PRAGMA table_info("${name}")`);
      const columns = colRows.map(c => ({
        name: c.name,
        type: c.type,
        notnull: !!c.notnull,
        pk: !!c.pk,
        default_value: c.dflt_value,
      }));

      // Get row count
      const { rows: countRows } = await userDb.execute(`SELECT COUNT(*) as c FROM "${name}"`);
      const rowCount = countRows[0]?.c || 0;

      // Get indexes
      const { rows: idxRows } = await userDb.execute(`PRAGMA index_list("${name}")`);
      const indexes = idxRows.map(i => i.name);

      tables.push({ name, columns, rowCount, indexes });
    }

    return { tables };
  } finally {
    userDb.close();
  }
}
