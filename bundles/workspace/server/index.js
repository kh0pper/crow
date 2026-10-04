#!/usr/bin/env node
/** Crow Workspace MCP server: stdio entry point (args must stay ["server/index.js"]; proxy.js cleanup matches it). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorkspaceServer } from "./server.js";
await createWorkspaceServer().connect(new StdioServerTransport());
