#!/usr/bin/env node

/**
 * Actual Budget MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createActualBudgetServer } from "./server.js";

const server = createActualBudgetServer();
const transport = new StdioServerTransport();
await server.connect(transport);
