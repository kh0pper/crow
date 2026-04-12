#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCrowdsecServer } from "./server.js";

const server = createCrowdsecServer();
const transport = new StdioServerTransport();
await server.connect(transport);
