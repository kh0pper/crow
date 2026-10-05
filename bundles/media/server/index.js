#!/usr/bin/env node

/**
 * Crow Media MCP Server — Bundle Entry Point (stdio transport)
 *
 * Unified news + podcast hub with RSS aggregation.
 * Initializes media tables on startup, then starts the MCP server.
 *
 * Background tasks (feed fetch, cleanup, the daily briefing) run when CROW_MEDIA_TASKS=1 AND this
 * is the copy the gateway supervises (CROW_ADDON_HOST=gateway); see shouldRunBackgroundTasks.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMediaServer } from "./server.js";
import { createDbClient } from "./db.js";
import { initMediaTables } from "./init-tables.js";

// stdout is the MCP channel in this process: everything logged goes to stderr.
console.log = (...args) => console.error(...args);

const db = createDbClient();

// Ensure media tables exist (safe to re-run)
await initMediaTables(db);

// Row contract: a briefing or article names an audio file only while that file is really there.
try {
  const { repairBriefingAudio, closeStuckBriefings } = await import("./briefing.js");
  await repairBriefingAudio(db);
  await closeStuckBriefings(db);
} catch (err) {
  console.error(`[media] audio repair skipped: ${err.message}`);
}

const server = createMediaServer(undefined, {
  instructions: "Crow Media Hub — news aggregation, RSS feeds, YouTube channels, podcasts, TTS audio, briefings, playlists, smart folders, email digests. Use crow_media_* tools to manage subscriptions and read articles.",
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Start background tasks in the gateway's own copy only
const { shouldRunBackgroundTasks } = await import("./tasks.js");
if (shouldRunBackgroundTasks()) {
  const { createTaskRunner, registerMediaTasks } = await import("./tasks.js");
  const runner = createTaskRunner(db);
  registerMediaTasks(runner, db);
  runner.start();
  const { startScheduleLoop } = await import("./schedule.js");
  startScheduleLoop(db);
  const { enablePushInThisProcess } = await import("./notify.js");
  await enablePushInThisProcess();
  const { MEDIA_VERSION } = await import("./server.js");
  console.error(`[media] v${MEDIA_VERSION}: background tasks started (daily briefing schedule checked every minute)`);
} else if (process.env.CROW_MEDIA_TASKS === "1") {
  console.error("[media] tools only: background tasks run in the gateway's own copy of this server");
}
