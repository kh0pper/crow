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
 *  - Path depth (roles from the root through indirection/fallback) is at most
 *    MAX_CHAIN_DEPTH; a separate cap of MAX_VISITS roles bounds total work.
 */
import { validateModelKey, splitKey } from "../../scripts/pi-bots/model_resolver.mjs";
import { isForeignInstanceHost, isInstanceIdShape, hostnameOf } from "./provider-host.js";
import { getOwnAddresses, addressClass } from "./locality.js";
import { classifyIp } from "./ip-classify.js";
import { isIP } from "node:net";
import { EMBED_TASKS, RERANK_TASKS } from "./provider-task.js";
import { servingClassOf } from "../gateway/models/serving-class.js";
import { doorKindOf, isDoorUrl } from "../gateway/models/door-resolve.js";

export const MAX_CHAIN_DEPTH = 4;
const MAX_VISITS = 16;
const DEFAULT_LOCAL_SUFFIXES = Object.freeze([".local", ".home.arpa"]);
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
  role("safety", "chat", false, []),
  role("voice", "chat", false, []),
  role("stt", "transcription", false, []),
  role("tts", "speech", false, []),
  role("image", "image", false, []),
  role("video", "video", false, []),
]);

const CORE_BY_ID = new Map(CORE_ROLES.map((r) => [r.id, r]));

/** Roles with these capabilities have no chat-style resolver yet: they refuse. */
export const MEDIA_CAPABILITIES = Object.freeze(["transcription", "speech", "image", "video"]);
const isMedia = (def) => MEDIA_CAPABILITIES.includes(def?.capability);

/** id -> i18n key of the role's display name. */
export const ROLE_LABEL_KEYS = Object.freeze(Object.fromEntries(CORE_ROLES.map((r) => [r.id, `settings.roles.${r.id}`])));

export const ROLE_BINDING_PREFIX = "model_role.";
export const ROLE_DEF_PREFIX = "model_role_def.";
export const SUBAGENT_MAP_KEY = "model_role_subagents";
/** `key >= lo AND key < hi` covers every role row (bindings, defs, the sub-agent map), used instead of LIKE. */
export const ROLE_KEY_RANGE = Object.freeze({ lo: "model_role", hi: "model_rolf" });

export function bindingKey(id) {
  return ROLE_BINDING_PREFIX + id;
}

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
 * Where does a key's traffic end up? Every row visited along the door chain
 * (the row itself, then each upstream resolveDoor names) is classified by its
 * base-URL host:
 *   "local"   - an IP literal in a private/loopback/link-local/tailnet range,
 *               one of ownAddrs, or a DNS name ending in one of localSuffixes
 *               (default .local, .home.arpa);
 *   "cloud"   - an IP literal in a public range that is not ours;
 *   "unknown" - everything else: any other DNS name (a name cannot be proven
 *               public or private without DNS, so *.ts.net, dotless and
 *               *.internal names land here), an unknown provider key, an
 *               unparseable baseUrl, a door whose upstream cannot be named, or
 *               more than MAX_DOOR_HOPS hops.
 * The result is the worst hop: cloud, else unknown, else local. isCloudKey
 * treats "unknown" as cloud. `host === "cloud"` on a row is never consulted.
 */
const MAX_DOOR_HOPS = 3;
const PUBLIC_CLASSES = new Set(["public4", "public6"]);

function hopVerdict(h, own, localSuffixes) {
  if (own.has(h)) return "local";
  const cls = addressClass(h);
  if (cls) return PUBLIC_CLASSES.has(cls) ? "cloud" : "local";
  return localSuffixes.some((sfx) => h.endsWith(sfx.toLowerCase())) ? "local" : "unknown";
}

export function cloudStatus(key, { providers, resolveDoor = defaultResolveDoor, ownAddrs, localSuffixes = DEFAULT_LOCAL_SUFFIXES } = {}) {
  const { provider, model } = splitKey(key);
  let row = providerById(providers, provider);
  if (!row || !model) return "unknown";
  const own = ownAddrs || getOwnAddresses();
  let sawUnknown = false;
  for (let hops = 0; hops <= MAX_DOOR_HOPS; hops++) {
    const h = hostnameOf(row.baseUrl);
    if (!h) return "unknown";
    const v = hopVerdict(h, own, localSuffixes);
    if (v === "cloud") return "cloud";
    if (v === "unknown") sawUnknown = true;
    const up = resolveDoor(row, providers);
    if (up === row) return sawUnknown ? "unknown" : "local";
    if (!up) return "unknown";
    row = up;
  }
  return "unknown";
}

/** The one cloud predicate (voice, phone, warnings): errs toward warning, so
 *  anything not proven local counts as cloud. */
export function isCloudKey(key, opts) {
  return cloudStatus(key, opts) !== "local";
}

/** id -> i18n key of the role's one-line job. */
export const ROLE_JOB_KEYS = Object.freeze(Object.fromEntries(CORE_ROLES.map((r) => [r.id, `settings.roleJobs.${r.id}`])));

// RFC 5737 documentation blocks: unroutable in practice, so naming one as a
// "cloud" upstream is harmless, and they are the fixtures tests use for cloud.
const DOC_V4 = [[0xc0000200, 24], [0xc6336400, 24], [0xcb007100, 24]];
function isDocumentationV4(h) {
  if (isIP(h) !== 4) return false;
  const n = h.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  return DOC_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/**
 * Where does a model run? "here" (loopback or one of this box's addresses),
 * "other_box" (local-network but not ours), "cloud" (proven public), "unproven"
 * (a name or literal that cannot be proven local OR public: 0.0.0.0, ::, NAT64
 * and other reserved or embedded literals), "missing" (no provider row, no model
 * half, or a role: ref - callers resolve a role first). localMarks is passed to
 * cloudStatus, which ignores it until marks exist.
 */
export function whereItRuns(key, { providers, ownAddrs, resolveDoor = defaultResolveDoor, localSuffixes = DEFAULT_LOCAL_SUFFIXES, localMarks } = {}) {
  if (isRoleRef(key)) return "missing";
  const { provider, model } = splitKey(key);
  const first = providerById(providers, provider);
  if (!first || !model) return "missing";
  const own = ownAddrs || getOwnAddresses();
  const status = cloudStatus(key, { providers, resolveDoor, ownAddrs: own, localSuffixes, localMarks });
  if (status === "unknown") return "unproven";
  if (status === "cloud") {
    // Every IP-literal hop that made it cloud must be a proven public address.
    let row = first;
    for (let hops = 0; row && hops <= MAX_DOOR_HOPS; hops++) {
      const h = hostnameOf(row.baseUrl);
      if (h && isIP(h) && !own.has(h) && addressClass(h) && !isDirectPublic(h) && !isDocumentationV4(h) && !isLocalHop(h)) return "unproven";
      const up = resolveDoor(row, providers);
      if (up === row) break;
      row = up;
    }
    return "cloud";
  }
  const h = hostnameOf(first.baseUrl);
  return h && (own.has(h) || addressClass(h) === "loopback") ? "here" : "other_box";
}

// Public AND not an IPv4 smuggled through a translator or tunnel (NAT64, 6to4, Teredo, ...).
const isDirectPublic = (h) => { const c = classifyIp(h); return c.cls === "public" && (c.via === null || c.via === "mapped"); };
const isLocalHop = (h) => ["loopback", "rfc1918", "cgnat", "linklocal", "ula"].includes(addressClass(h));

function capabilityOk(need, p, modelId) {
  const m = modelEntry(p, modelId);
  const task = m && typeof m === "object" && typeof m.task === "string" ? m.task.toLowerCase() : null;
  switch (need) {
    case "embed": return EMBED_TASKS.includes(task);
    case "score": return RERANK_TASKS.includes(task);
    case "vision":
      return task === "vision" || (m && typeof m === "object" && (m.vision === true || (Array.isArray(m.input) && m.input.includes("image"))));
    default: return !task || task === "chat" || task === "vision";
  }
}

function classOk(providerId, catalogId, catalog, allowHeavy, servingOverrides) {
  if (allowHeavy) return true;
  const entry = (catalog || []).find((m) => m.id === catalogId) || null;
  const cls = servingClassOf(entry);
  if (cls === null || cls === "resident") return true;
  // The catalog is the ceiling; provider rows are peer-writable and never widen it.
  const override = servingOverrides?.[providerId];
  return typeof override === "string" && override === cls;
}

/** A raw `provider/model` key (both halves non-empty). The one definition: the store and the seed import it. */
export const isRawKey = (k) => { const { provider, model } = splitKey(k); return !!(provider && model); };
const isStringArray = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");

/**
 * One `model_role.<id>` value. Corrupt JSON, a non-object, or a model that is
 * neither a raw `provider/model` nor a `role:` ref gives null. Never throws.
 * @returns {{model:string|null, fallback?:string[], seeded:boolean}|null}
 */
export function parseBindingValue(raw) {
  let v;
  try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const model = v.model ?? null;
  if (model !== null && !(typeof model === "string" && (isRoleRef(model) || isRawKey(model)))) return null;
  const out = { model };
  if (isStringArray(v.fallback)) out.fallback = [...v.fallback];
  out.seeded = v.seeded === true;
  return out;
}

const CUSTOM_CAPABILITIES = ["chat", "vision"];

function parseCustomDef(raw) {
  let v;
  try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v) || !CUSTOM_CAPABILITIES.includes(v.capability)) return null;
  // Spec 10-21 §3.2: a definition is {label, job, capability}; anything else is dropped.
  const def = { capability: v.capability };
  if (typeof v.label === "string") def.label = v.label;
  if (typeof v.job === "string") def.job = v.job;
  return def;
}

/**
 * `dashboard_settings` rows ({key, value}) -> {bindings, customDefs}. Unknown
 * ids, corrupt values, and custom defs whose capability is not chat or vision
 * are dropped. A custom binding is kept only when its definition survives.
 */
export function parseBindingRows(rows) {
  const bindings = {}, customDefs = {};
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    const k = r?.key;
    if (typeof k !== "string" || !k.startsWith(ROLE_DEF_PREFIX)) continue;
    const id = k.slice(ROLE_DEF_PREFIX.length);
    if (!isValidCustomRoleId(id)) continue;
    const def = parseCustomDef(r.value);
    if (def) customDefs[id] = def;
  }
  for (const r of list) {
    const k = r?.key;
    if (typeof k !== "string" || !k.startsWith(ROLE_BINDING_PREFIX)) continue;
    const id = k.slice(ROLE_BINDING_PREFIX.length);
    if (!CORE_BY_ID.has(id) && !customDefs[id]) continue;
    const b = parseBindingValue(r.value);
    if (b) bindings[id] = b;
  }
  return { bindings, customDefs };
}

function makeDefOf(customDefs) {
  return (id) => CORE_BY_ID.get(id) || (isValidCustomRoleId(id) && customDefs?.[id]
    ? { id, capability: customDefs[id].capability || "chat", allowHeavy: !!customDefs[id].allowHeavy, defaultFallback: customDefs[id].fallback || [] }
    : null);
}

/**
 * Walk a role's chain (bound model, then fallbacks, depth-first), yielding
 * every candidate in visit order:
 *   {role, key, verdict, filtered}
 * verdict: ok | not_configured | foreign | capability | class (a raw-key
 * candidate), or cycle | too_deep (key null). "not configured" is decided
 * first; the foreign, capability and class filters are still evaluated for a
 * not-configured candidate whenever a provider row or catalog entry exists,
 * and `filtered` is true when any filter rejects it, whatever the verdict.
 *
 * A heavy (non-resident) model needs allowHeavy on both the root and the role
 * that binds it, so an automatic root never reaches one through a fallback.
 *
 * `out.chain` (optional) receives the roles visited so far, live.
 * Unknown and media roots yield nothing.
 */
export function* walkRole(rootId, ctx = {}, out = {}) {
  const { need, bindings = {}, customDefs = {}, providers = [], models, catalog = [], ownInstanceId, servingOverrides = {} } = ctx;
  const defOf = makeDefOf(customDefs);
  const root = defOf(rootId);
  const chain = (out.chain = []);
  if (!root || isMedia(root)) return;
  const wanted = need || root.capability;
  const onPath = new Set(); // roles reached by indirection or fallback on the current path
  const seen = new Set();   // every role already tried (fallback revisits are skipped silently)

  const judge = (id, rawKey, def) => {
    const configured = isConfigured(rawKey, { models });
    const { provider, model } = splitKey(rawKey);
    const p = providerById(providers, provider);
    let foreign = false, capability = false;
    if (p) {
      if (isInstanceIdShape(p.host)) {
        if (typeof ownInstanceId === "function") foreign = isForeignInstanceHost(p.host, ownInstanceId);
        else if (configured) throw new TypeError("resolveRoleKey: ownInstanceId (a function) is required to resolve a role");
        else foreign = true; // cannot prove it is ours: fail closed for a candidate list
      }
      capability = !capabilityOk(wanted, p, model);
    }
    // Without a provider row the foreign check is not applicable, but the catalog class still is.
    // An automatic root never lands on a windowed/wedge-risk model through a chain (10-21 §5): root AND binder must allow heavy.
    const heavy = !classOk(provider, p?.gpuPolicy?.catalogId || provider, catalog, root.allowHeavy && def.allowHeavy, servingOverrides);
    const verdict = !configured ? "not_configured" : foreign ? "foreign" : capability ? "capability" : heavy ? "class" : "ok";
    return { role: id, key: rawKey, verdict, filtered: foreign || capability || heavy };
  };

  function* visit(id, viaIndirection, depth) {
    if (onPath.has(id) && viaIndirection) { yield { role: id, key: null, verdict: "cycle", filtered: false }; return; }
    if (seen.has(id)) return;
    if (depth > MAX_CHAIN_DEPTH || seen.size >= MAX_VISITS) { yield { role: id, key: null, verdict: "too_deep", filtered: false }; return; }
    const def = defOf(id);
    if (!def) return;
    seen.add(id); onPath.add(id); chain.push(id);
    if (isMedia(def)) {
      yield { role: id, key: null, verdict: "capability", filtered: true };
    } else {
      const b = bindings?.[id] || {};
      if (typeof b.model === "string" && b.model) {
        if (isRoleRef(b.model)) yield* visit(roleIdOf(b.model), true, depth + 1);
        else yield judge(id, b.model, def);
      }
      const fb = Array.isArray(b.fallback) ? b.fallback : def.defaultFallback;
      for (const f of fb) yield* visit(isRoleRef(f) ? roleIdOf(f) : f, false, depth + 1);
    }
    onPath.delete(id);
  }

  yield* visit(rootId, false, 1);
}

const bareRoleId = (r) => (isRoleRef(r) ? roleIdOf(r) : r);

/** The usable candidates of a role in resolver order: configured-or-not, never filtered, each key once (its first occurrence). */
export function roleCandidates(roleId, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const e of walkRole(bareRoleId(roleId), ctx)) {
    if (!e.key || e.filtered || !(e.verdict === "ok" || e.verdict === "not_configured") || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({ role: e.role, key: e.key });
  }
  return out;
}

/**
 * Resolve `key` (raw `provider/model` or `role:<id>`) to a usable raw key.
 * @returns {{key:string|null, role:string|null, chain:string[], reason:string}}
 * reason is one of: raw | bound | fallback | unknown_role | cycle | too_deep | capability | not_configured | unset
 * (a media root, MEDIA_CAPABILITIES, is refused with "capability").
 */
export function resolveRoleKey(key, ctx = {}) {
  if (!isRoleRef(key)) return { key: key ?? null, role: null, chain: [], reason: "raw" };
  const rootId = roleIdOf(key);
  const root = makeDefOf(ctx.customDefs)(rootId);
  if (!root) return { key: null, role: rootId, chain: [], reason: "unknown_role" };
  if (isMedia(root)) return { key: null, role: rootId, chain: [], reason: "capability" };

  const trace = {};
  let cycle = false, tooDeep = false, sawCapability = false, sawNotConfigured = false;
  for (const e of walkRole(rootId, ctx, trace)) {
    if (e.verdict === "ok") return { key: e.key, role: rootId, chain: [...trace.chain], reason: trace.chain.length > 1 ? "fallback" : "bound" };
    if (e.verdict === "cycle") cycle = true;
    else if (e.verdict === "too_deep") tooDeep = true;
    else if (e.verdict === "capability") sawCapability = true;
    else sawNotConfigured = true; // not_configured, foreign, class
  }
  const reason = cycle ? "cycle" : tooDeep ? "too_deep" : sawCapability ? "capability" : sawNotConfigured ? "not_configured" : "unset";
  return { key: null, role: rootId, chain: trace.chain || [], reason };
}

/**
 * For consumers with their own default: a role resolves only when the user
 * chose it (a binding row with a non-null model and no `seeded`). Otherwise
 * {key:null, reason:"not_chosen"} and the consumer runs its own logic. A
 * chosen root walks its chain normally, through seeded roles too.
 */
export function resolveChosenRoleKey(key, ctx = {}) {
  if (!isRoleRef(key)) return resolveRoleKey(key, ctx);
  const rootId = roleIdOf(key);
  if (!makeDefOf(ctx.customDefs)(rootId)) return { key: null, role: rootId, chain: [], reason: "unknown_role" };
  const b = ctx.bindings?.[rootId];
  if (!b || b.model == null || b.seeded === true) return { key: null, role: rootId, chain: [], reason: "not_chosen" };
  return resolveRoleKey(key, ctx);
}
