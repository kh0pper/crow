#!/usr/bin/env node

/**
 * Forgejo MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createForgejoServer } from "./server.js";

const server = createForgejoServer();
const transport = new StdioServerTransport();
await server.connect(transport);
