#!/usr/bin/env node
/**
 * End-to-end test: run a real orchestration job through the MCP server.
 *
 * This calls crow_orchestrate with the research preset, then polls
 * crow_orchestrate_status until completion or timeout.
 *
 * Requires llama-server running on port 8081.
 *
 * Usage: node servers/orchestrator/test-e2e.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOrchestratorServer } from "./server.js";

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 360000; // 6 minutes

async function main() {
  console.log("--- E2E Orchestration Test ---\n");

  // Create in-process client
  const server = createOrchestratorServer();
  const client = new Client({ name: "test-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Start orchestration
  console.log("[1] Starting orchestration...");
  const startResult = await client.callTool({
    name: "crow_orchestrate",
    arguments: {
      goal: "Search my memories for anything related to the home lab network architecture. Summarize what you find.",
      preset: "research",
    },
  });

  const startData = JSON.parse(startResult.content[0].text);
  console.log(`Job started: ${startData.jobId}`);
  console.log(`Status: ${startData.status}`);

  // Poll for completion
  console.log("\n[2] Polling for completion...");
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusResult = await client.callTool({
      name: "crow_orchestrate_status",
      arguments: { jobId: startData.jobId },
    });

    const status = JSON.parse(statusResult.content[0].text);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  [${elapsed}s] Status: ${status.status}`);

    if (status.status === "completed") {
      console.log("\n[3] RESULT:");
      console.log("─".repeat(60));
      console.log(status.result);
      console.log("─".repeat(60));
      console.log("\n--- E2E test passed ---");
      process.exit(0);
    }

    if (status.status === "failed") {
      console.error("\n[3] FAILED:", status.error);
      process.exit(1);
    }
  }

  console.error("\nTimed out waiting for orchestration to complete.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
