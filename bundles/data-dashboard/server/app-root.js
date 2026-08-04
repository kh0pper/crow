/**
 * Resolve the Crow app repo root from an INSTALLED copy (a bundles dir under any ~/.crow home)
 * or an in-repo run, so bundle code can import the shared better-sqlite3
 * db client instead of carrying its own SQLite build.
 *
 * WHY THIS MATTERS (2026-08-04 corruption root cause): loading a second
 * SQLite implementation (@libsql/client) into a process that already holds
 * better-sqlite3 connections defeats SQLite's last-closer detection -- POSIX
 * fcntl locks never conflict within one PID, so a libsql connection close
 * "wins" its am-I-alone check and unlinks crow.db-wal/-shm out from under
 * every other connection. Split WAL generations then corrupt the DB.
 * Panel routes import bundle server modules INTO the gateway process, so a
 * bundle that opens crow.db must always reach the gateway's own client.
 *
 * Resolution: CROW_APP_ROOT (exported by the gateway to its children) ->
 * relative guess (in-repo runs) -> ~/crow (conventional lab checkout, covers
 * externally spawned stdio MCP copies that get no CROW_APP_ROOT).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
function looksLikeAppRoot(p) { return !!p && existsSync(join(p, "servers", "db.js")); }
const guess = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const conventional = join(homedir(), "crow");
export const APP_ROOT = looksLikeAppRoot(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT
  : looksLikeAppRoot(guess) ? guess
  : looksLikeAppRoot(conventional) ? conventional
  : (process.env.CROW_APP_ROOT || guess);
export const appImport = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);
