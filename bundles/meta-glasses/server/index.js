#!/usr/bin/env node

/**
 * Meta Glasses MCP Server — stdio transport entry point.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMetaGlassesServer } from "./server.js";

const server = createMetaGlassesServer();
const transport = new StdioServerTransport();
await server.connect(transport);
