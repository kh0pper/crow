#!/usr/bin/env node

/**
 * Crow Campaigns MCP Server — Bundle Entry Point (stdio transport)
 *
 * Social media campaign management: draft, schedule, publish posts.
 * Initializes Campaigns tables on startup, then starts the MCP server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCampaignsServer } from "./server.js";
import { createDbClient } from "./db.js";
import { initCampaignsTables } from "./init-tables.js";
import { startCampaignScheduler } from "./campaign-scheduler.js";

const db = createDbClient();

// Ensure Campaigns tables exist (safe to re-run)
await initCampaignsTables(db);

// Start the scheduler (polls for due posts every 60s)
const encryptionKey = process.env.CROW_CAMPAIGNS_ENCRYPTION_KEY;
await startCampaignScheduler(db, encryptionKey);

const server = createCampaignsServer(undefined, {
  instructions: "Crow Campaigns — Social media campaign manager. Use crow_campaign_* tools to create campaigns, manage posts, store credentials, and publish to Reddit.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
