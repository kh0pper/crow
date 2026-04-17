/**
 * compat(role, provider, db?) — shared check consumed by BOTH the Roles
 * tab row renderer AND the save handler. Same function in both places =
 * UI dropdown colors and server-side validation never drift.
 *
 * Tiers:
 *   1. Blockers (hard-stop): disabled provider, embed/rerank model on a
 *      chat role, chat model on vision role when needs_vision=true.
 *   2. Warnings (yellow): mutex collision within a preset, cloud provider
 *      on a scheduled pipeline, cloud provider on a tool-heavy role.
 *   3. Informational: role-shape tag, provider capability tags.
 *
 * Lives in servers/orchestrator/ (not the UI sections dir) so this file
 * can land + be unit-tested before any sections/llm/ files exist.
 */

import { pipelines } from "./pipelines.js";
import { roleShape } from "./role-shape.js";
import { providerCapabilities } from "./provider-capabilities.js";

// Build the preset→scheduled-pipeline lookup once (three rows today).
const SCHEDULED_PRESETS = new Map();
for (const [name, p] of Object.entries(pipelines)) {
  if (!p.preset) continue;
  if (!SCHEDULED_PRESETS.has(p.preset)) SCHEDULED_PRESETS.set(p.preset, []);
  SCHEDULED_PRESETS.get(p.preset).push({
    pipeline: name,
    cron: p.defaultCron || null,
  });
}

const BLOCKER = "blocker";
const WARNING = "warning";
const HINT    = "hint";

/**
 * @param {{ preset_name: string, agent_name: string }} role
 * @param {import('./provider-capabilities.js').Provider | null | undefined} provider
 * @param {{ otherAssignments?: Array<{agent_name: string, provider: any}> } } [opts]
 * @returns {{
 *   ok: boolean,
 *   blockers: Array<{ code: string, message: string }>,
 *   warnings: Array<{ code: string, message: string }>,
 *   hints:    Array<{ code: string, message: string }>,
 *   role_shape: ReturnType<typeof roleShape> | null,
 *   provider_capabilities: ReturnType<typeof providerCapabilities>,
 * }}
 */
export function compat(role, provider, opts = {}) {
  const shape = roleShape(role?.preset_name, role?.agent_name);
  const caps = providerCapabilities(provider);
  const blockers = [];
  const warnings = [];
  const hints = [];

  if (!shape) {
    blockers.push({ code: "unknown_role", message: `Unknown preset or agent: ${role?.preset_name}/${role?.agent_name}` });
    return { ok: false, blockers, warnings, hints, role_shape: null, provider_capabilities: caps };
  }

  // ---- Tier 1: blockers ----
  if (!provider) {
    blockers.push({ code: "provider_missing", message: "No provider selected." });
    return { ok: false, blockers, warnings, hints, role_shape: shape, provider_capabilities: caps };
  }

  if (provider.disabled) {
    blockers.push({
      code: "provider_disabled",
      message: `Provider "${provider.id}" is disabled. Enable it before assigning.`,
    });
  }

  // Capability-mismatch: vision role must have vision tag
  if (shape.needs_vision && !caps.tags.includes("vision")) {
    blockers.push({
      code: "vision_required",
      message: `Agent "${role.agent_name}" processes images; provider "${provider.id}" advertises no vision capability.`,
    });
  }

  // Embed/rerank-only model on a non-embed role (every preset role is
  // effectively chat-capable; embed/rerank are not).
  const chatCapable = caps.tags.includes("chat") || caps.tags.includes("vision");
  const hasSpecialOnly = (caps.tags.includes("embed") || caps.tags.includes("rerank"))
    && !chatCapable;
  if (hasSpecialOnly) {
    blockers.push({
      code: "capability_mismatch",
      message: `Provider "${provider.id}" is ${caps.tags.includes("embed") ? "embedding" : "reranking"}-only; cannot serve the "${role.agent_name}" role.`,
    });
  }

  // ---- Tier 2: warnings (yellow banners) ----
  const isCloud = (provider.host === "cloud") || (provider.provider_type && !provider.bundle_id);

  // Mutex collision within a preset
  const others = Array.isArray(opts.otherAssignments) ? opts.otherAssignments : [];
  const myMutex = new Set(caps.mutex_groups);
  if (myMutex.size > 0) {
    for (const other of others) {
      if (!other?.provider || other.agent_name === role.agent_name) continue;
      const otherCaps = providerCapabilities(other.provider);
      for (const g of otherCaps.mutex_groups) {
        if (myMutex.has(g)) {
          warnings.push({
            code: "mutex_collision",
            message: `"${role.agent_name}" and "${other.agent_name}" both map to providers in mutex group "${g}" — orchestrator will serialize them; a cyclic dependency would deadlock.`,
          });
          break;
        }
      }
    }
  }

  // Scheduled-pipeline callout (cloud provider on a preset that runs on cron)
  if (isCloud && SCHEDULED_PRESETS.has(role.preset_name)) {
    const schedules = SCHEDULED_PRESETS.get(role.preset_name)
      .map((s) => `${s.pipeline}${s.cron ? ` (${s.cron})` : ""}`)
      .join(", ");
    warnings.push({
      code: "cloud_on_schedule",
      message: `This preset runs on a schedule (${schedules}). Cloud models on scheduled roles can accumulate cost — review before enabling.`,
    });
  }

  // Tool-heavy cloud role
  if (isCloud && (shape.tools_count > 0 || shape.max_turns > 3)) {
    warnings.push({
      code: "cloud_tool_heavy",
      message: `"${role.agent_name}" uses ${shape.tools_count} tool${shape.tools_count === 1 ? "" : "s"} and up to ${shape.max_turns} turns. A cloud model here will make many API calls per orchestration.`,
    });
  }

  // ---- Tier 3: hints ----
  hints.push({ code: "role_shape", message: shape.tag_text });
  if (caps.tags.length > 0) {
    hints.push({ code: "provider_caps", message: caps.tags.join(" · ") });
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    hints,
    role_shape: shape,
    provider_capabilities: caps,
  };
}

export const SEVERITY = { BLOCKER, WARNING, HINT };
