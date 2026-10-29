/**
 * Model roles: preview a rebind (who moves, any cloud model the changed chain
 * newly reaches, refusals, pins), then apply it only with fresh acks.
 *
 * The cloud warning (C2, narrowed by N5): for the changed role and every role
 * that reaches it, every usable candidate its chain can walk to counts, not
 * only today's resolution, so a cloud model sitting behind a working local one
 * warns now. Only pairs (role, cloud key) that are reachable after the change
 * and not before count: a local rebind under an already-cloud consumer needs
 * no new acknowledgement.
 *
 * apply recomputes the preview and refuses unless its hash matches the one the
 * user saw and the acknowledgements it needs are given. Env vars are never
 * touched; a setting pin is cleared only with replacePin.
 */
import { createHash } from "node:crypto";
import { splitKey } from "../../scripts/pi-bots/model_resolver.mjs";
import {
  resolveRoleKey, resolveChosenRoleKey, walkRole, isCloudKey, whereItRuns,
  finalHopRow, isRoleRef, roleIdOf, isRawKey, isValidCustomRoleId,
} from "./model-roles.js";
import {
  loadRoleContext, setBinding, addBindingsChangeListener, invalidateRoleContext, normalizeCustomDef, saveCustomRole,
} from "./model-roles-store.js";
import { scanSlots } from "./model-consumers.js";
import { listRoleConsumers, rolesReaching } from "./role-consumers.js";
import { getOwnAddresses } from "./locality.js";
import { parseClassifierSetting } from "./bot-bash-policy.js";
import { friendlyModel } from "../gateway/dashboard/shared/bot-display.js";
import { readSetting, writeSetting } from "../gateway/dashboard/settings/registry.js";
import { clearProviderTaskCache, pickProviderByTask, EMBED_TASKS } from "./provider-task.js";
import { hostnameOf } from "./provider-host.js";

/** Operator pins that override a role today: a setting, and for some an env var. */
export const LEGACY_PINS = Object.freeze({
  embed: Object.freeze({ setting: "embed_provider", env: "CROW_EMBED_PROVIDER" }),
  rerank: Object.freeze({ setting: "rerank_provider", env: "CROW_RERANK_PROVIDER" }),
  safety: Object.freeze({ setting: "bot_safety_classifier" }),
});

// m8: the gateway's resolveProviderForTask cache follows every binding change.
addBindingsChangeListener(() => clearProviderTaskCache());

const SAFETY_REFUSAL = Object.freeze({ id: "safety", labelKey: "settings.providers.job.safety" });
const PHONE_LOCAL = Object.freeze({ id: "phone_local_model", labelKey: "settings.providers.phone.local" });
const CONSUMER_GROUPS = ["unattended", "bots", "subagents", "jobs", "otherCrows", "notAffected", "keepsOwnModel"];

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The router's own gate (smart-router.js chooseProvider): it reads no tier unless smart_chat is true. */
async function smartChatOn(db) {
  try {
    const v = JSON.parse((await readSetting(db, "feature_flags")) || "null");
    return !!(v && v.smart_chat === true);
  } catch { return false; }
}

const SMART_PREFIX = "smart-router:";
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * What the sheet may show for a setting pin. Never the raw value: a URL is
 * shown by its host only (no userinfo, path or query), a JSON blob by its
 * model or name field, a `provider/model` by the model's display name, and
 * a bare provider id as itself. null means "a custom setting".
 */
export function pinDisplay(raw, providers) {
  const v = str(raw);
  if (!v) return null;
  if (URL_RE.test(v)) return hostnameOf(v);
  if (v.startsWith("{")) {
    let o = null;
    try { o = JSON.parse(v); } catch { o = null; }
    if (!o || typeof o !== "object") return null;
    for (const k of ["model", "name"]) if (str(o[k]) && !URL_RE.test(o[k])) return str(o[k]);
    return typeof o.url === "string" ? hostnameOf(o.url) : null;
  }
  const cls = parseClassifierSetting(v);
  if (cls?.provider) return friendlyModel(`${cls.provider}/${cls.model}`, providers) || cls.model;
  return /^[A-Za-z0-9._:-]+$/.test(v) ? v : null;
}

/** A shallow copy of ctx with roleId bound to {model, fallback}; the memoized ctx is never mutated. */
function hypothetical(ctx, roleId, { model = null, fallback } = {}) {
  const b = { model: model ?? null, seeded: false };
  if (fallback !== undefined) b.fallback = Array.isArray(fallback) ? [...fallback] : fallback;
  return { ...ctx, bindings: { ...(ctx.bindings || {}), [roleId]: b } };
}

/**
 * Every (viaRole, cloud key) a role in `roles` can walk to under ctxX: usable
 * candidates (ok or not_configured, never filtered) that isCloudKey calls cloud.
 * @returns {Array<{viaRole:string, key:string}>} in `roles` order, each pair once
 */
export function reachableCloud(ctxX, roles, { localMarks, ownAddrs } = {}) {
  const out = [], seen = new Set();
  for (const viaRole of roles) {
    for (const e of walkRole(viaRole, ctxX)) {
      if (!e.key || e.filtered || !(e.verdict === "ok" || e.verdict === "not_configured")) continue;
      const id = `${viaRole}|${e.key}`;
      if (seen.has(id)) continue;
      // Marks never apply to the classifier (minor e), whichever change reaches it.
      if (!isCloudKey(e.key, { providers: ctxX.providers, ...(viaRole === "safety" ? {} : { localMarks }), ownAddrs })) continue;
      seen.add(id);
      out.push({ viaRole, key: e.key });
    }
  }
  return out;
}

/** Pairs in `after` and not in `before`. */
function newlyReachable(before, after) {
  const had = new Set(before.map((p) => `${p.viaRole}|${p.key}`));
  return after.filter((p) => !had.has(`${p.viaRole}|${p.key}`));
}

const providerHalf = (key) => (key ? splitKey(key).provider || null : null);

/** Which provider embeddings come from: env, else the pin (unless replaced), else a chosen embed role, else the task pick. */
function embedProvider(ctxX, { envValue, pinValue }) {
  if (envValue) return envValue;
  if (pinValue) return pinValue;
  let key = null;
  try { key = resolveChosenRoleKey("role:embed", { ...ctxX, need: "embed" }).key; } catch { key = null; }
  return providerHalf(key) || pickProviderByTask(ctxX.providers || [], EMBED_TASKS);
}

function hashOf(consumers, cloud, pin, nextKey, fresh, envPinned) {
  const ids = CONSUMER_GROUPS.flatMap((g) => (consumers[g] || []).map((c) => c.id)).sort();
  const pairs = fresh.map((p) => `${p.viaRole}|${p.key}`).sort();
  return createHash("sha256").update(JSON.stringify([ids, cloud?.host, cloud?.model, pin?.value, nextKey, pairs, envPinned])).digest("hex");
}

const resolvedKey = (roleId, c) => {
  try { return resolveRoleKey(`role:${roleId}`, c).key; } catch { return null; }
};

/**
 * @typedef {{roleId:string, current:{key:string|null, where:string}, next:{key:string|null, reason:string, chain:string[], where:string},
 *   consumers:object, cloud:null|{host:string|null, viaRole:string, model:string, now:boolean}, refused:Array<{id:string, labelKey:string}>,
 *   reembed:boolean, pin:null|{setting:string, value:string|null, custom?:true}, envPinned:boolean, needs:{ackUnattended:boolean, ackCloud:boolean},
 *   needsIfReplacePin:{ackUnattended:boolean, ackCloud:boolean}, previewHash:string}} RolePreview
 *
 * `ctx` defaults to a fresh RoleContext; `slots` to one scanSlots(db).
 *
 * `reembed` ASSUMES "Replace the pin" is ticked: with a setting pin left in
 * place the embedding provider does not change at all. The page must show the
 * re-embed line only while replacePin is ticked. An env pin always wins, so
 * it gives reembed:false.
 *
 * `needs.ackUnattended` (the owner's 10-21 ruling, "rebinds that MOVE
 * unattended bots"): an unattended consumer exists, or a job's key under the
 * change differs from today's, judged the way that job reads it: a
 * smart-router tier only while smart chat is on and only through a chosen
 * binding; a job held by a setting pin does not move unless the pin is
 * replaced. `needs` assumes the pin stays; `needsIfReplacePin` (same shape)
 * is what applies once "Replace the pin" is ticked. Exposure through a
 * fallback only is the cloud warning's business.
 *
 * `pin.value` is a display name (pinDisplay), never the stored value; null
 * with `custom: true` when there is nothing safe to show.
 * `localMarks` (default ctx.localMarks) and `ownAddrs` pass through to the
 * cloud check; a safety change, the safety refusal and any chain walked via
 * safety never use marks (minor e).
 * @returns {Promise<RolePreview>}
 */
export async function previewRoleChange(db, roleId, change = {}, { ctx, slots, env = process.env, localMarks, ownAddrs, nextCustomDefs } = {}) {
  ctx ??= await loadRoleContext(db, { maxAgeMs: 0 });
  slots ??= await scanSlots(db, { withUnattended: true, includeSubagents: false, env });
  ownAddrs ??= getOwnAddresses(); // once per preview, not per candidate
  // The marks the Models page uses (the context's by default), so the sheet
  // and the page agree; never for a safety change (minor e).
  localMarks = roleId === "safety" ? undefined : localMarks ?? ctx.localMarks;
  const ctxX = hypothetical(ctx, roleId, change);
  // A custom-role edit: the same binding under the edited definitions.
  if (nextCustomDefs) ctxX.customDefs = nextCustomDefs;
  const whereOpts = { providers: ctx.providers, localMarks, ownAddrs };

  const cur = resolveRoleKey(`role:${roleId}`, ctx);
  const nxt = resolveRoleKey(`role:${roleId}`, ctxX);
  const where = (key) => (key ? whereItRuns(key, whereOpts) : "missing");

  const extraIds = slots.filter((s) => isRoleRef(s.value)).map((s) => roleIdOf(s.value));
  const reach = [...rolesReaching(roleId, { bindings: ctxX.bindings, customDefs: ctxX.customDefs, extraIds })];
  const reachSet = new Set(reach);

  const smartChat = await smartChatOn(db);
  const consumers = await listRoleConsumers(db, roleId, { slots, roleCtx: ctx, env, smartChat });

  // C2 + N5: cloud models newly reachable through any chain in reach.
  const fresh = newlyReachable(
    reachableCloud(ctx, reach, { localMarks, ownAddrs }),
    reachableCloud(ctxX, reach, { localMarks, ownAddrs }),
  );
  let cloud = null;
  if (fresh.length) {
    const { viaRole, key } = fresh[0];
    cloud = { host: hostnameOf(finalHopRow(key, { providers: ctx.providers })?.baseUrl) || null, viaRole, model: key, now: resolvedKey(viaRole, ctxX) === key };
  }

  const refused = [];
  if (reachSet.has("safety")) {
    // Marks never apply to the classifier (minor e).
    const unmarked = newlyReachable(reachableCloud(ctx, ["safety"], { ownAddrs }), reachableCloud(ctxX, ["safety"], { ownAddrs }));
    if (unmarked.length) refused.push({ ...SAFETY_REFUSAL });
  }
  const phone = slots.find((s) => s.kind === "phone" && s.id === PHONE_LOCAL.id && isRoleRef(s.value));
  if (phone && reachSet.has(roleIdOf(phone.value))) {
    const r = roleIdOf(phone.value);
    if (fresh.some((p) => p.viaRole === r)) refused.push({ ...PHONE_LOCAL });
  }

  const readPin = async (r) => {
    const l = LEGACY_PINS[r];
    if (!l?.setting) return null;
    try { return str(await readSetting(db, l.setting)); } catch (e) { console.warn(`[roles] pin ${l.setting} unreadable: ${e?.message}`); return null; }
  };
  const legacy = LEGACY_PINS[roleId] || null;
  const pinRaw = legacy ? await readPin(roleId) : null;
  let pin = null;
  if (pinRaw) {
    const shown = pinDisplay(pinRaw, ctx.providers);
    pin = shown ? { setting: legacy.setting, value: shown } : { setting: legacy.setting, value: null, custom: true };
  }
  const envValue = legacy?.env ? str(env?.[legacy.env]) : null;
  const envPinned = !!envValue;

  // I12: embeddings re-index only when the provider changes.
  const reembed = reachSet.has("embed")
    && embedProvider(ctx, { envValue: str(env?.CROW_EMBED_PROVIDER), pinValue: roleId === "embed" ? pinRaw : null })
      !== embedProvider(ctxX, { envValue: str(env?.CROW_EMBED_PROVIDER), pinValue: null });

  // A job consumer's own role is the head of its via path; each job is judged the way it reads its role.
  const jobKey = (c, r, cx) => {
    if (!String(c.id).startsWith(SMART_PREFIX)) return resolvedKey(r, cx);
    const need = c.id === `${SMART_PREFIX}vision` ? "vision" : "chat";
    try { return resolveChosenRoleKey(`role:${r}`, { ...cx, need }).key || null; } catch { return null; }
  };
  const pinHeld = new Map();
  for (const c of consumers.jobs) {
    const r = Array.isArray(c.via) && c.via.length ? c.via[0] : null;
    if (r && LEGACY_PINS[r] && !pinHeld.has(r)) pinHeld.set(r, r === roleId ? !!pinRaw : !!(await readPin(r)));
  }
  const jobMoves = (replacePin) => consumers.jobs.some((c) => {
    const r = Array.isArray(c.via) && c.via.length ? c.via[0] : null;
    if (r === null) return false;
    if (String(c.id).startsWith(SMART_PREFIX) && !smartChat) return false;
    if (pinHeld.get(r) && !(replacePin && r === roleId)) return false;
    return jobKey(c, r, ctx) !== jobKey(c, r, ctxX);
  });
  const needsFor = (replacePin) => ({
    ackUnattended: consumers.unattended.length > 0 || jobMoves(replacePin),
    ackCloud: cloud !== null,
  });
  const needs = needsFor(false);
  const needsIfReplacePin = pin ? needsFor(true) : needs;
  return {
    roleId,
    current: { key: cur.key, where: where(cur.key) },
    next: { key: nxt.key, reason: nxt.reason, chain: nxt.chain, where: where(nxt.key) },
    consumers,
    cloud,
    refused,
    reembed,
    pin,
    envPinned,
    needs,
    needsIfReplacePin,
    // The hash covers the stored pin, not the name shown for it.
    previewHash: hashOf(consumers, cloud, pinRaw ? { value: pinRaw } : null, nxt.key, fresh, envPinned),
  };
}

/**
 * Apply a rebind the user previewed. Refusals, in order: preview_changed,
 * cloud_refused (m4: a safety change whose model is a cloud raw key, whatever
 * that provider's enabled or configured state, or whose chain can reach any
 * cloud candidate; local marks never count for the classifier),
 * needs_ack_unattended, needs_ack_cloud, then any setBinding refusal.
 * @returns {Promise<{ok:true, preview:RolePreview}|{ok:false, reason:string, preview:RolePreview}>}
 */
export async function applyRoleChange(db, roleId, change = {}, {
  actor, previewHash, ackUnattended = false, ackCloud = false, replacePin = false,
  env = process.env, localMarks, ownAddrs,
} = {}) {
  const ctx = await loadRoleContext(db, { maxAgeMs: 0 });
  ownAddrs ??= getOwnAddresses();
  const preview = await previewRoleChange(db, roleId, change, { ctx, env, localMarks, ownAddrs });
  const fail = (reason) => ({ ok: false, reason, preview });
  if (typeof previewHash !== "string" || previewHash !== preview.previewHash) return fail("preview_changed");
  if (roleId === "safety") {
    const own = { ownAddrs };
    const m = change.model;
    if (typeof m === "string" && isRawKey(m) && isCloudKey(m, { providers: ctx.providers, ...own })) return fail("cloud_refused");
    if (reachableCloud(hypothetical(ctx, roleId, change), ["safety"], own).length) return fail("cloud_refused");
  }
  const needs = replacePin && preview.pin ? preview.needsIfReplacePin : preview.needs;
  if (needs.ackUnattended && ackUnattended !== true) return fail("needs_ack_unattended");
  if (needs.ackCloud && ackCloud !== true) return fail("needs_ack_cloud");

  const r = await setBinding(db, roleId, { model: change.model ?? null, fallback: change.fallback }, { actor });
  if (!r.ok) return fail(r.reason);
  if (replacePin && preview.pin) {
    await writeSetting(db, preview.pin.setting, "", { scope: "global" });
    // setBinding already fired the listeners; the pin write must clear the cache too.
    invalidateRoleContext();
    clearProviderTaskCache();
  }
  return { ok: true, preview };
}

// ---- custom-role edits -------------------------------------------------------

/** The fields whose change can move what a custom role resolves to. */
const defMoves = (a, b) => a.capability !== b.capability || !!a.allowHeavy !== !!b.allowHeavy;

/**
 * m14: what an edit to custom role `id` does before it is saved: the role's
 * own stored binding resolved under the edited definition (previewRoleChange
 * with the hypothetical customDefs). The hash also covers the definition, so
 * a preview of one edit never authorises another. `def` is normalised as
 * saveCustomRole would store it; an invalid def or an unknown id throws.
 * @returns {Promise<RolePreview>}
 */
export async function previewCustomRoleEdit(db, id, def, { ctx, env = process.env, localMarks, ownAddrs } = {}) {
  ctx ??= await loadRoleContext(db, { maxAgeMs: 0 });
  const n = normalizeCustomDef(def);
  if (n.error) throw new TypeError(`previewCustomRoleEdit: ${n.error}`);
  if (!isValidCustomRoleId(id) || !ctx.customDefs?.[id]) throw new TypeError("previewCustomRoleEdit: unknown_role");
  const b = ctx.bindings?.[id] || null;
  const change = { model: b?.model ?? null, ...(Array.isArray(b?.fallback) ? { fallback: [...b.fallback] } : {}) };
  const nextCustomDefs = { ...ctx.customDefs, [id]: n.def };
  const pv = await previewRoleChange(db, id, change, { ctx, env, localMarks, ownAddrs, nextCustomDefs });
  const previewHash = createHash("sha256").update(JSON.stringify([pv.previewHash, id, n.def.capability, !!n.def.allowHeavy])).digest("hex");
  // The sheet names the model the way the page does, never by its raw key alone.
  const label = pv.next.key ? friendlyModel(pv.next.key, ctx.providers) || pv.next.key : null;
  return { ...pv, next: { ...pv.next, label }, previewHash };
}

/**
 * Save a custom role from the page. A create, or an edit that keeps the
 * capability and the big-models switch, is written at once. An edit that
 * changes either needs the hash of a fresh previewCustomRoleEdit (refusals:
 * needs_preview without one, preview_changed on a mismatch) and the acks
 * that preview asks for (needs_ack_unattended, needs_ack_cloud). A refusal
 * after a preview carries it. `ctx` (default a fresh RoleContext) is the
 * context the preview is computed in; the route passes the one its own
 * preview route uses.
 * @returns {Promise<{ok:true, id:string}|{ok:false, reason:string, preview?:RolePreview}>}
 */
export async function applyCustomRoleEdit(db, def = {}, {
  actor, previewHash, ackUnattended = false, ackCloud = false, env = process.env, localMarks, ownAddrs, ctx,
} = {}) {
  const n = normalizeCustomDef(def);
  if (n.error) return { ok: false, reason: n.error };
  if (def.id === undefined || def.id === null) return saveCustomRole(db, { ...n.def }, { actor });
  ctx ??= await loadRoleContext(db, { maxAgeMs: 0 });
  const was = isValidCustomRoleId(def.id) ? ctx.customDefs?.[def.id] : null;
  if (!was) return { ok: false, reason: "unknown_role" };
  if (defMoves(was, n.def)) {
    const preview = await previewCustomRoleEdit(db, def.id, n.def, { ctx, env, localMarks, ownAddrs });
    const fail = (reason) => ({ ok: false, reason, preview });
    if (typeof previewHash !== "string" || !previewHash) return fail("needs_preview");
    if (previewHash !== preview.previewHash) return fail("preview_changed");
    if (preview.needs.ackUnattended && ackUnattended !== true) return fail("needs_ack_unattended");
    if (preview.needs.ackCloud && ackCloud !== true) return fail("needs_ack_cloud");
  }
  return saveCustomRole(db, { id: def.id, ...n.def }, { actor });
}
