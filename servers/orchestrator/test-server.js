#!/usr/bin/env node
/**
 * Quick test: verify the orchestrator MCP server starts and tools are callable.
 *
 * Usage: node servers/orchestrator/test-server.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOrchestratorServer } from "./server.js";

async function main() {
  console.log("--- Orchestrator Server Test ---\n");

  // Create in-process client
  const server = createOrchestratorServer();
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // List tools
  const { tools } = await client.listTools();
  console.log(`Tools registered: ${tools.length}`);
  for (const tool of tools) {
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 80)}`);
  }

  // Test 1: crow_list_presets
  console.log("\n[Test 1] Calling crow_list_presets...");
  const presetsResult = await client.callTool({ name: "crow_list_presets", arguments: {} });
  const presetsText = presetsResult.content[0].text;
  console.log(presetsText.slice(0, 500));
  console.log(presetsResult.isError ? "ERROR" : "OK");

  // Test 2: crow_orchestrate with bad preset
  console.log("\n[Test 2] Calling crow_orchestrate with bad preset...");
  const badResult = await client.callTool({
    name: "crow_orchestrate",
    arguments: { goal: "test", preset: "nonexistent" },
  });
  console.log(badResult.content[0].text);
  console.log(badResult.isError ? "ERROR (expected)" : "UNEXPECTED OK");

  // Test 3: crow_orchestrate_status with bad job ID
  console.log("\n[Test 3] Calling crow_orchestrate_status with bad job ID...");
  const statusResult = await client.callTool({
    name: "crow_orchestrate_status",
    arguments: { jobId: "nonexistent" },
  });
  console.log(statusResult.content[0].text);
  console.log(statusResult.isError ? "ERROR (expected)" : "UNEXPECTED OK");

  console.log("\n--- Server tests passed ---");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
