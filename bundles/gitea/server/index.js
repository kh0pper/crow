#!/usr/bin/env node

/**
 * Gitea MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGiteaServer } from "./server.js";

const server = createGiteaServer();
const transport = new StdioServerTransport();
await server.connect(transport);
