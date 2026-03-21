#!/usr/bin/env node

/**
 * Nominatim GIS — stdio transport entry point.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNominatimServer } from "./server.js";

const server = createNominatimServer();
const transport = new StdioServerTransport();
await server.connect(transport);
