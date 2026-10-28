#!/usr/bin/env node

/**
 * Crow Project Server MCP — stdio transport
 *
 * Manages projects, sources, citations, notes, and data backends.
 * For HTTP transport, see servers/gateway/index.js.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProjectServer } from "./server.js";
import { actorFromEnv } from "./actor.js";
import { createDbClient, verifyDb } from "../db.js";
import { generateInstructions } from "../shared/instructions.js";

try {
  await verifyDb(createDbClient());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const instructions = await generateInstructions({ deviceId: process.env.CROW_DEVICE_ID });
// Who is calling: the owner only when the generated owner config says so (CROW_ACTOR_KIND=owner);
// a pi bot's block carries its bot env; anything else is unknown.
const server = createProjectServer(undefined, { instructions, actor: actorFromEnv(process.env) });
const transport = new StdioServerTransport();
await server.connect(transport);
