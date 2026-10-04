/**
 * The crow.db client for the pending-change queue, opened LAZILY (createWorkspaceServer stays synchronous; every
 * queue path does `workspaceDb() || await openWorkspaceDb()`). One client per process. The db file's directory is
 * created first (F1: a fresh CROW_DATA_DIR must not make the first queued change fail).
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appImport } from "./app-root.js";
import { initWorkspaceTables } from "./init-tables.js";

let client = null, ready = null, openedPath = null;
export function workspaceDb() { return client; }
/** dbPath: explicit path (tests); default = what servers/db.js would open (CROW_DB_PATH, else <data dir>/crow.db). */
export function openWorkspaceDb(dbPath) {
  if (ready) {
    if (dbPath && openedPath && resolve(dbPath) !== openedPath) return Promise.reject(new Error(`workspace db already open at ${openedPath}`));
    return ready;
  }
  ready = (async () => {
    const { createDbClient, resolveDataDir } = await appImport("servers/db.js");
    const path = resolve(dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db"));
    mkdirSync(dirname(path), { recursive: true });
    const c = createDbClient(path);
    await initWorkspaceTables(c);
    openedPath = path; client = c;
    return c;
  })();
  ready.catch(() => { ready = null; }); // a failed open (unwritable dir…) is retried on the next queue path
  return ready;
}
