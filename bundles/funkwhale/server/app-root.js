/**
 * Resolve the Crow app root from an installed copy (the kiosk's pattern, without a guess at
 * ~/crow): CROW_APP_ROOT, which the gateway sets for itself and passes to the add-on servers
 * it starts, else the repo this file sits in. A co-hosted instance with its own app tree is
 * never sent to another tree.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
function looksLikeAppRoot(p) { return !!p && existsSync(join(p, "servers", "db.js")); }
const guess = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const APP_ROOT = looksLikeAppRoot(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT
  : looksLikeAppRoot(guess) ? guess
  : (process.env.CROW_APP_ROOT || guess);
export const appImport = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);
