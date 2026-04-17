/**
 * Per-agent shape inference for the LLM settings UI (Roles tab) and the
 * compat check. Reads the static presets.js definitions and returns a
 * compact summary used to:
 *   - render the "tool-heavy · N tools · M turns" hint next to each row
 *   - feed compat() for vision-required checks and cloud-on-tool-heavy
 *     warnings
 *
 * Explicit-annotation contract: an agent's `needs_vision` flag is ONLY
 * true when `presets.js` sets it explicitly. We do NOT infer from prompt
 * wording — the synthesizer's prompt mentions "image description" but
 * processes text-only output from the viewer, so prompt-keyword
 * inference would false-positive.
 */

import { presets } from "./presets.js";

/**
 * @param {string} presetName
 * @param {string} agentName
 * @returns {{
 *   preset_name: string,
 *   agent_name: string,
 *   tools_count: number,
 *   max_turns: number,
 *   needs_vision: boolean,
 *   needs_tools: boolean,
 *   tag_text: string,
 * } | null}  — null when the preset/agent pair is unknown.
 */
export function roleShape(presetName, agentName) {
  const preset = presets[presetName];
  if (!preset) return null;
  const agent = preset.agents?.find((a) => a.name === agentName);
  if (!agent) return null;

  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const toolsCount = tools.length;
  const maxTurns = Number(agent.maxTurns) || 0;
  const needsVision = agent.needs_vision === true;
  const needsTools = toolsCount > 0;

  const parts = [];
  if (needsVision) parts.push("vision");
  if (toolsCount === 0) parts.push("synthesis-only");
  else if (toolsCount >= 10) parts.push("tool-heavy");
  else parts.push(`${toolsCount} tool${toolsCount === 1 ? "" : "s"}`);
  if (maxTurns > 0) parts.push(`${maxTurns} turn${maxTurns === 1 ? "" : "s"}`);

  return {
    preset_name: presetName,
    agent_name: agentName,
    tools_count: toolsCount,
    max_turns: maxTurns,
    needs_vision: needsVision,
    needs_tools: needsTools,
    tag_text: parts.join(" · "),
  };
}

/**
 * Enumerate every (preset, agent) pair declared in presets.js. Callers
 * iterate this to render the Roles tab's 12 rows.
 */
export function listAllRoles() {
  const out = [];
  for (const [presetName, preset] of Object.entries(presets)) {
    for (const agent of preset.agents || []) {
      out.push({ preset_name: presetName, agent_name: agent.name });
    }
  }
  return out;
}
