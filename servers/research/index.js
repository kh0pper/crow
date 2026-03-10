#!/usr/bin/env node

/**
 * Crow Research Pipeline MCP Server — stdio transport
 *
 * Manages research projects, sources, citations, and notes.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createResearchServer } from "./server.js";
import { createDbClient, verifyDb } from "../db.js";
import { generateInstructions } from "../shared/instructions.js";

try {
  await verifyDb(createDbClient());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const instructions = await generateInstructions();
const server = createResearchServer(undefined, { instructions });
const transport = new StdioServerTransport();
await server.connect(transport);
