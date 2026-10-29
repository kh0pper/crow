/**
 * Model roles: what may fill a role, judged by the resolver's own rules.
 *
 * A candidate is offered only when binding it would make the role resolve to
 * it (resolveRoleKey on a hypothetical binding), so the page never lists a
 * model the resolver would skip (capability, serving class, foreign owner).
 *
 * Pure: the caller passes a RoleContext (loadRoleContext) and own addresses.
 */
import { splitKey } from "../../scripts/pi-bots/model_resolver.mjs";
import {
  CORE_ROLES, ROLE_LABEL_KEYS, MEDIA_CAPABILITIES, resolveRoleKey, walkRole,
  whereItRuns, isCloudKey, isValidCustomRoleId,
} from "./model-roles.js";
import { friendlyModel } from "../gateway/dashboard/shared/bot-display.js";
import { t, fill } from "../gateway/dashboard/shared/i18n.js";

const WHERE_RANK = Object.freeze({ here: 0, other_box: 1, cloud: 2, unproven: 3, missing: 4 });
/** I12: only the provider matters at run time for these, so one pick per provider. */
const PER_PROVIDER = new Set(["embed", "rerank"]);

/** Never offered as "Same as", and never offered other roles. */
const NO_CHAIN = "safety";

const CORE_BY_ID = new Map(CORE_ROLES.map((r) => [r.id, r]));

function capabilityOf(roleId, customDefs) {
  const core = CORE_BY_ID.get(roleId);
  if (core) return core.capability;
  return isValidCustomRoleId(roleId) && customDefs?.[roleId] ? customDefs[roleId].capability || "chat" : null;
}

function roleLabel(roleId, customDefs, lang) {
  if (CORE_BY_ID.has(roleId)) return t(ROLE_LABEL_KEYS[roleId], lang);
  const l = customDefs?.[roleId]?.label;
  return typeof l === "string" && l.trim() ? l.trim() : roleId;
}

/** The provider's display name: its description cut at the first " (", else its id. */
function providerLabel(providerId, providers) {
  const p = (providers || []).find((r) => r && r.id === providerId);
  const d = typeof p?.description === "string" ? p.description.trim() : "";
  if (!d) return providerId;
  const cut = d.indexOf(" (");
  return cut > 0 ? d.slice(0, cut) : d;
}

/** ctx with roleId bound to {model, fallback: []}; ctx itself is never mutated. */
const hypothetical = (ctx, roleId, model) =>
  ({ ...ctx, bindings: { ...(ctx.bindings || {}), [roleId]: { model, fallback: [], seeded: false } } });

function tryResolve(roleId, ctx) {
  try { return resolveRoleKey(`role:${roleId}`, ctx); } catch { return { key: null, reason: "error" }; }
}

/** Any usable candidate of safety's chain under ctxX that is not proven local (no marks, minor e). */
function safetyReachesCloud(ctxX, ownAddrs) {
  try {
    for (const e of walkRole("safety", ctxX)) {
      if (!e.key || e.filtered || !(e.verdict === "ok" || e.verdict === "not_configured")) continue;
      if (isCloudKey(e.key, { providers: ctxX.providers, ...(ownAddrs ? { ownAddrs } : {}) })) return true;
    }
  } catch { return true; } // cannot judge the chain: refuse
  return false;
}

/**
 * @typedef {{key:string, label:string, where:string, provider:string|null, recommended:boolean, allowed:boolean, why?:"cloud_refused"}} Pick
 * @param {string} roleId
 * @param {{ctx:object, lang?:string, recommendedFn?:(roleId:string)=>string[], ownAddrs?:Set<string>, localMarks?:object}} opts
 *   localMarks only shapes `where`; the safety check never uses them.
 * @returns {Pick[]}
 */
export function listRolePicks(roleId, { ctx, lang = "en", recommendedFn = () => [], ownAddrs, localMarks } = {}) {
  if (!ctx) return [];
  const capability = capabilityOf(roleId, ctx.customDefs);
  if (!capability || MEDIA_CAPABILITIES.includes(capability)) return [];
  const providers = ctx.providers || [];
  const own = ownAddrs ? { ownAddrs } : {};
  const where = (key) => (key ? whereItRuns(key, { providers, localMarks, ...own }) : "missing");

  let rec;
  try { rec = new Set((recommendedFn(roleId) || []).filter((k) => typeof k === "string")); } catch { rec = new Set(); }

  const out = [];
  const add = (key, label, resolvedKey, ctxX) => {
    const pick = {
      key,
      label,
      where: where(resolvedKey),
      provider: resolvedKey ? splitKey(resolvedKey).provider || null : null,
      recommended: rec.has(key),
      allowed: true,
    };
    if (roleId === "safety" && safetyReachesCloud(ctxX, ownAddrs)) {
      pick.allowed = false;
      pick.why = "cloud_refused";
    }
    out.push(pick);
  };

  // Raw candidates: every model of every enabled provider (ctx.models is the enabled set).
  const perProvider = PER_PROVIDER.has(roleId);
  for (const [providerId, entry] of Object.entries(ctx.models?.providers || {})) {
    const list = Array.isArray(entry?.models) ? entry.models : [];
    for (const m of list) {
      const modelId = typeof m === "string" ? m : m?.id;
      if (typeof modelId !== "string" || !modelId) continue;
      const key = `${providerId}/${modelId}`;
      const ctxX = hypothetical(ctx, roleId, key);
      if (tryResolve(roleId, ctxX).reason !== "bound") continue;
      add(key, perProvider ? providerLabel(providerId, providers) : friendlyModel(key, providers), key, ctxX);
      if (perProvider) break; // the provider's first model with a matching task
    }
  }

  // Role refs: for a chat role, every other chat role that resolves when followed.
  // The classifier is a safety boundary with its own refusal rules: it is never
  // chained, in either direction.
  if (capability === "chat" && roleId !== NO_CHAIN) {
    const ids = [...CORE_ROLES.map((r) => r.id), ...Object.keys(ctx.customDefs || {})];
    for (const id of ids) {
      if (id === roleId || id === NO_CHAIN || capabilityOf(id, ctx.customDefs) !== "chat") continue;
      const key = `role:${id}`;
      const ctxX = hypothetical(ctx, roleId, key);
      const r = tryResolve(roleId, ctxX);
      if (r.reason !== "bound" && r.reason !== "fallback") continue;
      add(key, fill(t("models.ui.sameAs", lang), { role: roleLabel(id, ctx.customDefs, lang) }), r.key, ctxX);
    }
  }

  return out.sort((a, b) =>
    (b.recommended - a.recommended)
    || (WHERE_RANK[a.where] ?? 9) - (WHERE_RANK[b.where] ?? 9)
    || a.label.localeCompare(b.label)
    || a.key.localeCompare(b.key));
}
