#!/usr/bin/env node

/**
 * SearXNG MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSearxngServer } from "./server.js";

const server = createSearxngServer();
const transport = new StdioServerTransport();
await server.connect(transport);
