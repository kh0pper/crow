#!/usr/bin/env node

/**
 * Crow Knowledge Base MCP Server — Bundle Entry Point (stdio transport)
 *
 * Multilingual knowledge base with structured resource tracking
 * and verification workflows.
 * Initializes KB tables on startup, then starts the MCP server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKnowledgeBaseServer } from "./server.js";
import { initKbTables } from "./init-tables.js";
import { createDbClient } from "./db.js";

const db = createDbClient();

// Ensure KB tables exist (safe to re-run)
await initKbTables(db);

const server = createKnowledgeBaseServer(db, {
  instructions: "Crow Knowledge Base — create, manage, search, and share multilingual knowledge base collections. Use crow_kb_* tools to manage articles and resources.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
