#!/usr/bin/env node

/**
 * Change Detection MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChangeDetectionServer } from "./server.js";

const server = createChangeDetectionServer();
const transport = new StdioServerTransport();
await server.connect(transport);
