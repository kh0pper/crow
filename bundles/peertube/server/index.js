#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPeertubeServer } from "./server.js";

const server = await createPeertubeServer();
const transport = new StdioServerTransport();
await server.connect(transport);
