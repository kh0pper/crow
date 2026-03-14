#!/usr/bin/env node

/**
 * Crow Persistent Memory MCP Server — stdio transport
 *
 * Provides searchable, context-aware persistent memory backed by SQLite.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer } from "./server.js";
import { createDbClient, verifyDb } from "../db.js";
import { generateInstructions } from "../shared/instructions.js";

try {
  await verifyDb(createDbClient());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const instructions = await generateInstructions({ deviceId: process.env.CROW_DEVICE_ID });
const server = createMemoryServer(undefined, { instructions });
const transport = new StdioServerTransport();
await server.connect(transport);
