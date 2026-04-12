#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMatrixDendriteServer } from "./server.js";

const server = await createMatrixDendriteServer();
const transport = new StdioServerTransport();
await server.connect(transport);
