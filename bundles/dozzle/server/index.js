#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDozzleServer } from "./server.js";

const server = createDozzleServer();
const transport = new StdioServerTransport();
await server.connect(transport);
