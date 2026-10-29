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
 *
 * Roles phase 2, Task 17: a cloud row this box consented to (cloud-consent.js)
 * gets a door entry `crow-c-<rowId>` instead: base URL the gateway's
 * loopback cloud door, key `!cat '<token file>'` (pi runs it under /bin/sh on
 * every auth resolve), so the provider key never lands in this file. Each
 * model carries the `compat` pi would have derived for the UPSTREAM URL
 * (pi-compat.js), because pi only sees the door's.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { doorKindOf, isLocalClassTarget } from "../gateway/models/door-resolve.js";
import { providerDoorUrl, cloudDoorUrl } from "../gateway/models/door.js";
import { consentVerdict, cloudDoorEligible } from "./cloud-consent.js";
import { piCompatFor, DOOR_ID_PREFIX, doorEntryId } from "./pi-compat.js";
import { EMBED_TASKS, RERANK_TASKS } from "./provider-task.js";
import { listProvidersAll } from "./providers-db.js";
import { resolvePiCli } from "../../scripts/pi-bots/pi_resolver.mjs";

export const CROW_MANAGED_KEY = "$crowManaged";
export { DOOR_ID_PREFIX, doorEntryId };
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

// pi's own defaults when a model omits them
// (pi-coding-agent dist/core/provider-composer.js: contextWindow ?? 128000,
// maxTokens ?? 16384).
const PI_DEFAULT_MAX_TOKENS = 16384;
const PI_INPUTS = new Set(["text", "image"]);

/** Coercers to pi's ModelDefinitionSchema types (final review I2). Each returns
 * undefined for a value that cannot be made valid, and the field is dropped. */
function asName(v) { if (typeof v !== "string") return undefined; const t = v.trim(); return t ? t : undefined; }
function asPosNumber(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
function asBool(v) { if (typeof v === "boolean") return v; if (v === "true") return true; if (v === "false") return false; return undefined; }
function asInput(v) {
  if (!Array.isArray(v)) return undefined;
  const ok = [...new Set(v.filter((x) => PI_INPUTS.has(x)))];
  return ok.length ? ok : undefined;
}

function chatModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m && typeof m.id === "string" && m.id.trim() && !NON_CHAT.has(m.task))
    .map((m) => {
      const out = { id: m.id };
      const name = asName(m.name);
      if (name !== undefined) out.name = name;
      const reasoning = asBool(m.reasoning);
      if (reasoning !== undefined) out.reasoning = reasoning;
      const input = asInput(m.input);
      if (input !== undefined) out.input = input;
      // Final review I3: bundle and native rows store the window as contextLen
      // (catalog context_len). Without it pi assumes 128000/16384, and a
      // 16384-token max_tokens is rejected outright by an 8192-context server.
      const ctx = asPosNumber(m.contextWindow) ?? asPosNumber(m.contextLen) ?? asPosNumber(m.context_len);
      if (ctx !== undefined) out.contextWindow = ctx;
      // maxTokens rule: min(row's maxTokens, or pi's default 16384, contextWindow / 2).
      // Half the window keeps room for the prompt on small models and never
      // raises pi's own default on big ones. Unknown window: row value as is.
      const rowMax = asPosNumber(m.maxTokens);
      if (ctx !== undefined) out.maxTokens = Math.min(rowMax ?? PI_DEFAULT_MAX_TOKENS, Math.floor(ctx / 2));
      else if (rowMax !== undefined) out.maxTokens = rowMax;
      return out;
    });
}

const nonEmptyStr = (v) => typeof v === "string" && v.length >= 1;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The parts of pi's models.json schema M1 can affect, checked over the WHOLE
 * merged file before it is written (final review I2). Source of truth:
 * @earendil-works/pi-coding-agent 0.85.1, dist/core/model-config.js
 * (ModelsConfigSchema / ProviderConfigSchema / ModelDefinitionSchema), the
 * global install at ~/.nvm/versions/node/v24.21.0/lib/node_modules/. Returns
 * a list of "path: problem" strings; empty means valid. Nested objects M1
 * never writes (compat, cost, thinkingLevelMap, modelOverrides) are not
 * re-checked here.
 */
export function validatePiModelsJson(json) {
  const errs = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) return ["root: not an object"];
  const provs = json.providers;
  if (!provs || typeof provs !== "object" || Array.isArray(provs)) return ["providers: required object"];
  for (const [pid, p] of Object.entries(provs)) {
    const at = `providers.${pid}`;
    if (!p || typeof p !== "object" || Array.isArray(p)) { errs.push(`${at}: not an object`); continue; }
    for (const k of ["name", "baseUrl", "apiKey", "api"]) if (p[k] !== undefined && !nonEmptyStr(p[k])) errs.push(`${at}.${k}: must be a non-empty string`);
    if (p.authHeader !== undefined && typeof p.authHeader !== "boolean") errs.push(`${at}.authHeader: must be boolean`);
    if (p.headers !== undefined && (typeof p.headers !== "object" || p.headers === null || Object.values(p.headers).some((v) => typeof v !== "string"))) errs.push(`${at}.headers: must map strings to strings`);
    if (p.models === undefined) continue;
    if (!Array.isArray(p.models)) { errs.push(`${at}.models: must be an array`); continue; }
    p.models.forEach((m, i) => {
      const mat = `${at}.models.${i}`;
      if (!m || typeof m !== "object") { errs.push(`${mat}: not an object`); return; }
      if (!nonEmptyStr(m.id)) errs.push(`${mat}.id: must be a non-empty string`);
      for (const k of ["name", "api", "baseUrl"]) if (m[k] !== undefined && !nonEmptyStr(m[k])) errs.push(`${mat}.${k}: must be a non-empty string`);
      if (m.reasoning !== undefined && typeof m.reasoning !== "boolean") errs.push(`${mat}.reasoning: must be boolean`);
      if (m.input !== undefined && (!Array.isArray(m.input) || m.input.some((x) => !PI_INPUTS.has(x)))) errs.push(`${mat}.input: must be an array of "text"/"image"`);
      for (const k of ["contextWindow", "maxTokens"]) if (m[k] !== undefined && !isNum(m[k])) errs.push(`${mat}.${k}: must be a number`);
    });
  }
  return errs;
}

/** A path as one /bin/sh single-quoted word: each ' becomes '\\'' (close, escaped quote, reopen). */
export function shellQuote(path) { return "'" + String(path).replace(/'/g, "'\\''") + "'"; }

/** The door entry for a consented cloud row, or null when the row does not qualify. */
function doorEntry(r, models, { cloudDoorPort, consent, consentSalt, tokenPath }) {
  // The door's own rule (enabled, cloud, https, keyed, openai or anthropic,
  // not local only, not crow-c-*): a row it would refuse gets no entry.
  if (!cloudDoorEligible(r)) return null;
  const type = r.provider_type;
  const anthropic = type === "anthropic";
  const entry = consent && typeof consent === "object" && Object.hasOwn(consent, r.id) ? consent[r.id] : null;
  if (consentVerdict(r, entry, { salt: consentSalt }) !== "ok") return null;
  // compat is an openai-completions schema; pi's own rules apply to that api only.
  const withCompat = anthropic ? models : models.map((m) => {
    const compat = piCompatFor(r.baseUrl, m.id);
    return compat ? { ...m, compat } : m;
  });
  return {
    baseUrl: cloudDoorUrl(cloudDoorPort, r.id, type),
    apiKey: "!cat " + shellQuote(tokenPath),
    api: anthropic ? "anthropic-messages" : "openai-completions",
    models: withCompat,
  };
}

export function buildManagedEntries(rows, {
  doorBase, cloudAllow = [], cloudDoorPort = null, consent = null, consentSalt = null, tokenPath = null,
  log = (m) => console.log(m),
} = {}) {
  const allow = new Set(cloudAllow);
  const door = cloudDoorPort != null && typeof tokenPath === "string" && tokenPath !== "";
  const out = {};
  const doors = [];
  for (const r of rows) {
    if (r.disabled || r.gpuPolicy?.local_only === true) continue;
    // The crow-c- namespace belongs to the door entries (minor c); pi
    // matches provider ids without regard to case, so CROW-C- is too.
    if (typeof r.id === "string" && r.id.toLowerCase().startsWith(DOOR_ID_PREFIX)) {
      log(`[pi-models-sync] provider "${r.id}" skipped: ids starting with "${DOOR_ID_PREFIX}" are reserved for the cloud door`);
      continue;
    }
    const cloud = !isLocalClassTarget(r.baseUrl) && !allow.has(r.id);
    if (cloud) {
      if (!door || !r.baseUrl) continue;
      const models = chatModels(r.models);
      if (!models.length) continue;
      const e = doorEntry(r, models, { cloudDoorPort, consent, consentSalt, tokenPath });
      if (e) doors.push([r.id, e]);
      continue;
    }
    if (!OPENAI_TYPES.has(r.provider_type)) continue;
    const kind = doorKindOf({ baseUrl: r.baseUrl, bundleId: r.bundleId, gpuPolicy: r.gpuPolicy, models: r.models });
    if (kind === "unmanaged" && !allow.has(r.id)) continue;
    // Final review minor 2: a managed marker (door_forward, bundleId) on a
    // public-address row does not bypass the cloud allowlist (the consent
    // gate): `cloud` above already sent every such row to the door path.
    const models = chatModels(r.models);
    if (!models.length || !r.baseUrl) continue;
    const native = kind === "native-owned" || kind === "native-foreign";
    const baseUrl = native && doorBase && kind === "native-owned" ? providerDoorUrl(doorBase, r.id) : r.baseUrl;
    out[r.id] = { baseUrl, apiKey: r.apiKey || "none", api: "openai-completions", models };
  }
  // pi folds provider ids to lower case, so two rows that differ only in case
  // (Cloud-A, cloud-a) would become ONE pi provider and a bot bound to one
  // could run on the other's door. Every colliding row is skipped; none is
  // picked. Direct ids never start with crow-c- (skipped above), so they
  // cannot collide with a door id.
  const byLower = new Map();
  for (const [rowId] of doors) {
    const lk = doorEntryId(rowId).toLowerCase();
    byLower.set(lk, (byLower.get(lk) || 0) + 1);
  }
  for (const [rowId, e] of doors) {
    if (byLower.get(doorEntryId(rowId).toLowerCase()) > 1) {
      log(`[pi-models-sync] provider "${rowId}" skipped: another provider's id differs from it only in case`);
      continue;
    }
    out[doorEntryId(rowId)] = e;
  }
  return out;
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function mergeManaged(fileJson, entries, { log = (m) => console.log(m) } = {}) {
  const json = { ...(fileJson || {}), providers: { ...((fileJson && fileJson.providers) || {}) } };
  const prevManaged = new Set(Array.isArray(json[CROW_MANAGED_KEY]) ? json[CROW_MANAGED_KEY] : []);
  const handWritten = new Set(Object.keys(json.providers).filter((id) => !prevManaged.has(id)));
  const handLower = new Set([...handWritten].map((id) => id.toLowerCase()));
  const added = [], updated = [], removed = [];
  const nextManaged = new Set();
  for (const [id, entry] of Object.entries(entries)) {
    if (handWritten.has(id)) continue;
    // A door entry that differs from a hand-written id only in case would
    // merge with it inside pi: the hand-written one keeps its id alone.
    if (id.toLowerCase().startsWith(DOOR_ID_PREFIX) && handLower.has(id.toLowerCase())) {
      log(`[pi-models-sync] "${id}" not written: a hand-written provider differs from it only in case`);
      continue;
    }
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

function defaultWriteAtomic(linkPath, data, mode) {
  // Final review minor 7: renaming over a symlink would replace the link with
  // a regular file; write through to the link's target instead.
  let path = linkPath;
  try { if (lstatSync(linkPath).isSymbolicLink()) path = realpathSync(linkPath); } catch { /* absent: create it */ }
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
  cloudDoorPort = null, consent = null, consentSalt = null, tokenPath = null,
  listProvidersAllFn = listProvidersAll,
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileAtomicFn = defaultWriteAtomic,
} = {}) {
  if (!path) return { disabled: true };
  const entries = buildManagedEntries(await listProvidersAllFn(db), { doorBase, cloudAllow, cloudDoorPort, consent, consentSalt, tokenPath });
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
    // Final review I2: pi rejects the WHOLE file on any schema error and then
    // loads zero custom providers, so a bad write would take every bot down.
    // Validate the merged result; on failure keep the old file.
    const problems = validatePiModelsJson(json);
    if (problems.length) throw new Error(`merged pi models.json at ${path} fails pi's schema — not written, old file kept: ${problems.slice(0, 5).join("; ")}`);
    writeFileAtomicFn(path, JSON.stringify(json, null, 2) + "\n", 0o600);
    return { path, added, updated, removed };
  }
  throw new Error(`pi models.json at ${path} kept changing under the writer; not written`);
}
