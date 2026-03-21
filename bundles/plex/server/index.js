#!/usr/bin/env node

/**
 * Plex MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPlexServer } from "./server.js";

const server = createPlexServer();
const transport = new StdioServerTransport();
await server.connect(transport);
