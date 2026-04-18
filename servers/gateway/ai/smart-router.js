/**
 * Smart Crow Chat — Path C auto-router.
 *
 * Pure function over a small rule set; no LLM classification. Given a
 * user message + its attachments + the conversation's recent context,
 * pick one of a few canonical routes (code / vision / fast / deep /
 * default) and resolve it to a { provider_id, model_id, reason } tuple.
 * chat.js calls this when the conversation's profile has kind="auto".
 *
 * Precedence (plan Path C):
 *   slash-command > attachment > keyword > fallback
 *
 * Route → provider mapping is driven by auto_rules.overrides (per-profile)
 * with a baked-in default fallback. An empty overrides map means "pick
 * the best-known local provider for this route" — the defaults are:
 *
 *   code    → crow-swap-agentic (Qwen3.6-35B-A3B agentic coder)
 *   vision  → grackle-vision
 *   fast    → crow-dispatch
 *   deep    → crow-swap-deep
 *   default → crow-chat (also the final fallback)
 *
 * Feature-flag gating: chooseProvider() first reads
 * dashboard_settings.feature_flags.smart_chat (local-only via
 * readSetting). If false/missing, throws SmartChatDisabled. chat.js
 * catches and falls back to the conversation's baked model. Ensures
 * non-UI clients can't accidentally route.
 *
 * Cross-vendor tool-use: when the chosen route's vendor differs from
 * the conversation's active vendor AND the history has tool_calls, the
 * router returns the current model with reason "vendor-lock" and logs
 * the skip — never silently breaks a tool-call replay.
 */

import { readSetting } from "../dashboard/settings/registry.js";
import { vendorBucket, hasActiveToolCalls } from "./vendor-guard.js";

export class SmartChatDisabled extends Error {
  constructor() { super("Smart Chat disabled"); this.code = "smart_chat_disabled"; }
}

const DEFAULT_ROUTES = {
  code:    "crow-swap-agentic",
  vision:  "grackle-vision",
  fast:    "crow-dispatch",
  deep:    "crow-swap-deep",
  default: "crow-chat",
};

// Regex fixtures — narrow, documentable patterns. Not LLM-based.
const SLASH_RE    = /^\/(code|vision|fast|deep)\b/i;
const CODE_FENCE  = /```[\s\S]*?```/m;
const CODE_KW     = /\b(write|debug|refactor|implement) (a|this|my)\b/i;
const DEEP_KW     = /\b(summarize|analyze|compare|contrast)\b/i;

/**
 * Strip a leading slash-command from raw message content. Used by
 * chat.js when it builds aiMessages for the adapter — the raw version
 * is preserved in chat_messages.content for transparency, but the
 * adapter sees the clean prompt.
 * @param {string} text
 * @returns {string}
 */
export function stripSlashCommand(text) {
  if (typeof text !== "string") return text;
  const m = text.match(SLASH_RE);
  if (!m) return text;
  return text.slice(m[0].length).replace(/^[\s\r\n]+/, "");
}

/**
 * Detect the slash-command in a raw user message, returning its canonical
 * route id or null.
 */
export function detectSlashCommand(text) {
  if (typeof text !== "string") return null;
  const m = text.match(SLASH_RE);
  return m ? m[1].toLowerCase() : null;
}

function hasImageAttachment(attachments) {
  if (!Array.isArray(attachments)) return false;
  return attachments.some((a) => a && typeof a.mime_type === "string" && a.mime_type.startsWith("image/"));
}

function detectKeywordRoute(content) {
  if (typeof content !== "string" || !content) return null;
  if (CODE_FENCE.test(content) || CODE_KW.test(content)) return "code";
  // DEEP_KW requires the message to also be substantial (>200 chars), per plan.
  if (DEEP_KW.test(content) && content.length >= 200) return "deep";
  return null;
}

/**
 * Resolve a route id → provider row using the profile's auto_rules
 * overrides when present, else the baked-in default. If the mapped
 * provider is disabled/missing, fall through to the final `default`
 * route and then to `crow-chat`.
 */
function resolveRouteToProvider(route, providers, rules) {
  const overrides = rules?.overrides || {};
  const fallback = rules?.fallback || DEFAULT_ROUTES.default;
  const byId = new Map(providers.map((p) => [p.id, p]));

  const pick = (candidate) => {
    if (!candidate) return null;
    const p = byId.get(candidate);
    if (p && !p.disabled) return p;
    return null;
  };

  // 1. auto_rules override for this specific route
  const custom = pick(overrides[route]);
  if (custom) return custom;
  // 2. baked-in default for this route
  const baked = pick(DEFAULT_ROUTES[route]);
  if (baked) return baked;
  // 3. profile fallback provider
  const fb = pick(fallback);
  if (fb) return fb;
  // 4. absolute last resort
  return pick(DEFAULT_ROUTES.default);
}

/**
 * Choose a provider + model + reason for the current message.
 *
 * @param {object} args
 * @param {object} args.db                 libsql client
 * @param {number} args.convId             chat_conversations.id
 * @param {string} args.content            raw user text (with any /slash)
 * @param {Array}  [args.attachments]      message attachments[] with mime_type
 * @param {string} args.currentProvider    conversation.provider (vendor guard)
 * @param {string} args.currentModel       conversation.model (fallback)
 * @param {object} [args.autoRules]        profile.auto_rules blob
 * @param {Array}  args.providers          listProvidersAll(db) result
 * @returns {Promise<{ provider_id: string|null, model_id: string|null, reason: string }>}
 * @throws SmartChatDisabled when feature flag is off
 */
export async function chooseProvider({ db, convId, content, attachments, currentProvider, currentModel, autoRules, providers }) {
  const flagsRaw = await readSetting(db, "feature_flags");
  let flags = null;
  try { flags = flagsRaw ? JSON.parse(flagsRaw) : null; } catch {}
  if (!flags || flags.smart_chat !== true) throw new SmartChatDisabled();

  const rules = autoRules || {};
  const disabled = new Set(Array.isArray(rules.disabled) ? rules.disabled : []);

  // 1. slash-command (highest precedence)
  const slash = detectSlashCommand(content);
  if (slash && !disabled.has("slash")) {
    const picked = resolveRouteToProvider(slash, providers, rules);
    if (picked) {
      return await wrapWithVendorLock({
        db, convId, picked, reasonBase: `matched /${slash}`,
        currentProvider, currentModel,
      });
    }
  }

  // 2. attachment
  if (!disabled.has("attachment") && hasImageAttachment(attachments)) {
    const picked = resolveRouteToProvider("vision", providers, rules);
    if (picked) {
      return await wrapWithVendorLock({
        db, convId, picked, reasonBase: "matched image attachment",
        currentProvider, currentModel,
      });
    }
  }

  // 3. keyword / intent
  if (!disabled.has("keyword")) {
    const kwRoute = detectKeywordRoute(content);
    if (kwRoute) {
      const picked = resolveRouteToProvider(kwRoute, providers, rules);
      if (picked) {
        return await wrapWithVendorLock({
          db, convId, picked, reasonBase: `keyword: ${kwRoute}`,
          currentProvider, currentModel,
        });
      }
    }
  }

  // 4. fallback
  const fb = resolveRouteToProvider("default", providers, rules);
  if (fb) {
    return await wrapWithVendorLock({
      db, convId, picked: fb, reasonBase: "default route",
      currentProvider, currentModel,
    });
  }

  // Everything failed (no providers usable) — keep the conversation's current model.
  return {
    provider_id: currentProvider || null,
    model_id: currentModel || null,
    reason: "no routable provider — using conversation default",
  };
}

async function wrapWithVendorLock({ db, convId, picked, reasonBase, currentProvider, currentModel }) {
  const currentBucket = vendorBucket(currentProvider);
  const pickedBucket = vendorBucket(picked.provider_type || picked.host);
  if (currentBucket !== pickedBucket && await hasActiveToolCalls(db, convId)) {
    return {
      provider_id: currentProvider || null,
      model_id: currentModel || null,
      reason: `route skipped: tool-call-vendor-lock (${reasonBase})`,
    };
  }
  const models = Array.isArray(picked.models) ? picked.models : [];
  const firstModel = models[0];
  const modelId = typeof firstModel === "string" ? firstModel : firstModel?.id;
  return {
    provider_id: picked.id,
    model_id: modelId || currentModel || null,
    reason: `${picked.id} · ${reasonBase}`,
  };
}
