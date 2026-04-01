#!/usr/bin/env node
/**
 * Diagnostic: replicate the exact runTeam flow step by step
 * to find where tools stop reaching the LLM.
 */

import { ToolRegistry, registerBuiltInTools, Agent, AgentPool, ToolExecutor } from "open-multi-agent";
import { registerCrowTools } from "./mcp-bridge.js";

// Step 1: Build shared registry (same as server.js getSharedRegistry)
const registry = new ToolRegistry();
registerBuiltInTools(registry);
await registerCrowTools(registry, { categories: ["memory"] });
console.log("Registry tools:", registry.list().length);

// Step 2: Build agent the same way buildAgent() does with shared registry
function buildAgent(config) {
  const executor = new ToolExecutor(registry); // shared registry
  return new Agent(config, registry, executor);
}

const researcherConfig = {
  name: "researcher",
  model: "opus-reasoning-35b",
  provider: "openai",
  apiKey: "not-needed",
  baseURL: "http://localhost:8081/v1",
  systemPrompt: "You are a research assistant. Always use tools to search when asked.",
  tools: ["crow_search_memories", "crow_list_memories"],
  maxTurns: 4,
  maxTokens: 2048,
};

// Step 3: Test agent directly (no pool)
console.log("\n--- Test 1: Agent.run() directly ---");
const agent1 = buildAgent(researcherConfig);
console.log("Agent tools from registry:", agent1.getTools().length);
for await (const event of agent1.stream("Search memories for home lab.")) {
  if (event.type === "error") console.error("  ERROR:", event.data?.message || event.data);
  if (event.type === "tool_use") console.log("  TOOL_USE:", event.data?.name);
  if (event.type === "done") console.log("  DONE: toolCalls=", event.data?.toolCalls?.length, "tokens=", event.data?.tokenUsage);
}

// Step 4: Test via pool (same as executeQueue)
console.log("\n--- Test 2: Via AgentPool.run() ---");
const agent2 = buildAgent(researcherConfig);
const pool = new AgentPool(1);
pool.add(agent2);
const poolResult = await pool.run("researcher", "Search memories for home lab.");
console.log("Pool result: success=", poolResult.success, "toolCalls=", poolResult.toolCalls.length, "tokens=", poolResult.tokenUsage);
if (poolResult.toolCalls.length === 0) {
  console.log("Output:", poolResult.output.slice(0, 200));
}

// Step 5: Test with ALL tools (not just memory) to check if it's a schema size issue
console.log("\n--- Test 3: Agent with all 8 preset tools ---");
const registry2 = new ToolRegistry();
registerBuiltInTools(registry2);
await registerCrowTools(registry2, { categories: ["memory", "projects"] });
console.log("Registry2 tools:", registry2.list().length);

const executor2 = new ToolExecutor(registry2);
const agent3 = new Agent(
  {
    ...researcherConfig,
    tools: [
      "crow_search_memories", "crow_recall_by_context", "crow_list_memories", "crow_memory_stats",
      "crow_search_sources", "crow_list_sources", "crow_search_notes", "crow_list_projects",
    ],
  },
  registry2,
  executor2,
);

for await (const event of agent3.stream("Search memories for home lab.")) {
  if (event.type === "error") console.error("  ERROR:", event.data?.message || event.data);
  if (event.type === "tool_use") console.log("  TOOL_USE:", event.data?.name);
  if (event.type === "done") console.log("  DONE: toolCalls=", event.data?.toolCalls?.length, "tokens=", event.data?.tokenUsage);
}

process.exit(0);
