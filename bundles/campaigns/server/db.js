/**
 * Crow Campaigns — Database Client Factory
 *
 * Creates a @libsql/client instance pointing at Crow's shared crow.db.
 * Enables foreign keys for cascading deletes.
 */

import { appImport } from "./app-root.js";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Resolve the Crow data directory path.
 * Priority: CROW_DATA_DIR env -> ~/.crow/data/ -> ./data/ (fallback)
 */
export function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) {
    return resolve(process.env.CROW_DATA_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  if (home && existsSync(crowHome)) {
    return crowHome;
  }
  return resolve(home || ".", "data");
}

let _coreCreateDbClient = null;
try {
  ({ createDbClient: _coreCreateDbClient } = await appImport("servers/db.js"));
} catch (err) {
  console.warn(
    `[campaigns db] core db client unavailable (${err.message}) — ` +
    "will fall back to @libsql/client (safe cross-process only)"
  );
}

let _coreBroken = false;
/** Core factory with call-time fallback: better-sqlite3 binds its native
 *  module lazily at construction, so an ABI mismatch (e.g. a node 20
 *  process importing a node 22 build) throws HERE, not at import. */
function tryCoreClient(filePath) {
  if (_coreBroken || !_coreCreateDbClient) return null;
  try { return _coreCreateDbClient(filePath); }
  catch (err) {
    _coreBroken = true;
    console.warn(`[campaigns db] core db client failed (${err.message.split("\n")[0]}) -- ` +
      "falling back to @libsql/client (safe cross-process only)");
    return null;
  }
}


// Lazy @libsql fallback: never statically load a second SQLite build into a
// process that may already hold better-sqlite3 connections (see app-root.js
// header — 2026-08-04 corruption root cause).
function libsqlProxy(filePath, extraPragmas = []) {
  const clientPromise = import("@libsql/client").then(({ createClient }) => {
    const client = createClient({ url: `file:${filePath}` });
    for (const p of ["PRAGMA busy_timeout = 5000", ...extraPragmas]) {
      client.execute(p).catch(err => console.warn("[campaigns db]", p, "failed:", err.message));
    }
    return client;
  });
  return {
    async execute(arg) { return (await clientPromise).execute(arg); },
    async batch(stmts) { return (await clientPromise).batch(stmts); },
    async executeMultiple(sql) { return (await clientPromise).executeMultiple(sql); },
    close() { clientPromise.then((c) => c.close()).catch(() => {}); },
  };
}

export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const core = tryCoreClient(filePath);
  if (core) {
    core.execute("PRAGMA foreign_keys = ON").catch(err =>
      console.warn("[campaigns-db] Failed to enable foreign_keys:", err.message)
    );
    return core;
  }
  return libsqlProxy(filePath, ["PRAGMA foreign_keys = ON"]);
}
