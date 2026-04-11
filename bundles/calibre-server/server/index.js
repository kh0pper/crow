#!/usr/bin/env node

/**
 * Calibre Server MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCalibreServer } from "./server.js";

const server = createCalibreServer();
const transport = new StdioServerTransport();
await server.connect(transport);
