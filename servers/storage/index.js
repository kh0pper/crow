#!/usr/bin/env node

/**
 * Crow Storage MCP Server — stdio transport
 *
 * S3-compatible file storage backed by MinIO.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStorageServer } from "./server.js";

const server = createStorageServer();
const transport = new StdioServerTransport();
await server.connect(transport);
