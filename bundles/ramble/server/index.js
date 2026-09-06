import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRambleServer } from "./server.js";
import { initRambleTables } from "./init-tables.js";
import { createDbClient } from "./db.js";

const db = createDbClient();
await initRambleTables(db);
const server = createRambleServer(db, { instructions: "Ramble: proximity marks + caws." });
await server.connect(new StdioServerTransport());
