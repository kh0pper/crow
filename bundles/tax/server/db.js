/**
 * Crow Tax — Database Client
 *
 * Reuses the standard Crow DB pattern.
 */

import { appImport } from "./app-root.js";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) {
    return resolve(process.env.CROW_DATA_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  if (home && existsSync(crowHome)) {
    return crowHome;
  }
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return resolve(home || ".", "data");
}

let _coreCreateDbClient = null;
try {
  ({ createDbClient: _coreCreateDbClient } = await appImport("servers/db.js"));
} catch (err) {
  console.warn(
    `[tax db] core db client unavailable (${err.message}) — ` +
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
    console.warn(`[tax db] core db client failed (${err.message.split("\n")[0]}) -- ` +
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
      client.execute(p).catch(err => console.warn("[tax db]", p, "failed:", err.message));
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
  const filePath = dbPath || process.env.CROW_TAX_DB_PATH || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const core = tryCoreClient(filePath);
  if (core) return core;
  return libsqlProxy(filePath);
}
