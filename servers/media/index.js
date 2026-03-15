#!/usr/bin/env node

/**
 * Crow Media MCP Server — stdio transport
 *
 * Unified news + podcast hub with RSS aggregation.
 * For HTTP transport, see servers/gateway/index.js.
 *
 * Stdio mode runs tools on-demand only — no background tasks.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMediaServer } from "./server.js";
import { createDbClient, verifyDb } from "../db.js";
import { generateInstructions } from "../shared/instructions.js";

try {
  await verifyDb(createDbClient());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const instructions = await generateInstructions({ deviceId: process.env.CROW_DEVICE_ID });
const server = createMediaServer(undefined, { instructions });
const transport = new StdioServerTransport();
await server.connect(transport);
