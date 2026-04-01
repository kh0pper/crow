#!/usr/bin/env node
/**
 * Diagnostic: call OpenMultiAgent.runTeam() and log everything.
 */

import { OpenMultiAgent, ToolRegistry, registerBuiltInTools } from "open-multi-agent";
import { registerCrowTools } from "./mcp-bridge.js";

const registry = new ToolRegistry();
registerBuiltInTools(registry);
await registerCrowTools(registry, { categories: ["memory"] });
console.log("Registry tools:", registry.list().length);

const orchestrator = new OpenMultiAgent({
  maxConcurrency: 1,
  defaultModel: "opus-reasoning-35b",
  defaultProvider: "openai",
  defaultApiKey: "not-needed",
  defaultBaseURL: "http://localhost:8081/v1",
  toolRegistry: registry,
  onProgress: (event) => {
    let extra = "";
    if (event.type === "agent_complete" && event.data) {
      const d = event.data;
      extra = ` toolCalls=${d.toolCalls?.length ?? "?"} output=${(d.output?.length ?? 0)}chars tokens=${JSON.stringify(d.tokenUsage)}`;
    }
    if (event.type === "task_complete" && event.data) {
      const d = event.data;
      extra = ` output=${(d.output?.length ?? 0)}chars`;
    }
    console.log(`[progress] ${event.type} agent=${event.agent || "-"} task=${event.task || "-"}${extra}`);
  },
});

const team = orchestrator.createTeam("test", {
  name: "test",
  agents: [
    {
      name: "researcher",
      model: "opus-reasoning-35b",
      provider: "openai",
      apiKey: "not-needed",
      baseURL: "http://localhost:8081/v1",
      systemPrompt: "You are a research assistant. Always use your search tools when asked to find information.",
      tools: ["crow_search_memories", "crow_list_memories"],
      maxTurns: 4,
      maxTokens: 2048,
    },
    {
      name: "writer",
      model: "opus-reasoning-35b",
      provider: "openai",
      apiKey: "not-needed",
      baseURL: "http://localhost:8081/v1",
      systemPrompt: "You are a writer. Synthesize research findings into clear text.",
      tools: [],
      maxTurns: 3,
      maxTokens: 2048,
    },
  ],
  sharedMemory: true,
  maxConcurrency: 1,
});

console.log("\nRunning team...");
const result = await orchestrator.runTeam(team, "Search my memories for anything about the home lab network.");

console.log("\n--- Team Result ---");
console.log("Success:", result.success);
console.log("Total tokens:", result.totalTokenUsage);
for (const [name, agentResult] of result.agentResults) {
  console.log(`\nAgent: ${name}`);
  console.log("  success:", agentResult.success);
  console.log("  toolCalls:", agentResult.toolCalls.length);
  console.log("  tokens:", agentResult.tokenUsage);
  console.log("  output:", agentResult.output.slice(0, 300));
}

process.exit(0);
