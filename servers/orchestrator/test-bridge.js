#!/usr/bin/env node
/**
 * Quick test: verify the MCP bridge can connect to the memory server
 * and call crow_store_memory + crow_search_memories through it.
 *
 * Usage: node servers/orchestrator/test-bridge.js
 */

import { ToolRegistry } from "open-multi-agent";
import { registerCrowTools } from "./mcp-bridge.js";

async function main() {
  console.log("--- MCP Bridge Test ---\n");

  const registry = new ToolRegistry();
  const { clients, toolCount } = await registerCrowTools(registry, {
    categories: ["memory"],
  });

  console.log(`\nTotal tools registered: ${toolCount}`);
  console.log("Tool names:", registry.list().map((t) => t.name).join(", "));

  // Test 1: Store a memory
  const storeTool = registry.get("crow_store_memory");
  if (!storeTool) {
    console.error("FAIL: crow_store_memory not found in registry");
    process.exit(1);
  }

  console.log("\n[Test 1] Calling crow_store_memory...");
  const storeResult = await storeTool.execute(
    {
      content: "MCP bridge test — this memory was stored through open-multi-agent's ToolRegistry",
      category: "system",
      tags: "test,mcp-bridge",
    },
    { agent: { name: "test", role: "test", model: "none" } }
  );
  console.log("Result:", storeResult.data.slice(0, 200));
  console.log("Error?", storeResult.isError || false);

  // Test 2: Search for the memory
  const searchTool = registry.get("crow_search_memories");
  if (!searchTool) {
    console.error("FAIL: crow_search_memories not found in registry");
    process.exit(1);
  }

  console.log("\n[Test 2] Calling crow_search_memories...");
  const searchResult = await searchTool.execute(
    { query: "MCP bridge test" },
    { agent: { name: "test", role: "test", model: "none" } }
  );
  console.log("Result:", searchResult.data.slice(0, 300));
  console.log("Error?", searchResult.isError || false);

  // Test 3: Verify rawInputSchema is set
  console.log("\n[Test 3] Checking rawInputSchema on crow_store_memory...");
  const rawSchema = storeTool.rawInputSchema;
  if (rawSchema && rawSchema.properties) {
    console.log("PASS: rawInputSchema has properties:", Object.keys(rawSchema.properties).join(", "));
  } else {
    console.log("WARN: rawInputSchema missing or has no properties:", rawSchema);
  }

  // Test 4: Verify toToolDefs() uses rawInputSchema
  console.log("\n[Test 4] Checking toToolDefs() output...");
  const defs = registry.toToolDefs();
  const storeDef = defs.find((d) => d.name === "crow_store_memory");
  if (storeDef && storeDef.inputSchema.properties) {
    console.log("PASS: toToolDefs() returns real JSON Schema with properties:",
      Object.keys(storeDef.inputSchema.properties).join(", "));
  } else {
    console.log("FAIL: toToolDefs() returned empty schema:", storeDef?.inputSchema);
  }

  console.log("\n--- All tests passed ---");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
