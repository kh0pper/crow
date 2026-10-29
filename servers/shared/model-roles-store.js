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
  CORE_ROLES, ROLE_KEY_RANGE, SUBAGENT_MAP_KEY, ROLE_BINDING_PREFIX, ROLE_DEF_PREFIX, CUSTOM_CAPABILITIES, bindingKey,
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

// ---- custom roles ------------------------------------------------------------

const CUSTOM_PREFIX = "c-";
const SLUG_MAX = 32;
const LABEL_MAX = 40;
const JOB_MAX = 160;
// No control characters (C0, DEL, C1) or line/paragraph separators in a label or job.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * The id for a new custom role: `c-` + a slug of the label ([a-z0-9-], at most
 * 32 characters, accents folded), `c-role` when nothing is left, and `-2`,
 * `-3` ... on a clash with `existingIds` (the slug is shortened so the suffix
 * still fits). Always matches isValidCustomRoleId, so it can never be a core
 * id (none starts with `c-`), differ only in case, or carry `role:` syntax.
 */
export function customRoleIdFor(label, existingIds = []) {
  const taken = new Set([...existingIds].map((x) => String(x).toLowerCase()));
  const slug = String(label ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX).replace(/-+$/, "") || "role";
  if (!taken.has(CUSTOM_PREFIX + slug)) return CUSTOM_PREFIX + slug;
  for (let n = 2; ; n++) {
    const sfx = `-${n}`;
    const id = CUSTOM_PREFIX + slug.slice(0, SLUG_MAX - sfx.length).replace(/-+$/, "") + sfx;
    if (!taken.has(id)) return id;
  }
}

/** Every custom id with a definition OR a leftover binding row: a new role never inherits a stale binding. */
async function customIdsInUse(db) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM dashboard_settings WHERE key >= ? AND key < ?",
    args: [ROLE_KEY_RANGE.lo, ROLE_KEY_RANGE.hi],
  });
  const out = new Set();
  for (const { key } of rows) {
    const id = key.startsWith(ROLE_DEF_PREFIX) ? key.slice(ROLE_DEF_PREFIX.length)
      : key.startsWith(ROLE_BINDING_PREFIX) ? key.slice(ROLE_BINDING_PREFIX.length) : null;
    if (id && id.startsWith(CUSTOM_PREFIX)) out.add(id);
  }
  return [...out];
}

/**
 * A custom role definition as stored, or {error}: label trimmed 1-40 (no
 * control characters), job trimmed to at most 160 (optional), capability
 * `chat` | `vision`, allowHeavy only when it is boolean true.
 */
export function normalizeCustomDef({ label, job, capability, allowHeavy } = {}) {
  const l = typeof label === "string" ? label.trim() : "";
  if (!l || l.length > LABEL_MAX || CONTROL_RE.test(l)) return { error: "invalid_label" };
  if (!CUSTOM_CAPABILITIES.includes(capability)) return { error: "invalid_capability" };
  const j = typeof job === "string" ? job.trim() : "";
  if (j.length > JOB_MAX || CONTROL_RE.test(j)) return { error: "invalid_label" };
  const def = { label: l, job: j, capability };
  if (allowHeavy === true) def.allowHeavy = true;
  return { def };
}

/**
 * Create (no `id`) or edit (`id` of an existing custom role) a custom role.
 * Writes `model_role_def.<id>` = {label, job, capability, allowHeavy?} to the
 * global table without an emit (instance scope), then invalidates the
 * context and fires the listeners. A core id, a malformed id, or an id with
 * no definition is `unknown_role`. An edit that changes what the role may
 * use is previewed first: the route requires the hash (role-change.js
 * previewCustomRoleEdit); this writer does not check it.
 * @returns {Promise<{ok:true, id:string}|{ok:false, reason:"invalid_label"|"invalid_capability"|"unknown_role"}>}
 */
export async function saveCustomRole(db, { id, label, job, capability, allowHeavy } = {}, { actor } = {}) {
  const n = normalizeCustomDef({ label, job, capability, allowHeavy });
  if (n.error) return { ok: false, reason: n.error };
  let roleId;
  if (id !== undefined && id !== null) {
    const { customDefs } = await readRoleRows(db);
    if (typeof id !== "string" || !isValidCustomRoleId(id) || !customDefs[id]) return { ok: false, reason: "unknown_role" };
    roleId = id;
  } else {
    roleId = customRoleIdFor(n.def.label, await customIdsInUse(db));
  }
  await writeSetting(db, ROLE_DEF_PREFIX + roleId, JSON.stringify(n.def), { scope: "global" });
  if (typeof actor === "string" && actor) console.log(`[roles] custom role ${roleId} saved by ${actor}`);
  invalidateRoleContext();
  fireListeners(roleId);
  return { ok: true, id: roleId };
}

/** Roles (other than roleId) whose stored binding model or fallback names roleId. */
function rolesNaming(roleId, bindings, customDefs) {
  const out = [];
  for (const [id, b] of Object.entries(bindings || {})) {
    if (id === roleId || !b) continue;
    const refs = [
      ...(isRoleRef(b.model) ? [roleIdOf(b.model)] : []),
      ...(Array.isArray(b.fallback) ? b.fallback.map((f) => (isRoleRef(f) ? roleIdOf(f) : f)) : []),
    ];
    if (!refs.includes(roleId)) continue;
    out.push(CORE_IDS.has(id)
      ? { kind: "role", id, labelKey: `settings.roles.${id}` }
      : { kind: "role", id, label: typeof customDefs?.[id]?.label === "string" ? customDefs[id].label : id });
  }
  return out;
}

/**
 * Delete a custom role. Refuses a core id (any case) as `core_role`. Inside
 * one BEGIN IMMEDIATE ... COMMIT it re-reads the bindings and definitions and
 * asks `consumersFn(db, id)` (role-consumers.js customRoleConsumers: the
 * bots, phone slots and sub-agents that name `role:<id>`; it must only read
 * this db, so nothing else runs inside the transaction); while any consumer,
 * or any other role's binding or fallback, names the role it refuses as
 * `in_use` with them listed. Otherwise it deletes `model_role_def.<id>` and
 * `model_role.<id>`, then invalidates the context and fires the listeners.
 * @returns {Promise<{ok:true}|{ok:false, reason:"core_role"|"unknown_role"|"in_use", consumers?:object[]}>}
 */
export async function deleteCustomRole(db, id, { consumersFn, actor } = {}) {
  if (typeof id === "string" && CORE_IDS.has(id.toLowerCase())) return { ok: false, reason: "core_role" };
  if (typeof id !== "string" || !isValidCustomRoleId(id)) return { ok: false, reason: "unknown_role" };
  if (typeof consumersFn !== "function") throw new TypeError("deleteCustomRole: consumersFn is required");
  await db.execute("BEGIN IMMEDIATE");
  let result;
  try {
    const { bindings, customDefs } = await readRoleRows(db);
    if (!customDefs[id]) {
      result = { ok: false, reason: "unknown_role" };
    } else {
      const users = [...(await consumersFn(db, id) || []), ...rolesNaming(id, bindings, customDefs)];
      if (users.length) {
        result = { ok: false, reason: "in_use", consumers: users };
      } else {
        await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key IN (?, ?)", args: [ROLE_DEF_PREFIX + id, bindingKey(id)] });
        result = { ok: true };
      }
    }
    await db.execute("COMMIT");
  } catch (e) {
    try { await db.execute("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  }
  if (result.ok) {
    if (typeof actor === "string" && actor) console.log(`[roles] custom role ${id} deleted by ${actor}`);
    invalidateRoleContext();
    fireListeners(id);
  }
  return result;
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
