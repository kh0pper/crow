#!/usr/bin/env node

/**
 * WriteFreely MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWritefreelyServer } from "./server.js";

const server = await createWritefreelyServer();
const transport = new StdioServerTransport();
await server.connect(transport);
