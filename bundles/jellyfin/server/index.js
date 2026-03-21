#!/usr/bin/env node

/**
 * Jellyfin MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJellyfinServer } from "./server.js";

const server = createJellyfinServer();
const transport = new StdioServerTransport();
await server.connect(transport);
