#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPixelfedServer } from "./server.js";

const server = await createPixelfedServer();
const transport = new StdioServerTransport();
await server.connect(transport);
