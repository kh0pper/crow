// scripts/pi-bots/pi_provider_id.mjs
/**
 * Which pi provider a bot turn spawns with, for a providers-row id (roles
 * phase 2, Task 17). The model half of the key never changes.
 *
 *  1. The row's own id, when pi's models.json has an entry under it (a
 *     hand-written entry, or a cloud row allow-listed by
 *     CROW_PI_MODELS_SYNC_CLOUD): the operator's entry wins.
 *  2. Otherwise, ONLY on the host-default home (the rule piModelsSyncPath
 *     uses to decide who writes the file), the cloud-door entry
 *     `crow-c-<rowId>` when the gateway wrote one. A co-hosted instance
 *     shares $HOME and so reads the primary's file, but the primary's door
 *     entries name the PRIMARY's rows and consent: never mapped onto (N1).
 *  3. Otherwise null for a pi built-in id: pi would fall through to the
 *     operator's own pi login for that provider, which a bot must never use.
 *     The caller fails the turn with the M2 wording.
 *  4. Otherwise the row id (pi's own "Unknown provider", or M2, handles it).
 *
 * No token is involved: the door entry's key is a `!cat` of a file pi reads
 * itself, so nothing is placed in any process environment.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PI_BUILTIN_PROVIDER_IDS, doorEntryId } from "../../servers/shared/pi-compat.js";

const BUILTIN = new Set(PI_BUILTIN_PROVIDER_IDS);

function has(json, id) {
  const p = json && typeof json === "object" ? json.providers : null;
  return !!p && typeof p === "object" && Object.hasOwn(p, id);
}

/**
 * @param {string} rowId
 * @param {object|null} piModelsJson  the parsed models.json (null when unreadable)
 * @param {{crowHome: string, homeDir: string}} where
 * @returns {string|null}
 */
export function piProviderIdFor(rowId, piModelsJson, { crowHome, homeDir } = {}) {
  if (typeof rowId !== "string" || !rowId) return null;
  if (has(piModelsJson, rowId)) return rowId;
  const defaultHome = typeof crowHome === "string" && typeof homeDir === "string"
    && resolve(crowHome) === resolve(homeDir, ".crow");
  if (defaultHome && has(piModelsJson, doorEntryId(rowId))) return doorEntryId(rowId);
  if (BUILTIN.has(rowId)) return null;
  return rowId;
}

/** The models.json the bot engine reads (the same path M2's file check uses). */
export function piModelsJsonPath(env = process.env) {
  return env.PI_MODELS_JSON || join(env.HOME || homedir(), ".pi", "agent", "models.json");
}

/** The parsed file, or null when it is missing or not JSON. */
export function readPiModelsJson({ path = piModelsJsonPath(), readFileFn = (p) => readFileSync(p, "utf8") } = {}) {
  try { return JSON.parse(readFileFn(path)); } catch { return null; }
}

/** piProviderIdFor for THIS process: its CROW_HOME, its HOME, the file now. */
export function piProviderIdHere(rowId, { env = process.env, piModelsJsonFn = () => readPiModelsJson({ path: piModelsJsonPath(env) }) } = {}) {
  const homeDir = env.HOME || homedir();
  return piProviderIdFor(rowId, piModelsJsonFn(), { crowHome: env.CROW_HOME || join(homeDir, ".crow"), homeDir });
}
