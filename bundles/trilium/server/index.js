#!/usr/bin/env node

/**
 * TriliumNext MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTriliumServer } from "./server.js";

const server = createTriliumServer();
const transport = new StdioServerTransport();
await server.connect(transport);
