#!/usr/bin/env node
/**
 * Diagnostic: test the researcher agent directly through open-multi-agent
 * to see if tools reach the LLM.
 */

import { OpenMultiAgent, ToolRegistry, registerBuiltInTools } from "open-multi-agent";
import { registerCrowTools } from "./mcp-bridge.js";

const registry = new ToolRegistry();
registerBuiltInTools(registry);
const { toolCount } = await registerCrowTools(registry, { categories: ["memory"] });
console.log(`Registry: ${toolCount} Crow tools + built-ins`);

// List what toToolDefs returns for the researcher's allowed tools
const allowedTools = [
  "crow_search_memories",
  "crow_recall_by_context",
  "crow_list_memories",
  "crow_memory_stats",
];

const allDefs = registry.toToolDefs();
const filteredDefs = allDefs.filter(d => allowedTools.includes(d.name));
console.log(`\nAll tool defs: ${allDefs.length}`);
console.log(`Filtered for researcher: ${filteredDefs.length}`);
for (const d of filteredDefs) {
  const hasProps = d.inputSchema?.properties ? Object.keys(d.inputSchema.properties).join(", ") : "(none)";
  console.log(`  - ${d.name}: ${hasProps}`);
}

// Run a single agent with tools
const orchestrator = new OpenMultiAgent({
  maxConcurrency: 1,
  defaultModel: "opus-reasoning-35b",
  defaultProvider: "openai",
  defaultApiKey: "not-needed",
  defaultBaseURL: "http://localhost:8081/v1",
  toolRegistry: registry,
});

// Also test: run the agent directly to capture errors
import { Agent } from "open-multi-agent";
import { ToolExecutor } from "open-multi-agent";

const executor = new ToolExecutor(registry);
const agent = new Agent(
  {
    name: "researcher",
    model: "opus-reasoning-35b",
    provider: "openai",
    apiKey: "not-needed",
    baseURL: "http://localhost:8081/v1",
    systemPrompt: "You are a research assistant. Always use your tools to search for information when asked.",
    tools: allowedTools,
    maxTurns: 4,
    maxTokens: 2048,
  },
  registry,
  executor,
);

console.log("\nStreaming researcher agent to capture all events...");
for await (const event of agent.stream("Search my memories for anything about the home lab network.")) {
  if (event.type === "error") {
    console.error("ERROR EVENT:", event.data);
  } else if (event.type === "text") {
    process.stdout.write(event.data);
  } else if (event.type === "tool_use") {
    console.log("\nTOOL_USE:", JSON.stringify(event.data));
  } else if (event.type === "tool_result") {
    console.log("TOOL_RESULT:", JSON.stringify(event.data).slice(0, 200));
  } else if (event.type === "done") {
    const r = event.data;
    console.log("\nDONE:", { toolCalls: r.toolCalls?.length, tokens: r.tokenUsage, turns: r.turns });
  }
}

console.log("\n\nAlso testing via orchestrator.runAgent...");
const result = await orchestrator.runAgent(
  {
    name: "researcher",
    model: "opus-reasoning-35b",
    provider: "openai",
    apiKey: "not-needed",
    baseURL: "http://localhost:8081/v1",
    systemPrompt: "You are a research assistant. Always use your tools to search for information when asked.",
    tools: allowedTools,
    maxTurns: 4,
    maxTokens: 2048,
  },
  "Search my memories for anything about the home lab network."
);

console.log("\n--- Result ---");
console.log("Success:", result.success);
console.log("Tool calls:", result.toolCalls.length);
for (const tc of result.toolCalls) {
  console.log(`  - ${tc.toolName}(${JSON.stringify(tc.input).slice(0, 100)})`);
  console.log(`    Output: ${tc.output.slice(0, 200)}`);
}
console.log("Output:", result.output.slice(0, 500));
console.log("Tokens:", result.tokenUsage);

process.exit(0);
