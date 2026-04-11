#!/usr/bin/env node

/**
 * Miniflux MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMinifluxServer } from "./server.js";

const server = createMinifluxServer();
const transport = new StdioServerTransport();
await server.connect(transport);
