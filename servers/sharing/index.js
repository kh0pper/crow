#!/usr/bin/env node

/**
 * Crow Sharing MCP Server — stdio transport
 *
 * Provides P2P sharing, messaging, and collaboration backed by
 * Hyperswarm, Hypercore, and Nostr.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSharingServer } from "./server.js";
import { createDbClient, verifyDb } from "../db.js";
import { generateInstructions } from "../shared/instructions.js";

try {
  await verifyDb(createDbClient());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const instructions = await generateInstructions({ deviceId: process.env.CROW_DEVICE_ID });
const server = createSharingServer(undefined, { instructions });
const transport = new StdioServerTransport();
await server.connect(transport);
