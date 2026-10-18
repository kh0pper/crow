#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSunvoxServer } from "./server.js";

const server = createSunvoxServer();
const transport = new StdioServerTransport();
await server.connect(transport);
