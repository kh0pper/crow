#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFunkwhaleServer } from "./server.js";

const server = await createFunkwhaleServer();
const transport = new StdioServerTransport();
await server.connect(transport);
