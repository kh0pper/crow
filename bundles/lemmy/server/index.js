#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLemmyServer } from "./server.js";

const server = await createLemmyServer();
const transport = new StdioServerTransport();
await server.connect(transport);
