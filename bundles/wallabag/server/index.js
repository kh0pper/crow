#!/usr/bin/env node

/**
 * Wallabag MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWallabagServer } from "./server.js";

const server = createWallabagServer();
const transport = new StdioServerTransport();
await server.connect(transport);
