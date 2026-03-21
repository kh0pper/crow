#!/usr/bin/env node

/**
 * Kodi MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKodiServer } from "./server.js";

const server = createKodiServer();
const transport = new StdioServerTransport();
await server.connect(transport);
