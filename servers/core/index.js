#!/usr/bin/env node

/**
 * Crow Core — stdio entry point
 *
 * Single MCP server with on-demand server activation.
 * Starts with memory tools (or CROW_DEFAULT_SERVER) + 3 management tools.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoreServer } from "./server.js";

const server = await createCoreServer();
const transport = new StdioServerTransport();
await server.connect(transport);
