#!/usr/bin/env node

/**
 * Data Dashboard — stdio transport entry point.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDataDashboardServer } from "./server.js";

const server = createDataDashboardServer();
const transport = new StdioServerTransport();
await server.connect(transport);
