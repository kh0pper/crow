/** Resolve the Crow app root from an installed copy (ramble pattern; see bundles/ramble/server/app-root.js). */
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
