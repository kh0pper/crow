// servers/shared/pi-models-sync.js
/**
 * M1 (spec §11.6): keep crow-managed provider entries in pi's models.json.
 * The Crow providers table is the source of truth for Bot Builder and
 * Perch; pi reads models.json. A top-level "$crowManaged" array names the
 * ids this module owns. Hand-written entries are never touched, and a
 * hand-written id wins over a DB row of the same id. The reconciler and the
 * first-boot seed (providers-db.js) skip $crowManaged ids, so this output is
 * never re-imported (Task 2).
 *
 * Scope (review, Q1 open): rows Crow manages (native, external engine,
 * bundle, door opt-in) and only allow-listed cloud rows
 * (CROW_PI_MODELS_SYNC_CLOUD). Embedding and rerank models are not chat
 * models for pi and are dropped.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { doorKindOf } from "../gateway/models/door-resolve.js";
import { providerDoorUrl } from "../gateway/models/door.js";
import { EMBED_TASKS, RERANK_TASKS } from "./provider-task.js";
import { listProvidersAll } from "./providers-db.js";
import { resolvePiCli } from "../../scripts/pi-bots/pi_resolver.mjs";

export const CROW_MANAGED_KEY = "$crowManaged";
const OPENAI_TYPES = new Set([null, undefined, "", "openai-compat", "openai"]);
const NON_CHAT = new Set([...EMBED_TASKS, ...RERANK_TASKS]);

export function piModelsSyncPath({
  env = process.env, crowHome = env.CROW_HOME || join(homedir(), ".crow"), home = env.HOME || homedir(),
  existsFn = existsSync, piCliFn = () => resolvePiCli({ env, crowHome }),
} = {}) {
  if (env.CROW_PI_MODELS_SYNC === "0") return null;
  if (env.CROW_PI_MODELS_SYNC_PATH) return env.CROW_PI_MODELS_SYNC_PATH;
  if (resolve(crowHome) !== resolve(join(home, ".crow"))) return null;
  if (!existsFn(join(home, ".pi", "agent"))) return null; // never create pi's dir on a host that does not run pi
  if (!piCliFn()) return null;
  return join(home, ".pi", "agent", "models.json");
}

function chatModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m && typeof m.id === "string" && m.id && !NON_CHAT.has(m.task))
    .map((m) => {
      const out = { id: m.id };
      for (const k of ["name", "contextWindow", "maxTokens", "reasoning", "input"]) if (m[k] !== undefined) out[k] = m[k];
      return out;
    });
}

export function buildManagedEntries(rows, { doorBase, cloudAllow = [] } = {}) {
  const allow = new Set(cloudAllow);
  const out = {};
  for (const r of rows) {
    if (r.disabled || r.gpuPolicy?.local_only === true) continue;
    if (!OPENAI_TYPES.has(r.provider_type)) continue;
    const kind = doorKindOf({ baseUrl: r.baseUrl, bundleId: r.bundleId, gpuPolicy: r.gpuPolicy, models: r.models });
    if (kind === "unmanaged" && !allow.has(r.id)) continue;
    const models = chatModels(r.models);
    if (!models.length || !r.baseUrl) continue;
    const native = kind === "native-owned" || kind === "native-foreign";
    const baseUrl = native && doorBase && kind === "native-owned" ? providerDoorUrl(doorBase, r.id) : r.baseUrl;
    out[r.id] = { baseUrl, apiKey: r.apiKey || "none", api: "openai-completions", models };
  }
  return out;
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function mergeManaged(fileJson, entries) {
  const json = { ...(fileJson || {}), providers: { ...((fileJson && fileJson.providers) || {}) } };
  const prevManaged = new Set(Array.isArray(json[CROW_MANAGED_KEY]) ? json[CROW_MANAGED_KEY] : []);
  const handWritten = new Set(Object.keys(json.providers).filter((id) => !prevManaged.has(id)));
  const added = [], updated = [], removed = [];
  const nextManaged = new Set();
  for (const [id, entry] of Object.entries(entries)) {
    if (handWritten.has(id)) continue;
    nextManaged.add(id);
    if (!(id in json.providers)) { json.providers[id] = entry; added.push(id); }
    else if (!same(json.providers[id], entry)) { json.providers[id] = entry; updated.push(id); }
  }
  for (const id of prevManaged) {
    if (!nextManaged.has(id) && id in json.providers) { delete json.providers[id]; removed.push(id); }
  }
  json[CROW_MANAGED_KEY] = [...nextManaged].sort();
  return { json, added: added.sort(), updated: updated.sort(), removed: removed.sort() };
}

function defaultWriteAtomic(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.crow-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function readOrNull(readFileFn, path) {
  try { return readFileFn(path); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

export async function syncPiModelsJson(db, {
  path = piModelsSyncPath(),
  doorBase = null,
  cloudAllow = String(process.env.CROW_PI_MODELS_SYNC_CLOUD || "").split(",").map((s) => s.trim()).filter(Boolean),
  listProvidersAllFn = listProvidersAll,
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileAtomicFn = defaultWriteAtomic,
} = {}) {
  if (!path) return { disabled: true };
  const entries = buildManagedEntries(await listProvidersAllFn(db), { doorBase, cloudAllow });
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = readOrNull(readFileFn, path);
    let current = { providers: {} };
    if (raw !== null) {
      try { current = JSON.parse(raw); } catch { throw new Error(`pi models.json at ${path} is not valid JSON — refusing to overwrite it`); }
    }
    const { json, added, updated, removed } = mergeManaged(current, entries);
    if (!added.length && !updated.length && !removed.length && Array.isArray(current[CROW_MANAGED_KEY])) return { path, added, updated, removed };
    // Lost-update guard: pi-lab and plan 4's windows hand-edit this file. If it
    // changed since we read it, merge again from the new content.
    if (readOrNull(readFileFn, path) !== raw) continue;
    writeFileAtomicFn(path, JSON.stringify(json, null, 2) + "\n", 0o600);
    return { path, added, updated, removed };
  }
  throw new Error(`pi models.json at ${path} kept changing under the writer; not written`);
}
