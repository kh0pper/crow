#!/usr/bin/env node

/**
 * Stirling PDF MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStirlingServer } from "./server.js";

const server = createStirlingServer();
const transport = new StdioServerTransport();
await server.connect(transport);
