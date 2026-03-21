#!/usr/bin/env node

/**
 * Crow IPTV MCP Server — Bundle Entry Point (stdio transport)
 *
 * Lightweight IPTV channel management with M3U playlists and EPG.
 * Initializes IPTV tables on startup, then starts the MCP server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createIptvServer } from "./server.js";
import { initIptvTables } from "./init-tables.js";
import { createDbClient } from "./db.js";

const db = createDbClient();

// Ensure IPTV tables exist (safe to re-run)
await initIptvTables(db);

const server = createIptvServer(db, {
  instructions: "Crow IPTV — M3U playlist management, EPG program guide, channel browsing, and favorites. Use crow_iptv_* tools to manage playlists and channels.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
