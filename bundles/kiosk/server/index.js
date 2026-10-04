#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKioskServer } from "./server.js";
await createKioskServer().connect(new StdioServerTransport());
