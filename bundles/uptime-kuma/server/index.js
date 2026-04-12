#!/usr/bin/env node

/**
 * Uptime Kuma MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createUptimeKumaServer } from "./server.js";

const server = createUptimeKumaServer();
const transport = new StdioServerTransport();
await server.connect(transport);
