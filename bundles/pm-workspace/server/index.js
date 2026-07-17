#!/usr/bin/env node

/**
 * Crow PM Workspace MCP Server — bundle entry point (stdio transport).
 *
 * Initializes pm_* tables, starts the digest/sync schedulers when
 * PM_RUN_CRON=1, then connects the MCP server over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPmWorkspaceServer } from "./server.js";
import { initPmTables } from "./init-tables.js";
import { createDbClient } from "./db.js";
import { loadConfig } from "./config.js";
import { startCrons } from "./digest/cron.js";

const db = createDbClient();

// Ensure PM tables exist (safe to re-run)
await initPmTables(db);

// Schedulers are opt-in: enable PM_RUN_CRON=1 on exactly one registration.
if (loadConfig().PM_RUN_CRON === "1") {
  startCrons(db, loadConfig);
}

const server = createPmWorkspaceServer(db, {
  instructions:
    "Crow PM Workspace — personal notes (markdown + drawing with OCR), a daily digest, and deterministic Monday.com sync. Use crow_pm_* tools. Boards and kanban stay with the tasks bundle / Bot Board tracker tools — this server only reads them for the digest and syncs them with Monday.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
