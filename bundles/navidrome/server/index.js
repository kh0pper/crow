#!/usr/bin/env node

/**
 * Navidrome MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNavidromeServer } from "./server.js";

const server = createNavidromeServer();
const transport = new StdioServerTransport();
await server.connect(transport);
