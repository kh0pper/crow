#!/usr/bin/env node

/**
 * Vikunja MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVikunjaServer } from "./server.js";

const server = createVikunjaServer();
const transport = new StdioServerTransport();
await server.connect(transport);
