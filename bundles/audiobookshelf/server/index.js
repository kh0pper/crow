#!/usr/bin/env node

/**
 * Audiobookshelf MCP Server — stdio transport entry point
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAudiobookshelfServer } from "./server.js";

const server = createAudiobookshelfServer();
const transport = new StdioServerTransport();
await server.connect(transport);
