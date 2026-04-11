#!/usr/bin/env node

/**
 * Linkding MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLinkdingServer } from "./server.js";

const server = createLinkdingServer();
const transport = new StdioServerTransport();
await server.connect(transport);
