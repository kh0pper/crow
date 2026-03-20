#!/usr/bin/env node

/**
 * Crow Tax MCP Server — Bundle Entry Point (stdio transport)
 *
 * Tax preparation engine: document collection, calculation, PDF generation.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaxServer } from "./server.js";
import { createDbClient } from "./db.js";
import { initTaxTables } from "./init-tables.js";

const db = createDbClient();

// Ensure tax tables exist (safe to re-run)
await initTaxTables(db);

const server = createTaxServer(undefined, {
  instructions: "Crow Tax Filing Assistant — prepare federal income taxes. Add documents (W-2, 1099, 1098), calculate liability, generate filled IRS PDFs, and get step-by-step filing instructions. Use crow_tax_* tools.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
