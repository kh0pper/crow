#!/usr/bin/env node

/**
 * Paperless-ngx MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaperlessServer } from "./server.js";

const server = createPaperlessServer();
const transport = new StdioServerTransport();
await server.connect(transport);
