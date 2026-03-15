#!/usr/bin/env node

/**
 * Crow Media MCP Server — Bundle Entry Point (stdio transport)
 *
 * Unified news + podcast hub with RSS aggregation.
 * Initializes media tables on startup, then starts the MCP server.
 *
 * Set CROW_MEDIA_TASKS=1 to enable background tasks (feed fetch, cleanup, etc.).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMediaServer } from "./server.js";
import { createDbClient } from "./db.js";
import { initMediaTables } from "./init-tables.js";

const db = createDbClient();

// Ensure media tables exist (safe to re-run)
await initMediaTables(db);

const server = createMediaServer(undefined, {
  instructions: "Crow Media Hub — news aggregation, RSS feeds, YouTube channels, podcasts, TTS audio, briefings, playlists, smart folders, email digests. Use crow_media_* tools to manage subscriptions and read articles.",
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Start background tasks if enabled
if (process.env.CROW_MEDIA_TASKS === "1") {
  const { createTaskRunner, registerMediaTasks } = await import("./tasks.js");
  const runner = createTaskRunner(db);
  registerMediaTasks(runner, db);
  runner.start();
  console.error("[media] Background tasks started");
}
