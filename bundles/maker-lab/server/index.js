#!/usr/bin/env node

/**
 * Crow Maker Lab MCP Server — Bundle Entry Point (stdio transport)
 *
 * Scaffolded AI learning companion paired with FOSS maker surfaces.
 * Hint-ladder pedagogy, per-learner memory scoped by research_project,
 * age-banded personas, classroom-capable.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMakerLabServer } from "./server.js";
import { initMakerLabTables } from "./init-tables.js";
import { createDbClient } from "./db.js";
import { startRetentionSweep } from "./retention-sweep.js";

const db = createDbClient();

await initMakerLabTables(db);
startRetentionSweep(db);

const server = createMakerLabServer(db, {
  instructions:
    "Crow Maker Lab — AI learning companion for kids. Tools take session_token (minted by admin via maker_start_session), never learner_id directly. Hint ladder: nudge → partial → demonstrate. Never initiate peer-sharing from a kid session. Defer to skills/maker-lab.md for pedagogy.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
