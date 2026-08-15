#!/usr/bin/env node
/** Reader MCP server — bundle entry point (stdio transport). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createReaderServer } from "./server.js";
import { initReaderTables } from "./init-tables.js";
import { createDbClient } from "./db.js";

const db = createDbClient();
await initReaderTables(db);

const server = createReaderServer(db, {
  instructions:
    "Crow Reader — import documents (crow_reader_ingest), browse the library (crow_reader_list), inspect a document (crow_reader_get). Reading happens in the dashboard Reader panel.",
});
await server.connect(new StdioServerTransport());
