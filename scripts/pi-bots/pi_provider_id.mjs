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
 * pi matches --provider without regard to case, so every comparison here
 * does too: a case variant of a built-in ("OpenAI") is refused outright, and
 * an id the file holds under more than one case is ambiguous and refused.
 *
 * No token is involved: the door entry's key is a `!cat` of a file pi reads
 * itself, so nothing is placed in any process environment.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PI_BUILTIN_PROVIDER_IDS, DOOR_ID_PREFIX, doorEntryId } from "../../servers/shared/pi-compat.js";
import { isDefaultCrowHome } from "../../servers/shared/crow-home.js";

const BUILTIN = new Set(PI_BUILTIN_PROVIDER_IDS.map((id) => id.toLowerCase()));

/** True when pi would resolve `id` to one of its built-in providers (pi
 * matches --provider without regard to case: pi 0.85.1
 * dist/core/model-resolver.js lower-cases both sides). */
export function isPiBuiltinId(id) {
  return typeof id === "string" && BUILTIN.has(id.toLowerCase());
}

/** models.json provider ids grouped by their lower-cased form. */
function indexOf(json) {
  const idx = new Map();
  const p = json && typeof json === "object" ? json.providers : null;
  if (!p || typeof p !== "object") return idx;
  for (const k of Object.keys(p)) {
    const lk = k.toLowerCase();
    if (!idx.has(lk)) idx.set(lk, []);
    idx.get(lk).push(k);
  }
  return idx;
}

/** "ok" when `id` is the file's only entry under its lower-cased form,
 * "absent" when none is, "ambiguous" otherwise (pi would merge the case
 * variants, or pick one other than `id`). */
function lookup(idx, id) {
  const ks = idx.get(id.toLowerCase());
  if (!ks) return "absent";
  return ks.length === 1 && ks[0] === id ? "ok" : "ambiguous";
}

/**
 * @param {string} rowId
 * @param {object|null} piModelsJson  the parsed models.json (null when unreadable)
 * @param {{crowHome: string, homeDir: string}} where
 * @returns {string|null}
 */
export function piProviderIdFor(rowId, piModelsJson, { crowHome, homeDir } = {}) {
  if (typeof rowId !== "string" || !rowId) return null;
  // A case variant of a built-in ("OpenAI") resolves to the built-in in pi
  // whatever the file says: refuse it. The exact built-in id keeps rule 1
  // (an operator's own hand-written override).
  if (isPiBuiltinId(rowId) && rowId !== rowId.toLowerCase()) return null;
  const idx = indexOf(piModelsJson);
  const own = lookup(idx, rowId);
  if (own === "ok") return rowId;
  if (own === "ambiguous") return null;
  const defaultHome = typeof crowHome === "string" && typeof homeDir === "string"
    && isDefaultCrowHome({ CROW_HOME: crowHome }, homeDir);
  if (defaultHome) {
    const door = lookup(idx, doorEntryId(rowId));
    if (door === "ok") return doorEntryId(rowId);
    if (door === "ambiguous") return null;
  }
  if (isPiBuiltinId(rowId)) return null;
  return rowId;
}

/**
 * What the bot engine would run for `provider/model`, the one rule the
 * bridge (PiRpc, M2) and both pickers (Bot Builder, Perch) share.
 * → {ok:true, piProvider, key} | {ok:false, reason}
 * `ok` means pi will be spawned with `piProvider`; it does not mean the model
 * is listed (pickers check `key` against the file, M2 against pi itself).
 */
export function piSpawnTarget(provider, model, piModelsJson, where) {
  const piProvider = piProviderIdFor(provider, piModelsJson, where);
  if (piProvider == null) return { ok: false, reason: `model "${provider}/${model}" is not available to the bot engine` };
  return { ok: true, piProvider, key: `${piProvider}/${model}` };
}

/**
 * The providers-row id for a provider pi reports (a live child's model list,
 * its model_select event, a set_model answer): a crow-c-* door entry names
 * row `<rest>` on the host-default home; anything else is already a row id.
 * Keeps Perch's session state, persistence and metering in row-id space.
 */
export function rowIdForPiProvider(piProvider, { env = process.env } = {}) {
  if (typeof piProvider !== "string") return piProvider;
  const homeDir = env.HOME || homedir();
  if (!isDefaultCrowHome({ CROW_HOME: env.CROW_HOME || join(homeDir, ".crow") }, homeDir)) return piProvider;
  return piProvider.toLowerCase().startsWith(DOOR_ID_PREFIX) ? piProvider.slice(DOOR_ID_PREFIX.length) : piProvider;
}

/** The models.json the bot engine reads: PI_MODELS_JSON, else pi's own agent
 * dir (PI_CODING_AGENT_DIR, else ~/.pi/agent; pi 0.85.1 config.js
 * getAgentDir). The same rule Perch's picker uses (loadPiProviderNames). */
export function piModelsJsonPath(env = process.env) {
  if (env.PI_MODELS_JSON) return env.PI_MODELS_JSON;
  return join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent"), "models.json");
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
