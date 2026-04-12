#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMastodonServer } from "./server.js";

const server = await createMastodonServer();
const transport = new StdioServerTransport();
await server.connect(transport);
