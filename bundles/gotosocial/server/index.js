#!/usr/bin/env node

/**
 * GoToSocial MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGotosocialServer } from "./server.js";

const server = await createGotosocialServer();
const transport = new StdioServerTransport();
await server.connect(transport);
