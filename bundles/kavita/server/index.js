#!/usr/bin/env node

/**
 * Kavita MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKavitaServer } from "./server.js";

const server = createKavitaServer();
const transport = new StdioServerTransport();
await server.connect(transport);
