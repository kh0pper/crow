#!/usr/bin/env node

/**
 * Vaultwarden MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVaultwardenServer } from "./server.js";

const server = createVaultwardenServer();
const transport = new StdioServerTransport();
await server.connect(transport);
