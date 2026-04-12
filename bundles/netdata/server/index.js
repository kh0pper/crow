#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNetdataServer } from "./server.js";

const server = createNetdataServer();
const transport = new StdioServerTransport();
await server.connect(transport);
