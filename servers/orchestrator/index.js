#!/usr/bin/env node
/**
 * Crow Orchestrator — stdio entry point.
 *
 * Launches the orchestrator MCP server over stdio transport.
 * Same pattern as servers/memory/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOrchestratorServer } from "./server.js";

const server = createOrchestratorServer();
const transport = new StdioServerTransport();
await server.connect(transport);
