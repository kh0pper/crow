#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdguardServer } from "./server.js";

const server = createAdguardServer();
const transport = new StdioServerTransport();
await server.connect(transport);
