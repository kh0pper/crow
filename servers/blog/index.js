#!/usr/bin/env node

/**
 * Crow Blog MCP Server — stdio transport
 *
 * Lightweight blogging platform with Markdown, RSS, and themes.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBlogServer } from "./server.js";
import { createDbClient, verifyDb } from "../db.js";
import { generateInstructions } from "../shared/instructions.js";

try {
  await verifyDb(createDbClient());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const instructions = await generateInstructions();
const server = createBlogServer(undefined, { instructions });
const transport = new StdioServerTransport();
await server.connect(transport);
