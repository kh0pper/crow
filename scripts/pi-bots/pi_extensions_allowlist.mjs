#!/usr/bin/env node
/**
 * Crow Bot Builder — curated pi-extension allowlist + install-approval gate
 * (Phase 2.4, plan §3).
 *
 * INVARIANT (the actual safety property): NO Bot Builder code path ever runs
 * `pi install`. pi loads its extension set from pi-lab via
 * `~/.pi/agent/settings.json` `packages[]` — a fixed, human-curated package.
 * The bridge spawns `pi --mode rpc …` with NO install/add-package step
 * (verified: bridge.mjs PiRpc args = mode/provider/model/session-dir
 * [+tools/+append-system-prompt/+session] only). Adding a NEW pi extension is
 * therefore a deliberate human operation in the pi-lab gitea repo
 * (clone → branch → `npm run test:extensions` → merge → `git -C ~/pi-lab
 * pull`), NEVER a GUI/bridge side effect at bot-save or bot-spawn time.
 *
 * This module is the single source of truth for which extensions a bot may
 * select. Every entry below is a pi-lab BUILT-IN already loaded for all pi on
 * crow (no install needed) — selecting it just opts this bot into using it.
 * Anything outside this list is REFUSED (logged) by the bridge and is never
 * offered by the GUI; obtaining a new one is the documented pi-lab human flow.
 */

import { loadModels, validateModelKey } from "./model_resolver.mjs";

export const PI_EXT_ALLOWLIST = Object.freeze([
  // pi-lab built-ins (extensions/ — loaded via settings.json packages[]):
  "plan-mode", // read-only exploration mode (pi-lab/extensions/plan-mode/)
  "todo", // task list extension (pi-lab/extensions/todo.ts)
  "subagent", // single/parallel/chain sub-agents (pi-lab/extensions/subagent/)
]);

const ALLOW = new Set(PI_EXT_ALLOWLIST);

/**
 * Split a requested extension list into allowed vs rejected.
 * @param {string[]} requested
 * @returns {{ allowed: string[], rejected: string[] }}
 */
export function validateExtensions(requested) {
  const list = Array.isArray(requested) ? requested : [];
  const allowed = [];
  const rejected = [];
  for (const e of list) {
    if (typeof e === "string" && ALLOW.has(e)) allowed.push(e);
    else rejected.push(String(e));
  }
  return { allowed, rejected };
}

/**
 * Curated provider/model ids strong enough to coordinate sub-agents
 * (Phase 3.1, R11). Multi-agent (the pi-lab `subagent` tool) is gated to
 * THIS list — single-agent local-qwen bots can NEVER multi-agent (the
 * Phase-1 invariant). The bridge computes `model_capable =
 * isMultiAgentCapable(resolved.provider, resolved.model)` from the
 * POST-resolution pair and injects it into PI_BOT_PERMISSION_POLICY; the
 * pi-lab gate requires multi_agent && model_capable (fail-closed). Ratified
 * 2026-05-17 against the live ~/.pi/agent/models.json inventory;
 * `multiAgentCapableDrift()` / CLI `capable-drift` makes any divergence a
 * deploy-time failure, not a silent runtime hole.
 */
export const MULTI_AGENT_CAPABLE = Object.freeze([
  "alibaba-coding/qwen3.6-plus",
  "alibaba-coding/qwen3.5-plus",
  "alibaba-coding/qwen3-max-2026-01-23",
  "zai-coding/glm-5.1",
  "zai-coding/glm-5",
]);

const MA = new Set(MULTI_AGENT_CAPABLE);

/** True iff `<provider>/<model>` is on the multi-agent capability allowlist. */
export function isMultiAgentCapable(provider, model) {
  return MA.has(String(provider) + "/" + String(model));
}

/**
 * Deploy-time drift guard (R11): every MULTI_AGENT_CAPABLE entry MUST exist
 * in the live models.json — else a capability-listed bot resolves to a
 * non-existent model. Returns entries NOT present (empty array = OK). If
 * models.json can't be read, treats ALL as drift (loud, fail-closed).
 */
export async function multiAgentCapableDrift() {
  const models = await loadModels();
  if (!models) return MULTI_AGENT_CAPABLE.slice();
  return MULTI_AGENT_CAPABLE.filter((k) => !validateModelKey(models, k).ok);
}

// CLI: print the allowlist, or `validate a,b,c`
if (import.meta.url === "file://" + process.argv[1]) {
  const arg = process.argv[2];
  if (arg === "validate") {
    const r = validateExtensions((process.argv[3] || "").split(",").filter(Boolean));
    console.log(JSON.stringify(r));
    process.exit(r.rejected.length ? 1 : 0);
  }
  if (arg === "capable") {
    console.log(MULTI_AGENT_CAPABLE.join("\n"));
    process.exit(0);
  }
  if (arg === "capable-drift") {
    const d = await multiAgentCapableDrift();
    console.log(d.length ? "DRIFT: " + d.join(", ") : "OK: all MULTI_AGENT_CAPABLE present in models.json");
    process.exit(d.length ? 1 : 0);
  }
  console.log(PI_EXT_ALLOWLIST.join("\n"));
  process.exit(0);
}
