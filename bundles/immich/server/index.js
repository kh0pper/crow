#!/usr/bin/env node

/**
 * Immich MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImmichServer } from "./server.js";

const server = createImmichServer();
const transport = new StdioServerTransport();
await server.connect(transport);
