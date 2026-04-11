#!/usr/bin/env node

/**
 * Calibre-Web MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCalibreWebServer } from "./server.js";

const server = createCalibreWebServer();
const transport = new StdioServerTransport();
await server.connect(transport);
