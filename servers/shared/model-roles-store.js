/**
 * Model roles: the binding store. Bindings are instance-owned
 * `dashboard_settings` rows (INSTANCE_SCOPE_KEYS: global table, never
 * synced). This module reads and writes them, owns the per-key authority seam
 * a satellite instance will later use to follow a primary, and builds the
 * memoized RoleContext every resolver walks.
 *
 * Import hygiene (I4): never import model-consumers.js, ai/smart-router.js or
 * model-roles-seed.js from here (tests/model-roles-import-graph.test.js).
 */
import {
  CORE_ROLES, ROLE_KEY_RANGE, SUBAGENT_MAP_KEY, bindingKey,
  parseBindingRows, isRoleRef, roleIdOf, isValidCustomRoleId,
  resolveRoleKey, resolveChosenRoleKey, isRawKey,
} from "./model-roles.js";
import { modelsFromRows, loadModelsFromFile } from "../../scripts/pi-bots/model_resolver.mjs";
import { providerRowToObject } from "./provider-row.js";
import { loadCatalog, wrapOwnId } from "./model-roles-env.js";
import { writeSetting } from "../gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId as defaultGetOwnId } from "../gateway/instance-registry.js";

const CORE_IDS = new Set(CORE_ROLES.map((r) => r.id));

/** Keys that are always this instance's own, whatever a satellite follows (I7). */
const ALWAYS_SELF = new Set([bindingKey("embed"), bindingKey("rerank"), SUBAGENT_MAP_KEY]);

/**
 * Who may write `key`: this instance, or a primary it follows. The satellite
 * seam: Phase 1 always answers self. The follow-up consults its setting here,
 * except for ALWAYS_SELF keys, which never consult it.
 * @returns {Promise<{kind:"self"}|{kind:"primary", instanceId:string}>}
 */
export async function roleBindingAuthority(_db, key) {
  if (ALWAYS_SELF.has(key)) return { kind: "self" };
  // Phase 1 has no follow-a-primary setting yet: every other key is ours too.
  return { kind: "self" };
}

async function readRoleRows(db) {
  const { rows } = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key >= ? AND key < ?",
    args: [ROLE_KEY_RANGE.lo, ROLE_KEY_RANGE.hi],
  });
  return parseBindingRows(rows);
}

/** @returns {Promise<{[id:string]: {model:string|null, fallback?:string[], seeded:boolean}}>} */
export async function readBindings(db) {
  return (await readRoleRows(db)).bindings;
}

export async function readCustomRoleDefs(db) {
  return (await readRoleRows(db)).customDefs;
}

// ---- change listeners -------------------------------------------------------

const listeners = new Set();

/** fn(roleId) after every successful setBinding. Returns the unsubscribe. */
export function addBindingsChangeListener(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fireListeners(roleId) {
  for (const fn of listeners) {
    try {
      const r = fn(roleId);
      if (r && typeof r.catch === "function") r.catch((e) => console.warn("[roles] bindings listener failed:", e?.message));
    } catch (e) {
      console.warn("[roles] bindings listener failed:", e?.message);
    }
  }
}

// ---- setBinding --------------------------------------------------------------

function knownRole(id, customDefs) {
  return CORE_IDS.has(id) || (isValidCustomRoleId(id) && !!customDefs[id]);
}

/**
 * Bind `roleId` to a model (null clears it, a raw `provider/model`, or
 * `role:<known id>`), with optional fallback role ids. "Configured" is not
 * required. Writes {model, fallback?, at, by} (never `seeded`) to the global
 * table without an emit, then invalidates the context and fires listeners.
 */
export async function setBinding(db, roleId, { model = null, fallback } = {}, { actor, authority = roleBindingAuthority } = {}) {
  const { customDefs } = await readRoleRows(db);
  if (typeof roleId !== "string" || !knownRole(roleId, customDefs)) return { ok: false, reason: "unknown_role" };
  if (model !== null) {
    const ok = typeof model === "string" && (isRoleRef(model) ? knownRole(roleIdOf(model), customDefs) : isRawKey(model));
    if (!ok) return { ok: false, reason: "invalid_model" };
  }
  if (fallback !== undefined) {
    const ok = Array.isArray(fallback) && fallback.every((f) => typeof f === "string" && knownRole(isRoleRef(f) ? roleIdOf(f) : f, customDefs));
    if (!ok) return { ok: false, reason: "invalid_fallback" };
  }
  const key = bindingKey(roleId);
  const auth = await authority(db, key);
  if (auth?.kind !== "self") return { ok: false, reason: "follows_primary" };

  const value = { model };
  if (fallback !== undefined) value.fallback = [...fallback];
  value.at = new Date().toISOString();
  if (typeof actor === "string" && actor) value.by = actor;
  await writeSetting(db, key, JSON.stringify(value), { scope: "global" });
  invalidateRoleContext();
  fireListeners(roleId);
  return { ok: true };
}

// ---- RoleContext ------------------------------------------------------------

/** The loadModels() rule: the DB's enabled rows when any parse, else models.json. Never a union. */
function modelsFor(enabledRows) {
  const m = modelsFromRows(enabledRows);
  if (m && Object.keys(m.providers).length) return m;
  return loadModelsFromFile();
}

const contextCache = new WeakMap(); // db -> {at, gen, promise}
let generation = 0;

/** Drop every memoized RoleContext (a binding or provider changed). */
export function invalidateRoleContext() {
  generation++;
}

async function buildContext(db, getOwnId) {
  const { bindings, customDefs } = await readRoleRows(db);
  const { rows } = await db.execute("SELECT * FROM providers ORDER BY disabled ASC, id");
  const providers = rows.map(providerRowToObject);
  const enabledRows = rows.filter((r) => !r.disabled).map((r) => ({ id: r.id, models: r.models }));
  return {
    bindings,
    customDefs,
    providers,
    models: modelsFor(enabledRows),
    catalog: loadCatalog(),
    ownInstanceId: wrapOwnId(getOwnId),
  };
}

/**
 * {bindings, customDefs, providers, models, catalog, ownInstanceId}, memoized
 * per db for maxAgeMs. An injected getOrCreateLocalInstanceId (a test seam)
 * bypasses the cache.
 */
export async function loadRoleContext(db, { maxAgeMs = 1000, getOrCreateLocalInstanceId } = {}) {
  if (getOrCreateLocalInstanceId) return buildContext(db, getOrCreateLocalInstanceId);
  const hit = contextCache.get(db);
  if (hit && hit.gen === generation && Date.now() - hit.at < maxAgeMs) return hit.promise;
  const promise = buildContext(db, defaultGetOwnId);
  const entry = { at: Date.now(), gen: generation, promise };
  contextCache.set(db, entry);
  promise.catch(() => { if (contextCache.get(db) === entry) contextCache.delete(db); });
  return promise;
}

const loggedReasons = new Set();

/**
 * Resolve a raw key or `role:<id>` against this instance's bindings. Never
 * throws: an error gives {key:null, reason:"error"}, logged once per message.
 * @returns {Promise<{key:string|null, role:string|null, chain:string[], reason:string}>}
 */
export async function resolveRole(db, key, { need, chosenOnly = false } = {}) {
  try {
    const ctx = await loadRoleContext(db);
    const fn = chosenOnly ? resolveChosenRoleKey : resolveRoleKey;
    return fn(key, { ...ctx, need });
  } catch (e) {
    const msg = String(e?.message || e);
    if (!loggedReasons.has(msg)) {
      loggedReasons.add(msg);
      console.warn(`[roles] resolve failed for ${String(key)}: ${msg}`);
    }
    return { key: null, role: isRoleRef(key) ? roleIdOf(key) : null, chain: [], reason: "error" };
  }
}
