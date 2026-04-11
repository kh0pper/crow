#!/usr/bin/env node

/**
 * BookStack MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBookstackServer } from "./server.js";

const server = createBookstackServer();
const transport = new StdioServerTransport();
await server.connect(transport);
