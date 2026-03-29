#!/usr/bin/env node

/**
 * CrowClaw MCP Server — Bundle Entry Point (stdio transport)
 *
 * Manages OpenClaw bots: create, configure, deploy, monitor.
 * Initializes CrowClaw tables on startup, then starts the MCP server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCrowClawServer } from "./server.js";
import { createDbClient } from "./db.js";
import { initCrowClawTables } from "./init-tables.js";

const db = createDbClient();

// Ensure CrowClaw tables exist (safe to re-run)
await initCrowClawTables(db);

const server = createCrowClawServer(undefined, {
  instructions: "CrowClaw — OpenClaw bot management. Use crow_* tools to create, configure, deploy, and monitor OpenClaw bots.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
