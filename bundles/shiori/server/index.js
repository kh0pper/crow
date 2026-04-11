#!/usr/bin/env node

/**
 * Shiori MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createShioriServer } from "./server.js";

const server = createShioriServer();
const transport = new StdioServerTransport();
await server.connect(transport);
