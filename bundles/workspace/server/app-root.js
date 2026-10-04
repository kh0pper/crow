/**
 * Resolve the Crow app repo root from an INSTALLED copy (~/.crow/bundles/…)
 * or an in-repo run. The gateway exports CROW_APP_ROOT for itself and its
 * spawned addon children; the relative guess covers direct in-repo runs.
 * The W2-5 migration's static `../../../servers/...` imports only resolved
 * in-repo — this resolver is what lets the installed copy run at all.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
function looksLikeAppRoot(p) { return !!p && existsSync(join(p, "servers", "db.js")); }
const guess = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// pi bots spawn this server from a raw mcp-addons block where CROW_APP_ROOT may be unset; from an
// installed copy the relative guess lands on ~, so also try ~/crow (review I11).
const homeCrow = join(homedir(), "crow");
export const APP_ROOT = looksLikeAppRoot(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT
  : looksLikeAppRoot(guess) ? guess
  : looksLikeAppRoot(homeCrow) ? homeCrow
  : (process.env.CROW_APP_ROOT || guess);
export const appImport = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);
