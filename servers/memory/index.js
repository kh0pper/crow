#!/usr/bin/env node

/**
 * Crow Persistent Memory MCP Server — stdio transport
 *
 * Provides searchable, context-aware persistent memory backed by SQLite.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer } from "./server.js";

const server = createMemoryServer();
const transport = new StdioServerTransport();
await server.connect(transport);
