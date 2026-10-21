/**
 * Model roles: one named vocabulary (Everyday, Quick voice, ...) that bots,
 * voice and routers refer to as `role:<id>` instead of a raw `provider/model`.
 *
 * Pure: no DB, no fs, no network. Callers pass what they loaded.
 *
 * Resolution rules:
 *  - A raw `provider/model` key passes through untouched (no filters).
 *  - A role walks its chain (bound model, then fallbacks). A candidate is
 *    skipped only when it is NOT CONFIGURED (exactly validateModelKey over the
 *    loadModels() result) or fails a chain filter (foreign owner, capability,
 *    serving class). Liveness is never an input: an asleep model is bound.
 *  - Chain depth is at most MAX_CHAIN_DEPTH roles.
 */
import { validateModelKey, splitKey } from "../../scripts/pi-bots/model_resolver.mjs";
import { isForeignInstanceHost, hostnameOf } from "./provider-host.js";
import { getOwnAddresses, isPrivateHost } from "./locality.js";
import { servingClassOf } from "../gateway/models/serving-class.js";
import { doorKindOf, isDoorUrl } from "../gateway/models/door-resolve.js";

export const MAX_CHAIN_DEPTH = 4;
export const ROLE_REF_PREFIX = "role:";
const CUSTOM_ID_RE = /^c-[a-z0-9-]{1,32}$/;

const role = (id, capability, allowHeavy, defaultFallback) =>
  Object.freeze({ id, capability, allowHeavy, defaultFallback: Object.freeze([...defaultFallback]) });

export const CORE_ROLES = Object.freeze([
  role("quick", "chat", false, ["everyday"]),
  role("everyday", "chat", false, ["quick"]),
  role("deep", "chat", true, ["everyday"]),
  role("coordinator", "chat", true, ["deep", "everyday"]),
  role("critic", "chat", true, ["deep"]),
  role("expert", "chat", true, []),
  role("vision", "vision", false, []),
  role("embed", "embed", false, []),
  role("rerank", "score", false, []),
  role("safety", "chat", false, ["quick"]),
]);

const CORE_BY_ID = new Map(CORE_ROLES.map((r) => [r.id, r]));

export function isRoleRef(key) {
  return typeof key === "string" && key.startsWith(ROLE_REF_PREFIX) && key.length > ROLE_REF_PREFIX.length;
}

export function roleIdOf(key) {
  return isRoleRef(key) ? key.slice(ROLE_REF_PREFIX.length) : null;
}

export function isValidCustomRoleId(id) {
  return typeof id === "string" && CUSTOM_ID_RE.test(id);
}

/** Exactly the bot loader's test (scripts/pi-bots/model_resolver.mjs). */
export function isConfigured(key, { models } = {}) {
  return validateModelKey(models, key).ok;
}

const providerList = (providers) => (Array.isArray(providers) ? providers : Object.values(providers || {}));

function providerById(providers, id) {
  return providerList(providers).find((p) => p && p.id === id) || null;
}

function modelEntry(p, modelId) {
  return (Array.isArray(p?.models) ? p.models : []).find((m) => (typeof m === "string" ? m : m?.id) === modelId) || null;
}

function normBase(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(url || "").toLowerCase().replace(/\/+$/, "");
  }
}

/** Same model id on the same normalised base URL: one server under two names. */
export function sameServer(keyA, keyB, { providers } = {}) {
  const a = splitKey(keyA), b = splitKey(keyB);
  if (!a.provider || !b.provider || a.model !== b.model) return false;
  const pa = providerById(providers, a.provider), pb = providerById(providers, b.provider);
  if (!pa || !pb || !pa.baseUrl || !pb.baseUrl) return false;
  return normBase(pa.baseUrl) === normBase(pb.baseUrl);
}

/** A door row names its upstream provider in its path (/llm/p/<id>/v1). */
function defaultResolveDoor(row, providers) {
  if (!row || doorKindOf(row) === "unmanaged" || !isDoorUrl(row.baseUrl)) return row;
  try {
    const m = new URL(row.baseUrl).pathname.match(/\/llm\/p\/([^/]+)\/v1\/?$/i);
    if (m) return providerById(providers, decodeURIComponent(m[1])) || null;
  } catch {}
  return null;
}

/**
 * The one cloud predicate. Follows a door to its upstream, then asks whether
 * the upstream's host is a public address or name that is not one of ours.
 * `host === "cloud"` is deliberately not consulted. An unknown key is false.
 */
export function isCloudKey(key, { providers, resolveDoor = defaultResolveDoor, ownAddrs } = {}) {
  const { provider, model } = splitKey(key);
  let row = providerById(providers, provider);
  if (!row || !model) return false;
  for (let hops = 0; hops < 3; hops++) {
    const up = resolveDoor(row, providers);
    if (!up) return false; // a door whose upstream cannot be named is not shown to be cloud
    if (up === row) break;
    row = up;
  }
  const h = hostnameOf(row.baseUrl);
  if (!h) return false;
  if ((ownAddrs || getOwnAddresses()).has(h)) return false;
  return !isPrivateHost(h);
}

function capabilityOk(need, p, modelId) {
  const m = modelEntry(p, modelId);
  const task = m && typeof m === "object" ? m.task : null;
  switch (need) {
    case "embed": return task === "embed";
    case "score": return task === "score" || task === "rerank";
    case "vision":
      return task === "vision" || (m && typeof m === "object" && (m.vision === true || (Array.isArray(m.input) && m.input.includes("image"))));
    default: return !task || task === "chat" || task === "vision";
  }
}

function classOk(p, catalog, allowHeavy) {
  if (allowHeavy) return true;
  const entry = (catalog || []).find((m) => m.id === (p?.gpuPolicy?.catalogId || p?.id)) || null;
  const cls = servingClassOf(entry);
  if (cls === null || cls === "resident") return true;
  const override = p?.gpuPolicy?.servingOverride ?? p?.servingOverride;
  return typeof override === "string" && override === cls;
}

/**
 * Resolve `key` (raw `provider/model` or `role:<id>`) to a usable raw key.
 * @returns {{key:string|null, role:string|null, chain:string[], reason:string}}
 */
export function resolveRoleKey(key, { need, bindings = {}, customDefs = {}, providers = [], models, catalog = [], ownInstanceId = () => null } = {}) {
  if (!isRoleRef(key)) return { key: key ?? null, role: null, chain: [], reason: "raw" };
  const rootId = roleIdOf(key);
  const defOf = (id) => CORE_BY_ID.get(id) || (isValidCustomRoleId(id) && customDefs?.[id]
    ? { id, capability: customDefs[id].capability || "chat", allowHeavy: !!customDefs[id].allowHeavy, defaultFallback: customDefs[id].fallback || [] }
    : null);
  const root = defOf(rootId);
  if (!root) return { key: null, role: rootId, chain: [], reason: "unknown_role" };

  const chain = [];
  const onPath = new Set(); // roles reached by indirection or fallback on the current path
  const seen = new Set();   // every role already tried (fallback revisits are skipped silently)
  let cycle = false, sawCapability = false, sawNotConfigured = false;
  const wanted = need || root.capability;

  const tryRaw = (rawKey, def) => {
    if (!isConfigured(rawKey, { models })) { sawNotConfigured = true; return false; }
    const { provider, model } = splitKey(rawKey);
    const p = providerById(providers, provider);
    if (p) {
      if (isForeignInstanceHost(p.host, ownInstanceId)) { sawNotConfigured = true; return false; }
      if (!capabilityOk(wanted, p, model)) { sawCapability = true; return false; }
      if (!classOk(p, catalog, def.allowHeavy)) { sawNotConfigured = true; return false; }
    }
    return true;
  };

  // Returns a raw key or null. `viaIndirection` marks a model that is itself a role ref.
  const visit = (id, viaIndirection) => {
    if (onPath.has(id) && viaIndirection) { cycle = true; return null; }
    if (seen.has(id)) return null;
    if (chain.length >= MAX_CHAIN_DEPTH) { cycle = true; return null; }
    const def = defOf(id);
    if (!def) return null;
    seen.add(id); onPath.add(id); chain.push(id);
    const b = bindings?.[id] || {};
    let found = null;
    if (typeof b.model === "string" && b.model) {
      if (isRoleRef(b.model)) found = visit(roleIdOf(b.model), true);
      else if (tryRaw(b.model, def)) found = b.model;
    }
    if (!found) {
      const fb = Array.isArray(b.fallback) ? b.fallback : def.defaultFallback;
      for (const f of fb) {
        found = visit(isRoleRef(f) ? roleIdOf(f) : f, false);
        if (found) break;
      }
    }
    onPath.delete(id);
    return found;
  };

  const found = visit(rootId, false);
  if (found) return { key: found, role: rootId, chain, reason: chain.length > 1 ? "fallback" : "bound" };
  const reason = cycle ? "cycle" : sawCapability ? "capability" : sawNotConfigured ? "not_configured" : "unset";
  return { key: null, role: rootId, chain, reason };
}
