#!/usr/bin/env node

/**
 * Crow Research Pipeline MCP Server — stdio transport
 *
 * Manages research projects, sources, citations, and notes.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createResearchServer } from "./server.js";

const server = createResearchServer();
const transport = new StdioServerTransport();
await server.connect(transport);
