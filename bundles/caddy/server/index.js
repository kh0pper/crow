#!/usr/bin/env node

/**
 * Caddy MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCaddyServer } from "./server.js";

const server = createCaddyServer();
const transport = new StdioServerTransport();
await server.connect(transport);
