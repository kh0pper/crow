#!/usr/bin/env node

/**
 * Frigate MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFrigateServer } from "./server.js";

const server = createFrigateServer();
const transport = new StdioServerTransport();
await server.connect(transport);
