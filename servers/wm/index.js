#!/usr/bin/env node

/**
 * Crow Window Manager MCP Server — stdio transport
 *
 * Provides tools for voice-controlled window management in kiosk mode.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWmServer } from "./server.js";

const server = createWmServer();
const transport = new StdioServerTransport();
await server.connect(transport);
