/**
 * Multi-Agent Team Presets
 *
 * Each preset defines a team configuration for OpenMultiAgent.runTeam():
 *   - categories: which MCP servers to bridge into the shared ToolRegistry
 *   - agents: array of { name, systemPrompt, tools, maxTurns }
 *   - provider / model: optional overrides (defaults resolved from env or models.json)
 *
 * Tool filtering: each agent's `tools` array is a whitelist of tool names
 * from the shared ToolRegistry. List the tools relevant to each agent's role.
 * Use `tools: []` for agents that should not call tools (e.g., writers).
 */

import { ATS_PLATFORMS_JSON, WRITING_VOICE_RULES } from "./presets/shared.js";
import { corePresets } from "./presets/core.js";
import { mpaPresets } from "./presets/mpa.js";
import { teamPresets } from "./presets/teams.js";
import { jobSearchPresets } from "./presets/bot-job-search.js";
import { trackerPresets } from "./presets/bot-trackers.js";

export const presets = {
  ...corePresets,
  ...mpaPresets,
  ...teamPresets,
  ...jobSearchPresets,
  ...trackerPresets,
};
