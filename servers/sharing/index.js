#!/usr/bin/env node

/**
 * Crow Sharing MCP Server — stdio transport
 *
 * Provides P2P sharing, messaging, and collaboration backed by
 * Hyperswarm, Hypercore, and Nostr.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSharingServer } from "./server.js";

const server = createSharingServer();
const transport = new StdioServerTransport();
await server.connect(transport);
